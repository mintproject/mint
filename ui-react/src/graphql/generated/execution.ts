/**
 * Execution-pipeline types for the MINT modeling workflow.
 *
 * These types mirror the legacy Redux reducers in ui/src/screens/modeling/reducers.ts
 * and map to Hasura tables: thread_model_execution_summary, thread_model_execution,
 * thread_model_io, thread_model_parameter.
 *
 * The execution lifecycle (submit → monitor → results) is orchestrated via the
 * mint-ensemble-manager REST API, not via Hasura directly.
 */
import type { ThreadAdapterPlan } from '@/lib/adapter-execution';

// ─── Parameter / Input file descriptors ──────────────────────────────────────

/** Mirrors ModelParameter from ui legacy */
export interface ModelParameter {
  id: string;
  name: string;
  description?: string | null;
  type?: string | null;
  min?: string | null;
  max?: string | null;
  default?: string | null;
  /** If set, only these values are accepted */
  accepted_values?: string[] | null;
  /** Sort order */
  position?: number | null;
  /** A pre-assigned fixed value (expert-set) */
  value?: string | null;
  /** `secret` marks an owner-registered credential, never a runner input */
  parameter_type?: string | null;
}

/** Mirrors ModelIO (input file) from ui legacy */
export interface ModelInputFile {
  id: string;
  name: string;
  description?: string | null;
  position?: number | null;
  format?: string | null;
  /** Pre-assigned fixed value */
  value?: {
    resources?: Array<{ id: string; name: string; url?: string | null; selected?: boolean | null }>;
  } | null;
  variables?: string[];
  /** Stable standard-variable ids parallel to `variables`, when catalog metadata provides them. */
  variableIds?: string[];
  /** The model runs without this input bound; the Datasets step may skip it. */
  isOptional?: boolean;
}

/** Mirrors ModelIO (output file) from ui legacy */
export interface ModelOutputFile {
  id: string;
  name: string;
  description?: string | null;
  variables?: string[];
  format?: string | null;
}

/** Thread model descriptor (simplified) */
export interface ThreadModel {
  id: string;
  name?: string | null;
  localname?: string | null;
  input_parameters: ModelParameter[];
  input_files: ModelInputFile[];
  output_files: ModelOutputFile[];
  output_parameters?: ModelParameter[];
  usage_notes?: string | null;
}

// ─── Ensemble / Execution state ───────────────────────────────────────────────

/** Map from input_id → array of string values (multi-value parameter sweep) */
export type IOBindings = Record<string, string[]>;

/** Per-model ensemble: the ensemble_id from Hasura + parameter/input bindings */
export interface ModelEnsemble {
  id: string;
  bindings: IOBindings;
}

/** Map from model_id → ModelEnsemble */
export type ModelEnsembleMap = Record<string, ModelEnsemble>;

/** Counters for a single model's execution summary */
export interface ExecutionSummary {
  total_runs: number;
  submitted_runs: number;
  failed_runs: number;
  successful_runs: number;
  /** ISO timestamp when submitted to the execution engine */
  submission_time?: string | null;
  submitted_for_execution?: boolean | null;
  submitted_for_ingestion?: boolean | null;
  submitted_for_publishing?: boolean | null;
  published_runs?: number | null;
  ingested_runs?: number | null;
  fetched_run_outputs?: number | null;
  /** Set to true when the summary changed and the UI should re-fetch executions */
  changed?: boolean;
}

/** Map from model_id → ExecutionSummary */
export type ExecutionSummaryMap = Record<string, ExecutionSummary>;

// ─── Individual execution (run) record ────────────────────────────────────────

/** Single file result produced by one execution run */
export interface ExecutionResult {
  id: string;
  name?: string | null;
  url?: string | null;
  location?: string | null;
}

/** One execution run for a specific model+ensemble combo */
export interface Execution {
  id: string;
  modelid: string;
  /** Durable Ensemble Manager parent run id, when this is a workflow run. */
  run_id?: string | null;
  /** 'SUCCESS' | 'FAILURE' | 'RUNNING' | 'WAITING' */
  status: string;
  run_progress?: number | null;
  start_time?: string | null;
  end_time?: string | null;
  execution_engine?: string | null;
  /** Map from input_id → bound DataResource or string value */
  bindings: Record<string, unknown>;
  /** Map from output_id → ExecutionResult */
  results: Record<string, ExecutionResult>;
  /** Whether this run is selected in the UI (for bulk actions) */
  selected?: boolean;
}

/** Paginated list of executions for one model */
export interface ModelExecutionGroup {
  executions: Execution[];
  loading: boolean;
}

/** Map from model_id → ModelExecutionGroup */
export type ModelExecutionsMap = Record<string, ModelExecutionGroup>;

// ─── Thread data shape (execution-focused fields) ────────────────────────────

/**
 * Execution-pipeline view of a thread.
 * These fields live in Hasura (thread_model_*) tables but are fetched separately
 * from the base Thread record (which only has metadata).
 *
 * The React port uses Apollo subscriptions or polls to keep these in sync.
 * For this 1:1 port we receive them as props passed down from the parent.
 */
export interface ThreadExecutionData {
  /** thread.id */
  id: string;
  /** Map of selected models keyed by model_id */
  models: Record<string, ThreadModel>;
  /** Map of ensemble/binding state keyed by model_id */
  model_ensembles: ModelEnsembleMap;
  /** Execution summaries keyed by model_id */
  execution_summary: ExecutionSummaryMap;
  /** Dataset resources keyed by dataset_id */
  data: Record<string, { selected_resources: number; [k: string]: unknown }>;
  /** Response variable IDs */
  response_variables?: string[];
  /** Adapter plans discovered for each selected model, keyed by model id. */
  adapter_plans?: Record<string, ThreadAdapterPlan[]>;
}
