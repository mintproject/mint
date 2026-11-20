import { getThread, getExecutionHistory } from "@/classes/graphql/graphql_functions_v2";
import { getConfiguration } from "@/classes/mint/mint-functions";
import { adapterInternalSecret } from "./adapterConfig";
import { getTokenFromAuthorizationHeader } from "@/utils/authUtils";
import { BadRequestError, NotFoundError } from "@/classes/common/errors";
import {
    createHasuraUnifiedExecutionStore,
    UnifiedExecutionRecord,
    UnifiedExecutionStep
} from "./unifiedExecutionStore";

const HISTORY_SCHEMA_VERSION = 1;
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const EXECUTION_FETCH_LIMIT = 500;

type LegacyExecution = {
    id: string;
    status?: string | null;
    run_progress?: number | null;
    run_id?: string | null;
    start_time?: string | null;
    end_time?: string | null;
    execution_engine?: string | null;
    modelcatalog_configuration_id?: string | null;
    parameter_bindings?: Array<{ model_parameter_id: string; parameter_value: string }>;
    data_bindings?: Array<{ model_io_id: string; resource?: { id: string; name: string } | null }>;
    results?: Array<{ model_io_id: string; resource?: { id: string; name: string } | null }>;
};

type ModelHistory = {
    id: string;
    modelId: string;
    modelName?: string | null;
    executions: LegacyExecution[];
};

export interface RunHistorySummary {
    run_key: string;
    source: "workflow" | "legacy_execution";
    run_kind: "workflow_pipeline" | "legacy_model_job";
    status: string;
    effective_started_at: string | null;
    started_at: string | null;
    ended_at: string | null;
    thread_id: string;
    model_id: string;
    model_name: string | null;
    execution_id: string | null;
    model_child_id: string | null;
    parent_execution_id: string | null;
    tapis_workflow?: {
        provider: "tapis-workflows";
        workflow_id: string | null;
        run_id: string | null;
        stage_count: number;
    } | null;
    plan_id: string | null;
    provenance_completeness: "complete" | "partial" | "unavailable" | "unknown";
    warnings: string[];
}

export interface RunHistoryDetail extends RunHistorySummary {
    schema_version: number;
    identity: {
        execution_engine: string | null;
        source_id: string;
        plan_hash: string | null;
        parameter_values_hash: string | null;
    };
    model: { id: string; name: string | null; configuration_id: string | null };
    inputs: Array<{ model_io_id: string; resource_id: string | null; name: string | null }>;
    parameters: Array<{
        parameter_id: string;
        requested_value: string | null;
        executed_value: unknown;
    }>;
    outputs: Array<{ model_io_id: string; resource_id: string | null; name: string | null }>;
    workflow: {
        adapter_steps: unknown[];
        adapter_runs: unknown[];
        tapis_workflow?: RunHistorySummary["tapis_workflow"];
        stages: UnifiedExecutionStep[];
        output_handoff: unknown;
        failure_code: string | null;
        events: Array<{
            type: string;
            availability: "available" | "not_recorded" | "unavailable";
            captured_at: string | null;
            data_object_id?: string | null;
        }>;
    } | null;
    artifacts: Array<{
        kind: "application_log" | "archived_files" | "workflow_logs";
        provider: "ensemble_manager" | "svo_adapter";
        source_id: string;
        endpoint: string | null;
        availability: "available" | "not_recorded" | "unknown";
    }>;
    errors: Array<{ code: string | null; message: string; source: string }>;
    status_history: Array<{ status: string; observed_at: string | null; source: string }>;
}

interface CanonicalRun {
    summary: RunHistorySummary;
    unified?: UnifiedExecutionRecord;
    legacy?: LegacyExecution;
    modelName: string | null;
    workflowSteps?: UnifiedExecutionStep[];
}

function encodeOpaque(value: string): string {
    return Buffer.from(value, "utf8")
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
}

function decodeOpaque(value: string): string | null {
    try {
        const padded = value.replace(/-/g, "+").replace(/_/g, "/");
        return Buffer.from(padded + "=".repeat((4 - (padded.length % 4)) % 4), "base64").toString(
            "utf8"
        );
    } catch {
        return null;
    }
}

function runKey(source: "workflow" | "legacy_execution", id: string): string {
    return encodeOpaque(source + ":" + id);
}

function effectiveTimestamp(
    unified?: UnifiedExecutionRecord,
    legacy?: LegacyExecution
): string | null {
    return unified?.created_at || legacy?.start_time || legacy?.end_time || null;
}

function timestampValue(value: string | null): number {
    if (!value) return 0;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
}

function statusFor(unified?: UnifiedExecutionRecord, legacy?: LegacyExecution): string {
    return String(unified?.status || legacy?.status || "unknown");
}

function warningsFor(unified?: UnifiedExecutionRecord, legacy?: LegacyExecution): string[] {
    const warnings: string[] = [];
    if (legacy && !unified) warnings.push("Legacy execution has no recorded workflow stages.");
    if (unified && !legacy && unified.model_child_id) {
        warnings.push("The workflow parent has no matching persisted model execution yet.");
    }
    if (unified?.error_message) warnings.push("The run contains a recorded execution error.");
    return warnings;
}

function completenessFor(
    unified?: UnifiedExecutionRecord,
    legacy?: LegacyExecution
): RunHistorySummary["provenance_completeness"] {
    if (!unified) return "partial";
    if (unified.model_child_id && !legacy) return "partial";
    return "complete";
}

function tapisWorkflowFor(
    unified?: UnifiedExecutionRecord
): RunHistorySummary["tapis_workflow"] {
    if (!unified) return null;
    const workflows = (unified.adapter_run_ids || [])
        .filter((child): child is Record<string, unknown> => Boolean(child && typeof child === "object"))
        .map((child) => ({
            workflow_id:
                typeof child.tapis_workflow_id === "string" ? child.tapis_workflow_id : null,
            run_id:
                typeof child.tapis_run_id === "string" ? child.tapis_run_id : null
        }))
        .filter((workflow) => workflow.workflow_id || workflow.run_id);
    const primary = workflows.length === 1 ? workflows[0] : null;
    return {
        provider: "tapis-workflows",
        workflow_id: primary?.workflow_id || null,
        run_id: primary?.run_id || null,
        stage_count: workflows.length
    };
}

function toSummary(
    threadId: string,
    model: ModelHistory,
    unified?: UnifiedExecutionRecord,
    legacy?: LegacyExecution
): RunHistorySummary {
    const started = unified?.created_at || legacy?.start_time || null;
    return {
        run_key: runKey(unified ? "workflow" : "legacy_execution", unified?.id || legacy!.id),
        source: unified ? "workflow" : "legacy_execution",
        run_kind: unified ? "workflow_pipeline" : "legacy_model_job",
        status: statusFor(unified, legacy),
        effective_started_at: effectiveTimestamp(unified, legacy),
        started_at: started,
        ended_at: legacy?.end_time || unified?.updated_at || null,
        thread_id: threadId,
        model_id: model.modelId,
        model_name: model.modelName || null,
        execution_id: legacy?.id || null,
        model_child_id: unified?.model_child_id || legacy?.run_id || null,
        parent_execution_id: unified ? "ue_" + unified.id : null,
        tapis_workflow: tapisWorkflowFor(unified),
        plan_id: unified?.plan_id || null,
        provenance_completeness: completenessFor(unified, legacy),
        warnings: warningsFor(unified, legacy)
    };
}

function sortRuns(runs: CanonicalRun[]): CanonicalRun[] {
    return runs.sort((a, b) => {
        const byDate =
            timestampValue(b.summary.effective_started_at) -
            timestampValue(a.summary.effective_started_at);
        return byDate || b.summary.run_key.localeCompare(a.summary.run_key);
    });
}

function parseLimit(value: unknown): number {
    if (value == null || value === "") return DEFAULT_LIMIT;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_LIMIT) {
        throw new BadRequestError("limit must be an integer between 1 and " + MAX_LIMIT);
    }
    return parsed;
}

function cursorValue(cursor: string | undefined): { timestamp: number; key: string } | null {
    if (!cursor) return null;
    const decoded = decodeOpaque(cursor);
    if (!decoded) throw new BadRequestError("cursor is invalid");
    const [timestamp, ...rest] = decoded.split(":");
    const numeric = Number(timestamp);
    if (!Number.isFinite(numeric) || rest.length === 0) {
        throw new BadRequestError("cursor is invalid");
    }
    return { timestamp: numeric, key: rest.join(":") };
}

function afterCursor(
    run: CanonicalRun,
    cursor: { timestamp: number; key: string } | null
): boolean {
    if (!cursor) return true;
    const timestamp = timestampValue(run.summary.effective_started_at);
    return (
        timestamp < cursor.timestamp ||
        (timestamp === cursor.timestamp && run.summary.run_key < cursor.key)
    );
}

function nextCursor(run: CanonicalRun | undefined): string | null {
    if (!run) return null;
    return encodeOpaque(
        timestampValue(run.summary.effective_started_at) + ":" + run.summary.run_key
    );
}

async function loadModels(
    threadId: string,
    token: string,
    modelId?: string
): Promise<ModelHistory[]> {
    const thread: any = await getThread(threadId, token);
    if (!thread) throw new NotFoundError("Subtask not found");
    const modelRows = (thread.thread_models || []).filter(
        (row: any) => !modelId || row.modelcatalog_configuration_id === modelId
    );
    return Promise.all(
        modelRows.map(async (row: any) => {
            const history = await getExecutionHistory(row.id, token, EXECUTION_FETCH_LIMIT);
            return {
                id: row.id,
                modelId: row.modelcatalog_configuration_id,
                modelName: row.modelcatalog_configuration?.label || null,
                executions: (history?.executions || [])
                    .map((entry: any) => entry.execution)
                    .filter(Boolean)
            } as ModelHistory;
        })
    );
}

async function assemble(
    threadId: string,
    authorization: string,
    modelId?: string
): Promise<CanonicalRun[]> {
    const token = getTokenFromAuthorizationHeader(authorization);
    const models = await loadModels(threadId, token, modelId);
    const legacyByRunId = new Map<string, { execution: LegacyExecution; model: ModelHistory }>();
    const legacyRuns: CanonicalRun[] = [];
    for (const model of models) {
        for (const execution of model.executions) {
            // Unified parents link to the durable legacy execution row by its
            // execution id. The provider run id is a separate identifier and
            // is only available after the downstream job is submitted.
            legacyByRunId.set(execution.id, { execution, model });
            if (execution.run_id) legacyByRunId.set(execution.run_id, { execution, model });
            legacyRuns.push({
                summary: toSummary(threadId, model, undefined, execution),
                legacy: execution,
                modelName: model.modelName || null
            });
        }
    }

    let unified: UnifiedExecutionRecord[] = [];
    const workflowSteps = new Map<string, UnifiedExecutionStep[]>();
    try {
        const store = createHasuraUnifiedExecutionStore();
        unified = store.listByThread ? await store.listByThread(threadId, modelId) : [];
        if (store.listSteps) {
            await Promise.all(
                unified.map(async (record) => {
                    workflowSteps.set(record.id, await store.listSteps!(record.id));
                })
            );
        }
    } catch {
        // Legacy history remains useful when the optional workflow store is unavailable.
        unified = [];
    }

    const linkedLegacy = new Set<string>();
    const workflowRuns = unified.map((record) => {
        const child = record.model_child_id ? legacyByRunId.get(record.model_child_id) : undefined;
        if (child) linkedLegacy.add(child.execution.id);
        const model = child?.model ||
            models.find((candidate) => candidate.modelId === record.model_id) || {
                id: record.model_id,
                modelId: record.model_id,
                modelName: null,
                executions: []
            };
        return {
            summary: toSummary(threadId, model, record, child?.execution),
            unified: record,
            legacy: child?.execution,
            modelName: model.modelName || null,
            workflowSteps: workflowSteps.get(record.id) || []
        } as CanonicalRun;
    });

    return sortRuns([
        ...workflowRuns,
        ...legacyRuns.filter((run) => !linkedLegacy.has(run.legacy!.id))
    ]);
}

function adapterRunId(value: unknown): string | null {
    if (typeof value === "string") return value;
    if (value && typeof value === "object") {
        const candidate = value as Record<string, unknown>;
        return typeof candidate.run_id === "string" ? candidate.run_id : null;
    }
    return null;
}

async function loadWorkflowEvents(
    run: CanonicalRun
): Promise<RunHistoryDetail["workflow"]["events"]> {
    const runIds = (run.unified?.adapter_run_ids || [])
        .map(adapterRunId)
        .filter(Boolean) as string[];
    if (!run.unified || runIds.length === 0) {
        return [
            {
                type: "workflow_provenance_events",
                availability: "not_recorded",
                captured_at: run.unified?.updated_at || run.unified?.created_at || null
            }
        ];
    }
    const config = getConfiguration() as {
        svo_adapter_api?: string;
    };
    const base = (config.svo_adapter_api || process.env.SVO_ADAPTER_API || "").replace(/\/$/, "");
    if (!base) {
        return [
            { type: "workflow_provenance_events", availability: "unavailable", captured_at: null }
        ];
    }
    const secret = adapterInternalSecret();
    const responses = await Promise.all(
        runIds.map(async (runId) => {
            try {
                const response = await fetch(
                    base + "/runs/" + encodeURIComponent(runId) + "/provenance",
                    {
                        headers: {
                            ...(secret ? { "X-Ensemble-Manager-Secret": secret } : {})
                        }
                    }
                );
                if (!response.ok) return [];
                const body = await response.json().catch(() => ({}));
                return (body.events || []).map((event: any) => ({
                    type: String(event.event_type || "unknown"),
                    availability: "available" as const,
                    captured_at: event.created_at || null,
                    data_object_id: event.data_object_id || null
                }));
            } catch {
                return [];
            }
        })
    );
    const events = responses.flat();
    return events.length
        ? events
        : [{ type: "workflow_provenance_events", availability: "unavailable", captured_at: null }];
}

async function detailsFor(run: CanonicalRun): Promise<RunHistoryDetail> {
    const legacy = run.legacy;
    const unified = run.unified;
    const inputs = (legacy?.data_bindings || []).map((binding) => ({
        model_io_id: binding.model_io_id,
        resource_id: binding.resource?.id || null,
        name: binding.resource?.name || null
    }));
    const outputs = (legacy?.results || []).map((result) => ({
        model_io_id: result.model_io_id,
        resource_id: result.resource?.id || null,
        name: result.resource?.name || null
    }));
    const parameters = (legacy?.parameter_bindings || []).map((binding) => ({
        parameter_id: binding.model_parameter_id,
        requested_value: binding.parameter_value ?? null,
        executed_value:
            unified?.parameter_values?.[binding.model_parameter_id] ?? binding.parameter_value
    }));
    if (unified) {
        for (const [parameterId, value] of Object.entries(unified.parameter_values || {})) {
            if (!parameters.some((parameter) => parameter.parameter_id === parameterId)) {
                parameters.push({
                    parameter_id: parameterId,
                    requested_value: null,
                    executed_value: value
                });
            }
        }
    }
    const sourceId = legacy?.id || unified?.id || run.summary.run_key;
    const artifacts: RunHistoryDetail["artifacts"] = legacy
        ? [
              {
                  kind: "application_log",
                  provider: "ensemble_manager",
                  source_id: legacy.id,
                  // The UI joins this path to ENSEMBLE_MANAGER_API, which
                  // already includes the /v1 prefix in local and deployed
                  // configurations.
                  endpoint: "/executions/" + encodeURIComponent(legacy.id) + "/logs",
                  availability: "available"
              },
              {
                  kind: "archived_files",
                  provider: "ensemble_manager",
                  source_id: legacy.id,
                  endpoint: "/executions/" + encodeURIComponent(legacy.id) + "/files",
                  availability: "available"
              }
          ]
        : [];
    if (unified) {
        artifacts.push({
            kind: "workflow_logs",
            provider: "svo_adapter",
            source_id: unified.id,
            endpoint: null,
            availability: "unknown"
        });
    }
    return {
        ...run.summary,
        schema_version: HISTORY_SCHEMA_VERSION,
        identity: {
            execution_engine: legacy?.execution_engine || unified?.execution_engine || null,
            source_id: sourceId,
            plan_hash: unified?.plan_hash || null,
            parameter_values_hash: unified?.parameter_values_hash || null
        },
        model: {
            id: run.summary.model_id,
            name: run.modelName,
            configuration_id: legacy?.modelcatalog_configuration_id || unified?.model_id || null
        },
        inputs,
        parameters,
        outputs,
        workflow: unified
            ? {
                  adapter_steps: unified.adapter_steps || [],
                  adapter_runs: unified.adapter_run_ids || [],
                  tapis_workflow: run.summary.tapis_workflow,
                  stages: run.workflowSteps || [],
                  output_handoff: unified.output_handoff || null,
                  failure_code: unified.failure_code || null,
                  events: await loadWorkflowEvents(run)
              }
            : null,
        artifacts,
        errors: unified?.error_message
            ? [
                  {
                      code: unified.failure_code || null,
                      message: unified.error_message,
                      source: "ensemble_manager"
                  }
              ]
            : [],
        status_history: [
            {
                status: run.summary.status,
                observed_at: run.summary.effective_started_at,
                source: run.summary.source
            }
        ]
    };
}

export interface RunHistoryService {
    list(
        threadId: string,
        authorization: string,
        options: { modelId?: string; limit?: unknown; cursor?: string }
    ): Promise<{ schema_version: number; runs: RunHistorySummary[]; next_cursor: string | null }>;
    detail(threadId: string, runKey: string, authorization: string): Promise<RunHistoryDetail>;
}

export function createRunHistoryService(): RunHistoryService {
    return {
        async list(threadId, authorization, options) {
            const limit = parseLimit(options.limit);
            const cursor = cursorValue(options.cursor);
            const runs = (await assemble(threadId, authorization, options.modelId)).filter((run) =>
                afterCursor(run, cursor)
            );
            const page = runs.slice(0, limit);
            return {
                schema_version: HISTORY_SCHEMA_VERSION,
                runs: page.map((run) => run.summary),
                next_cursor: runs.length > limit ? nextCursor(page[page.length - 1]) : null
            };
        },
        async detail(threadId, runKeyValue, authorization) {
            const runs = await assemble(threadId, authorization);
            const run = runs.find((candidate) => candidate.summary.run_key === runKeyValue);
            if (!run) throw new NotFoundError("Run not found");
            return await detailsFor(run);
        }
    };
}

export default createRunHistoryService();
