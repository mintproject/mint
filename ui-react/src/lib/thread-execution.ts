/**
 * Adapters between the thread execution GraphQL rows and the in-memory
 * ThreadExecutionData the Datasets, Parameters, Runs and Results steps consume.
 *
 * Mirrors the legacy Lit adapters in ui/src/util/graphql_adapter.ts
 * (threadFromGQL, modelFromGQL, modelEnsembleFromGQL,
 * threadModelExecutionSummaryFromGQL, executionFromGQL). Pure functions only —
 * no Apollo, no React — so the mapping is testable on its own.
 */
import { extractModelIO } from '@/graphql/generated/modeling';
import type {
  Execution,
  ExecutionResult,
  ExecutionSummary,
  IOBindings,
  ModelParameter,
  ThreadExecutionData,
  ThreadModel,
} from '@/graphql/generated/execution';
import type {
  ExecutionRow,
  ExecutionSummaryRow,
  ParameterRow,
  ThreadExecutionRow,
  ThreadModelRow,
} from '@/graphql/generated/thread-execution';
import { adapterParametersComplete } from './adapter-execution';
import { userParameters } from './secret-parameters';

/** A model-catalog parameter row as the adjustable/fixed parameter the UI edits. */
export function parameterFromGQL(p: ParameterRow): ModelParameter {
  return {
    id: p.id,
    name: p.label ?? p.id,
    description: p.description ?? null,
    type: p.has_data_type ?? null,
    min: p.has_minimum_accepted_value ?? null,
    max: p.has_maximum_accepted_value ?? null,
    default: p.has_default_value ?? null,
    accepted_values: p.has_accepted_values ?? null,
    position: p.position ?? null,
    // `value` is what separates an expert-fixed parameter from an adjustable
    // one everywhere downstream — MintParameters, MintRuns and the step rail
    // all branch on `!p.value`.
    value: p.has_fixed_value ?? null,
    parameter_type: p.parameter_type ?? null,
  };
}

/** Counters for one model, from its (at most one) execution-summary row. */
export function summaryFromGQL(row: ExecutionSummaryRow): ExecutionSummary {
  return {
    total_runs: row.total_runs,
    submitted_runs: row.submitted_runs,
    successful_runs: row.successful_runs,
    failed_runs: row.failed_runs,
    ingested_runs: row.ingested_runs,
    published_runs: row.published_runs,
    fetched_run_outputs: row.fetched_run_outputs,
    submission_time: row.submission_time ?? null,
    submitted_for_execution: row.submitted_for_execution,
    submitted_for_ingestion: row.submitted_for_ingestion,
    submitted_for_publishing: row.submitted_for_publishing,
  };
}

/**
 * Merge a thread model's data and parameter bindings into one map.
 *
 * Both live in the same `bindings` record, keyed by the model input id or the
 * model parameter id — that is what MintParameters and MintRuns read. Values
 * are dataslice ids for inputs and literal strings for parameters.
 */
export function bindingsFromGQL(tm: ThreadModelRow): IOBindings {
  const bindings: IOBindings = {};
  for (const db of tm.data_bindings ?? []) {
    (bindings[db.model_io_id] ??= []).push(db.dataslice_id);
  }
  for (const pb of tm.parameter_bindings ?? []) {
    (bindings[pb.model_parameter_id] ??= []).push(pb.parameter_value);
  }
  return bindings;
}

/** The configuration a thread model points at, as the model the steps render. */
export function threadModelFromGQL(tm: ThreadModelRow): ThreadModel | null {
  const cfg = tm.modelcatalog_configuration;
  if (!cfg) return null;
  const io = extractModelIO(cfg);
  return {
    id: cfg.id,
    name: cfg.label ?? cfg.id,
    usage_notes: cfg.usage_notes ?? null,
    // The data catalog filters by standard-variable NAME, so inputs carry the
    // labels. Outputs carry the ids, because the response variable they are
    // matched against is an id. Same split as the model-tree path.
    input_files: io.inputs.map((i) => ({
      id: i.id,
      name: i.name,
      variables: i.variableLabels,
      variableIds: i.variableIds,
      format: i.format,
      isOptional: i.optional,
    })),
    output_files: io.outputs.map((o) => ({
      id: o.id,
      name: o.name,
      variables: o.variableIds,
      format: o.format,
    })),
    input_parameters: (cfg.parameters ?? [])
      .map((cp) => parameterFromGQL(cp.parameter))
      .sort((a, b) => {
        if (a.position != null && b.position != null) return a.position - b.position;
        return (a.name ?? '').localeCompare(b.name ?? '');
      }),
  };
}

/**
 * Build the execution-pipeline view of a thread from the GetThreadExecution row.
 *
 * Returns null when the thread is absent so the caller can tell "not loaded
 * yet" from "loaded and empty" — the distinction the wizard rail depends on.
 */
export function threadExecutionFromGQL(
  thread: ThreadExecutionRow | null | undefined,
): ThreadExecutionData | null {
  if (!thread) return null;

  const data: ThreadExecutionData['data'] = {};
  for (const td of thread.thread_data ?? []) {
    const ds = td.dataslice;
    if (!ds) continue;
    const resources = ds.resources ?? [];
    data[ds.id] = {
      id: ds.id,
      name: ds.name,
      dataset: ds.dataset,
      start_date: ds.start_date ?? null,
      end_date: ds.end_date ?? null,
      resource_count: ds.resource_count,
      total_resources: resources.length,
      // Counted here rather than with a `*_aggregate` field: aggregates are not
      // exposed to Hasura's anonymous role, and one absent field fails the
      // whole document.
      selected_resources: resources.filter((r) => r.selected).length,
      // `dcid` is the data catalog's own resource id; `id` is the URL hash this
      // app stores as the PK. Handing back the catalog id keeps a re-save from
      // overwriting `dcid` with the hash.
      resources: resources.map((r) => ({
        id: r.resource.dcid ?? r.resource.id,
        name: r.resource.name,
        url: r.resource.url,
        selected: r.selected,
      })),
    };
  }

  const models: ThreadExecutionData['models'] = {};
  const model_ensembles: ThreadExecutionData['model_ensembles'] = {};
  const execution_summary: ThreadExecutionData['execution_summary'] = {};

  for (const tm of thread.thread_models ?? []) {
    const model = threadModelFromGQL(tm);
    if (!model) continue;
    models[model.id] = model;
    model_ensembles[model.id] = { id: tm.id, bindings: bindingsFromGQL(tm) };
    const summaryRow = (tm.execution_summary ?? [])[0];
    if (summaryRow) execution_summary[model.id] = summaryFromGQL(summaryRow);
  }

  return {
    id: thread.id,
    models,
    model_ensembles,
    execution_summary,
    data,
    response_variables: thread.response_variable_id ? [thread.response_variable_id] : [],
  };
}

/** One execution row as the run the Runs and Results tables render. */
export function executionFromGQL(ex: ExecutionRow): Execution {
  const bindings: Record<string, unknown> = {};
  for (const pb of ex.parameter_bindings ?? []) {
    bindings[pb.model_parameter_id] = pb.parameter_value;
  }
  for (const db of ex.data_bindings ?? []) {
    bindings[db.model_io_id] = db.resource;
  }
  const results: Record<string, ExecutionResult> = {};
  for (const r of ex.results ?? []) {
    results[r.model_io_id] = r.resource;
  }
  return {
    id: ex.id,
    modelid: ex.modelcatalog_configuration_id ?? '',
    run_id: ex.run_id ?? null,
    status: ex.status ?? 'WAITING',
    run_progress: ex.run_progress,
    start_time: ex.start_time ?? null,
    end_time: ex.end_time ?? null,
    execution_engine: ex.execution_engine ?? null,
    bindings,
    results,
  };
}

/**
 * How many runs this model's ensemble expands to.
 *
 * A run is one combination of input resources and parameter values, so both
 * sides multiply: a dataslice of 5 files crossed with 3 threshold values is 15
 * runs, not 3. Counting parameters alone understated the total, and the Runs
 * step compares finished runs against it to decide the step is done.
 * Mirrors getTotalConfigs in ui/src/util/graphql_adapter.ts.
 */
export function totalConfigs(
  model: ThreadModel,
  bindings: Record<string, string[]>,
  data: ThreadExecutionData['data'],
): number {
  let total = 1;
  for (const io of model.input_files) {
    if (io.value) {
      total *= (io.value.resources ?? []).filter((r) => r.selected !== false).length || 1;
      continue;
    }
    const slices = bindings[io.id] ?? [];
    if (slices.length === 0) continue;
    const resources = slices.reduce(
      (acc, sliceId) => acc + (data?.[sliceId]?.selected_resources ?? 0),
      0,
    );
    total *= resources || 1;
  }
  for (const p of userParameters(model).filter((x) => !x.value)) {
    total *= (bindings[p.id ?? ''] ?? []).length || 1;
  }
  return total;
}

/**
 * Count the input-resource combinations shown in the Runs step.
 *
 * Optional model inputs may be intentionally unbound. They do not create a
 * zero-resource ensemble; they contribute the neutral factor of one. A
 * missing required input remains zero so the display still exposes an
 * incomplete dataset configuration.
 */
export function inputResourceCount(model: ThreadModel, bindings: Record<string, string[]>): number {
  return model.input_files
    .map((input) => {
      if (input.value) {
        return (input.value.resources ?? []).filter((resource) => resource.selected !== false)
          .length;
      }
      const bound = (bindings[input.id] ?? []).length;
      return bound > 0 || input.isOptional ? bound || 1 : 0;
    })
    .reduce((product, count) => product * count, 1);
}

// ─── Step completion ─────────────────────────────────────────────────────────
//
// One definition per step, shared by the wizard rail and the step component, so
// the rail can never disagree with the panel it links to. Each answers the same
// question: has this step's write landed in the database?

/** Every required input of every selected model has at least one dataslice bound. */
export function datasetsComplete(threadData: ThreadExecutionData | null): boolean {
  if (!threadData) return false;
  const modelIds = Object.keys(threadData.models ?? {});
  if (modelIds.length === 0) return false;
  return modelIds.every((mid) => {
    const bindings = threadData.model_ensembles[mid]?.bindings ?? {};
    return threadData.models[mid]!.input_files.filter((f) => !f.isOptional).every(
      (f) => (bindings[f.id] ?? []).length > 0,
    );
  });
}

/**
 * Every adjustable parameter is bound and every model has an execution summary.
 *
 * The summary is what makes this a completion test rather than a vacuous one: a
 * model with no adjustable parameters satisfies the binding half by definition,
 * and without the summary row the Runs step has nothing to submit.
 */
export function parametersComplete(threadData: ThreadExecutionData | null): boolean {
  if (!threadData) return false;
  const modelIds = Object.keys(threadData.models ?? {});
  if (modelIds.length === 0) return false;
  return modelIds.every((mid) => {
    if (!threadData.execution_summary[mid]) return false;
    const bindings = threadData.model_ensembles[mid]?.bindings ?? {};
    return (
      userParameters(threadData.models[mid]!)
        .filter((p) => !p.value)
        .every((p) => (bindings[p.id ?? ''] ?? []).length > 0) &&
      adapterParametersComplete(threadData.adapter_plans?.[mid] ?? [])
    );
  });
}

/** Every model's runs have been submitted and have all finished. */
export function runsComplete(threadData: ThreadExecutionData | null): boolean {
  if (!threadData) return false;
  const modelIds = Object.keys(threadData.execution_summary ?? {});
  if (modelIds.length === 0) return false;
  return modelIds.every((mid) => {
    const s = threadData.execution_summary[mid]!;
    return (
      s.submitted_runs > 0 && s.successful_runs + s.failed_runs >= s.total_runs && s.total_runs > 0
    );
  });
}

/** True while any model still has runs the execution engine has not finished. */
export function hasUnfinishedRuns(summary: ThreadExecutionData['execution_summary']): boolean {
  return Object.values(summary ?? {}).some(
    (s) => s.submitted_for_execution && s.successful_runs + s.failed_runs < s.total_runs,
  );
}
