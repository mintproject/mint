/**
 * Backfill what flow runs read and which settings they used.
 *
 * Flow runs recorded before the Ensemble Manager wrote provenance have an
 * `execution` row with results but empty `execution_data_binding` and
 * `execution_parameter_binding`. This rebuilds those rows from what the Ensemble
 * Manager stored at submit time, using the same rules as a live run
 * (`src/api/api-v1/services/flowProvenance.ts`).
 *
 * DRY RUN BY DEFAULT: it only reads, and prints what it would write. Nothing is
 * written without `--apply`.
 *
 * Usage (from mint-ensemble-manager/):
 *   HASURA_URL=https://.../v1/graphql HASURA_ADMIN_SECRET=... \
 *     npx ts-node --transpile-only scripts/backfill-flow-provenance.ts [options]
 *
 *   --apply            write the rows (default: print only)
 *   --thread <id>      only the runs of this thread
 *   --limit <n>        look at no more than n runs, newest first
 *
 * The admin secret comes from the environment only, never from an argument.
 *
 * What it reads, per flow run:
 *   unified_execution   plan_id (decoded: thread, model, adapter plan id),
 *                       model_child_id (the execution), parameter_values (what the
 *                       submit sent), adapter_run_ids[0] (replacement, last_pause),
 *                       model_result.replacement
 *   adapter_workflow_plan.plan_json   flow.collections, flow.inputs, parameters
 *                       (defaults, default_source), flow.linked_settings, secrets
 *   resource            the catalog resource for each file's url
 *   modelcatalog_configuration.parameters   the flow's catalog parameters, by name
 *   execution           existing bindings, so nothing is written twice
 * It writes (with --apply) insert-only rows, with ON CONFLICT DO NOTHING:
 *   execution_data_binding, execution_parameter_binding, and the edited file's
 *   resource row where a resumed run was edited.
 */
import crypto from "crypto";
import {
    buildFlowProvenance,
    inputsFromPlan,
    settingsFromPlan
} from "../src/api/api-v1/services/flowProvenance";
import type { AdapterPlanJson } from "../src/api/api-v1/services/adapterTypes";
import type { FlowPause, FlowReplacement } from "../src/api/api-v1/services/flowExecution";
import type { UnifiedExecutionRecord } from "../src/api/api-v1/services/unifiedExecutionStore";

/** The rows the backfill reads, under the root field each query asks for. */
export interface GqlData {
    unified_execution?: UnifiedExecutionRecord[];
    execution_by_pk?: {
        id: string;
        data_bindings: { model_io_id: string; resource_id: string }[];
        parameter_bindings: { model_parameter_id: string }[];
    } | null;
    adapter_workflow_plan_by_pk?: { id: string; plan_json?: AdapterPlanJson | null } | null;
    resource?: { id: string; url: string; name?: string }[];
    modelcatalog_configuration_by_pk?: {
        parameters?: {
            parameter?: { id: string; label?: string; parameter_type?: string | null };
        }[];
    } | null;
}

export type Gql = (query: string, variables?: Record<string, unknown>) => Promise<GqlData>;

/** The part of a flow run's first child the backfill reads. */
interface BackfillChild {
    replacement?: FlowReplacement | null;
    last_pause?: FlowPause | null;
}

export interface BackfillOptions {
    apply: boolean;
    threadId?: string;
    limit?: number;
}

export interface BackfillReport {
    run_id: string;
    execution_id: string | null;
    outcome: "rebuilt" | "partial" | "skipped";
    reason?: string;
    data_bindings: { model_io_id: string; resource_id: string; name: string }[];
    parameter_bindings: { model_parameter_id: string; value: string }[];
    edit?: { model_io_id: string; url: string } | null;
    /** Files the plan names that no catalog resource stands for. */
    unresolved_urls: string[];
    /** Settings the run used that the flow's catalog entry does not declare. */
    unrecorded_settings: string[];
}

const UNIFIED = `
query FlowRuns($where: unified_execution_bool_exp!, $limit: Int) {
  unified_execution(where: $where, order_by: [{created_at: desc}], limit: $limit) {
    id plan_id thread_id model_id model_child_id status parameter_values
    adapter_run_ids model_result
  }
}`;
const EXECUTION = `
query Execution($id: uuid!) {
  execution_by_pk(id: $id) {
    id
    data_bindings { model_io_id resource_id }
    parameter_bindings { model_parameter_id }
  }
}`;
const PLAN = `
query Plan($id: String!) {
  adapter_workflow_plan_by_pk(id: $id) { id plan_json }
}`;
const RESOURCES = `
query Resources($urls: [String!]!) {
  resource(where: {url: {_in: $urls}}, order_by: [{id: asc}]) { id name url }
}`;
const PARAMETERS = `
query Parameters($id: String!) {
  modelcatalog_configuration_by_pk(id: $id) {
    parameters { parameter { id label parameter_type } }
  }
}`;
const INSERT_DATA = `
mutation InsertData($objects: [execution_data_binding_insert_input!]!) {
  insert_execution_data_binding(
    objects: $objects
    on_conflict: {constraint: execution_data_binding_pkey, update_columns: []}
  ) { affected_rows }
}`;
const INSERT_PARAMS = `
mutation InsertParams($objects: [execution_parameter_binding_insert_input!]!) {
  insert_execution_parameter_binding(
    objects: $objects
    on_conflict: {constraint: execution_parameter_binding_pkey, update_columns: []}
  ) { affected_rows }
}`;

/** The plan id's payload. Read without checking its signature: this only reads. */
export function planOf(planId: string): { flow?: { adapter_plan_id?: string } } | null {
    if (typeof planId !== "string" || !planId.startsWith("em_")) return null;
    try {
        const encoded = planId.slice(3).split(".")[0];
        const padded = encoded.replace(/-/g, "+").replace(/_/g, "/");
        return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
    } catch {
        return null;
    }
}

const md5 = (text: string) => crypto.createHash("md5").update(text).digest("hex");

function skipped(run_id: string, execution_id: string | null, reason: string): BackfillReport {
    return {
        run_id,
        execution_id,
        outcome: "skipped",
        reason,
        data_bindings: [],
        parameter_bindings: [],
        unresolved_urls: [],
        unrecorded_settings: []
    };
}

async function rebuildOne(
    gql: Gql,
    record: UnifiedExecutionRecord,
    apply: boolean
): Promise<BackfillReport | null> {
    const plan = planOf(record.plan_id);
    if (!plan?.flow?.adapter_plan_id) return null; // not a flow run
    const runId = `ue_${record.id}`;
    const executionId: string | null = record.model_child_id || null;
    if (!executionId) return skipped(runId, null, "the run never created an execution row");
    const execution = (await gql(EXECUTION, { id: executionId })).execution_by_pk;
    if (!execution) return skipped(runId, executionId, "the execution row no longer exists");

    const child = ((record.adapter_run_ids || [])[0] || {}) as BackfillChild;
    const hasInputs = execution.data_bindings.length > 0;
    const havingParams = new Set<string>(
        execution.parameter_bindings.map((row) => row.model_parameter_id)
    );

    const stored = (await gql(PLAN, { id: plan.flow.adapter_plan_id })).adapter_workflow_plan_by_pk;
    const planJson = stored?.plan_json || null;
    const values = (record.parameter_values || {}) as Record<string, unknown>;

    const inputs = planJson ? inputsFromPlan(planJson) : [];
    const urls = [...new Set(inputs.flatMap((input) => input.files.map((file) => file.url)))];
    const resources = new Map<string, { id: string; name?: string }>();
    if (urls.length) {
        for (const row of (await gql(RESOURCES, { urls })).resource || []) {
            // Several catalog rows for one url: the lowest id, so a rerun picks the same.
            if (!resources.has(row.url)) resources.set(row.url, { id: row.id, name: row.name });
        }
    }
    const configuration = (await gql(PARAMETERS, { id: record.model_id }))
        .modelcatalog_configuration_by_pk;
    const parameterIds = new Map<string, string>();
    for (const row of configuration?.parameters || []) {
        const parameter = row.parameter;
        if (parameter && parameter.parameter_type !== "secret") {
            parameterIds.set(parameter.label || parameter.id, parameter.id);
        }
    }
    const built = buildFlowProvenance(
        inputs,
        settingsFromPlan(planJson || {}, values),
        resources,
        parameterIds
    );

    const dataRows = hasInputs
        ? []
        : built.inputs.flatMap((input) =>
              input.resources.map((resource) => ({
                  model_io_id: input.model_io_id,
                  resource_id: resource.id,
                  name: resource.name
              }))
          );
    const paramRows = built.parameters
        .filter((parameter) => !havingParams.has(parameter.model_parameter_id))
        .map((parameter) => ({
            model_parameter_id: parameter.model_parameter_id,
            value: parameter.value
        }));

    // The file a person edited at a pause, as an input of the resumed part.
    const replacement =
        child.replacement ||
        (record.model_result as { replacement?: FlowReplacement } | null)?.replacement ||
        null;
    const editIo: string | undefined = child.last_pause?.model_io_id || undefined;
    let edit: BackfillReport["edit"] = null;
    let editObject: Record<string, unknown> | null = null;
    if (replacement?.url && editIo) {
        const resourceId = md5(replacement.url);
        const present = execution.data_bindings.some(
            (row) => row.model_io_id === editIo && row.resource_id === resourceId
        );
        if (!present) {
            edit = { model_io_id: editIo, url: replacement.url };
            editObject = {
                execution_id: executionId,
                model_io_id: editIo,
                resource: {
                    data: {
                        id: resourceId,
                        ...(replacement.resource_id ? { dcid: replacement.resource_id } : {}),
                        name: `edited ${replacement.file || child.last_pause?.output_key || "file"}`,
                        url: replacement.url
                    },
                    on_conflict: { constraint: "resource_pkey", update_columns: ["name"] }
                }
            };
        }
    }

    const unrecorded = Object.keys(built.settings).filter((name) => !parameterIds.has(name));
    const report: BackfillReport = {
        run_id: runId,
        execution_id: executionId,
        outcome: planJson ? "rebuilt" : "partial",
        ...(planJson
            ? {}
            : {
                  reason: "the adapter's stored plan is gone: only the settings the submit sent are known, and no inputs"
              }),
        data_bindings: dataRows,
        parameter_bindings: paramRows,
        edit,
        unresolved_urls: built.unresolved.map((item) => item.url),
        unrecorded_settings: unrecorded
    };
    if (hasInputs && !paramRows.length && !edit) {
        return skipped(runId, executionId, "already has its bindings");
    }
    if (apply) {
        const dataObjects = [
            ...dataRows.map((row) => ({
                execution_id: executionId,
                model_io_id: row.model_io_id,
                resource_id: row.resource_id
            })),
            ...(editObject ? [editObject] : [])
        ];
        if (dataObjects.length) await gql(INSERT_DATA, { objects: dataObjects });
        if (paramRows.length) {
            await gql(INSERT_PARAMS, {
                objects: paramRows.map((row) => ({
                    execution_id: executionId,
                    model_parameter_id: row.model_parameter_id,
                    parameter_value: row.value
                }))
            });
        }
    }
    return report;
}

export async function backfillFlowProvenance(
    gql: Gql,
    options: BackfillOptions
): Promise<BackfillReport[]> {
    const where: Record<string, unknown> = { plan_id: { _like: "em_%" } };
    if (options.threadId) where.thread_id = { _eq: options.threadId };
    const rows =
        (await gql(UNIFIED, { where, limit: options.limit ?? null })).unified_execution || [];
    const reports: BackfillReport[] = [];
    for (const record of rows) {
        const report = await rebuildOne(gql, record, options.apply);
        if (report) reports.push(report);
    }
    return reports;
}

function hasuraClient(url: string, secret: string): Gql {
    return async (query, variables) => {
        const response = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-Hasura-Admin-Secret": secret },
            body: JSON.stringify({ query, variables })
        });
        const body = (await response.json()) as { data: GqlData; errors?: unknown };
        if (!response.ok || body.errors) {
            throw new Error(`Hasura refused: ${JSON.stringify(body.errors || response.status)}`);
        }
        return body.data;
    };
}

function printReport(reports: BackfillReport[], apply: boolean): void {
    for (const report of reports) {
        const head = `${report.run_id} (execution ${report.execution_id ?? "none"}): ${report.outcome}`;
        console.log(report.reason ? `${head} - ${report.reason}` : head);
        if (report.outcome === "skipped") continue;
        const by = new Map<string, string[]>();
        for (const row of report.data_bindings) {
            by.set(row.model_io_id, [...(by.get(row.model_io_id) || []), row.name]);
        }
        for (const [io, names] of by)
            console.log(`  input ${io}: ${names.length} file(s) ${names.join(", ")}`);
        for (const row of report.parameter_bindings) {
            console.log(`  setting ${row.model_parameter_id} = ${row.value}`);
        }
        if (report.edit)
            console.log(`  edited file under ${report.edit.model_io_id}: ${report.edit.url}`);
        for (const url of report.unresolved_urls)
            console.log(`  CANNOT BIND (no catalog resource): ${url}`);
        if (report.unrecorded_settings.length) {
            console.log(
                `  not catalog parameters, not written: ${report.unrecorded_settings.join(", ")}`
            );
        }
    }
    const counts = reports.reduce<Record<string, number>>((all, r) => {
        all[r.outcome] = (all[r.outcome] || 0) + 1;
        return all;
    }, {});
    console.log(
        `${apply ? "WROTE" : "DRY RUN, nothing written. Would write"} for ${JSON.stringify(counts)}`
    );
    if (!apply) console.log("Run again with --apply to write.");
}

async function main(argv: string[]): Promise<void> {
    const flag = (name: string) => argv.indexOf(name);
    const value = (name: string) => (flag(name) >= 0 ? argv[flag(name) + 1] : undefined);
    const url = process.env.HASURA_URL;
    const secret = process.env.HASURA_ADMIN_SECRET;
    if (!url || !secret) {
        throw new Error("set HASURA_URL and HASURA_ADMIN_SECRET in the environment");
    }
    const apply = flag("--apply") >= 0;
    const reports = await backfillFlowProvenance(hasuraClient(url, secret), {
        apply,
        threadId: value("--thread"),
        limit: value("--limit") ? Number(value("--limit")) : undefined
    });
    printReport(reports, apply);
}

if (require.main === module) {
    main(process.argv.slice(2)).catch((error) => {
        console.error(error instanceof Error ? error.message : error);
        process.exit(1);
    });
}
