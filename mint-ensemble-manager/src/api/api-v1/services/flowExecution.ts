/**
 * Running a flow from a modeling thread.
 *
 * A flow is a model configuration that runs a graph of ETL pieces instead of a
 * Tapis app. The SVO adapter plans it and runs it as one Tapis Workflows
 * pipeline; this module is the thread's side of that: it binds the thread's
 * datasets and dates to the flow, records the run where the thread's screens
 * look for it, follows it step by step, and files each of the flow's outputs as
 * a result. No Tapis job is submitted or read here.
 *
 * The unified execution service calls in at three points (plan, submit, follow)
 * and passes in what it owns: its store and its way of calling the adapter.
 */
import { UnifiedExecutionError } from "@/classes/common/errors";
import { Region } from "@/classes/mint/mint-types";
import { deriveRegionSource, InputSource, RegionGeometryError } from "./inputStepDerivation";
import { UnifiedExecutionRecord, UnifiedExecutionStore } from "./unifiedExecutionStore";

/** What the plan id carries for a flow. Small: the plan id is an indexed column. */
export interface FlowPlan {
    adapter_plan_id: string;
    /** Who planned it. The plan holds that user's datasets, so only they may run it. */
    planned_by: string;
}

export interface FlowInputBinding {
    model_io_id: string;
    name: string;
    format?: string;
    standard_variables: string[];
    optional: boolean;
    resources: { id: string; name: string; url: string }[];
}

export interface FlowThreadContext {
    is_flow: boolean;
    /** The caller the thread was read as. */
    caller?: string;
    /** Which input or setting the thread's region and dates fill in (catalog ids). */
    thread_bindings: Record<string, { input?: string; parameter?: string }>;
    inputs: FlowInputBinding[];
    /** The flow's settings as the thread has them: catalog parameter id -> name and value. */
    parameters: { id: string; name: string; value?: string }[];
    outputs: { model_io_id: string; name: string }[];
    dates?: { start_date?: string; end_date?: string };
    /** The thread's region, for the input the flow marks as its region. */
    region?: Region | null;
}

/** The thread's side of a flow run: reads the thread and writes its run records. */
export interface FlowThreadService {
    /**
     * What the thread bound to the flow, read as the caller. `write` also requires
     * that the caller may change the thread, as running a flow in it does.
     */
    flowContext(
        threadmodel: { thread_id: string; model_id: string },
        authorization: string,
        access?: "read" | "write"
    ): Promise<FlowThreadContext>;
    /** Record a run that is about to start, for a caller who may change the thread. Returns the execution's id. */
    startFlowExecution(
        threadId: string,
        modelId: string,
        runId: string,
        authorization: string
    ): Promise<string>;
    /** Close the run's record, filing each output as a result. Safe to call twice. */
    finishFlowExecution(
        threadId: string,
        modelId: string,
        executionId: string,
        status: "completed" | "failed",
        outputs: { model_io_id: string; name: string; url: string }[]
    ): Promise<void>;
}

export interface FlowDeps {
    store: UnifiedExecutionStore;
    adapterRequest(
        path: string,
        init: { method?: string; body?: unknown; idempotencyKey?: string },
        authorization?: string
    ): Promise<any>;
    parentRunId(id: string): string;
    flows: FlowThreadService;
}

export interface FlowStage {
    stage_id: string;
    type: "flow_step";
    name?: string;
    depends_on: string[];
    status: string;
    provider: string;
    provider_ids: Record<string, string>;
    error_message?: string | null;
}

interface FlowChild {
    adapter_plan_id: string;
    model_io_id: string;
    run_id: string;
    status?: string;
    execution_kind: "workflow";
    stage: "flow";
    tapis_workflow_id?: string | null;
    tapis_run_id?: string | null;
    error_message?: string | null;
    steps?: Array<Record<string, any>>;
    /** The flow's outputs as its submitter saw them, to file each as a result. */
    outputs?: { model_io_id: string; name: string }[];
}

const TERMINAL = new Set(["completed", "failed"]);
/** How long a submission may sit with no pipeline before it is taken as interrupted. */
const DISPATCH_GRACE_MS = 60 * 1000;
const ABANDONED_MS = 10 * 60 * 1000;

const RUN_STATUS: Record<string, string> = {
    completed: "completed",
    finished: "completed",
    normal_completion: "completed",
    failed: "failed",
    error: "failed",
    terminated: "failed",
    cancelled: "cancelled"
};

const TAPIS_LOCATION = /^tapis:\/\/[A-Za-z0-9][A-Za-z0-9._-]*\/[^\s\u0000-\u001f]*$/;

/**
 * A result's location comes from what a piece printed. It becomes a link on the
 * thread's results screen and a folder the files view lists, so only a plain
 * Tapis location is taken: nothing a browser would run, and no climbing out of
 * a folder.
 */
function isResultLocation(value: unknown): value is string {
    return (
        typeof value === "string" &&
        value.length <= 2000 &&
        TAPIS_LOCATION.test(value) &&
        !value.split("/").includes("..")
    );
}

function ageMs(record: UnifiedExecutionRecord): number {
    const stamp = Date.parse(String(record.updated_at || record.created_at || ""));
    return Number.isNaN(stamp) ? 0 : Date.now() - stamp;
}

/** A submission that was recorded but whose pipeline was never started. */
function neverStarted(record: UnifiedExecutionRecord): boolean {
    return record.status === "adapter_dispatching" && !(record.adapter_run_ids || []).length;
}

/** Settings the thread itself fills in: its own values, then its dates where the flow asks. */
function threadValues(context: FlowThreadContext): Record<string, unknown> {
    const values: Record<string, unknown> = {};
    const nameOf = new Map(context.parameters.map((parameter) => [parameter.id, parameter.name]));
    for (const parameter of context.parameters) {
        if (parameter.value !== undefined && parameter.value !== null && parameter.value !== "") {
            values[parameter.name] = parameter.value;
        }
    }
    for (const role of ["start_date", "end_date"] as const) {
        const name = nameOf.get(context.thread_bindings[role]?.parameter || "");
        const date = context.dates?.[role];
        if (name && date) values[name] = date;
    }
    return values;
}

/**
 * Plan a flow for a thread, or return null when the thread's model is not a flow.
 *
 * Each dataset the thread bound to a flow input is registered with the adapter,
 * which then plans the flow's own graph. Nothing is searched for.
 */
export async function planFlow(
    deps: FlowDeps,
    threadmodel: { thread_id: string; model_id: string },
    authorization: string | undefined
) {
    if (!authorization) return null;
    const context = await deps.flows.flowContext(threadmodel, authorization);
    if (!context.is_flow) return null;
    if (!context.caller) {
        throw new UnifiedExecutionError(
            401,
            "a Tapis token is required to plan a flow",
            "AUTH_REQUIRED"
        );
    }

    const inputs: Record<string, string> = {};
    const regionInput = context.thread_bindings.region?.input;
    let region: { input: string; source: InputSource } | undefined;
    for (const input of context.inputs) {
        if (input.resources.length > 1) {
            // One run of the flow per dataset is not built yet.
            throw new UnifiedExecutionError(
                422,
                `the flow input ${input.name} has ${input.resources.length} datasets bound; a flow takes one dataset per input`,
                "FLOW_FANOUT_UNSUPPORTED",
                { input: input.model_io_id, datasets: input.resources.length }
            );
        }
        const resource = input.resources[0];
        if (!resource && input.model_io_id === regionInput && context.region) {
            // No dataset is bound to the input the flow marks as its region: the
            // thread's own region fills it, shaped as it is for a model's input.
            try {
                region = { input: input.model_io_id, source: deriveRegionSource(context.region) };
            } catch (error) {
                if (!(error instanceof RegionGeometryError)) throw error;
                throw new UnifiedExecutionError(422, error.message, "FLOW_REGION_INVALID", {
                    input: input.model_io_id
                });
            }
            continue;
        }
        if (!resource) {
            if (input.optional) continue;
            throw new UnifiedExecutionError(
                422,
                `the flow input ${input.name} has no dataset bound`,
                "FLOW_INPUT_UNBOUND",
                { input: input.model_io_id }
            );
        }
        const registered = await deps.adapterRequest(
            "/data-objects",
            {
                method: "POST",
                body: {
                    label: resource.name || input.name,
                    resource_uri: resource.url,
                    ...(input.format ? { format: input.format } : {}),
                    variables: input.standard_variables.map((uri) => ({
                        standard_variable_uri: uri
                    }))
                }
            },
            authorization
        );
        if (typeof registered?.id !== "string") {
            throw new UnifiedExecutionError(
                502,
                "SVO adapter returned an incomplete data object",
                "ADAPTER_DATA_OBJECT_INVALID"
            );
        }
        inputs[input.model_io_id] = registered.id;
    }

    const planned = await deps.adapterRequest(
        "/plans/flow",
        {
            method: "POST",
            body: { flow_id: threadmodel.model_id, inputs, ...(region ? { region } : {}) }
        },
        authorization
    );
    if (typeof planned?.plan_id !== "string") {
        throw new UnifiedExecutionError(
            502,
            "SVO adapter returned an incomplete flow plan",
            "FLOW_PLAN_INVALID"
        );
    }
    const parameters: Array<Record<string, any>> = planned.plan_json?.parameters || [];
    return {
        flow: { adapter_plan_id: planned.plan_id, planned_by: context.caller } as FlowPlan,
        parameters,
        parameter_values: threadValues(context),
        // What the flow's author chose for pieces that run with the runner's token.
        // The runner sees these before running, and says so at submit.
        flow_settings: {
            defaults: Object.fromEntries(
                parameters
                    .filter((parameter) => parameter.default_source === "flow")
                    .map((parameter) => [parameter.name, parameter.default])
            ),
            links: planned.plan_json?.flow?.linked_settings || []
        },
        steps: (planned.plan_json?.steps || []).map((step: any) => ({
            step: step.step,
            name: step.name,
            depends_on: step.depends_on || []
        }))
    };
}

/** Start a planned flow. One run record, one execution, one pipeline. */
export async function submitFlow(
    deps: FlowDeps,
    plan: { thread_id: string; model_id: string; execution_engine: string; flow: FlowPlan },
    planId: string,
    planHash: string,
    body: any,
    authorization: string | undefined
): Promise<UnifiedExecutionRecord> {
    if (!authorization) {
        throw new UnifiedExecutionError(
            401,
            "a Tapis token is required to run a flow",
            "AUTH_REQUIRED"
        );
    }
    // Before anything is read back or written: the caller may change this thread,
    // and this is the plan they made. A plan carries its planner's datasets.
    const context = await deps.flows.flowContext(
        { thread_id: plan.thread_id, model_id: plan.model_id },
        authorization,
        "write"
    );
    if (!context.is_flow || !context.caller || context.caller !== plan.flow.planned_by) {
        throw new UnifiedExecutionError(
            403,
            "this flow plan was made by someone else; plan the flow again to run it",
            "FLOW_PLAN_NOT_YOURS"
        );
    }
    const existing = await deps.store.getByPlanId(planId);
    // A submission cut short after it was recorded (the service stopped, or the
    // record could not be written) is taken up again. The adapter starts one
    // pipeline per run id however often it is asked.
    const resume = existing && neverStarted(existing) && ageMs(existing) > DISPATCH_GRACE_MS;
    if (existing && !resume) return existing;
    if (!existing && deps.store.listByThread) {
        // One open run of a flow per thread: starting a run resets the thread's
        // counts, and an earlier run finishing later would be counted on them.
        const open = (await deps.store.listByThread(plan.thread_id, plan.model_id)).find(
            (other) =>
                other.plan_id !== planId &&
                !TERMINAL.has(other.status) &&
                !(neverStarted(other) && ageMs(other) > ABANDONED_MS)
        );
        if (open) {
            throw new UnifiedExecutionError(
                409,
                "this thread already has a run of this flow in progress; wait for it or cancel it",
                "FLOW_ALREADY_RUNNING",
                { run_id: deps.parentRunId(open.id) }
            );
        }
    }
    // The caller's values win over what the thread holds.
    const values = existing
        ? ((existing.parameter_values || {}) as Record<string, unknown>)
        : { ...threadValues(context), ...(body.parameter_values || {}) };

    const parent =
        existing ||
        (await deps.store.insert({
            plan_id: planId,
            thread_id: plan.thread_id,
            model_id: plan.model_id,
            execution_engine: plan.execution_engine,
            status: "adapter_dispatching",
            idempotency_key: body.idempotency_key || planId,
            plan_hash: planHash,
            adapter_steps: [],
            adapter_run_ids: [],
            parameter_values: values
        }));
    const runId = deps.parentRunId(parent.id);
    let executionId: string | null = parent.model_child_id || null;
    try {
        if (!executionId) {
            executionId = await deps.flows.startFlowExecution(
                plan.thread_id,
                plan.model_id,
                runId,
                authorization
            );
            // Kept at once, so a submission taken up again reuses this record.
            await deps.store.update(parent.id, { model_child_id: executionId });
        }
        const result = await deps.adapterRequest(
            "/workflows/submit",
            {
                method: "POST",
                body: {
                    plan_id: plan.flow.adapter_plan_id,
                    args: values,
                    accept_flow_settings: body.accept_flow_settings === true,
                    idempotency_key: `${runId}:${plan.flow.adapter_plan_id}`
                },
                idempotencyKey: `${runId}:${plan.flow.adapter_plan_id}`
            },
            authorization
        );
        const child: FlowChild = {
            adapter_plan_id: plan.flow.adapter_plan_id,
            model_io_id: "",
            run_id: result.run_id,
            status: result.status || "running",
            execution_kind: "workflow",
            stage: "flow",
            tapis_workflow_id: result.tapis_workflow_id || null,
            tapis_run_id: result.tapis_run_id || null,
            outputs: context.outputs
        };
        const updated = await deps.store.update(parent.id, {
            status: "adapter_running",
            adapter_run_ids: [child],
            model_child_id: executionId
        });
        return updated || { ...parent, status: "adapter_running", adapter_run_ids: [child] };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await deps.store.update(parent.id, {
            status: "failed",
            failure_code:
                error instanceof UnifiedExecutionError && error.code
                    ? error.code
                    : "FLOW_SUBMISSION_FAILED",
            error_message: message,
            model_child_id: executionId
        });
        if (executionId) {
            await deps.flows
                .finishFlowExecution(plan.thread_id, plan.model_id, executionId, "failed", [])
                .catch(() => undefined);
        }
        throw error;
    }
}

/** Ask the adapter how the run is doing and bring the thread's records up to date. */
export async function reconcileFlow(
    deps: FlowDeps,
    record: UnifiedExecutionRecord,
    authorization: string | undefined
): Promise<UnifiedExecutionRecord> {
    if (TERMINAL.has(record.status)) return record;
    const child = ((record.adapter_run_ids || []) as FlowChild[])[0];
    if (!child?.run_id) return record;

    let polled: any;
    try {
        polled = await deps.adapterRequest(
            `/runs/${encodeURIComponent(child.run_id)}/poll`,
            { method: "POST" },
            authorization
        );
    } catch (error) {
        // The adapter or Tapis could not be asked. The run itself is not known to
        // have failed, so its record is left as it is.
        return record;
    }
    // The adapter's own word for the run where it gives one; Tapis's otherwise.
    const raw = String(polled?.flow?.status || polled?.status || child.status || "running");
    const status = RUN_STATUS[raw.toLowerCase()] || raw.toLowerCase();
    const next: FlowChild = {
        ...child,
        status,
        steps: Array.isArray(polled?.flow?.steps) ? polled.flow.steps : child.steps,
        error_message: polled?.error_message || null
    };
    const executionId = record.model_child_id || null;

    if (status === "completed") {
        // The outputs as the submitter saw them, kept with the run: closing a run
        // must not depend on who is asking or on a read that can fail.
        const names = new Map((child.outputs || []).map((o) => [o.model_io_id, o.name]));
        // Only an output the flow registered, and whose step reported where it is.
        const outputs = (Array.isArray(polled?.flow?.outputs) ? polled.flow.outputs : [])
            .filter(
                (output: any) =>
                    typeof output?.output_id === "string" &&
                    names.has(output.output_id) &&
                    isResultLocation(output.value)
            )
            .map((output: any) => ({
                model_io_id: output.output_id as string,
                name: names.get(output.output_id) as string,
                url: output.value as string
            }));
        if (names.size && !outputs.length) {
            // Every step finished, yet none said where an output is. Filing the run
            // as done with nothing to show would hide that for good.
            if (executionId) {
                await deps.flows.finishFlowExecution(
                    record.thread_id,
                    record.model_id,
                    executionId,
                    "failed",
                    []
                );
            }
            const message = "the flow finished but its steps did not report where its outputs are";
            const unreported = await deps.store.update(record.id, {
                status: "failed",
                adapter_run_ids: [{ ...next, error_message: message }],
                failure_code: "FLOW_OUTPUTS_UNREPORTED",
                error_message: message
            });
            return unreported || { ...record, status: "failed", adapter_run_ids: [next] };
        }
        if (executionId) {
            await deps.flows.finishFlowExecution(
                record.thread_id,
                record.model_id,
                executionId,
                "completed",
                outputs
            );
        }
        const updated = await deps.store.update(record.id, {
            status: "completed",
            adapter_run_ids: [next],
            model_result: { outputs }
        });
        return updated || { ...record, status: "completed", adapter_run_ids: [next] };
    }
    if (status === "failed" || status === "cancelled") {
        if (executionId) {
            await deps.flows.finishFlowExecution(
                record.thread_id,
                record.model_id,
                executionId,
                "failed",
                []
            );
        }
        const updated = await deps.store.update(record.id, {
            status: "failed",
            adapter_run_ids: [next],
            failure_code: status === "cancelled" ? "CANCELLED_BY_USER" : "FLOW_FAILED",
            error_message: next.error_message || `the flow run ${status}`
        });
        return updated || { ...record, status: "failed", adapter_run_ids: [next] };
    }
    const updated = await deps.store.update(record.id, { adapter_run_ids: [next] });
    return updated || { ...record, adapter_run_ids: [next] };
}

/** One stage per step of the flow. There is no model stage: a flow has no model job. */
export function flowStages(record: UnifiedExecutionRecord): FlowStage[] {
    const child = ((record.adapter_run_ids || []) as FlowChild[])[0];
    const providerIds: Record<string, string> = {};
    if (child?.tapis_workflow_id) providerIds.workflow_id = child.tapis_workflow_id;
    if (child?.tapis_run_id) providerIds.run_id = child.tapis_run_id;
    const steps = child?.steps || [];
    if (!steps.length) {
        // Before the first poll the steps are not known: show the run as one stage.
        return [
            {
                stage_id: "flow",
                type: "flow_step",
                depends_on: [],
                status: String(child?.status || record.status || "planned"),
                provider: "tapis-workflows",
                provider_ids: providerIds,
                error_message: record.error_message || null
            }
        ];
    }
    return steps.map((step) => ({
        stage_id: `step-${step.step}`,
        type: "flow_step" as const,
        name: typeof step.name === "string" ? step.name : undefined,
        depends_on: (Array.isArray(step.depends_on) ? step.depends_on : []).map(
            (number: unknown) => `step-${number}`
        ),
        status: String(step.status || "pending"),
        provider: "tapis-workflows",
        provider_ids: {
            ...providerIds,
            ...(typeof step.task_id === "string" ? { task_id: step.task_id } : {})
        },
        error_message: step.status === "failed" ? step.message || null : null
    }));
}
