import type { UnifiedParameterDefinition } from "./unifiedExecutionService";

/** One step of a planned flow, as the adapter lists it. */
export interface AdapterPlanStep {
    [key: string]: unknown;
    step?: number;
    name?: string;
    depends_on?: number[];
}

/**
 * A plan's `plan_json` as the adapter returns it. The adapter's JSON is not
 * validated here, so what the service checks while reading stays `unknown`.
 */
export interface AdapterPlanJson {
    [key: string]: unknown;
    parameters?: UnifiedParameterDefinition[];
    steps?: AdapterPlanStep[];
    secrets?: unknown;
    secrets_ready?: unknown;
    sends_data_to?: unknown;
    flow?: {
        collections?: unknown;
        inputs?: unknown;
        linked_settings?: unknown[];
    };
}

/** One output of a flow run, as the adapter reports it. */
export interface AdapterFlowOutput {
    [key: string]: unknown;
    key?: unknown;
    output_id?: unknown;
    editable?: { file?: unknown } | null;
    file_location?: unknown;
    location?: unknown;
    value?: unknown;
}

/** The flow view of a run the adapter reports. */
export interface AdapterFlowView {
    [key: string]: unknown;
    status?: string;
    steps?: Array<{ [key: string]: unknown; step?: number }>;
    outputs?: unknown;
    paused_after_step?: unknown;
    paused_at?: unknown;
    resume_error?: unknown;
    replacement?: unknown;
    resumed_run_id?: string;
}

/** What the adapter reports about a run's output publication. */
export interface AdapterPublication {
    status?: string;
    ckan_dataset?: unknown;
    stac_item?: unknown;
    public?: unknown;
    catalog?: unknown;
    error?: unknown;
}

/**
 * A JSON body from the SVO adapter. Its shape varies by endpoint (plans, runs,
 * bindings), so keys stay open and the fields read from runs are named.
 */
export interface AdapterResponse {
    [key: string]: unknown;
    status?: string;
    run_id?: string;
    output_uri?: string;
    output_data_object_id?: string | null;
    error_message?: string | null;
    tapis_workflow_id?: string | null;
    tapis_run_id?: string | null;
    publication?: AdapterPublication;
    health?: string | null;
    model_job_uuid?: string | null;
    started_at?: string | null;
    // Pipeline runs name their ids differently.
    pipelineId?: string;
    uuid?: string;
    flow?: AdapterFlowView;
    // Data objects the adapter registers.
    id?: string;
    label?: string;
    resource_uri?: string;
    data_object_id?: string;
    output_data_object?: { id?: string };
    plan_id?: string;
    plan_json?: AdapterPlanJson;
    input_steps?: unknown[];
    steps_digest?: string;
}
