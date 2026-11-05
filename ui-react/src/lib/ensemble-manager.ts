/**
 * Ensemble Manager REST calls.
 *
 * These are the only places the app talks to mint-ensemble-manager over REST
 * (everything else goes through Hasura). All of them need the user's access
 * token, so the Authorization header is built here, once.
 *
 * Why one place: the two call sites used to read the token from localStorage
 * by string literal, the literal did not match the key `token-store` writes,
 * and the header was spread conditionally — so every call went out anonymous
 * with no error (#85).
 */
import { getAccessToken } from './auth/token-store';

/**
 * A failed Ensemble Manager response, carrying the machine-readable `code` the
 * server sends beside the message.
 *
 * The status alone does not say what to do about it. `NO_OUTPUTS_DECLARED`
 * (422) means the model configuration declares no output — a state the user
 * fixes by promoting a file from a finished run, not an error to read and
 * dismiss (#267). `message` keeps the shape the Results step already renders.
 */
export class EnsembleManagerError extends Error {
  readonly status: number;
  /** The server's own error code, when it sends one. */
  readonly code?: string;
  /** Structured server details, when present. */
  readonly details?: unknown;

  constructor(status: number, message: string, code?: string, details?: unknown) {
    super(message);
    this.name = 'EnsembleManagerError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/** The code the server sends when a model configuration declares no output. */
export const NO_OUTPUTS_DECLARED = 'NO_OUTPUTS_DECLARED';

/**
 * Turn a failed response into an `EnsembleManagerError`.
 *
 * A body that is not JSON, or that carries no message, still yields the status
 * — the Results step showed a bare status before the server learned to explain
 * itself, and that path must keep working.
 */
function formatErrorValue(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0) return value;
  if (value == null) return undefined;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

async function toEnsembleManagerError(resp: Response): Promise<EnsembleManagerError> {
  const body = await resp
    .json()
    .then(
      (parsed: { message?: unknown; code?: unknown; detail?: unknown; details?: unknown }) =>
        parsed,
    )
    .catch(() => undefined);
  const serverMessage = formatErrorValue(body?.message ?? body?.detail ?? body?.details);
  const message = serverMessage
    ? `Ensemble manager returned ${resp.status}: ${serverMessage}`
    : `Ensemble manager returned ${resp.status}`;
  return new EnsembleManagerError(
    resp.status,
    message,
    typeof body?.code === 'string' ? body.code : undefined,
    body?.details ?? body?.detail,
  );
}

/**
 * Request headers for the Ensemble Manager, carrying the stored access token
 * as a Bearer credential. The header is omitted when no token is stored, so
 * anonymous calls stay possible.
 */
export function ensembleManagerHeaders(base: Record<string, string> = {}): Record<string, string> {
  const token = getAccessToken();
  return { ...base, ...(token ? { Authorization: `Bearer ${token}` } : {}) };
}

/**
 * Submission route for an execution engine.
 *
 * The Ensemble Manager does not serve one route per engine under a common
 * prefix: the two older backends predate `/executionEngines` and kept their
 * own paths (`server.ts` mounts `/executionsLocal`, `/executions` and
 * `/executionEngines` separately, and the last registers `/tapis` alone). So
 * `/executionEngines/${engine}` is right for Tapis and a 404 for the other
 * two — which is what #88 was. Same mapping the legacy UI makes in
 * `ui/src/screens/modeling/thread/mint-runs.ts`.
 *
 * An unrecognised engine falls through to `/executionEngines/<engine>`, where
 * any newer backend is mounted.
 */
export function executionEnginePath(executionEngine: string): string {
  if (executionEngine === 'localex') return '/executionsLocal';
  if (executionEngine === 'wings') return '/executions';
  return `/executionEngines/${executionEngine}`;
}

/** Submit a thread's model runs to an execution engine. */
export async function submitRuns(
  ensembleManagerApi: string,
  executionEngine: string,
  /** `thread_id` is optional only so an absent route param serialises as it did before. */
  body: { thread_id: string | undefined; model_id: string },
): Promise<void> {
  const resp = await fetch(`${ensembleManagerApi}${executionEnginePath(executionEngine)}`, {
    method: 'POST',
    headers: ensembleManagerHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    throw new Error(`Ensemble manager returned ${resp.status}`);
  }
}

export type UnifiedExecutor = 'ensemble_manager' | 'svo_adapter';

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
  /** Supplied by the adapter/coordinator, not entered in the Parameters step. */
  managed?: boolean;
  managed_source?: string;
}

export interface UnifiedExecutionPlan {
  plan_id: string | null;
  executor: UnifiedExecutor;
  version: number;
  status: string;
  parameters: UnifiedParameterDefinition[];
  parameter_values: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Outcome of the optional publish step. Publication is an outcome of a
 * completed run, not a run status: a failed publish leaves the run completed.
 */
export interface UnifiedPublication {
  status: 'published' | 'failed' | 'awaiting_owner' | string;
  error?: string | null;
  /** Catalogs written, as the task reports them (`ckan+stac` or `ckan`). */
  catalog?: string | null;
  ckan_dataset?: string | null;
  /** Null when the user chose CKAN only. */
  stac_item?: string | null;
  public?: boolean | null;
}

/** One catalog an output can be published to, as offered by GET /plans/publishers. */
export interface PlanPublisher {
  transform_spec_id: string;
  name: string;
  catalog_tokens: string[];
  parameters: UnifiedParameterDefinition[];
  /**
   * Whether the caller may publish, why not, and the allow-listed CKAN
   * organisations they belong to (`orgs_ok`, absent on an older adapter).
   */
  can_publish: { ok: boolean; reason: string | null; orgs_ok?: string[] };
  /**
   * Declared formats of the model outputs this publisher can take, verbatim
   * from the model catalog. Absent on an older adapter.
   */
  output_formats?: string[];
  /**
   * The catalog token sets a user may choose for this publisher, e.g.
   * `[["ckan","stac"],["ckan"]]`. Absent on an older adapter, which offers
   * only `catalog_tokens`.
   */
  catalog_options?: string[][];
}

export interface PlanPublishersResponse {
  configuration_id: string | null;
  publishers: PlanPublisher[];
}

/** Liveness verdict the adapter keeps beside a run's lifecycle status. */
export type UnifiedRunHealth = 'ok' | 'stalled' | 'reported_failed' | string;

export interface UnifiedAdapterRun {
  adapter_plan_id?: string;
  model_io_id?: string;
  stage?: string;
  run_id?: string;
  status?: string;
  health?: UnifiedRunHealth | null;
  started_at?: string | null;
  model_job_id?: string | null;
  error_message?: string | null;
  execution_kind?: 'workflow' | 'composite_workflow' | string;
  tapis_workflow_id?: string | null;
  tapis_run_id?: string | null;
}

export interface UnifiedRunSnapshot {
  run_id?: string;
  parent_execution_id?: string | null;
  executor?: string;
  execution_mode?: 'job' | 'workflow' | 'workflow_pipeline' | string;
  tapis_workflow?: {
    provider: 'tapis-workflows' | string;
    workflow_id: string | null;
    run_id: string | null;
    stage_count: number;
  };
  /** Whether the adapter runs before the model or are deferred until its output. */
  adapter_stage?: 'none' | 'pre_model' | 'post_model' | string;
  workflow_stages?: Array<{
    stage_id: string;
    type: 'adapter_input' | 'model' | 'output_handoff' | 'adapter_output' | string;
    depends_on: string[];
    status: string;
    provider: string;
    provider_ids: Record<string, string>;
    output_reference?: unknown;
    error_message?: string | null;
  }>;
  status?: string;
  plan_id?: string;
  model_child_id?: string | null;
  model_job_id?: string | null;
  model_result?: {
    status?: string | null;
    [key: string]: unknown;
  } | null;
  output_handoff?: {
    final_output_data_object_id?: string | null;
    final_resource_uri?: string | null;
    result?: unknown;
    publication?: UnifiedPublication | null;
    [key: string]: unknown;
  } | null;
  adapter_runs?: UnifiedAdapterRun[];
  failure_code?: string | null;
  error_message?: string | null;
  [key: string]: unknown;
}

export interface RunHistorySummary {
  run_key: string;
  source: 'workflow' | 'legacy_execution';
  run_kind: 'workflow_pipeline' | 'legacy_model_job';
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
    provider: 'tapis-workflows' | string;
    workflow_id: string | null;
    run_id: string | null;
    stage_count: number;
  } | null;
  plan_id: string | null;
  provenance_completeness: 'complete' | 'partial' | 'unavailable' | 'unknown';
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
    tapis_workflow?: RunHistorySummary['tapis_workflow'];
    stages: Array<{
      id: string;
      execution_id: string;
      step_key: string;
      stage: string;
      external_id?: string | null;
      idempotency_key: string;
      plan_hash: string;
      parameter_values_hash?: string | null;
      status: string;
      attempt: number;
      output_reference?: unknown;
      error_message?: string | null;
    }>;
    output_handoff: unknown;
    failure_code: string | null;
    events: Array<{ type: string; availability: string; captured_at: string | null }>;
  } | null;
  artifacts: Array<{
    kind: string;
    provider: string;
    source_id: string;
    endpoint: string | null;
    availability: string;
  }>;
  errors: Array<{ code: string | null; message: string; source: string }>;
  status_history: Array<{ status: string; observed_at: string | null; source: string }>;
}

export interface RunHistoryResponse {
  schema_version: number;
  runs: RunHistorySummary[];
  next_cursor: string | null;
}

async function unifiedRequest<T>(
  ensembleManagerApi: string,
  path: string,
  method: 'GET' | 'POST',
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const resp = await fetch(`${ensembleManagerApi}${path}`, {
    method,
    signal,
    headers: ensembleManagerHeaders({ 'Content-Type': 'application/json' }),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!resp.ok) throw await toEnsembleManagerError(resp);
  return (await resp.json()) as T;
}

/** Create one public plan for either the legacy engine or the SVO adapter. */
export function createExecutionPlan(
  ensembleManagerApi: string,
  body: {
    executor: UnifiedExecutor;
    thread_id?: string;
    model_id?: string;
    execution_engine?: string;
    adapter_request?: Record<string, unknown> & {
      data_object?: Record<string, unknown>;
    };
    adapter_steps?: Array<{
      adapter_plan_id: string;
      model_io_id: string;
      source_resource_id?: string;
      stage?: 'pre_model' | 'post_model';
      source?: Record<string, unknown>;
    }>;
    post_model_adapter?: {
      model_io_id: string;
      model_output_key: string;
      source_contract: Record<string, unknown>;
      target_contract: Record<string, unknown>;
      target_dataset_specification_id?: string;
    };
    /** Catalog tokens to publish the model output to; unknown tokens are a 422. */
    publish?: string[];
    /**
     * Which declared model output to publish (name or id). Without it the
     * Ensemble Manager takes the first output a requested publisher can take.
     */
    model_output_key?: string;
  },
): Promise<UnifiedExecutionPlan> {
  return unifiedRequest<UnifiedExecutionPlan>(ensembleManagerApi, '/plans', 'POST', body);
}

/** Catalogs a model's output can be published to, with their user-facing parameters. */
export function fetchPlanPublishers(
  ensembleManagerApi: string,
  modelId: string,
  signal?: AbortSignal,
): Promise<PlanPublishersResponse> {
  return unifiedRequest<PlanPublishersResponse>(
    ensembleManagerApi,
    `/plans/publishers?model_id=${encodeURIComponent(modelId)}`,
    'GET',
    undefined,
    signal,
  );
}

/** Submit a previously-created plan; adapter validation happens server-side. */
export function submitExecutionPlan(
  ensembleManagerApi: string,
  body: {
    plan_id: string;
    parameter_values?: Record<string, unknown>;
    max_minutes?: number;
    run_name?: string;
    recreate?: boolean;
    dry_run?: boolean;
    execution_id?: string;
    idempotency_key?: string;
    adapter_parameter_values?: Record<string, Record<string, unknown>>;
  },
): Promise<UnifiedRunSnapshot> {
  return unifiedRequest<UnifiedRunSnapshot>(ensembleManagerApi, '/plans/submit', 'POST', body);
}

/** Retrieve the immutable plan snapshot and its adapter parameter definitions. */
export function fetchExecutionPlan(
  ensembleManagerApi: string,
  planId: string,
  signal?: AbortSignal,
): Promise<UnifiedExecutionPlan> {
  return unifiedRequest<UnifiedExecutionPlan>(
    ensembleManagerApi,
    `/plans/${encodeURIComponent(planId)}`,
    'GET',
    undefined,
    signal,
  );
}

/** Retrieve adapter child-run status through Ensemble Manager. */
export function fetchUnifiedRun(
  ensembleManagerApi: string,
  runId: string,
  signal?: AbortSignal,
): Promise<UnifiedRunSnapshot> {
  return unifiedRequest<UnifiedRunSnapshot>(
    ensembleManagerApi,
    `/plans/runs/${encodeURIComponent(runId)}`,
    'GET',
    undefined,
    signal,
  );
}

/**
 * Cancel a unified execution: Ensemble Manager terminates the adapter's
 * Tapis Workflows run (and its verified model job) as the calling user.
 */
export function cancelUnifiedRun(
  ensembleManagerApi: string,
  runId: string,
  signal?: AbortSignal,
): Promise<UnifiedRunSnapshot> {
  return unifiedRequest<UnifiedRunSnapshot>(
    ensembleManagerApi,
    `/plans/runs/${encodeURIComponent(runId)}/cancel`,
    'POST',
    undefined,
    signal,
  );
}

/** Statuses after which a unified run no longer changes on its own. */
export const UNIFIED_TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);

export function isUnifiedRunTerminal(run: Pick<UnifiedRunSnapshot, 'status'> | undefined): boolean {
  return Boolean(run?.status && UNIFIED_TERMINAL_STATUSES.has(String(run.status)));
}

/** Read the server-owned run history for one problem-formulation subtask. */
export function fetchRunHistory(
  ensembleManagerApi: string,
  threadId: string,
  options: { modelId?: string; limit?: number; cursor?: string } = {},
  signal?: AbortSignal,
): Promise<RunHistoryResponse> {
  const params = new URLSearchParams();
  if (options.modelId) params.set('model_id', options.modelId);
  if (options.limit) params.set('limit', String(options.limit));
  if (options.cursor) params.set('cursor', options.cursor);
  const query = params.toString();
  return unifiedRequest<RunHistoryResponse>(
    ensembleManagerApi,
    `/threads/${encodeURIComponent(threadId)}/runs${query ? `?${query}` : ''}`,
    'GET',
    undefined,
    signal,
  );
}

/** Read one normalized provenance packet from the server-owned run history. */
export function fetchRunHistoryDetail(
  ensembleManagerApi: string,
  threadId: string,
  runKey: string,
  signal?: AbortSignal,
): Promise<RunHistoryDetail> {
  return unifiedRequest<RunHistoryDetail>(
    ensembleManagerApi,
    `/threads/${encodeURIComponent(threadId)}/runs/${encodeURIComponent(runKey)}`,
    'GET',
    undefined,
    signal,
  );
}

/** The three path segments that address one thread on the publish routes. */
export interface SubtaskIds {
  problemStatementId: string;
  taskId: string;
  threadId: string;
}

/**
 * Base URL of one subtask (thread) on the Ensemble Manager.
 *
 * Each id is one path segment. TACC's are opaque and need no escaping, but the
 * legacy `mint://…/…` form carries slashes, which would otherwise split into
 * extra segments and miss the route entirely.
 */
function subtaskUrl(ensembleManagerApi: string, ids: SubtaskIds): string {
  return (
    `${ensembleManagerApi}/problemStatements/${encodeURIComponent(ids.problemStatementId)}` +
    `/tasks/${encodeURIComponent(ids.taskId)}` +
    `/subtasks/${encodeURIComponent(ids.threadId)}`
  );
}

/**
 * Register a thread's run outputs in the data catalog, so the Results step can
 * show them.
 *
 * The route publishes every execution under the *subtask* (thread), not under
 * one model, which is why `modelId` is not a parameter — the legacy UI calls
 * the same route from its own per-model button
 * (`ui/src/screens/modeling/thread/mint-results.ts:_fetchAllResults`).
 *
 * The server answers 400 `No executions found to publish` when every
 * per-execution registration threw, because it catches each one and counts
 * successes — so a 400 here means "all of them failed", not "there were none".
 * The caller surfaces the message rather than dropping it (#110).
 */
export async function publishResults(ensembleManagerApi: string, ids: SubtaskIds): Promise<void> {
  const resp = await fetch(`${subtaskUrl(ensembleManagerApi, ids)}/outputs`, {
    method: 'POST',
    headers: ensembleManagerHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({}),
  });
  if (!resp.ok) {
    throw await toEnsembleManagerError(resp);
  }
}

/**
 * Register the outputs of ONE execution.
 *
 * Nothing republishes by itself, so this is the call behind the per-run
 * "Publish this execution now" button: the user promotes a file, then presses
 * it (#261). The bulk route above walks every execution of the thread instead.
 *
 * It answers the same 422 `NO_OUTPUTS_DECLARED` as the bulk route when the
 * model configuration declares no output.
 */
export async function publishExecution(
  ensembleManagerApi: string,
  ids: SubtaskIds,
  executionId: string,
): Promise<void> {
  const url = `${subtaskUrl(ensembleManagerApi, ids)}/executions/${encodeURIComponent(executionId)}/outputs`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: ensembleManagerHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({}),
  });
  if (!resp.ok) {
    throw await toEnsembleManagerError(resp);
  }
}

/** One file that an execution archived. Mirrors the server's `ExecutionFile`. */
export interface ExecutionFile {
  /** The file name, without the folder. */
  name: string;
  /** The path on the archive system. It tells two files of the same name apart. */
  path: string;
  /** The size in bytes. */
  size: number;
  /** The `tapis://` URI. CKAN reads this URI as it is. */
  url: string;
}

/**
 * List the files that an execution archived.
 *
 * MINT stores none of these files: the server reads them live from Tapis with
 * the user's own token. An execution that archived nothing answers an empty
 * list, which is not an error — the run may still be on its way.
 */
export async function fetchExecutionFiles(
  ensembleManagerApi: string,
  executionId: string,
  signal?: AbortSignal,
): Promise<ExecutionFile[]> {
  const url = `${ensembleManagerApi}/executions/${encodeURIComponent(executionId)}/files`;
  const resp = await fetch(url, { signal, headers: ensembleManagerHeaders() });
  if (!resp.ok) {
    throw await toEnsembleManagerError(resp);
  }
  const body = (await resp.json()) as { files?: ExecutionFile[] };
  return body.files ?? [];
}

/** Fetch the raw log text for one execution. Caller handles ANSI cleanup. */
export async function fetchExecutionLog(
  ensembleManagerApi: string,
  executionId: string,
  signal?: AbortSignal,
): Promise<string> {
  const resp = await fetch(`${ensembleManagerApi}/executions/${executionId}/logs`, {
    signal,
    headers: ensembleManagerHeaders(),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.text();
}
