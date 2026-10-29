import crypto from "crypto";
import { getConfiguration } from "@/classes/mint/mint-functions";
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

export class UnifiedExecutionError extends Error {
    constructor(
        public statusCode: number,
        message: string,
        public code?: string,
        public details?: unknown
    ) {
        super(message);
        this.name = "UnifiedExecutionError";
    }
}

interface LegacyPlan {
    executor: "ensemble_manager";
    thread_id: string;
    model_id: string;
    execution_engine: string;
    adapter_steps?: AdapterStep[];
    post_model_adapter?: PostModelAdapter;
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
    plan_json?: { parameters?: UnifiedParameterDefinition[]; [key: string]: unknown };
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
    return `em_${encoded}.${signature}`;
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
        const details =
            detail && typeof detail === "object" ? detail : body?.details ?? detail;
        throw new UnifiedExecutionError(response.status, message, code, details);
    }
    return body;
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
    const values = adapter
        ? body.adapter_parameter_values?.[adapter.adapter_plan_id] || body.parameter_values || {}
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
    const withDefaults = { ...values };
    for (const parameter of adapter?.parameters || []) {
        if (withDefaults[parameter.name] === undefined && parameter.default !== undefined) {
            withDefaults[parameter.name] = parameter.default;
        }
    }
    return { values: withDefaults, hash: parameterValuesHash(withDefaults) };
}

function parentRunId(id: string): string {
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
            error_message: child.error_message || null
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
                output_uri: string;
                output_name: string;
                output_format?: string;
                job_definition: unknown;
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
            const outputUri = modelResult?.output_uri;
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
                            error_message: "Composite workflow completed without a discoverable final output URI"
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
                    const updated = await store.update(record.id, {
                        status: nextStatus,
                        adapter_run_ids: adapterChildren,
                        model_result: nextModelResult,
                        error_message: run.error_message || null,
                        failure_code: run.status === "failed" ? "COMPOSITE_WORKFLOW_FAILED" : null
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
                child.status = run.status;
                child.output_data_object_id = run.output_data_object_id || null;
                child.error_message = run.error_message || null;
                child.tapis_workflow_id = run.tapis_workflow_id || child.tapis_workflow_id || null;
                child.tapis_run_id = run.tapis_run_id || child.tapis_run_id || null;
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
                                      : {})
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
                output_handoff: { ...handoff, bound_plan_id: binding.bound_plan_id },
                error_message: null
            });
            return parentResponse(updated || { ...record, status: "adapter_running" });
        } catch (error) {
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
            const updated = await store.update(record.id, {
                status: "adapter_running",
                adapter_run_ids: children
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

    return {
        async createPlan(body: any, authorization?: string) {
            const executor = body?.executor as UnifiedExecutor;
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
            const plan: LegacyPlan = {
                executor,
                thread_id: body.thread_id,
                model_id: body.model_id,
                execution_engine:
                    body.execution_engine || getConfiguration().execution_engine || "localex"
            };
            if (body.post_model_adapter !== undefined) {
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
                const adapter = body.post_model_adapter;
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
                post_model_adapter: plan.post_model_adapter || null
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
                                idempotency_key: `${parentRunId(parent.id)}:${adapter.adapter_plan_id}:${adapterValues.hash}`,
                                model_task: {
                                    stage_id: "model",
                                    output_uri: modelTask.output_uri,
                                    output_name: modelTask.output_name,
                                    output_format: modelTask.output_format || "",
                                    max_minutes: requestedMaxMinutes,
                                    job_definition: modelTask.job_definition
                                }
                            },
                            idempotencyKey: `${parentRunId(parent.id)}:${adapter.adapter_plan_id}:${adapterValues.hash}`
                        },
                        authorization
                    );
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
                        error.statusCode >= 400 &&
                        error.statusCode < 500;
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
