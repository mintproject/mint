import { env } from "process";

export type Scalars = {
    ID: { input: string; output: string };
    String: { input: string; output: string };
    Boolean: { input: boolean; output: boolean };
    Int: { input: number; output: number };
    Float: { input: number; output: number };
    date: { input: any; output: any };
    float8: { input: any; output: any };
    geography: { input: any; output: any };
    geometry: { input: any; output: any };
    problem_statement_events: { input: any; output: any };
    task_events: { input: any; output: any };
    thread_events: { input: any; output: any };
    timestamp: { input: any; output: any };
    timestamptz: { input: any; output: any };
    uuid: { input: any; output: any };
};

export interface IdMap<T> {
    [id: string]: T;
}

export interface IdNameObject {
    id?: string;
    name?: string;
}

export interface User {
    email: string;
    uid: string;
    region: string;
    graph: string;
}

export interface AppState {
    page: string;
    subpage: string;
    user?: User;
    prefs?: UserPreferences;
}

export interface UserPreferences {
    mint: MintPreferences;
}

interface TapisConfig {
    username: string;
    basePath: string;
    dataurl: string;
    datadir: string;
    parallelism: number;
    password: string;
}

interface OpenAPIServer {
    url: string;
    description?: string;
}

export interface MintPreferences {
    data_catalog_api: string;
    data_catalog_type?: string;
    data_catalog_key?: string;
    data_catalog_extra?: {
        owner_organization_id?: string;
        owner_provenance_id?: string;
        default_dataset_id?: string;
    };

    data_server_type?: string;
    data_server_extra?: {
        region?: string;
        bucket?: string;
        access_key?: string;
        secret_access_key?: string;
    };

    ensemble_manager_api: string;
    /** Internal SVO adapter URL used by the unified plan/submit boundary. */
    svo_adapter_api?: string;
    /** HMAC secret used to sign opaque legacy unified-plan identifiers. */
    unified_plan_secret?: string;
    /**
     * Optional override for the base URL Tapis uses to deliver job notification webhooks.
     * When unset, falls back to `${ensemble_manager_api}/tapis`. Use this in dev clusters
     * whose ingress hostnames are not publicly resolvable (e.g. *.local) to point Tapis at
     * a publicly reachable target such as https://webhook.site/<uuid>.
     */
    tapis_webhook_base_url?: string;
    ingestion_api: string;
    visualization_url: string;
    execution_engine?: "wings" | "localex" | "tapis";

    // Local Execution
    localex?: LocalExecutionPreferences;

    // Kubernetes Preferences
    kubernetes?: KubernetesPreferences;

    // Wings Execution
    wings?: WingsPreferences;
    graphql?: GraphQLPreferences;

    //auth
    auth_server: string;
    auth_realm: string;
    auth_client_id: string;
    auth?: {
        client_id: string;
        authorization_url: string;
        public_key: string;
        algorithms: string[];
    };

    // Tapis Preferences
    tapis?: TapisConfig;

    // Remove unused fields
    wings_api?: string;
    google_maps_key?: string;
    apiKey?: string;
    authDomain?: string;
    databaseURL?: string;
    projectId?: string;
    storageBucket?: string;
    messagingSenderId?: string;
    appId?: string;
    cromo_api?: string;

    // OpenAPI Configuration
    openapi?: {
        servers?: OpenAPIServer[];
    };
}

export interface KubernetesPreferences {
    use?: boolean;
    node_affinity?: boolean;
    namespace?: string;
    cpu_limit?: string;
    memory_limit?: string;
}

export interface GraphQLPreferences {
    endpoint: string;
    enable_ssl: boolean;
    secret: string;
    username: string;
    password: string;
}

export interface WingsPreferences {
    server: string;
    domain: string;
    username: string;
    password: string;
    datadir: string;
    dataurl: string;
    // The following is retrieved from wings itself
    export_url?: string;
    storage?: string;
    dotpath?: string;
    onturl?: string;
}

export interface LocalExecutionPreferences {
    datadir: string;
    dataurl: string;
    logdir: string;
    logurl: string;
    codedir: string;
    tempdir: string;
    parallelism: number;
}

export type RegionMap = IdMap<Region>;

export interface Region extends IdNameObject {
    bounding_box?: BoundingBox;
    model_catalog_uri?: string;
    category_id: string;
    geometries: any[];
}

export interface RegionsState {
    regions?: RegionMap;
    top_region_ids?: string[];
    sub_region_ids?: IdMap<string[]>;
    categories?: IdMap<RegionCategory>;
    bbox_preview?: BoundingBox[];
}

export interface RegionCategory extends IdNameObject {
    citation?: string;
    subcategories?: RegionCategory[];
}

export interface BoundingBox {
    xmin: number;
    xmax: number;
    ymin: number;
    ymax: number;
}

export interface Point {
    x: number;
    y: number;
}

export interface Dataset extends IdNameObject {
    region: string;
    variables?: string[];
    datatype: string;
    time_period: DateRange;
    description: string;
    version: string;
    limitations: string;
    source: Source;
    categories?: string[];
    is_cached?: boolean;
    resource_repr?: any;
    dataset_repr?: any;
    resources?: DataResource[];
    resources_loaded?: boolean;
    resource_count?: number;
    spatial_coverage?: any;
}

export interface Dataslice extends IdNameObject {
    dataset?: Dataset;
    total_resources?: number;
    selected_resources?: number;
    resources: DataResource[];
    resources_loaded?: boolean;
    time_period?: DateRange;
    spatial_coverage?: any;
}

export interface DataResource extends IdNameObject {
    url: string;
    time_period?: DateRange;
    spatial_coverage?: any;
    selected?: boolean;
    type?: string;
}

export interface DatasetDetail extends Dataset {
    documentation: string;
    image: string;
}

export interface Source {
    name: string;
    url: string;
    type: string;
}

export interface DatasetQueryParameters {
    spatialCoverage?: BoundingBox;
    dateRange?: DateRange;
    name?: string;
    variables?: string[];
}

export interface DatasetsState {
    model_datasets?: ModelDatasets;
    query_datasets?: DatasetsWithStatus;
    region_datasets?: DatasetsWithStatus;
    dataset?: DatasetWithStatus;
    datasets?: IdMap<Dataset>;
}
export interface DatasetsWithStatus {
    loading: boolean;
    datasets: Dataset[];
}
export interface DatasetWithStatus {
    loading: boolean;
    dataset: Dataset;
}
export type ModelInputDatasets = Map<string, DatasetsWithStatus[]>;
export type ModelDatasets = Map<string, ModelInputDatasets>;

export type ModelSecretSource = "owner_only" | "user_then_owner" | "user_only";

// A credential a model needs at run time. Declared in the catalog as a
// parameter row with parameter_type "secret"; never part of input_parameters.
export interface ModelSecretDeclaration {
    name: string;
    // field name -> app environment variable key
    env: Record<string, string>;
    source: ModelSecretSource;
    description?: string;
}

export interface Model extends IdNameObject {
    localname?: string;
    region_name: string;
    description?: string;
    category: string;
    input_files: ModelIO[];
    input_parameters: ModelParameter[];
    required_secrets?: ModelSecretDeclaration[];
    output_files: ModelIO[];
    code_url?: string;
    model_type?: string;
    model_name?: string;
    model_version?: string;
    model_configuration?: string;
    parameter_assignment?: string;
    parameter_assignment_details?: string;
    software_image?: string;
    calibration_target_variable?: string;
    modeled_processes?: string[];
    dimensionality?: number | string;
    spatial_grid_type?: string;
    spatial_grid_resolution?: string;
    output_time_interval?: string;
    usage_notes?: string;
    indicators?: string;
    hasRegion?: any;
}

const getLastPart = (s: string) => {
    const sp = s.split("/");
    if (sp && sp.length > 0) return sp.pop();
    return "";
};

export const getPathFromModel = (m: Model) => {
    let path = "";
    const model = getLastPart(m.model_name);
    if (model) {
        path += "/" + model;
        const version = getLastPart(m.model_version);
        if (version) {
            path += "/" + version;
            const cfg = getLastPart(m.model_configuration);
            if (cfg) {
                path += "/" + cfg;
                path += "/" + getLastPart(m.id);
            }
        }
    }
    return path;
};

export interface ModelIO extends IdNameObject {
    type?: string;
    variables: string[];
    value?: Dataslice;
    position?: number;
    format?: string;
    is_optional?: boolean;
}

export interface ModelOutput {
    position: number;
    model_io: ModelIO;
}

export interface ModelParameter extends IdNameObject {
    type: string;
    description?: string;
    min?: string;
    max?: string;
    unit?: string;
    default?: string;
    value?: string;
    adjustment_variable?: string;
    accepted_values?: string[];
    position?: number;
}

export interface ModelDetail extends Model {
    documentation: string;
    lookupTable: string;
    image: string;
}

export interface ModelsState {
    models: VariableModels;
    model: ModelDetail | null;
    loading: boolean;
}

export type VariableModels = Map<string, Model[]>; // Map of response variable to models

export interface ModelingState {
    problem_statements?: ProblemStatementList;
    problem_statement?: ProblemStatement;
    thread?: Thread;
    execution_summaries?: ThreadModelExecutionSummary;
    executions?: ThreadModelExecutions;
}

export interface ExecutionsWithStatus {
    loading: boolean;
    changed: boolean;
    executions: Execution[];
}

export type ModelExecutions = {
    [modelid: string]: ExecutionsWithStatus;
};

export type ThreadModelExecutions = {
    [threadid: string]: ModelExecutions;
};

export type ThreadModelExecutionSummary = {
    [threadid: string]: ModelExecutionSummary;
};

export type ModelExecutionSummary = {
    [modelid: string]: ExecutionSummary;
};

export interface MintPermission {
    userid: string;
    read: boolean;
    write: boolean;
    execute: boolean;
    owner: boolean;
}

export interface MintEvent {
    event: string;
    userid: string;
    timestamp: Date;
    notes: string;
}

export interface ProblemStatementEvent extends MintEvent {
    event: "CREATE" | "UPDATE" | "ADD_TASK" | "DELETE_TASK";
}

export interface TaskEvent extends MintEvent {
    event: "CREATE" | "UPDATE" | "ADD_THREAD" | "DELETE_THREAD";
}

export interface ThreadEvent extends MintEvent {
    event:
        | "CREATE"
        | "UPDATE"
        | "SELECT_DATA"
        | "SELECT_MODELS"
        | "SELECT_PARAMETERS"
        | "EXECUTE"
        | "INGEST"
        | "VISUALIZE";
}

export interface ProblemStatementList {
    problem_statement_ids: string[];
    problem_statements: IdMap<ProblemStatementInfo>;
    unsubscribe?: Function;
}

export interface ProblemStatementInfo extends IdNameObject {
    regionid: string;
    dates: DateRange;
    events?: ProblemStatementEvent[];
    permissions?: MintPermission[];
    preview?: string[];
}

export interface DateRange {
    start_date: Date;
    end_date: Date;
}

export interface ProblemStatement extends ProblemStatementInfo {
    tasks: Task[];
    changed?: boolean;
    unsubscribe?: Function;
}

export interface ThreadInfo extends IdNameObject {
    dates?: DateRange;
    task_id: string;
    driving_variables: string[];
    response_variables: string[];
    regionid?: string;
    events?: ThreadEvent[];
    permissions?: MintPermission[];
    dataset_id?: string;
}

export interface ThreadList {
    thread_ids: string[];
    threads: IdMap<ThreadInfo>;
    unsubscribe?: Function;
}

export interface Thread extends ThreadInfo {
    models?: ModelMap;
    data?: DataMap;
    model_ensembles?: ModelEnsembleMap;
    //data_transformations?: IdMap<DataTransformation>
    model_dt_ensembles?: ModelEnsembleMap;
    execution_summary: IdMap<ExecutionSummary>;
    visualizations?: Visualization[];
    events: ThreadEvent[];
    changed?: boolean;
    refresh?: boolean;
    unsubscribe?: Function;
}

export interface Visualization {
    type: string;
    url: string;
}

export interface ComparisonFeature {
    name: string;
    fn: Function;
}

export type ModelMap = IdMap<Model>;

export type DataMap = IdMap<Dataslice>;

export interface TaskList {
    task_ids: string[];
    tasks: IdMap<Task>;
    unsubscribe?: Function;
}

export interface Task extends IdNameObject {
    problem_statement_id: string;
    dates?: DateRange;
    response_variables: string[];
    driving_variables: string[];
    regionid?: string;
    threads?: IdMap<ThreadInfo>;
    events?: TaskEvent[];
    permissions?: MintPermission[];
    unsubscribe?: Function;
}

// Mapping of model id to data ensembles
export interface ModelEnsembleMap {
    [modelid: string]: ThreadModelMap;
}

export interface ThreadModelMap {
    id: string;
    bindings: ModelIOBindings;
}

// Mapping of model input to list of values (data ids or parameter values)
export interface ModelIOBindings {
    [inputid: string]: string[];
}

export interface ExecutionSummary {
    workflow_name?: string;
    changed?: boolean;
    unsubscribe?: Function;

    submitted_for_execution: boolean;
    submission_time: Date;
    total_runs: number;
    submitted_runs: number;
    successful_runs: number;
    failed_runs: number;

    submitted_for_ingestion: boolean;
    fetched_run_outputs: number; // Run data fetched for ingestion
    ingested_runs: number; // Run data ingested in the Visualization database

    submitted_for_registration: boolean;
    registered_runs: number; // Registered in the data catalog

    submitted_for_publishing: boolean;
    published_runs: number; // Published in the provenance catalog
}

export interface Execution {
    id?: string;
    modelid: string;
    bindings: InputBindings;
    runid?: string;
    start_time: Date;
    end_time?: Date;
    execution_engine?: "wings" | "localex" | "tapis";
    status: "FAILURE" | "SUCCESS" | "RUNNING" | "WAITING";
    run_progress?: number; // 0 to 100 (percentage done)
    results: any[]; // Chosen results after completed run
    selected: boolean;
}

export type Execution_Result = {
    execution?: Execution;
    model_io: ModelIO | null;
    resource: DataResource;
};

export interface InputBindings {
    [input: string]: string | DataResource;
}

export type VariableMap = IdMap<Variable>;

export interface Variable extends IdNameObject {
    description: string;
    is_adjustment_variable: boolean;
    is_indicator: boolean;
    categories: string[];
    intervention: Intervention;
}

export interface Intervention extends IdNameObject {
    description: string;
}

export interface VariablesState {
    variables?: VariableMap;
}

export interface Wcm {
    wings: any;
}

export interface WingsWcm {
    inputs: ModelIO[];
    outputs: ModelIO[];
}

export interface DatasetSearchCriteria {
    modelId?: string;
    inputId?: string;
    variables?: string[];
    dateRange?: DateRange;
    region?: Region;
    datasetIds?: string[];
    categories?: string[];
    limit?: number;
    offset?: number;
}
