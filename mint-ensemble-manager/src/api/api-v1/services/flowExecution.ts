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

/** The catalog id of the input or setting a thread value fills in. */
export interface FlowBinding {
    input?: string;
    parameter?: string;
}

/** What a flow says about how a thread uses it (catalog ids). */
export interface FlowThreadBindings {
    /** The input the thread's region fills in. */
    region?: FlowBinding;
    /** The setting the thread's dates fill in. */
    start_date?: FlowBinding;
    end_date?: FlowBinding;
    /** The inputs that each take a collection: several resources are one input, and one run. */
    collections?: string[];
}

const BINDING_ROLES = ["region", "start_date", "end_date"] as const;

/** The bindings a flow row holds, keeping only what is well formed. */
export function readThreadBindings(stored: unknown): FlowThreadBindings {
    const bindings: FlowThreadBindings = {};
    if (!stored || typeof stored !== "object") return bindings;
    const row = stored as Record<string, unknown>;
    for (const role of BINDING_ROLES) {
        const target = row[role] as Record<string, unknown> | null | undefined;
        if (!target || typeof target !== "object") continue;
        bindings[role] = {
            ...(typeof target.input === "string" ? { input: target.input } : {}),
            ...(typeof target.parameter === "string" ? { parameter: target.parameter } : {})
        };
    }
    if (Array.isArray(row.collections)) {
        bindings.collections = row.collections.filter((id): id is string => typeof id === "string");
    }
    return bindings;
}

export interface FlowThreadContext {
    is_flow: boolean;
    /** The caller the thread was read as. */
    caller?: string;
    /** Which inputs and settings the thread's region and dates fill in, and which inputs take a collection. */
    thread_bindings: FlowThreadBindings;
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
        init: { method?: string; body?: unknown; idempotencyKey?: string; asUser?: boolean },
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

/** The status of a run stopped after a step, waiting for its user to edit a file. Not terminal. */
export const AWAITING_EDIT = "awaiting_edit";

/** A run stopped at its pause is cancelled by the adapter after this many days. */
export const PAUSE_MAX_DAYS = 14;

/** What a person needs to edit a file the flow stopped for. */
export interface FlowPause {
    /** How the adapter names the output to replace, and how a resume must. */
    output_key: string;
    /** The flow output it is, when the flow registered it as a result. */
    model_io_id?: string | null;
    /** The file's name, and where it is (a Tapis location the person downloads it from). */
    file: string | null;
    file_location: string | null;
    paused_after_step: number | null;
    paused_at: string | null;
    /** Why the last continuation failed, when it did: the person may send another edit. */
    error?: string | null;
}

/** An edit the run continued on: who, when, which catalog file, and what was fetched. */
export interface FlowReplacement {
    output: string;
    file?: string | null;
    /** What the file had to be (`lexicon`, `json`): how the result names the edit. */
    check?: string | null;
    url?: string;
    dataset_id?: string | null;
    resource_id?: string | null;
    replaced_by?: string;
    replaced_at?: string;
    original?: string | null;
    sha256?: string;
    bytes?: number;
}

interface FlowChild {
    adapter_plan_id: string;
    model_io_id: string;
    run_id: string;
    status?: string;
    /** The run that paused, once it has been resumed: `run_id` is then the one after the edit. */
    paused_run_id?: string;
    pause?: FlowPause | null;
    /** The pause as it was when the person resumed it, to go back to if the continuation fails. */
    last_pause?: FlowPause | null;
    replacement?: FlowReplacement | null;
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

/** Where the adapter says an output is; an adapter from before it said so gives only the value. */
function whereItIs(output: any): unknown {
    return typeof output?.location === "string" ? output.location : output?.value;
}

function plainText(value: unknown, max = 500): string | undefined {
    return typeof value === "string" && value.length <= max ? value : undefined;
}

/** The pause the adapter reports: the editable output and where its file is. Only what is well formed. */
function readPause(flow: any): FlowPause | null {
    const editable = (Array.isArray(flow?.outputs) ? flow.outputs : []).find(
        (output: any) => output && typeof output.editable === "object" && output.editable
    );
    if (!editable || typeof editable.key !== "string") return null;
    return {
        output_key: editable.key,
        model_io_id: typeof editable.output_id === "string" ? editable.output_id : null,
        file: plainText(editable.editable.file, 200) ?? null,
        file_location: isResultLocation(editable.file_location) ? editable.file_location : null,
        paused_after_step:
            typeof flow.paused_after_step === "number" ? flow.paused_after_step : null,
        paused_at: plainText(flow.paused_at, 100) ?? null,
        error: plainText(flow.resume_error, 2000) ?? null
    };
}

/** The adapter's record of the edit, keeping only the fields of the declared shape. */
function readReplacement(value: any): FlowReplacement | null {
    if (!value || typeof value !== "object" || typeof value.output !== "string") return null;
    const digest = plainText(value.sha256, 64);
    return {
        output: value.output,
        file: plainText(value.file, 200) ?? null,
        check: plainText(value.check, 50) ?? null,
        url: plainText(value.url, 2000),
        dataset_id: plainText(value.dataset_id, 200) ?? null,
        resource_id: plainText(value.resource_id, 200) ?? null,
        replaced_by: plainText(value.replaced_by, 200),
        replaced_at: plainText(value.replaced_at, 100),
        original: isResultLocation(value.original) ? value.original : null,
        ...(digest && /^[0-9a-f]{64}$/.test(digest) ? { sha256: digest } : {}),
        ...(typeof value.bytes === "number" ? { bytes: value.bytes } : {})
    };
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

/** A secret the flow's pieces need from the runner: names only, never a value. */
export interface FlowRequiredSecret {
    name: string;
    label: string;
    /** The field names the steps need. */
    fields: string[];
    /** The positions of the steps that use it. */
    steps: number[];
    /** Whether the runner has stored it with the adapter. */
    stored: boolean;
}

/** What a step says it sends, and to whom, for the runner to read before running. */
export interface FlowSendsData {
    step: number;
    piece: string;
    service: string;
    what: string;
}

/**
 * The secrets a flow plan asks for, as the adapter planned them. The adapter holds
 * the runner's secrets; this passes on what is needed and whether it is stored.
 */
function readSecrets(planJson: any): {
    required_secrets: FlowRequiredSecret[];
    secrets_ready: boolean;
    sends_data_to: FlowSendsData[];
} {
    const listed = Array.isArray(planJson?.secrets) ? planJson.secrets : [];
    const required_secrets: FlowRequiredSecret[] = listed
        .filter((item: any) => item && typeof item.name === "string")
        .map((item: any) => ({
            name: item.name,
            label: typeof item.label === "string" ? item.label : item.name,
            fields: Array.isArray(item.fields) ? item.fields.map(String) : [],
            steps: Array.isArray(item.steps) ? item.steps.map(Number) : [],
            stored: item.stored === true
        }));
    const sends = Array.isArray(planJson?.sends_data_to) ? planJson.sends_data_to : [];
    return {
        required_secrets,
        secrets_ready:
            typeof planJson?.secrets_ready === "boolean"
                ? planJson.secrets_ready
                : required_secrets.every((item) => item.stored),
        sends_data_to: sends
            .filter((item: any) => item && typeof item.service === "string")
            .map((item: any) => ({
                step: Number(item.step),
                piece: String(item.piece ?? ""),
                service: item.service,
                what: String(item.what ?? "")
            }))
    };
}

/**
 * Plan a flow for a thread, or return null when the thread's model is not a flow.
 *
 * Each dataset the thread bound to a flow input is registered with the adapter,
 * which then plans the flow's own graph. Nothing is searched for. An input the flow
 * marks as taking a collection is sent with all its resources instead, as one input.
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
    const collections: Record<
        string,
        { label: string; resources: { name: string; url: string }[] }
    > = {};
    const takesCollection = new Set(context.thread_bindings.collections || []);
    const regionInput = context.thread_bindings.region?.input;
    let region: { input: string; source: InputSource } | undefined;
    for (const input of context.inputs) {
        if (takesCollection.has(input.model_io_id) && input.resources.length) {
            // Every resource is one input made of many files, in the order the
            // thread holds them. Nothing is registered here: the adapter gathers
            // the files into one folder when the flow runs.
            collections[input.model_io_id] = {
                label: input.name,
                resources: input.resources.map(({ name, url }) => ({ name, url }))
            };
            continue;
        }
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
                asUser: true,
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
            asUser: true,
            method: "POST",
            body: {
                flow_id: threadmodel.model_id,
                inputs,
                ...(Object.keys(collections).length ? { collections } : {}),
                ...(region ? { region } : {})
            }
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
        ...readSecrets(planned.plan_json),
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
        tapis_workflow_id: polled?.tapis_workflow_id || child.tapis_workflow_id || null,
        tapis_run_id: polled?.tapis_run_id || child.tapis_run_id || null,
        steps: Array.isArray(polled?.flow?.steps) ? polled.flow.steps : child.steps,
        error_message: polled?.error_message || null,
        replacement: readReplacement(polled?.flow?.replacement) ?? child.replacement ?? null
    };
    const executionId = record.model_child_id || null;

    if (
        status === "resumed" &&
        typeof polled?.flow?.resumed_run_id === "string" &&
        polled.flow.resumed_run_id !== child.run_id
    ) {
        // The adapter resumed this run, but this record never learned the new run's id
        // (the write after the resume failed). The run after the edit is the one to
        // follow from here on.
        const adopted: FlowChild = {
            ...next,
            paused_run_id: child.paused_run_id || child.run_id,
            last_pause: child.pause || child.last_pause || null,
            pause: null,
            run_id: polled.flow.resumed_run_id,
            status: "running",
            tapis_workflow_id: null,
            tapis_run_id: null,
            error_message: null
        };
        const updated = await deps.store.update(record.id, {
            status: "adapter_running",
            adapter_run_ids: [adopted],
            failure_code: null,
            error_message: null
        });
        return updated || { ...record, status: "adapter_running", adapter_run_ids: [adopted] };
    }
    if (status === AWAITING_EDIT) {
        // The first part of the flow ended at its pause. The run, the thread's one
        // open run of this flow and its execution all stay open; nothing is filed.
        const pause = readPause(polled.flow);
        const updated = await deps.store.update(record.id, {
            status: AWAITING_EDIT,
            adapter_run_ids: [
                { ...next, status: AWAITING_EDIT, pause, error_message: pause?.error ?? null }
            ],
            error_message: pause?.error ?? null
        });
        return (
            updated || { ...record, status: AWAITING_EDIT, adapter_run_ids: [{ ...next, pause }] }
        );
    }
    if (status === "failed" && child.paused_run_id) {
        // What continued from the person's edit failed (most often the edit itself
        // was refused). The run goes back to its pause with the reason, so the person
        // can send another edit; it is not closed.
        const message = next.error_message || "the run after the edit failed";
        const back: FlowChild = {
            ...next,
            run_id: child.paused_run_id,
            status: AWAITING_EDIT,
            pause: { ...(child.last_pause as FlowPause), error: message },
            error_message: message
        };
        const updated = await deps.store.update(record.id, {
            status: AWAITING_EDIT,
            adapter_run_ids: [back],
            error_message: message
        });
        return updated || { ...record, status: AWAITING_EDIT, adapter_run_ids: [back] };
    }

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
                    isResultLocation(whereItIs(output))
            )
            .map((output: any) => ({
                model_io_id: output.output_id as string,
                name: names.get(output.output_id) as string,
                url: whereItIs(output) as string
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
            model_result: {
                outputs,
                ...(next.replacement ? { replacement: next.replacement } : {})
            }
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

/**
 * Continue a run stopped at its pause, on the edited file the person uploaded to the
 * data catalog. Only the person who started the run may, and they must still be able
 * to change the thread. The adapter fetches the file as them, refuses one the pieces
 * could not load, and starts the rest of the flow; this keeps the thread's run open
 * and follows the new run from here on. If the adapter refuses, the run stays paused.
 */
export async function resumeFlow(
    deps: FlowDeps,
    plan: { thread_id: string; model_id: string; flow: FlowPlan },
    record: UnifiedExecutionRecord,
    body: any,
    authorization: string | undefined
): Promise<UnifiedExecutionRecord> {
    if (!authorization) {
        throw new UnifiedExecutionError(
            401,
            "a Tapis token is required to resume a flow",
            "AUTH_REQUIRED"
        );
    }
    const child = ((record.adapter_run_ids || []) as FlowChild[])[0];
    if (record.status !== AWAITING_EDIT || !child?.run_id) {
        throw new UnifiedExecutionError(
            409,
            "this run is not waiting for an edit",
            "FLOW_NOT_AWAITING_EDIT"
        );
    }
    // Before anything is sent: the caller may change this thread, and is the person
    // who started the run (its plan is theirs).
    const context = await deps.flows.flowContext(
        { thread_id: plan.thread_id, model_id: plan.model_id },
        authorization,
        "write"
    );
    if (!context.is_flow || !context.caller || context.caller !== plan.flow.planned_by) {
        throw new UnifiedExecutionError(
            403,
            "only the user who started this run may resume it",
            "FLOW_RESUME_NOT_YOURS"
        );
    }
    const replacements = body?.replacements;
    const keys =
        replacements && typeof replacements === "object" && !Array.isArray(replacements)
            ? Object.keys(replacements)
            : [];
    const given = keys.length === 1 ? replacements[keys[0]] : null;
    if (!given || typeof given.url !== "string" || given.url.length > 2000) {
        throw new UnifiedExecutionError(
            422,
            "a resume gives one edited file for the one output the flow stopped for",
            "FLOW_REPLACEMENT_INVALID"
        );
    }
    if (child.pause?.output_key && keys[0] !== child.pause.output_key) {
        throw new UnifiedExecutionError(
            422,
            "the file to replace is not the one this run stopped for",
            "FLOW_REPLACEMENT_NOT_EDITABLE",
            { editable: [child.pause.output_key] }
        );
    }
    let result: any;
    try {
        result = await deps.adapterRequest(
            `/runs/${encodeURIComponent(child.run_id)}/resume`,
            {
                method: "POST",
                body: {
                    replacements: {
                        [keys[0]]: {
                            url: given.url,
                            ...(typeof given.dataset_id === "string"
                                ? { dataset_id: given.dataset_id }
                                : {}),
                            ...(typeof given.resource_id === "string"
                                ? { resource_id: given.resource_id }
                                : {})
                        }
                    }
                }
            },
            authorization
        );
    } catch (error) {
        if ((error as { code?: string })?.code === "RUN_NOT_AWAITING_EDIT") {
            // The adapter already resumed this run: an earlier resume got through but
            // this record was not updated. Follow what the adapter has instead of
            // refusing for good.
            const followed = await reconcileFlow(deps, record, authorization);
            if (followed.status !== AWAITING_EDIT) return followed;
        }
        throw error;
    }
    if (typeof result?.run_id !== "string") {
        throw new UnifiedExecutionError(
            502,
            "SVO adapter returned an incomplete resume",
            "FLOW_RESUME_INVALID"
        );
    }
    const resumed: FlowChild = {
        ...child,
        paused_run_id: child.paused_run_id || child.run_id,
        last_pause: child.pause || child.last_pause || null,
        pause: null,
        run_id: result.run_id,
        status: result.status || "running",
        tapis_workflow_id: result.tapis_workflow_id || result.pipelineId || null,
        tapis_run_id: result.tapis_run_id || result.uuid || null,
        steps: child.steps,
        error_message: null
    };
    // The adapter has resumed the run. If this write fails the answer is still the
    // resumed run, and the next look at the run (a poll of the paused one reports
    // "resumed" and the run that followed) brings the record up to date.
    const updated = await deps.store
        .update(record.id, {
            status: "adapter_running",
            adapter_run_ids: [resumed],
            failure_code: null,
            error_message: null
        })
        .catch(() => null);
    return updated || { ...record, status: "adapter_running", adapter_run_ids: [resumed] };
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
