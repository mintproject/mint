import crypto from "crypto";
import { UnifiedExecutionError } from "@/classes/common/errors";
import { ModelSecretDeclaration, Region } from "@/classes/mint/mint-types";
import { getConfiguration } from "@/classes/mint/mint-functions";
import { deriveRegionSource, InputSource, RegionGeometryError } from "./inputStepDerivation";
import {
    createHasuraUnifiedExecutionStore,
    UnifiedExecutionRecord,
    UnifiedExecutionStore
} from "./unifiedExecutionStore";

export type UnifiedExecutor = "ensemble_manager" | "svo_adapter";

export interface UnifiedParameterDefinition {
    name: string;
    type?: string;
    required?: boolean;
    default?: unknown;
    description?: string;
    allowed_values?: unknown[];
    minimum?: number;
    maximum?: number;
    source_transform?: string;
    transform_spec_id?: string;
    managed?: boolean;
    managed_source?: string;
}

export { UnifiedExecutionError };

interface LegacyPlan {
    executor: "ensemble_manager";
    thread_id: string;
    model_id: string;
    execution_engine: string;
    adapter_steps?: AdapterStep[];
    post_model_adapter?: PostModelAdapter;
    // Input ETL is planned by the bridge (POST /plans/model-inputs). The plan
    // records only what submit needs to plan the same steps again: the region
    // the source was shaped from and the digest of the steps the user saw.
    // Geometry, steps, filled inputs and warnings are returned with the plan
    // but never encoded into it: plan_id is the encoded plan and a uniquely
    // indexed column, so it has to stay small (see MAX_PLAN_ID_LENGTH).
    input_region_id?: string;
    steps_digest?: string;
    // Catalog tokens the run asked its outputs to be published to. Tokens only;
    // the publish parameters travel with the submit, not the plan id.
    publish?: string[];
}

interface ConsideredInput {
    app_input_name?: string;
    standard_variable_uri?: string;
    optional?: boolean;
    outcome?: "planned" | "filled" | "fixed" | "unbound" | "no_path";
    blocking?: boolean;
}

interface InputPlanResult {
    steps: Record<string, unknown>[];
    outputs: { id: string; name: string; format?: string }[];
    sources: InputSource[];
    filledAppInputs: string[];
    stepsDigest?: string;
    regionId?: string;
    warnings: string[];
}

interface AdapterStep {
    adapter_plan_id: string;
    model_io_id: string;
    source_resource_id: string;
}

interface PostModelAdapter {
    adapter_plan_id: string;
    model_io_id: string;
    model_output_key: string;
    source_contract: Record<string, unknown>;
    target_contract: Record<string, unknown>;
    plan_hash: string;
    parameters: UnifiedParameterDefinition[];
}

interface AdapterChildRun {
    adapter_plan_id: string;
    model_io_id: string;
    source_resource_id?: string;
    run_id: string;
    status?: string;
    output_data_object_id?: string | null;
    execution_kind?: "workflow" | "composite_workflow";
    tapis_workflow_id?: string | null;
    tapis_run_id?: string | null;
    error_message?: string | null;
    // Adapter liveness verdict beside status: "ok" | "stalled" | "reported_failed".
    health?: string | null;
    model_job_id?: string | null;
    started_at?: string | null;
}

interface UnifiedWorkflowStage {
    stage_id: string;
    type: "adapter_input" | "model" | "output_handoff" | "adapter_output";
    depends_on: string[];
    status: string;
    provider: string;
    provider_ids: Record<string, string>;
    output_reference?: unknown;
    error_message?: string | null;
    health?: string | null;
}

// Parent failure codes derived from an adapter child's health, not its status.
const HEALTH_FAILURE_CODES: Record<string, string> = {
    stalled: "COMPOSITE_WORKFLOW_STALLED",
    reported_failed: "MODEL_FAILURE_REPORTED"
};

type AdapterLiveness = Pick<
    AdapterChildRun,
    "health" | "model_job_id" | "started_at" | "error_message"
>;

function healthFailureCode(children: Array<Pick<AdapterLiveness, "health">>): string | null {
    const unhealthy = children.find((child) => child.health && HEALTH_FAILURE_CODES[child.health]);
    return unhealthy?.health ? HEALTH_FAILURE_CODES[unhealthy.health] : null;
}

function stringOrNull(value: unknown): string | null {
    return typeof value === "string" && value ? value : null;
}

// Copy the adapter run's liveness fields onto the stored child record.
function copyAdapterLiveness(
    child: AdapterLiveness,
    run: { health?: unknown; model_job_uuid?: unknown; started_at?: unknown }
) {
    child.health = stringOrNull(run.health);
    child.model_job_id = stringOrNull(run.model_job_uuid);
    child.started_at = stringOrNull(run.started_at);
}

interface TapisWorkflowTracking {
    provider: "tapis-workflows";
    workflow_id: string | null;
    run_id: string | null;
    stage_count: number;
}

interface AdapterPlanResponse {
    status?: string;
    plan_id?: string;
    plan_json?: {
        parameters?: UnifiedParameterDefinition[];
        steps?: unknown[];
        [key: string]: unknown;
    };
    plan_hash?: string;
    message?: string;
}

function adapterBaseUrl(): string {
    const prefs = getConfiguration() as { svo_adapter_api?: string };
    return (prefs.svo_adapter_api || process.env.SVO_ADAPTER_API || "").replace(/\/$/, "");
}

function adapterInternalSecret(): string {
    const prefs = getConfiguration() as {
        svo_adapter_internal_secret?: string;
        graphql?: { secret?: string };
    };
    return (
        process.env.SVO_ADAPTER_INTERNAL_SERVICE_SECRET ||
        prefs.svo_adapter_internal_secret ||
        prefs.graphql?.secret ||
        ""
    );
}

function unifiedPlanSecret(): string {
    const prefs = getConfiguration() as {
        unified_plan_secret?: string;
    };
    const secret = process.env.UNIFIED_PLAN_SECRET || prefs.unified_plan_secret || "";
    if (!secret) {
        throw new UnifiedExecutionError(
            503,
            "unified plan signing is not configured",
            "UNIFIED_PLAN_UNAVAILABLE"
        );
    }
    return secret;
}

// Postgres refuses btree index rows above 2704 bytes and plan_id is unique
// indexed in unified_execution; stay well below so a plan never fails at the
// store with an opaque database error.
const MAX_PLAN_ID_LENGTH = 2400;

function encodePlan(value: LegacyPlan): string {
    const encoded = Buffer.from(JSON.stringify(value), "utf8")
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
    const signature = crypto
        .createHmac("sha256", unifiedPlanSecret())
        .update(encoded)
        .digest("hex");
    const planId = `em_${encoded}.${signature}`;
    if (planId.length > MAX_PLAN_ID_LENGTH) {
        throw new UnifiedExecutionError(
            500,
            `plan id of ${planId.length} characters exceeds the ${MAX_PLAN_ID_LENGTH} the store indexes`,
            "PLAN_TOO_LARGE"
        );
    }
    return planId;
}

function decodePlan(planId: string): LegacyPlan {
    if (!planId.startsWith("em_")) {
        throw new UnifiedExecutionError(404, "execution plan not found", "PLAN_NOT_FOUND");
    }
    try {
        const [encoded, signature] = planId.slice(3).split(".");
        if (!encoded || !signature) throw new Error("unsigned legacy plan");
        const expected = crypto
            .createHmac("sha256", unifiedPlanSecret())
            .update(encoded)
            .digest("hex");
        if (
            signature.length !== expected.length ||
            !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
        ) {
            throw new Error("invalid legacy plan signature");
        }
        const padded = encoded.replace(/-/g, "+").replace(/_/g, "/");
        const value = JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
        if (
            value?.executor !== "ensemble_manager" ||
            typeof value.thread_id !== "string" ||
            typeof value.model_id !== "string"
        ) {
            throw new Error("invalid legacy plan");
        }
        return value as LegacyPlan;
    } catch {
        throw new UnifiedExecutionError(404, "execution plan not found", "PLAN_NOT_FOUND");
    }
}

async function adapterRequest(
    path: string,
    init: { method?: string; body?: unknown; idempotencyKey?: string },
    authorization?: string
): Promise<any> {
    const base = adapterBaseUrl();
    if (!base) {
        throw new UnifiedExecutionError(
            503,
            "SVO adapter is not configured",
            "SVO_ADAPTER_UNAVAILABLE"
        );
    }
    const internalSecret = adapterInternalSecret();
    const response = await fetch(`${base}${path}`, {
        method: init.method || "GET",
        headers: {
            "Content-Type": "application/json",
            ...(init.idempotencyKey ? { "Idempotency-Key": init.idempotencyKey } : {}),
            ...(internalSecret ? { "X-Ensemble-Manager-Secret": internalSecret } : {}),
            ...(authorization ? { Authorization: authorization } : {})
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) })
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
        const detail = body?.detail;
        const detailMessage =
            detail && typeof detail === "object" && typeof detail.message === "string"
                ? detail.message
                : undefined;
        const message =
            typeof detail === "string"
                ? detail
                : detailMessage || body?.message || `SVO adapter returned ${response.status}`;
        const code = typeof detail === "object" ? detail?.code : body?.code;
        const details = detail && typeof detail === "object" ? detail : (body?.details ?? detail);
        throw new UnifiedExecutionError(response.status, message, code, details);
    }
    return body;
}

// Adapter responses with a structured `detail.code` (including 5xx such as
// SIGNALS_REQUIRED / SECRETS_NOT_CONFIGURED / SECRET_UNREADABLE) are
// deterministic refusals the client must see, not unknown submissions.
function hasStructuredAdapterCode(error: UnifiedExecutionError): boolean {
    const details = error.details as { code?: unknown } | undefined;
    return (
        typeof error.code === "string" &&
        !!details &&
        typeof details === "object" &&
        typeof details.code === "string"
    );
}

function isRetryableAdapterAuthFailure(record: UnifiedExecutionRecord): boolean {
    if (!["adapter_unknown", "unknown"].includes(record.status)) return false;
    const message = String(record.error_message || "").toLowerCase();
    return (
        message.includes("tapis token") ||
        message.includes("authorization") ||
        message.includes("unauthorized")
    );
}

function adapterPlanId(planId: string): string {
    return planId.startsWith("svo_") ? planId.slice(4) : planId;
}

// What the adapter reports about a run's output publication, reduced to the
// fields the unified execution keeps in output_handoff.publication.
function publicationOf(run: Record<string, any> | null | undefined) {
    const publication = run?.publication;
    if (!publication || typeof publication !== "object") return undefined;
    if (publication.status === "published") {
        return {
            status: "published",
            ckan_dataset: publication.ckan_dataset,
            stac_item: publication.stac_item,
            public: publication.public,
            catalog: publication.catalog
        };
    }
    if (publication.status === "failed") {
        return { status: "failed", error: publication.error };
    }
    return undefined;
}

function isRunOwnerMismatch(error: unknown): boolean {
    return (
        error instanceof UnifiedExecutionError &&
        error.statusCode === 403 &&
        error.code === "RUN_OWNER_MISMATCH"
    );
}

function planHash(plan: LegacyPlan): string {
    return crypto.createHash("sha256").update(JSON.stringify(plan)).digest("hex");
}

function parameterValuesHash(values: Record<string, unknown>): string {
    return crypto
        .createHash("sha256")
        .update(JSON.stringify(values, Object.keys(values).sort()))
        .digest("hex");
}

function adapterParameterValues(
    plan: LegacyPlan,
    body: any
): { values: Record<string, unknown>; hash: string } {
    const adapter = plan.post_model_adapter;
    const values: Record<string, unknown> = adapter
        ? {
              ...(body.parameter_values || {}),
              ...(body.adapter_parameter_values?.[adapter.adapter_plan_id] || {})
          }
        : {};
    const missing = (adapter?.parameters || [])
        .filter(
            (parameter) =>
                parameter.required && !parameter.managed && parameter.default === undefined
        )
        .filter(
            (parameter) => values[parameter.name] === undefined || values[parameter.name] === ""
        )
        .map((parameter) => ({
            step: adapter?.adapter_plan_id,
            name: parameter.name,
            reason: "required"
        }));
    if (missing.length) {
        throw new UnifiedExecutionError(
            422,
            "required adapter parameters are missing",
            "PARAMETER_VALIDATION_FAILED",
            { fields: missing }
        );
    }
    const notAllowed = (adapter?.parameters || [])
        .filter(
            (parameter) =>
                Array.isArray(parameter.allowed_values) &&
                parameter.allowed_values.length > 0 &&
                values[parameter.name] !== undefined &&
                values[parameter.name] !== "" &&
                !parameter.allowed_values.includes(values[parameter.name])
        )
        .map((parameter) => ({
            step: adapter?.adapter_plan_id,
            name: parameter.name,
            reason: "not_allowed",
            allowed: parameter.allowed_values
        }));
    if (notAllowed.length) {
        throw new UnifiedExecutionError(
            422,
            "adapter parameter values are not allowed",
            "PARAMETER_VALIDATION_FAILED",
            { fields: notAllowed }
        );
    }
    const withDefaults = { ...values };
    for (const parameter of adapter?.parameters || []) {
        if (withDefaults[parameter.name] === undefined && parameter.default !== undefined) {
            withDefaults[parameter.name] = parameter.default;
        }
    }
    return { values: withDefaults, hash: parameterValuesHash(withDefaults) };
}

export function parentRunId(id: string): string {
    return `ue_${id}`;
}

const DEFAULT_MAX_MINUTES = 60;

function parseMaxMinutes(value: unknown): number {
    if (value === undefined || value === null || value === "") return DEFAULT_MAX_MINUTES;
    if ((typeof value !== "number" && typeof value !== "string") || !/^\d+$/.test(String(value))) {
        throw new UnifiedExecutionError(
            422,
            "max_minutes must be a positive integer",
            "INVALID_MAX_MINUTES"
        );
    }
    const minutes = Number(value);
    if (!Number.isSafeInteger(minutes) || minutes < 1) {
        throw new UnifiedExecutionError(
            422,
            "max_minutes must be a positive integer",
            "INVALID_MAX_MINUTES"
        );
    }
    return minutes;
}

// Tapis logical queue names are short slugs (e.g. "development", "vm-small").
// Tapis itself rejects a queue the execution system does not define.
function parseQueue(value: unknown): string | undefined {
    if (value === undefined || value === null || value === "") return undefined;
    if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(value)) {
        throw new UnifiedExecutionError(422, "queue must be a queue name", "INVALID_QUEUE");
    }
    return value;
}

function storedQueue(record: UnifiedExecutionRecord): string | undefined {
    const value = (record.model_result as { __queue?: unknown } | null)?.__queue;
    return value === undefined ? undefined : parseQueue(value);
}

function jobOptionsResult(maxMinutes?: number, queue?: string) {
    return maxMinutes === undefined && queue === undefined
        ? {}
        : {
              model_result: {
                  ...(maxMinutes === undefined ? {} : { __max_minutes: maxMinutes }),
                  ...(queue === undefined ? {} : { __queue: queue })
              }
          };
}

function storedMaxMinutes(record: UnifiedExecutionRecord): number | undefined {
    const value = (record.model_result as { __max_minutes?: unknown } | null)?.__max_minutes;
    return value === undefined ? undefined : parseMaxMinutes(value);
}

function modelStageStatus(record: UnifiedExecutionRecord, plan: LegacyPlan): string {
    if (record.failure_code && record.status === "failed") return "failed";
    if (record.model_child_id) {
        return [
            "model_succeeded",
            "output_registering",
            "output_verified",
            "adapter_dispatching",
            "adapter_running",
            "completed"
        ].includes(record.status)
            ? "succeeded"
            : "running";
    }
    return plan.adapter_steps?.length && record.status.startsWith("adapter_")
        ? "queued"
        : record.status === "model_dispatching"
          ? "submitting"
          : "planned";
}

function workflowStages(record: UnifiedExecutionRecord, plan: LegacyPlan): UnifiedWorkflowStage[] {
    const stages: UnifiedWorkflowStage[] = [];
    const adapterChildren = (record.adapter_run_ids || []) as Array<Record<string, any>>;
    const adapterStageType = plan.post_model_adapter ? "adapter_output" : "adapter_input";

    adapterChildren.forEach((child, index) => {
        const stageId = `${adapterStageType.replace("_", "-")}-${index + 1}`;
        stages.push({
            stage_id: stageId,
            type: adapterStageType,
            depends_on: plan.post_model_adapter ? ["output_handoff"] : [],
            status: String(child.status || "planned"),
            provider: "svo_adapter",
            provider_ids: {
                ...(child.run_id ? { run_id: String(child.run_id) } : {}),
                ...(child.tapis_workflow_id
                    ? { tapis_workflow_id: String(child.tapis_workflow_id) }
                    : {}),
                ...(child.tapis_run_id ? { tapis_run_id: String(child.tapis_run_id) } : {})
            },
            output_reference: child.output_data_object_id
                ? { data_object_id: child.output_data_object_id }
                : undefined,
            error_message: child.error_message || null,
            health: child.health || null
        });
    });

    if (plan.adapter_steps?.length && !plan.post_model_adapter) {
        plan.adapter_steps.forEach((step, index) => {
            if (stages[index]) return;
            stages.push({
                stage_id: `adapter-input-${index + 1}`,
                type: "adapter_input",
                depends_on: [],
                status: "planned",
                provider: "svo_adapter",
                provider_ids: { adapter_plan_id: step.adapter_plan_id }
            });
        });
    }

    const modelStage: UnifiedWorkflowStage = {
        stage_id: "model",
        type: "model",
        depends_on: plan.adapter_steps?.length
            ? stages
                  .filter((stage) => stage.type === "adapter_input")
                  .map((stage) => stage.stage_id)
            : [],
        status: modelStageStatus(record, plan),
        provider: record.execution_engine,
        provider_ids: record.model_child_id
            ? {
                  model_child_id: record.model_child_id,
                  ...(modelProviderJobId(record.model_result)
                      ? { tapis_job_id: modelProviderJobId(record.model_result)! }
                      : {}),
                  ...(typeof (record.model_result as any)?.tapis_workflow_id === "string"
                      ? { tapis_workflow_id: (record.model_result as any).tapis_workflow_id }
                      : {}),
                  ...(typeof (record.model_result as any)?.tapis_run_id === "string"
                      ? { tapis_run_id: (record.model_result as any).tapis_run_id }
                      : {})
              }
            : {}
    };
    stages.push(modelStage);

    if (plan.post_model_adapter) {
        const handoffStatus = record.output_handoff
            ? "succeeded"
            : record.status === "completed"
              ? "succeeded"
              : ["output_registering", "output_verifying", "adapter_dispatching"].includes(
                      record.status
                  )
                ? "running"
                : "planned";
        stages.push({
            stage_id: "output-handoff",
            type: "output_handoff",
            depends_on: ["model"],
            status: handoffStatus,
            provider: "ensemble_manager",
            provider_ids: record.model_output_id ? { model_output_id: record.model_output_id } : {},
            output_reference: record.output_handoff || undefined
        });
        if (!adapterChildren.length) {
            stages.push({
                stage_id: "adapter-output-1",
                type: "adapter_output",
                depends_on: ["output-handoff"],
                status: "planned",
                provider: "svo_adapter",
                provider_ids: { adapter_plan_id: plan.post_model_adapter.adapter_plan_id }
            });
        }
    }
    return stages;
}

function tapisWorkflowTracking(record: UnifiedExecutionRecord): TapisWorkflowTracking {
    const workflows = ((record.adapter_run_ids || []) as Array<Record<string, unknown>>)
        .map((child) => ({
            workflow_id:
                typeof child.tapis_workflow_id === "string" ? child.tapis_workflow_id : null,
            run_id: typeof child.tapis_run_id === "string" ? child.tapis_run_id : null
        }))
        .filter((workflow) => workflow.workflow_id || workflow.run_id);

    // A single adapter workflow is the common case and can be promoted to the
    // parent tracking reference. Multiple adapter stages remain visible in
    // workflow_stages/adapter_runs; do not pretend they are one provider run.
    const primary = workflows.length === 1 ? workflows[0] : null;
    return {
        provider: "tapis-workflows",
        workflow_id: primary?.workflow_id || null,
        run_id: primary?.run_id || null,
        stage_count: workflows.length
    };
}

function parentResponse(record: UnifiedExecutionRecord) {
    const plan = decodePlan(record.plan_id);
    const hasWorkflowStage = Boolean(plan.post_model_adapter || record.adapter_steps?.length);
    const adapterStage = plan.post_model_adapter
        ? "post_model"
        : record.adapter_steps?.length
          ? "pre_model"
          : "none";
    const modelJobId = modelProviderJobId(record.model_result) || record.model_child_id || null;
    return {
        run_id: parentRunId(record.id),
        parent_execution_id: parentRunId(record.id),
        executor: "ensemble_manager",
        execution_mode: hasWorkflowStage ? "workflow_pipeline" : "job",
        adapter_stage: adapterStage,
        tapis_workflow: tapisWorkflowTracking(record),
        workflow_stages: workflowStages(record, plan),
        status: record.status,
        plan_id: record.plan_id,
        adapter_runs: record.adapter_run_ids,
        model_child_id: record.model_child_id || null,
        model_job_id: modelJobId,
        model_output_id: record.model_output_id || null,
        output_handoff: record.output_handoff || null,
        failure_code: record.failure_code || null,
        model_result: record.model_result || null,
        error_message: record.error_message || null
    };
}

function legacyModelExecutionId(result: any): string | null {
    const submitted = Array.isArray(result?.submittedExecutions) ? result.submittedExecutions : [];
    const first = submitted[0];
    if (typeof first === "string") return first;
    if (!first || typeof first !== "object") return null;
    const execution = first.execution;
    if (typeof execution?.id === "string") return execution.id;
    for (const key of ["id", "executionId", "jobId", "job_id"]) {
        if (typeof first[key] === "string") return first[key];
    }
    return null;
}

function modelProviderJobId(result: any): string | null {
    if (typeof result?.provider_job_id === "string") return result.provider_job_id;
    const submitted = Array.isArray(result?.submittedExecutions) ? result.submittedExecutions : [];
    const first = submitted[0];
    if (!first || typeof first !== "object") return null;
    for (const key of ["jobId", "job_id", "tapisJobId", "tapis_job_id"]) {
        if (typeof first[key] === "string") return first[key];
    }
    if (typeof first.execution?.runid === "string") return first.execution.runid;
    return null;
}

export function createUnifiedExecutionService(
    legacyServices: {
        local: { submitExecution(body: any): Promise<any> };
        wings: { submitExecution(body: any): Promise<any> };
        tapis: {
            submitExecution(body: any, authorization: string): Promise<any>;
            buildCompositeWorkflowModelTask?(
                body: any,
                workflowPath: string,
                authorization: string
            ): Promise<{
                execution_id: string;
                configuration_id: string;
                required_secrets: Pick<ModelSecretDeclaration, "name" | "env" | "source">[];
                output_uri: string;
                output_name: string;
                output_format?: string;
                job_definition: unknown;
            }>;
            compositeModelContext?(
                threadmodel: { thread_id: string; model_id: string },
                authorization: string
            ): Promise<{
                configuration_id: string;
                region: Region | null;
                has_bound_inputs: boolean;
                filled_app_inputs: string[];
                outputs: { id: string; name: string; format?: string }[];
                unmatched_optional_inputs: string[];
            }>;
            resolveCompositeWorkflowOutput?: (
                executionId: string,
                archivePath: string,
                outputName: string,
                authorization: string
            ) => Promise<string | null>;
            getExecution?: (executionId: string, authorization: string) => Promise<any>;
            getJobStatus?: (jobId: string, authorization: string) => Promise<any>;
            updateCompositeWorkflowExecution?: (
                threadId: string,
                modelId: string,
                executionId: string,
                status: "completed" | "failed",
                output?: {
                    model_io_id: string;
                    resource_id: string;
                    name: string;
                    url: string;
                }
            ) => Promise<void>;
        };
    },
    dependencies: { store?: UnifiedExecutionStore } = {}
) {
    const store = dependencies.store || createHasuraUnifiedExecutionStore();

    const persistWorkflowStages = async (record: UnifiedExecutionRecord) => {
        if (!store.upsertStep) return;
        const plan = decodePlan(record.plan_id);
        await Promise.all(
            workflowStages(record, plan).map((stage) => {
                const externalId = Object.values(stage.provider_ids)[0] || null;
                return store.upsertStep!({
                    execution_id: record.id,
                    step_key: stage.stage_id,
                    stage: stage.type,
                    external_id: externalId,
                    idempotency_key: `${parentRunId(record.id)}:${stage.stage_id}:${
                        record.parameter_values_hash || record.plan_hash
                    }`,
                    plan_hash: record.plan_hash,
                    parameter_values_hash: record.parameter_values_hash || null,
                    status: stage.status,
                    attempt: ["planned", "queued"].includes(stage.status) ? 0 : 1,
                    output_reference: stage.output_reference || null,
                    error_message: stage.error_message || null
                });
            })
        );
    };

    const submitLegacy = async (
        plan: LegacyPlan,
        authorization: string | undefined,
        adapterResourceOverrides?: unknown[],
        maxMinutes?: number,
        queue?: string
    ) => {
        const request = {
            thread_id: plan.thread_id,
            model_id: plan.model_id,
            ...(maxMinutes === undefined ? {} : { max_minutes: maxMinutes }),
            ...(queue === undefined ? {} : { queue }),
            ...(adapterResourceOverrides?.length
                ? { adapter_resource_overrides: adapterResourceOverrides }
                : {})
        };
        if (plan.execution_engine === "tapis") {
            try {
                return await legacyServices.tapis.submitExecution(request, authorization || "");
            } catch (error) {
                const structuredError = error as {
                    code?: string;
                    message?: unknown;
                    details?: unknown;
                };
                if (structuredError?.code === "COMPONENT_CONTRACT_MISMATCH") {
                    const message =
                        typeof structuredError.message === "string"
                            ? structuredError.message
                            : JSON.stringify(structuredError.message ?? structuredError);
                    throw new UnifiedExecutionError(
                        422,
                        message,
                        "COMPONENT_CONTRACT_MISMATCH",
                        structuredError.details
                    );
                }
                throw error;
            }
        }
        if (plan.execution_engine === "wings") {
            return legacyServices.wings.submitExecution(request);
        }
        return legacyServices.local.submitExecution(request);
    };

    const reconcilePostModel = async (
        record: UnifiedExecutionRecord,
        authorization?: string
    ): Promise<Record<string, unknown>> => {
        const plan = decodePlan(record.plan_id);
        const adapter = plan.post_model_adapter;
        const compositeOutput = (modelResult: Record<string, unknown> | null | undefined) => {
            // The handoff URI is the registered model output; it covers runs
            // whose model result carries no composite output_uri.
            // Only for runs that ended in a publication outcome; other runs keep
            // the model result as the only source.
            const outputUri =
                modelResult?.output_uri ??
                (existingHandoff.publication?.status === "published" ||
                existingHandoff.publication?.status === "failed"
                    ? existingHandoff.resource_uri
                    : undefined);
            if (!adapter || typeof outputUri !== "string") return undefined;
            return {
                model_io_id: adapter.model_io_id,
                resource_id: outputUri,
                name: adapter.model_output_key,
                url: outputUri
            };
        };
        const retryableCompositeStatus =
            record.status === "unknown" &&
            record.failure_code === "COMPOSITE_WORKFLOW_STATUS_UNKNOWN";
        const retryableAdapterAuthFailure = isRetryableAdapterAuthFailure(record);
        const modelResult = (record.model_result || {}) as Record<string, any>;
        const compositeWorkflowRunId =
            modelResult.composite_workflow_run_id || modelResult.tapis_run_id;
        const existingHandoff = (record.output_handoff || {}) as Record<string, any>;
        const finalUriLooksLikeModelUri =
            typeof existingHandoff.final_resource_uri === "string" &&
            typeof existingHandoff.resource_uri === "string" &&
            (existingHandoff.final_resource_uri === existingHandoff.resource_uri ||
                existingHandoff.resource_uri.startsWith(existingHandoff.final_resource_uri) ||
                existingHandoff.final_resource_uri.startsWith(existingHandoff.resource_uri));
        const existingChildren = (record.adapter_run_ids || []) as Array<Record<string, any>>;
        const stalePostModelChild = existingChildren.find(
            (child) =>
                child.execution_kind === "workflow" &&
                child.stage === "post_model" &&
                // A publication outcome (published or failed) belongs to a completed
                // run, not a stale child: never resubmit it (and never under
                // another identity).
                !child.publication &&
                ((compositeWorkflowRunId && child.tapis_run_id === compositeWorkflowRunId) ||
                    finalUriLooksLikeModelUri ||
                    (record.status === "failed" && child.status === "failed"))
        );
        const retryableAdapterSubmission =
            record.status === "failed" &&
            record.failure_code === "ADAPTER_SUBMISSION_FAILED" &&
            Boolean(record.model_child_id && record.output_handoff);
        const hasPendingPostModelHandoff = Boolean(
            adapter &&
            (record.status === "completed" || record.status === "failed" || stalePostModelChild) &&
            record.model_child_id &&
            (retryableAdapterSubmission ||
                (!record.output_handoff &&
                    existingChildren.some(
                        (child) => child.execution_kind === "composite_workflow"
                    )) ||
                stalePostModelChild)
        );
        if (
            legacyServices.tapis.updateCompositeWorkflowExecution &&
            record.model_child_id &&
            (record.status === "completed" || record.status === "failed")
        ) {
            try {
                await legacyServices.tapis.updateCompositeWorkflowExecution(
                    plan.thread_id,
                    plan.model_id,
                    record.model_child_id,
                    record.status,
                    record.status === "completed"
                        ? compositeOutput(record.model_result as Record<string, unknown> | null)
                        : undefined
                );
            } catch (error) {
                const updated = await store.update(record.id, {
                    status: "unknown",
                    failure_code: "LEGACY_EXECUTION_FINALIZATION_FAILED",
                    error_message: error instanceof Error ? error.message : String(error)
                });
                return parentResponse(updated || { ...record, status: "unknown" });
            }
        }
        if (
            ["completed", "failed", "cancelled"].includes(record.status) ||
            (record.status === "unknown" &&
                !retryableCompositeStatus &&
                !retryableAdapterAuthFailure)
        ) {
            if (!hasPendingPostModelHandoff) return parentResponse(record);
        }
        if (!adapter) return parentResponse(record);
        let adapterChildren = (record.adapter_run_ids || []) as Array<Record<string, any>>;
        const postModelAttemptSuffix =
            stalePostModelChild?.status === "failed" ? `:retry-${stalePostModelChild.run_id}` : "";
        if (stalePostModelChild) {
            // A prior version reused the composite workflow idempotency key
            // for the deferred stage. Treat that child as the completed model
            // stage and submit a fresh output workflow below.
            adapterChildren = adapterChildren.filter((child) => child !== stalePostModelChild);
            const previousHandoff = (record.output_handoff || {}) as Record<string, any>;
            const {
                final_output_data_object_id: _discardedOutputId,
                final_resource_uri: _discardedResourceUri,
                ...modelHandoff
            } = previousHandoff;
            const updated = await store.update(record.id, {
                status: "model_succeeded",
                adapter_run_ids: adapterChildren,
                output_handoff: modelHandoff,
                error_message: null,
                failure_code: null
            });
            record = updated || {
                ...record,
                status: "model_succeeded",
                adapter_run_ids: adapterChildren,
                output_handoff: modelHandoff,
                error_message: null,
                failure_code: null
            };
        }
        const compositeChild = adapterChildren.find(
            (child) => child.execution_kind === "composite_workflow"
        );
        if (compositeChild) {
            try {
                const polled = await adapterRequest(
                    `/runs/${encodeURIComponent(compositeChild.run_id)}/poll`,
                    { method: "POST" },
                    authorization
                );
                const persisted = await adapterRequest(
                    `/runs/${encodeURIComponent(compositeChild.run_id)}`,
                    {},
                    authorization
                );
                const run = { ...(polled || {}), ...(persisted || {}) } as Record<string, any>;
                if (!run.output_uri && polled?.output_uri) run.output_uri = polled.output_uri;
                compositeChild.status = run.status;
                compositeChild.tapis_workflow_id =
                    run.tapis_workflow_id || compositeChild.tapis_workflow_id || null;
                compositeChild.tapis_run_id =
                    run.tapis_run_id || compositeChild.tapis_run_id || null;
                copyAdapterLiveness(compositeChild, run);
                const nextModelResult = {
                    ...((record.model_result as Record<string, unknown>) || {}),
                    composite_workflow_run: run
                };
                if (
                    legacyServices.tapis.updateCompositeWorkflowExecution &&
                    record.model_child_id &&
                    (run.status === "completed" || run.status === "failed")
                ) {
                    await legacyServices.tapis.updateCompositeWorkflowExecution(
                        plan.thread_id,
                        plan.model_id,
                        record.model_child_id,
                        run.status,
                        undefined
                    );
                }
                if (run.status === "completed" && adapter) {
                    if (!run.output_uri) {
                        const updated = await store.update(record.id, {
                            status: "output_verifying",
                            adapter_run_ids: adapterChildren,
                            model_result: nextModelResult,
                            error_message:
                                "Composite workflow completed without a discoverable final output URI"
                        });
                        return parentResponse(updated || { ...record, status: "output_verifying" });
                    }
                    const registered = await adapterRequest(
                        `/runs/${encodeURIComponent(compositeChild.run_id)}/register-output`,
                        {
                            method: "POST",
                            body: {
                                output_data_object: {
                                    id: `em-final-output-${record.id}`,
                                    label:
                                        adapter.target_contract?.standard_variable_uri ||
                                        adapter.model_output_key,
                                    resource_uri: run.output_uri,
                                    source_catalog: "svo-adapter",
                                    owner_execution_id: parentRunId(record.id),
                                    owner_model_child_id: record.model_child_id,
                                    variables: [
                                        {
                                            standard_variable_uri:
                                                adapter.target_contract?.standard_variable_uri,
                                            unit: adapter.target_contract?.unit
                                        }
                                    ]
                                }
                            }
                        },
                        authorization
                    );
                    compositeChild.status = "completed";
                    compositeChild.output_data_object_id =
                        registered.output_data_object_id || registered.data_object_id || null;
                    const updated = await store.update(record.id, {
                        status: "completed",
                        adapter_run_ids: adapterChildren,
                        model_result: nextModelResult,
                        output_handoff: {
                            ...((record.output_handoff as Record<string, unknown> | null) || {}),
                            final_output_data_object_id: compositeChild.output_data_object_id,
                            final_resource_uri: run.output_uri,
                            ...(run.result && typeof run.result === "object"
                                ? { result: run.result }
                                : {})
                        },
                        error_message: null,
                        failure_code: null
                    });
                    record = updated || {
                        ...record,
                        status: "completed",
                        adapter_run_ids: adapterChildren,
                        model_result: nextModelResult,
                        output_handoff: {
                            final_output_data_object_id: compositeChild.output_data_object_id,
                            final_resource_uri: run.output_uri
                        },
                        error_message: null,
                        failure_code: null
                    };
                    return parentResponse(record);
                } else {
                    const nextStatus = run.status === "failed" ? "failed" : "model_running";
                    // A stalled or self-reported failure keeps the lifecycle status
                    // but is surfaced through the failure code so the UI can act.
                    const failureCode =
                        run.status === "failed"
                            ? "COMPOSITE_WORKFLOW_FAILED"
                            : healthFailureCode([compositeChild]);
                    const updated = await store.update(record.id, {
                        status: nextStatus,
                        adapter_run_ids: adapterChildren,
                        model_result: nextModelResult,
                        error_message: run.error_message || null,
                        failure_code: failureCode
                    });
                    return parentResponse(updated || { ...record, status: nextStatus });
                }
            } catch (error) {
                const updated = await store.update(record.id, {
                    status: "unknown",
                    failure_code: "COMPOSITE_WORKFLOW_STATUS_UNKNOWN",
                    error_message: error instanceof Error ? error.message : String(error)
                });
                return parentResponse(updated || { ...record, status: "unknown" });
            }
        }
        if (adapterChildren.length) {
            const child = adapterChildren[0];
            try {
                const polled = await adapterRequest(
                    `/runs/${encodeURIComponent(child.run_id)}/poll`,
                    { method: "POST" },
                    authorization
                );
                const persisted = await adapterRequest(
                    `/runs/${encodeURIComponent(child.run_id)}`,
                    {},
                    authorization
                );
                const run = { ...(polled || {}), ...(persisted || {}) } as Record<string, any>;
                if (!run.output_uri && polled?.output_uri) run.output_uri = polled.output_uri;
                // A null persisted publication must not hide the polled one.
                if (!run.publication && polled?.publication) run.publication = polled.publication;
                child.status = run.status;
                child.output_data_object_id = run.output_data_object_id || null;
                child.error_message = run.error_message || null;
                child.tapis_workflow_id = run.tapis_workflow_id || child.tapis_workflow_id || null;
                child.tapis_run_id = run.tapis_run_id || child.tapis_run_id || null;
                const publication = publicationOf(run);
                if (publication) child.publication = publication;
                if (child.stage === "post_model" && publication) {
                    // Publication is an outcome of a completed run. The model
                    // output registered at handoff stays the run's output: the
                    // publish child's own output_uri (a STAC item URL) is never
                    // registered or mirrored, and nothing waits on it. The child
                    // is never resubmitted (see the stale-child predicate).
                    const outcomeHandoff = {
                        ...((record.output_handoff as Record<string, unknown> | null) || {}),
                        publication
                    };
                    const modelOutputUri = (outcomeHandoff as Record<string, any>).resource_uri;
                    if (
                        legacyServices.tapis.updateCompositeWorkflowExecution &&
                        record.model_child_id
                    ) {
                        await legacyServices.tapis.updateCompositeWorkflowExecution(
                            plan.thread_id,
                            plan.model_id,
                            record.model_child_id,
                            "completed",
                            compositeOutput(
                                record.model_result as Record<string, unknown> | null
                            ) ||
                                (typeof modelOutputUri === "string"
                                    ? {
                                          model_io_id: adapter.model_io_id,
                                          resource_id: modelOutputUri,
                                          name: adapter.model_output_key,
                                          url: modelOutputUri
                                      }
                                    : undefined)
                        );
                    }
                    const publicationOutcome = await store.update(record.id, {
                        status: "completed",
                        adapter_run_ids: adapterChildren,
                        output_handoff: outcomeHandoff,
                        error_message: null,
                        failure_code: null
                    });
                    return parentResponse(
                        publicationOutcome || {
                            ...record,
                            status: "completed",
                            adapter_run_ids: adapterChildren,
                            output_handoff: outcomeHandoff
                        }
                    );
                }
                if (run.status === "completed" && !child.output_data_object_id) {
                    if (!run.output_uri) {
                        const updated = await store.update(record.id, {
                            status: "output_verifying",
                            adapter_run_ids: adapterChildren,
                            error_message: "Adapter completed without a discoverable output URI"
                        });
                        return parentResponse(updated || { ...record, status: "output_verifying" });
                    }
                    const registered = await adapterRequest(
                        `/runs/${encodeURIComponent(child.run_id)}/register-output`,
                        {
                            method: "POST",
                            body: {
                                output_data_object: {
                                    id: `em-final-output-${record.id}`,
                                    label:
                                        adapter.target_contract?.standard_variable_uri ||
                                        adapter.model_output_key,
                                    resource_uri: run.output_uri,
                                    source_catalog: "svo-adapter",
                                    owner_execution_id: parentRunId(record.id),
                                    owner_model_child_id: record.model_child_id,
                                    variables: [
                                        {
                                            standard_variable_uri:
                                                adapter.target_contract?.standard_variable_uri,
                                            unit: adapter.target_contract?.unit
                                        }
                                    ]
                                },
                                execution_id: parentRunId(record.id)
                            }
                        },
                        authorization
                    );
                    child.output_data_object_id =
                        registered?.output_data_object?.id || registered?.id || null;
                    if (!child.output_data_object_id) {
                        throw new Error("Adapter output registration returned no data object ID");
                    }
                    if (
                        legacyServices.tapis.updateCompositeWorkflowExecution &&
                        record.model_child_id
                    ) {
                        // Keep the legacy Results view useful as well as the
                        // workflow provenance view: its declared model output
                        // now points at the transformed artifact.
                        await legacyServices.tapis.updateCompositeWorkflowExecution(
                            plan.thread_id,
                            plan.model_id,
                            record.model_child_id,
                            "completed",
                            {
                                model_io_id: child.model_io_id,
                                resource_id: child.output_data_object_id,
                                name:
                                    (typeof adapter.target_contract?.standard_variable_uri ===
                                    "string"
                                        ? adapter.target_contract.standard_variable_uri
                                        : undefined) || adapter.model_output_key,
                                url: String(run.output_uri)
                            }
                        );
                    }
                }
                const nextStatus =
                    run.status === "completed" && child.output_data_object_id
                        ? "completed"
                        : run.status === "failed"
                          ? "failed"
                          : "adapter_running";
                const updated = await store.update(record.id, {
                    status: nextStatus,
                    adapter_run_ids: adapterChildren,
                    output_handoff:
                        nextStatus === "completed"
                            ? {
                                  ...((record.output_handoff as Record<string, unknown>) || {}),
                                  final_output_data_object_id: child.output_data_object_id,
                                  final_resource_uri: run.output_uri || null,
                                  ...(run.result && typeof run.result === "object"
                                      ? { result: run.result }
                                      : {}),
                                  ...(publication ? { publication } : {})
                              }
                            : record.output_handoff,
                    error_message: run.error_message || null,
                    failure_code: run.status === "failed" ? "ADAPTER_FAILED" : null
                });
                return parentResponse(updated || { ...record, status: nextStatus });
            } catch (error) {
                const updated = await store.update(record.id, {
                    status: "unknown",
                    failure_code: "ADAPTER_STATUS_UNKNOWN",
                    error_message: error instanceof Error ? error.message : String(error)
                });
                return parentResponse(updated || { ...record, status: "unknown" });
            }
        }
        const getExecution = legacyServices.tapis.getExecution;
        const knownCompositeOutput = (record.model_result as Record<string, unknown> | null)
            ?.output_uri;
        if ((!getExecution && typeof knownCompositeOutput !== "string") || !record.model_child_id) {
            const updated = await store.update(record.id, {
                status: "unknown",
                failure_code: "MODEL_STATUS_UNAVAILABLE",
                error_message: "model execution status is unavailable for post-model orchestration"
            });
            return parentResponse(updated || { ...record, status: "unknown" });
        }

        let model: any;
        if (!getExecution && typeof knownCompositeOutput === "string") {
            // Composite model tasks already carry their output URI. Do not
            // require a legacy execution lookup just to start the deferred
            // adapter when the provider has no legacy job endpoint.
            model = {
                status: "SUCCESS",
                results: [
                    {
                        model_io: { id: adapter.model_io_id },
                        resource: { url: knownCompositeOutput, name: adapter.model_output_key }
                    }
                ],
                output_uri: knownCompositeOutput
            };
        } else {
            try {
                model = await getExecution(record.model_child_id, authorization || "");
            } catch (error) {
                const updated = await store.update(record.id, {
                    status: "unknown",
                    failure_code: "MODEL_STATUS_UNKNOWN",
                    error_message: error instanceof Error ? error.message : String(error)
                });
                return parentResponse(updated || { ...record, status: "unknown" });
            }
        }
        let modelStatus = String(model?.status || "").toUpperCase();
        const providerJobId = modelProviderJobId(record.model_result) || model?.runid;
        const getJobStatus = legacyServices.tapis.getJobStatus;
        if (getJobStatus && providerJobId) {
            try {
                const providerJob = await getJobStatus(providerJobId, authorization || "");
                modelStatus = String(providerJob?.status || modelStatus).toUpperCase();
                if (modelStatus === "SUCCESS") {
                    model = { ...model, status: "SUCCESS" };
                } else if (modelStatus === "FAILURE") {
                    model = {
                        ...model,
                        status: "FAILURE",
                        error: providerJob?.error || providerJob?.result || model?.error
                    };
                }
            } catch (error) {
                const updated = await store.update(record.id, {
                    status: "unknown",
                    failure_code: "MODEL_STATUS_UNKNOWN",
                    error_message: error instanceof Error ? error.message : String(error)
                });
                return parentResponse(updated || { ...record, status: "unknown" });
            }
        }
        if (providerJobId && model && typeof model === "object") {
            model = { ...model, provider_job_id: providerJobId };
        }
        if (["WAITING", "RUNNING", "SUBMITTED"].includes(modelStatus)) {
            const updated = await store.update(record.id, { status: "model_running" });
            return parentResponse(updated || { ...record, status: "model_running" });
        }
        if (modelStatus !== "SUCCESS") {
            const updated = await store.update(record.id, {
                status: "failed",
                failure_code: "MODEL_FAILED",
                error_message:
                    model?.error || `model execution ended with status ${modelStatus || "unknown"}`
            });
            return parentResponse(updated || { ...record, status: "failed" });
        }

        await store.update(record.id, {
            status: "model_succeeded",
            model_result: {
                ...((record.model_result as Record<string, unknown>) || {}),
                ...model
            },
            error_message: null,
            failure_code: null
        });

        const modelResults = Array.isArray(model.results)
            ? model.results
            : Object.entries(model.results || {}).map(([model_io_id, resource]) => ({
                  model_io_id,
                  resource
              }));
        const result = modelResults.find(
            (candidate: any) =>
                candidate?.model_io?.id === adapter.model_io_id ||
                candidate?.model_io_id === adapter.model_io_id
        );
        const resource = result?.resource;
        if (!resource?.url) {
            const updated = await store.update(record.id, {
                status: "output_registering",
                failure_code: "MODEL_OUTPUT_NOT_FOUND",
                error_message: `model output ${adapter.model_io_id} was not registered`
            });
            return parentResponse(updated || { ...record, status: "output_registering" });
        }

        let handoff = (record.output_handoff || {}) as Record<string, any>;
        if (!handoff.data_object_id) {
            await store.update(record.id, { status: "output_registering", model_result: model });
            try {
                const output = await adapterRequest(
                    "/data-objects",
                    {
                        method: "POST",
                        body: {
                            id: `em-output-${record.id}`,
                            label: resource.name || `${adapter.model_io_id} output`,
                            resource_uri: resource.url,
                            format: adapter.source_contract.format,
                            extension: adapter.source_contract.extension,
                            source_catalog: "ensemble-manager",
                            owner_execution_id: parentRunId(record.id),
                            owner_model_child_id: record.model_child_id,
                            variables: [
                                {
                                    standard_variable_uri:
                                        adapter.source_contract.standard_variable_uri,
                                    unit: adapter.source_contract.unit
                                }
                            ]
                        }
                    },
                    authorization
                );
                handoff = { data_object_id: output.id, resource_uri: output.resource_uri };
                await store.update(record.id, {
                    status: "output_verified",
                    model_output_id: output.id,
                    output_handoff: handoff,
                    model_result: model,
                    error_message: null,
                    failure_code: null
                });
            } catch (error) {
                const updated = await store.update(record.id, {
                    status: "failed",
                    failure_code: "OUTPUT_REGISTRATION_FAILED",
                    error_message: error instanceof Error ? error.message : String(error)
                });
                return parentResponse(updated || { ...record, status: "failed" });
            }
        }

        const values = {
            ...(record.parameter_values || {}),
            // The model output URI is created by this coordinator after the
            // model succeeds. It is not a user-editable adapter parameter.
            ...(handoff.resource_uri ? { source_uri: handoff.resource_uri } : {}),
            // Deferred workflow plans use this managed argument in the hosted
            // task code; request metadata alone is not sufficient for Tapis
            // Workflows argument validation.
            execution_id: parentRunId(record.id)
        };
        const statusBeforeDispatch = record.status;
        try {
            await store.update(record.id, { status: "adapter_dispatching" });
            const binding = await adapterRequest(
                `/plans/deferred/${encodeURIComponent(adapter.adapter_plan_id)}/bind`,
                {
                    method: "POST",
                    body: {
                        data_object_id: handoff.data_object_id,
                        plan_hash: adapter.plan_hash,
                        parent_execution_id: parentRunId(record.id),
                        model_child_id: record.model_child_id,
                        parameter_values_hash: record.parameter_values_hash
                    }
                },
                authorization
            );
            const submitted = await adapterRequest(
                "/workflows/submit",
                {
                    method: "POST",
                    body: {
                        plan_id: binding.bound_plan_id,
                        args: values,
                        execution_id: parentRunId(record.id),
                        idempotency_key: `${parentRunId(record.id)}:${adapter.adapter_plan_id}:${record.parameter_values_hash}:post-model${postModelAttemptSuffix}`
                    },
                    idempotencyKey: `${parentRunId(record.id)}:${adapter.adapter_plan_id}:${record.parameter_values_hash}:post-model${postModelAttemptSuffix}`
                },
                authorization
            );
            const { publication: priorPublication, ...handoffWithoutPublication } = handoff;
            const dispatchedHandoff =
                priorPublication?.status === "awaiting_owner" ? handoffWithoutPublication : handoff;
            const child = {
                adapter_plan_id: adapter.adapter_plan_id,
                model_io_id: adapter.model_io_id,
                stage: "post_model",
                run_id: submitted.run_id,
                status: submitted.status || "running",
                execution_kind: "workflow",
                tapis_workflow_id: submitted.tapis_workflow_id || null,
                tapis_run_id: submitted.tapis_run_id || null
            };
            const updated = await store.update(record.id, {
                status: "adapter_running",
                adapter_run_ids: [child],
                // The owner's poll dispatched it: drop any awaiting_owner marker.
                output_handoff: { ...dispatchedHandoff, bound_plan_id: binding.bound_plan_id },
                error_message: null
            });
            return parentResponse(updated || { ...record, status: "adapter_running" });
        } catch (error) {
            if (isRunOwnerMismatch(error) && plan.publish?.length) {
                // Someone other than the submitter observed completion. The
                // publication runs as the owner, so wait for the owner's poll:
                // not a failure, and no child exists to count as stale.
                const awaitingHandoff = { ...handoff, publication: { status: "awaiting_owner" } };
                const awaiting = await store.update(record.id, {
                    status: statusBeforeDispatch,
                    output_handoff: awaitingHandoff
                });
                return parentResponse(
                    awaiting || {
                        ...record,
                        status: statusBeforeDispatch,
                        output_handoff: awaitingHandoff
                    }
                );
            }
            const updated = await store.update(record.id, {
                status:
                    error instanceof UnifiedExecutionError && error.statusCode < 500
                        ? "failed"
                        : "unknown",
                failure_code: "ADAPTER_SUBMISSION_FAILED",
                error_message: error instanceof Error ? error.message : String(error)
            });
            return parentResponse(updated || { ...record, status: "unknown" });
        }
    };

    const reconcileParent = async (
        record: UnifiedExecutionRecord,
        authorization?: string
    ): Promise<Record<string, unknown>> => {
        if (
            ["model_submitted", "failed", "model_unknown"].includes(record.status) ||
            (record.status === "adapter_unknown" && !isRetryableAdapterAuthFailure(record))
        ) {
            return parentResponse(record);
        }

        const children = (record.adapter_run_ids || []) as AdapterChildRun[];
        for (const child of children) {
            if (child.status === "completed" && child.output_data_object_id) continue;
            try {
                await adapterRequest(
                    `/runs/${encodeURIComponent(child.run_id)}/poll`,
                    { method: "POST" },
                    authorization
                );
                const run = await adapterRequest(
                    `/runs/${encodeURIComponent(child.run_id)}`,
                    {},
                    authorization
                );
                child.status = run.status;
                child.output_data_object_id = run.output_data_object_id || null;
                child.error_message = run.error_message || null;
                copyAdapterLiveness(child, run);
            } catch (error) {
                const updated = await store.update(record.id, {
                    status: "adapter_unknown",
                    adapter_run_ids: children,
                    error_message: error instanceof Error ? error.message : String(error)
                });
                return parentResponse(updated || { ...record, status: "adapter_unknown" });
            }
        }

        await store.update(record.id, { adapter_run_ids: children });
        if (children.some((child) => child.status === "failed")) {
            const childError = children.find((child) => child.status === "failed")?.error_message;
            const updated = await store.update(record.id, {
                status: "failed",
                error_message: childError || "One or more SVO adapter child runs failed",
                adapter_run_ids: children
            });
            return parentResponse(updated || { ...record, status: "failed" });
        }
        if (children.some((child) => child.status !== "completed")) {
            // Still running as far as Tapis knows; the adapter's liveness verdict
            // (stalled / self-reported failure) rides along as the failure code
            // and clears again when the child recovers.
            const healthCode = healthFailureCode(children);
            const unhealthy = children.find(
                (child) => child.health && HEALTH_FAILURE_CODES[child.health]
            );
            const clearingHealthCode =
                !healthCode &&
                record.failure_code &&
                Object.values(HEALTH_FAILURE_CODES).includes(record.failure_code);
            const updated = await store.update(record.id, {
                status: "adapter_running",
                adapter_run_ids: children,
                ...(healthCode
                    ? { failure_code: healthCode, error_message: unhealthy?.error_message || null }
                    : clearingHealthCode
                      ? { failure_code: null, error_message: null }
                      : {})
            });
            return parentResponse(updated || { ...record, status: "adapter_running" });
        }

        const overrides: Array<{
            model_io_id: string;
            resource_id: string;
            name?: string;
            url: string;
        }> = [];
        for (const child of children) {
            if (!child.output_data_object_id) {
                const updated = await store.update(record.id, {
                    status: "output_verifying",
                    adapter_run_ids: children,
                    error_message: "Adapter completed without a registered output"
                });
                return parentResponse(updated || { ...record, status: "output_verifying" });
            }
            try {
                const output = await adapterRequest(
                    `/data-objects/${encodeURIComponent(child.output_data_object_id)}`,
                    {},
                    authorization
                );
                if (!output.resource_uri) throw new Error("Adapter output has no resource URI");
                overrides.push({
                    model_io_id: child.model_io_id,
                    resource_id: output.id,
                    name: output.label,
                    url: output.resource_uri
                });
            } catch (error) {
                const updated = await store.update(record.id, {
                    status: "output_verifying",
                    adapter_run_ids: children,
                    error_message: error instanceof Error ? error.message : String(error)
                });
                return parentResponse(updated || { ...record, status: "output_verifying" });
            }
        }

        await store.update(record.id, { status: "model_dispatching", adapter_run_ids: children });
        try {
            const plan = decodePlan(record.plan_id);
            const result = await submitLegacy(
                plan,
                authorization,
                overrides,
                storedMaxMinutes(record),
                storedQueue(record)
            );
            const modelChildId = legacyModelExecutionId(result);
            if (!modelChildId) {
                const updated = await store.update(record.id, {
                    status: "model_unknown",
                    model_result: result,
                    failure_code: "MODEL_ID_UNAVAILABLE",
                    error_message: "model submission did not return a child execution ID"
                });
                return parentResponse(updated || { ...record, status: "model_unknown" });
            }
            const updated = await store.update(record.id, {
                status: "model_submitted",
                model_child_id: modelChildId,
                model_result: result,
                error_message: null
            });
            const responseRecord = updated || {
                ...record,
                status: "model_submitted",
                model_child_id: modelChildId,
                model_result: result
            };
            await persistWorkflowStages(responseRecord);
            return parentResponse(responseRecord);
        } catch (error) {
            // The downstream request may have reached the execution engine even
            // when this process did not receive a response. Do not auto-retry it.
            const updated = await store.update(record.id, {
                status: "model_unknown",
                error_message: error instanceof Error ? error.message : String(error)
            });
            return parentResponse(updated || { ...record, status: "model_unknown" });
        }
    };

    /**
     * Ask the bridge which input-ETL steps a composite model needs. The EM
     * supplies only what it alone knows: the catalog configuration, the app
     * inputs the job already fills, and the thread region shaped as a source.
     * The bridge pairs sources with bound inputs through the registry. Returns
     * the model's outputs too, for an input-only plan.
     */
    const deriveInputSteps = async (
        plan: LegacyPlan,
        strictInputs: boolean,
        authorization?: string
    ): Promise<InputPlanResult> => {
        const empty: InputPlanResult = {
            steps: [],
            outputs: [],
            sources: [],
            filledAppInputs: [],
            warnings: []
        };
        const contextOf = legacyServices.tapis.compositeModelContext;
        if (!contextOf) return empty;
        const context = await contextOf.call(
            legacyServices.tapis,
            { thread_id: plan.thread_id, model_id: plan.model_id },
            authorization || ""
        );
        if (!context.has_bound_inputs) {
            // The Waco miss of 2026-11-05 was exactly this state: nothing bound,
            // so nothing planned and nothing said. Say it, so a model registered
            // without bindings is never a silent label-only run.
            return {
                ...empty,
                outputs: context.outputs,
                warnings: [
                    `model ${plan.model_id} records no app-input bindings; its app file inputs are matched by label only`
                ]
            };
        }
        if (!context.region) {
            throw new UnifiedExecutionError(
                422,
                "the thread region is required to derive model inputs",
                "AOI_REGION_UNAVAILABLE"
            );
        }
        let source: InputSource;
        try {
            source = deriveRegionSource(context.region);
        } catch (error) {
            if (error instanceof RegionGeometryError) {
                throw new UnifiedExecutionError(422, error.message, "AOI_REGION_GEOMETRY_INVALID");
            }
            throw error;
        }
        let planned: any;
        try {
            planned = await adapterRequest(
                "/plans/model-inputs",
                {
                    method: "POST",
                    body: {
                        configuration_id: context.configuration_id,
                        sources: [source],
                        filled_app_inputs: context.filled_app_inputs
                    }
                },
                authorization
            );
        } catch (error) {
            // An adapter without the endpoint must not look like "no steps needed".
            if (error instanceof UnifiedExecutionError && error.statusCode === 404) {
                throw new UnifiedExecutionError(
                    502,
                    "SVO adapter does not support POST /plans/model-inputs; deploy a matching adapter",
                    "ADAPTER_CAPABILITY_MISSING"
                );
            }
            throw error;
        }
        const considered: ConsideredInput[] = Array.isArray(planned?.considered)
            ? planned.considered
            : [];
        const blocked = considered.find((row) => row.blocking);
        if (blocked) {
            throw new UnifiedExecutionError(
                422,
                `no input transform path to required app input ${blocked.app_input_name ?? "(unnamed)"}` +
                    (blocked.standard_variable_uri ? ` (${blocked.standard_variable_uri})` : ""),
                "NO_INPUT_TRANSFORM_PATH"
            );
        }
        const warnings: string[] = [];
        if (planned?.registry === "missing") {
            warnings.push(
                `the bridge has no registry entry for configuration ${context.configuration_id}; input steps could not be planned (run sync-from-mint)`
            );
        }
        for (const row of considered) {
            const name = row.app_input_name ?? row.standard_variable_uri ?? "(unnamed)";
            if (row.outcome === "unbound") {
                warnings.push(`model input ${name} is not bound to a Tapis file input`);
            } else if (row.outcome === "no_path") {
                warnings.push(`no input transform path to optional app input ${name}`);
            }
        }
        for (const name of context.unmatched_optional_inputs) {
            warnings.push(`optional app input ${name} matched no model input and will be skipped`);
        }
        if (strictInputs && warnings.length) {
            throw new UnifiedExecutionError(
                422,
                `input warnings: ${warnings.join("; ")}`,
                "INPUT_WARNINGS"
            );
        }
        return {
            steps: Array.isArray(planned?.input_steps) ? planned.input_steps : [],
            outputs: context.outputs,
            sources: [source],
            filledAppInputs: context.filled_app_inputs,
            stepsDigest: planned?.steps_digest,
            regionId: context.region.id,
            warnings
        };
    };

    // Only the references go on the plan; the preview itself is returned
    // alongside it (see createPlan) and re-derived at submit.
    const applyInputPlan = (plan: LegacyPlan, derived: InputPlanResult) => {
        if (!derived.steps.length) return;
        plan.input_region_id = derived.regionId;
        plan.steps_digest = derived.stepsDigest;
    };

    /**
     * Shape the thread region into the source the plan was previewed with, at
     * submit time. The region is read again rather than stored: it is too large
     * for the plan id, and a region swapped under the thread must be visible.
     */
    const inputSourcesForSubmit = async (
        plan: LegacyPlan,
        authorization?: string
    ): Promise<{ input_sources: InputSource[]; filled_app_inputs: string[] }> => {
        const contextOf = legacyServices.tapis.compositeModelContext;
        if (!contextOf) {
            throw new UnifiedExecutionError(
                500,
                "input planning is not available for this execution engine",
                "INPUT_PLAN_UNAVAILABLE"
            );
        }
        const context = await contextOf.call(
            legacyServices.tapis,
            { thread_id: plan.thread_id, model_id: plan.model_id },
            authorization || ""
        );
        if (!context.region || context.region.id !== plan.input_region_id) {
            throw new UnifiedExecutionError(
                422,
                `the thread region changed since the plan was made (planned ${plan.input_region_id}, now ${context.region?.id ?? "none"}); plan again`,
                "INPUT_REGION_CHANGED"
            );
        }
        try {
            return {
                input_sources: [deriveRegionSource(context.region)],
                filled_app_inputs: context.filled_app_inputs
            };
        } catch (error) {
            if (error instanceof RegionGeometryError) {
                throw new UnifiedExecutionError(422, error.message, "AOI_REGION_GEOMETRY_INVALID");
            }
            throw error;
        }
    };

    /** A publisher as GET /publishers on the adapter describes it. */
    type OfferedPublisher = { catalog_tokens?: string[]; output_formats?: string[] };

    /**
     * Normalise the requested catalog tokens and check them against the
     * publishers the adapter offers for the model. The adapter is the source of
     * truth; the Ensemble Manager keeps no token list. The offered publishers
     * come back too, so the output to publish can be chosen from them.
     */
    const validatedPublishTokens = async (
        requested: unknown,
        modelId: string,
        authorization?: string
    ): Promise<{ tokens: string[]; offered: OfferedPublisher[] }> => {
        if (requested === undefined || requested === null) return { tokens: [], offered: [] };
        if (!Array.isArray(requested) || requested.some((token) => typeof token !== "string")) {
            throw new UnifiedExecutionError(
                400,
                "publish must be an array of catalog tokens",
                "PUBLISH_INVALID"
            );
        }
        const tokens = [...new Set(requested.map((token: string) => token.trim()).filter(Boolean))];
        if (!tokens.length) return { tokens: [], offered: [] };
        const response = await adapterRequest(
            `/publishers?configuration_id=${encodeURIComponent(modelId)}`,
            {},
            authorization
        );
        const offered = (response?.publishers || []) as OfferedPublisher[];
        const available = [
            ...new Set(offered.flatMap((publisher) => publisher.catalog_tokens || []))
        ];
        if (tokens.some((token) => !available.includes(token))) {
            throw new UnifiedExecutionError(
                422,
                `unknown publish catalog; available: ${available.join(", ") || "none"}`,
                "PUBLISH_CATALOG_UNKNOWN",
                { requested: tokens, available }
            );
        }
        return { tokens, offered };
    };

    /**
     * The model outputs a publisher for the requested catalogs can take, in
     * catalog order. The adapter reports each publisher's `output_formats`
     * verbatim from the model catalog, so an output qualifies when its declared
     * format is one of them; no format aliasing happens here. Returns null when
     * the adapter reported no formats at all (an older adapter), so the caller
     * can keep its previous choice instead of refusing every publish.
     */
    const publishableOutputs = (
        outputs: { id: string; name: string; format?: string }[],
        offered: OfferedPublisher[],
        tokens: string[]
    ): { id: string; name: string; format?: string }[] | null => {
        const relevant = offered.filter((publisher) =>
            (publisher.catalog_tokens || []).some((token) => tokens.includes(token))
        );
        if (!relevant.some((publisher) => Array.isArray(publisher.output_formats))) return null;
        const formats = new Set(
            relevant.flatMap((publisher) => publisher.output_formats || []).map((f) => f.trim())
        );
        return outputs.filter((output) => formats.has((output.format || "").trim()));
    };

    return {
        async listPublishers(modelId: unknown, authorization?: string) {
            if (typeof modelId !== "string" || !modelId) {
                throw new UnifiedExecutionError(400, "model_id is required", "MODEL_ID_REQUIRED");
            }
            return adapterRequest(
                `/publishers?configuration_id=${encodeURIComponent(modelId)}`,
                {},
                authorization
            );
        },

        async createPlan(body: any, authorization?: string) {
            const executor = body?.executor as UnifiedExecutor;
            let inputPlan: InputPlanResult | undefined;
            if (executor === "svo_adapter") {
                const adapterBody = body.adapter_request || body.adapter;
                if (!adapterBody || typeof adapterBody !== "object") {
                    throw new UnifiedExecutionError(
                        400,
                        "adapter_request is required for an SVO adapter plan",
                        "ADAPTER_REQUEST_REQUIRED"
                    );
                }
                const { data_object: dataObject, ...planRequest } = adapterBody as {
                    data_object?: Record<string, unknown>;
                    [key: string]: unknown;
                };
                if (dataObject !== undefined) {
                    if (
                        typeof dataObject !== "object" ||
                        dataObject === null ||
                        typeof dataObject.label !== "string" ||
                        typeof dataObject.resource_uri !== "string"
                    ) {
                        throw new UnifiedExecutionError(
                            400,
                            "adapter data_object requires label and resource_uri",
                            "ADAPTER_DATA_OBJECT_INVALID"
                        );
                    }
                    const registered = await adapterRequest(
                        "/data-objects",
                        { method: "POST", body: dataObject },
                        authorization
                    );
                    if (typeof registered?.id !== "string") {
                        throw new UnifiedExecutionError(
                            502,
                            "SVO adapter returned an incomplete data object",
                            "ADAPTER_DATA_OBJECT_INVALID"
                        );
                    }
                    planRequest.data_object_id = registered.id;
                }
                const result = (await adapterRequest(
                    "/plans",
                    {
                        method: "POST",
                        body: planRequest
                    },
                    authorization
                )) as AdapterPlanResponse;
                const rawPlanId = result.plan_id;
                return {
                    ...result,
                    executor,
                    version: 1,
                    plan_id: rawPlanId ? `svo_${rawPlanId}` : null,
                    parameters: result.plan_json?.parameters || [],
                    parameter_values: {}
                };
            }

            if (executor !== "ensemble_manager") {
                throw new UnifiedExecutionError(
                    400,
                    "executor must be ensemble_manager or svo_adapter"
                );
            }
            if (typeof body.thread_id !== "string" || typeof body.model_id !== "string") {
                throw new UnifiedExecutionError(
                    400,
                    "thread_id and model_id are required",
                    "THREAD_MODEL_REQUIRED"
                );
            }
            const { tokens: publish, offered: offeredPublishers } = await validatedPublishTokens(
                body.publish,
                body.model_id,
                authorization
            );
            const plan: LegacyPlan = {
                executor,
                thread_id: body.thread_id,
                model_id: body.model_id,
                execution_engine:
                    body.execution_engine || getConfiguration().execution_engine || "localex",
                ...(publish.length ? { publish } : {})
            };
            // Composite path: an explicit post-model adapter, or input-only ETL.
            // Input ETL is automatic for Tapis plans (the bridge is not called
            // when no model input is bound to an app input); `input_etl: false` opts out.
            let adapter = body.post_model_adapter;
            let identityPostModel = false;
            // Automatic derivation steps aside for pre-model adapter_steps plans
            // (mixed stages are unsupported); an explicit `input_etl: true` does not.
            const inputEtl =
                plan.execution_engine === "tapis" &&
                body.input_etl !== false &&
                (body.input_etl === true || !body.adapter_steps?.length);
            if (adapter !== undefined || body.input_etl === true) {
                if (plan.execution_engine !== "tapis") {
                    throw new UnifiedExecutionError(
                        422,
                        "post-model adapter orchestration currently requires the Tapis engine",
                        "POST_MODEL_ENGINE_UNSUPPORTED"
                    );
                }
                if (body.adapter_steps?.length) {
                    throw new UnifiedExecutionError(
                        422,
                        "mixed pre-model and post-model adapter plans are not supported",
                        "MIXED_ADAPTER_STAGES_UNSUPPORTED"
                    );
                }
            }
            if (adapter !== undefined) {
                if (
                    typeof adapter?.model_io_id !== "string" ||
                    typeof adapter?.model_output_key !== "string" ||
                    !adapter.source_contract ||
                    !adapter.target_contract
                ) {
                    throw new UnifiedExecutionError(
                        400,
                        "post_model_adapter requires model_io_id, model_output_key, source_contract, and target_contract",
                        "POST_MODEL_ADAPTER_INVALID"
                    );
                }
                if (publish.length) {
                    adapter = {
                        ...adapter,
                        target_contract: {
                            ...adapter.target_contract,
                            catalog: publish.join("+")
                        }
                    };
                }
                if (body.input_etl !== false) {
                    inputPlan = await deriveInputSteps(
                        plan,
                        body.strict_inputs === true,
                        authorization
                    );
                    applyInputPlan(plan, inputPlan);
                }
            } else if (inputEtl) {
                // Input-only composite. Everything downstream of the model (the
                // submit, the output handoff, reconciliation) keys on a stored
                // post-model plan, so a model that needs input ETL but no
                // post-model ETL gets an identity deferred plan: source and target
                // contract are the model output's own, which the adapter plans as
                // zero steps. If nothing needs deriving and nothing is published
                // the plan stays an ordinary non-composite plan.
                const derived = await deriveInputSteps(
                    plan,
                    body.strict_inputs === true,
                    authorization
                );
                inputPlan = derived;
                applyInputPlan(plan, derived);
                // Publication is independent of input ETL: a request to publish
                // builds the identity plan even when no input steps were derived.
                if (derived.steps.length || publish.length) {
                    const requested =
                        typeof body.model_output_key === "string"
                            ? body.model_output_key.trim()
                            : "";
                    // With publish, the output must be one the publisher can take:
                    // a model's first declared output is often an archive or a
                    // manifest, and planning that against the publish piece is
                    // the "no transform path" 422 of 2026-11-05.
                    const eligible = publish.length
                        ? publishableOutputs(derived.outputs, offeredPublishers, publish)
                        : null;
                    const notPublishable = (what: string) =>
                        new UnifiedExecutionError(
                            422,
                            `${what} cannot be published to ${publish.join("+")}; ` +
                                `publishable outputs: ${
                                    eligible?.map((candidate) => candidate.name).join(", ") ||
                                    "none"
                                }`,
                            "PUBLISH_OUTPUT_NOT_PUBLISHABLE",
                            {
                                requested: requested || null,
                                publishable: (eligible || []).map((candidate) => candidate.name)
                            }
                        );
                    let output: (typeof derived.outputs)[number] | undefined;
                    if (requested) {
                        output = derived.outputs.find(
                            (candidate) =>
                                candidate.name === requested || candidate.id === requested
                        );
                        if (output && eligible && !eligible.includes(output)) {
                            throw notPublishable(`output ${requested}`);
                        }
                    } else if (eligible) {
                        if (!eligible.length) throw notPublishable("none of the model's outputs");
                        output = eligible[0];
                    } else {
                        output = derived.outputs[0];
                    }
                    if (!output) {
                        throw new UnifiedExecutionError(
                            422,
                            `model does not declare output ${requested || "(none)"}`,
                            "MODEL_OUTPUT_NOT_DECLARED"
                        );
                    }
                    const contract = output.format ? { format: output.format } : {};
                    adapter = {
                        model_io_id: output.id,
                        model_output_key: output.name,
                        source_contract: contract,
                        target_contract: {
                            ...contract,
                            ...(publish.length ? { catalog: publish.join("+") } : {})
                        }
                    };
                    identityPostModel = true;
                }
            }
            if (publish.length && adapter === undefined) {
                throw new UnifiedExecutionError(
                    422,
                    "publish needs a post-model stage: use the Tapis engine with input_etl enabled or supply post_model_adapter",
                    "PUBLISH_REQUIRES_POST_MODEL"
                );
            }
            if (adapter !== undefined) {
                const result = (await adapterRequest(
                    "/plans/deferred",
                    {
                        method: "POST",
                        body: {
                            source_contract: adapter.source_contract,
                            target_contract: adapter.target_contract,
                            target_dataset_specification_id:
                                adapter.target_dataset_specification_id,
                            model_output_key: adapter.model_output_key
                        }
                    },
                    authorization
                )) as AdapterPlanResponse;
                if (!result.plan_id || !result.plan_hash) {
                    throw new UnifiedExecutionError(
                        502,
                        "SVO adapter returned an incomplete deferred plan",
                        "DEFERRED_PLAN_INVALID"
                    );
                }
                // An identity plan without publish has no post-model steps. With
                // publish, the only steps allowed are the ones the adapter marks
                // as publishing; the marker comes from the adapter, not from
                // transform-type names, so new publishers need no change here.
                const planned = (result.plan_json?.steps || []) as Array<{ publishes?: boolean }>;
                if (
                    identityPostModel &&
                    (publish.length
                        ? !planned.every((step) => step?.publishes === true)
                        : planned.length > 0)
                ) {
                    throw new UnifiedExecutionError(
                        502,
                        "SVO adapter planned post-model steps for an input-only plan",
                        "INPUT_ONLY_PLAN_NOT_IDENTITY"
                    );
                }
                plan.post_model_adapter = {
                    adapter_plan_id: result.plan_id,
                    model_io_id: adapter.model_io_id,
                    model_output_key: adapter.model_output_key,
                    source_contract: adapter.source_contract,
                    target_contract: adapter.target_contract,
                    plan_hash: result.plan_hash,
                    parameters: result.plan_json?.parameters || []
                };
            }
            if (body.adapter_steps !== undefined) {
                if (!Array.isArray(body.adapter_steps)) {
                    throw new UnifiedExecutionError(400, "adapter_steps must be an array");
                }
                plan.adapter_steps = body.adapter_steps.map((step: any) => {
                    if (
                        typeof step?.adapter_plan_id !== "string" ||
                        typeof step?.model_io_id !== "string" ||
                        typeof step?.source_resource_id !== "string"
                    ) {
                        throw new UnifiedExecutionError(
                            400,
                            "each adapter step requires adapter_plan_id, model_io_id, and source_resource_id",
                            "ADAPTER_STEP_INVALID"
                        );
                    }
                    return {
                        adapter_plan_id: adapterPlanId(step.adapter_plan_id),
                        model_io_id: step.model_io_id,
                        source_resource_id: step.source_resource_id
                    };
                });
            }
            return {
                executor,
                version: 1,
                plan_id: encodePlan(plan),
                parameters: plan.post_model_adapter?.parameters || [],
                parameter_values: {},
                status: plan.post_model_adapter
                    ? "post_model_ready"
                    : plan.adapter_steps?.length
                      ? "adapter_ready"
                      : "ready",
                adapter_steps: plan.adapter_steps || [],
                post_model_adapter: plan.post_model_adapter || null,
                // The preview travels with the response only; the plan keeps
                // the region id and the digest (see LegacyPlan).
                ...(inputPlan?.steps.length
                    ? {
                          input_steps: inputPlan.steps,
                          input_sources: inputPlan.sources,
                          filled_app_inputs: inputPlan.filledAppInputs,
                          steps_digest: inputPlan.stepsDigest
                      }
                    : {}),
                ...(inputPlan?.warnings.length ? { input_warnings: inputPlan.warnings } : {})
            };
        },

        async getPlan(planId: string, authorization?: string) {
            if (planId.startsWith("svo_")) {
                const result = await adapterRequest(
                    `/plans/${encodeURIComponent(adapterPlanId(planId))}`,
                    {},
                    authorization
                );
                return {
                    ...result,
                    executor: "svo_adapter",
                    version: 1,
                    plan_id: planId,
                    parameters: result.plan_json?.parameters || []
                };
            }
            const plan = decodePlan(planId);
            return {
                ...plan,
                version: 1,
                plan_id: planId,
                parameters: plan.post_model_adapter?.parameters || [],
                status: plan.post_model_adapter
                    ? "post_model_ready"
                    : plan.adapter_steps?.length
                      ? "adapter_ready"
                      : "ready"
            };
        },

        async getRun(runId: string, authorization?: string) {
            if (runId.startsWith("ue_")) {
                const record = await store.getById(runId.slice(3));
                if (!record) {
                    throw new UnifiedExecutionError(
                        404,
                        "execution run not found",
                        "RUN_NOT_FOUND"
                    );
                }
                const decoded = decodePlan(record.plan_id);
                const response = decoded.post_model_adapter
                    ? reconcilePostModel(record, authorization)
                    : reconcileParent(record, authorization);
                const result = await response;
                const latest = await store.getById(runId.slice(3));
                if (latest) await persistWorkflowStages(latest);
                return result;
            }
            const result = await adapterRequest(
                `/runs/${encodeURIComponent(runId)}`,
                {},
                authorization
            );
            return {
                ...result,
                executor: "svo_adapter",
                child_execution_id: runId
            };
        },

        async cancelRun(runId: string, authorization?: string) {
            if (!authorization) {
                throw new UnifiedExecutionError(
                    401,
                    "a Tapis bearer token is required to cancel a run",
                    "AUTHORIZATION_REQUIRED"
                );
            }
            if (!runId.startsWith("ue_")) {
                const result = await adapterRequest(
                    `/runs/${encodeURIComponent(runId)}/cancel`,
                    { method: "POST" },
                    authorization
                );
                return { ...result, executor: "svo_adapter", child_execution_id: runId };
            }
            const record = await store.getById(runId.slice(3));
            if (!record) {
                throw new UnifiedExecutionError(404, "execution run not found", "RUN_NOT_FOUND");
            }
            const children = (record.adapter_run_ids || []) as AdapterChildRun[];
            const active = children.filter(
                (child) =>
                    child.run_id &&
                    !["completed", "failed", "cancelled"].includes(String(child.status || ""))
            );
            if (!active.length) {
                throw new UnifiedExecutionError(
                    409,
                    "this run has no active adapter workflow to cancel",
                    "RUN_NOT_CANCELLABLE"
                );
            }
            // The adapter checks that the caller submitted the run (or is a
            // cancel admin) and terminates the Tapis Workflows run and its
            // verified model job; its 403/502 propagate unchanged.
            let cancelledBy: string | null = null;
            for (const child of active) {
                await adapterRequest(
                    `/runs/${encodeURIComponent(child.run_id)}/cancel`,
                    { method: "POST" },
                    authorization
                );
                const run = await adapterRequest(
                    `/runs/${encodeURIComponent(child.run_id)}`,
                    {},
                    authorization
                );
                child.status = run.status || "cancelled";
                child.error_message = run.error_message || null;
                copyAdapterLiveness(child, run);
                cancelledBy = cancelledBy || run.error_message || null;
            }
            const updated = await store.update(record.id, {
                status: "failed",
                failure_code: "CANCELLED_BY_USER",
                adapter_run_ids: children,
                error_message: cancelledBy || "Cancelled by user"
            });
            const latest = updated || { ...record, status: "failed" };
            await persistWorkflowStages(latest);
            return parentResponse(latest);
        },

        async submit(body: any, authorization: string | undefined) {
            if (typeof body?.plan_id !== "string") {
                throw new UnifiedExecutionError(400, "plan_id is required", "PLAN_ID_REQUIRED");
            }
            const maxMinutes = parseMaxMinutes(body.max_minutes);
            const requestedMaxMinutes =
                body.max_minutes === undefined ||
                body.max_minutes === null ||
                body.max_minutes === ""
                    ? undefined
                    : maxMinutes;
            const requestedQueue = parseQueue(body.queue);
            if (body.plan_id.startsWith("svo_")) {
                const result = await adapterRequest(
                    "/workflows/submit",
                    {
                        method: "POST",
                        body: {
                            plan_id: adapterPlanId(body.plan_id),
                            args: body.parameter_values || {},
                            run_name: body.run_name,
                            recreate: body.recreate,
                            dry_run: body.dry_run,
                            execution_id: body.execution_id,
                            idempotency_key: body.idempotency_key
                        },
                        idempotencyKey: body.idempotency_key
                    },
                    authorization
                );
                return {
                    ...result,
                    executor: "svo_adapter",
                    execution_mode: "workflow",
                    parent_execution_id: body.execution_id || null,
                    child_execution_id: result.run_id || null
                };
            }

            const plan = decodePlan(body.plan_id);
            if (plan.post_model_adapter) {
                const adapter = plan.post_model_adapter;
                const existing = await store.getByPlanId(body.plan_id);
                if (existing) return parentResponse(existing);
                const adapterValues = adapterParameterValues(plan, body);
                const parent = await store.insert({
                    plan_id: body.plan_id,
                    thread_id: plan.thread_id,
                    model_id: plan.model_id,
                    execution_engine: plan.execution_engine,
                    status: "model_dispatching",
                    idempotency_key: body.idempotency_key || body.plan_id,
                    plan_hash: planHash(plan),
                    adapter_steps: [],
                    adapter_run_ids: [],
                    parameter_values: adapterValues.values,
                    parameter_values_hash: adapterValues.hash,
                    schema_version: 1,
                    state_revision: 0,
                    model_child_id: null,
                    model_output_id: null,
                    output_handoff: null,
                    failure_code: null,
                    ...jobOptionsResult(requestedMaxMinutes, requestedQueue)
                });
                const dispatchClaim = await store.compareAndSet(parent.id, 0, {
                    status: "model_dispatching"
                });
                if (!dispatchClaim) {
                    return parentResponse((await store.getById(parent.id)) || parent);
                }
                try {
                    if (!legacyServices.tapis.buildCompositeWorkflowModelTask) {
                        throw new UnifiedExecutionError(
                            503,
                            "composite Tapis workflow model task support is unavailable",
                            "COMPOSITE_WORKFLOW_UNAVAILABLE"
                        );
                    }
                    const modelTask = await legacyServices.tapis.buildCompositeWorkflowModelTask(
                        {
                            thread_id: plan.thread_id,
                            model_id: plan.model_id,
                            output_name: adapter.model_output_key,
                            ...(requestedMaxMinutes === undefined
                                ? {}
                                : { max_minutes: requestedMaxMinutes }),
                            ...(requestedQueue === undefined ? {} : { queue: requestedQueue })
                        },
                        parentRunId(parent.id),
                        authorization || ""
                    );
                    // The bridge derives the steps from the registry, excluding
                    // inputs already filled, so there is no conflict to check here.
                    const hasInputPlan = !!plan.steps_digest;
                    const inputs = hasInputPlan
                        ? await inputSourcesForSubmit(plan, authorization)
                        : undefined;
                    const submitKey =
                        `${parentRunId(parent.id)}:${adapter.adapter_plan_id}:${adapterValues.hash}` +
                        (hasInputPlan ? `:in-${plan.steps_digest}` : "");
                    const submitted = await adapterRequest(
                        "/workflows/submit",
                        {
                            method: "POST",
                            body: {
                                plan_id: adapter.adapter_plan_id,
                                args: {
                                    ...adapterValues.values,
                                    execution_id: parentRunId(parent.id)
                                },
                                execution_id: parentRunId(parent.id),
                                idempotency_key: submitKey,
                                ...(body.dry_run ? { dry_run: true } : {}),
                                model_task: {
                                    stage_id: "model",
                                    configuration_id: modelTask.configuration_id,
                                    required_secrets: modelTask.required_secrets,
                                    output_uri: modelTask.output_uri,
                                    output_name: modelTask.output_name,
                                    output_format: modelTask.output_format || "",
                                    max_minutes: requestedMaxMinutes,
                                    job_definition: modelTask.job_definition,
                                    ...(inputs
                                        ? {
                                              input_sources: inputs.input_sources,
                                              filled_app_inputs: inputs.filled_app_inputs,
                                              expected_steps_digest: plan.steps_digest
                                          }
                                        : {})
                                }
                            },
                            idempotencyKey: submitKey
                        },
                        authorization
                    );
                    if (body.dry_run) {
                        // The adapter only generated the pipeline; nothing runs.
                        // A dry run must not consume the caller's idempotency key:
                        // the key is released so a later real submit is not
                        // answered with this record.
                        const generated = await store.update(parent.id, {
                            status: "planned",
                            idempotency_key: `dry-run:${parent.id}`,
                            adapter_run_ids: [
                                {
                                    adapter_plan_id: adapter.adapter_plan_id,
                                    model_io_id: adapter.model_io_id,
                                    stage: "composite",
                                    run_id: submitted.run_id,
                                    status: submitted.status || "generated",
                                    execution_kind: "composite_workflow"
                                }
                            ],
                            error_message: null,
                            failure_code: null
                        });
                        return {
                            ...parentResponse(generated || { ...parent, status: "planned" }),
                            dry_run: true,
                            tapis_workflow_definition: submitted.tapis_workflow_definition || null
                        };
                    }
                    const modelChildId = modelTask.execution_id;
                    const updated = await store.update(parent.id, {
                        status: "model_running",
                        model_child_id: modelChildId,
                        model_result: {
                            execution_id: modelChildId,
                            ...(requestedMaxMinutes === undefined
                                ? {}
                                : { __max_minutes: requestedMaxMinutes }),
                            ...(requestedQueue === undefined ? {} : { __queue: requestedQueue }),
                            output_uri: modelTask.output_uri,
                            composite_workflow_run_id: submitted.run_id,
                            tapis_workflow_id: submitted.tapis_workflow_id || null,
                            tapis_run_id: submitted.tapis_run_id || null
                        },
                        adapter_run_ids: [
                            {
                                adapter_plan_id: adapter.adapter_plan_id,
                                model_io_id: adapter.model_io_id,
                                stage: "composite",
                                run_id: submitted.run_id,
                                status: submitted.status || "queued",
                                execution_kind: "composite_workflow",
                                tapis_workflow_id: submitted.tapis_workflow_id || null,
                                tapis_run_id: submitted.tapis_run_id || null
                            }
                        ],
                        parameter_values: adapterValues.values,
                        parameter_values_hash: adapterValues.hash,
                        error_message: null,
                        failure_code: null
                    });
                    const responseRecord = updated || {
                        ...parent,
                        status: "model_running",
                        model_child_id: modelChildId,
                        model_result: {
                            execution_id: modelChildId,
                            output_uri: modelTask.output_uri,
                            composite_workflow_run_id: submitted.run_id
                        },
                        adapter_run_ids: [
                            {
                                adapter_plan_id: adapter.adapter_plan_id,
                                model_io_id: adapter.model_io_id,
                                stage: "composite",
                                run_id: submitted.run_id,
                                status: submitted.status || "queued",
                                execution_kind: "composite_workflow"
                            }
                        ]
                    };
                    await persistWorkflowStages(responseRecord);
                    return parentResponse(responseRecord);
                } catch (error) {
                    const isClientError =
                        error instanceof UnifiedExecutionError &&
                        ((error.statusCode >= 400 && error.statusCode < 500) ||
                            hasStructuredAdapterCode(error));
                    const updated = await store.update(parent.id, {
                        status: isClientError ? "failed" : "unknown",
                        failure_code: isClientError
                            ? error.code || "MODEL_SUBMISSION_FAILED"
                            : "MODEL_SUBMISSION_UNKNOWN",
                        error_message: error instanceof Error ? error.message : String(error)
                    });
                    if (isClientError) throw error;
                    return parentResponse(updated || { ...parent, status: "unknown" });
                }
            }
            if (plan.adapter_steps?.length) {
                const existing = await store.getByPlanId(body.plan_id);
                if (existing) return parentResponse(existing);

                const parent = await store.insert({
                    plan_id: body.plan_id,
                    thread_id: plan.thread_id,
                    model_id: plan.model_id,
                    execution_engine: plan.execution_engine,
                    status: "adapter_dispatching",
                    idempotency_key: body.idempotency_key || body.plan_id,
                    plan_hash: planHash(plan),
                    adapter_steps: plan.adapter_steps,
                    adapter_run_ids: [],
                    parameter_values: body.adapter_parameter_values || {},
                    ...jobOptionsResult(requestedMaxMinutes, requestedQueue)
                });
                const children: AdapterChildRun[] = [];
                for (const step of plan.adapter_steps) {
                    const values =
                        body.adapter_parameter_values?.[step.adapter_plan_id] ||
                        (plan.adapter_steps.length === 1 ? body.parameter_values || {} : {});
                    try {
                        const result = await adapterRequest(
                            "/workflows/submit",
                            {
                                method: "POST",
                                body: {
                                    plan_id: step.adapter_plan_id,
                                    args: values,
                                    execution_id: parentRunId(parent.id),
                                    idempotency_key: `${parentRunId(parent.id)}:${step.adapter_plan_id}`
                                },
                                idempotencyKey: `${parentRunId(parent.id)}:${step.adapter_plan_id}`
                            },
                            authorization
                        );
                        children.push({
                            ...step,
                            run_id: result.run_id,
                            status: result.status || "running",
                            execution_kind: "workflow",
                            tapis_workflow_id: result.tapis_workflow_id || null,
                            tapis_run_id: result.tapis_run_id || null
                        });
                        await store.update(parent.id, { adapter_run_ids: children });
                    } catch (error) {
                        // Validation/authentication errors happen before a child
                        // workflow is accepted. Preserve the adapter's 4xx
                        // response so the caller can fix parameters instead of
                        // receiving an ambiguous parent run.
                        if (
                            children.length === 0 &&
                            error instanceof UnifiedExecutionError &&
                            error.statusCode >= 400 &&
                            error.statusCode < 500
                        ) {
                            await store.update(parent.id, {
                                status: "failed",
                                adapter_run_ids: children,
                                error_message: error.message
                            });
                            throw error;
                        }
                        const updated = await store.update(parent.id, {
                            status: "adapter_unknown",
                            adapter_run_ids: children,
                            error_message: error instanceof Error ? error.message : String(error)
                        });
                        return parentResponse(updated || { ...parent, status: "adapter_unknown" });
                    }
                }
                const updated = await store.update(parent.id, {
                    status: "adapter_running",
                    adapter_run_ids: children
                });
                const responseRecord = updated || {
                    ...parent,
                    status: "adapter_running",
                    adapter_run_ids: children
                };
                await persistWorkflowStages(responseRecord);
                return parentResponse(responseRecord);
            }
            const result = await submitLegacy(
                plan,
                authorization,
                undefined,
                requestedMaxMinutes,
                requestedQueue
            );
            const modelChildId = legacyModelExecutionId(result);
            return {
                ...result,
                executor: "ensemble_manager",
                execution_mode: "job",
                parent_execution_id: plan.thread_id,
                model_child_id: modelChildId,
                model_job_id: modelProviderJobId(result) || modelChildId,
                adapter_runs: []
            };
        }
    };
}
