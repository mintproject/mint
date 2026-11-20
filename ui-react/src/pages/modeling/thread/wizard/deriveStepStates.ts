import type { Thread } from '@/graphql/generated/modeling';
import type { StepState, WizardStepId } from './types';

export interface DeriveOpts {
  /** All required inputs assigned across all selected models. */
  datasetsComplete?: boolean;
  /** Parameter values valid for every model (defaults give a valid baseline). */
  parametersComplete?: boolean;
  /** Every model's runs have been submitted and have finished. */
  runsComplete?: boolean;
  /** >=1 model has a successful run to show; this alone unlocks Results. */
  resultsAvailable?: boolean;
  /** Models whose runs have all finished, out of the thread's models. */
  finishedModels?: { finished: number; total: number };
}

export type StepStateMap = Record<WizardStepId, StepState>;

export function deriveStepStates(thread: Thread, opts: DeriveOpts = {}): StepStateMap {
  const goalSet = !!thread.name?.trim();
  const modelCount = thread.thread_models?.length ?? 0;
  const modelsSet = modelCount >= 1;
  const datasetsSet = !!opts.datasetsComplete;
  const parametersSet = !!opts.parametersComplete;
  const runsSet = !!opts.runsComplete;
  const resultsAvailable = !!opts.resultsAvailable || runsSet;
  const { finished = 0, total = 0 } = opts.finishedModels ?? {};
  // Complete only when every model is done; a partial thread says how far it is.
  const runsSummary = runsSet
    ? 'Complete'
    : finished > 0 && total > 1
      ? `${finished} of ${total} complete`
      : 'Pending';

  const region = thread.region_id?.trim() || 'any region';
  const framingSummary = goalSet ? `${thread.name!.trim()} · ${region}` : 'Not set';
  // The stored id is a standard variable URI (#106); the label is what a reader
  // recognises, so the summary prefers it.
  const variablesSummary =
    thread.response_variable?.label?.trim() ||
    thread.response_variable_id?.trim() ||
    'No indicator';

  // status helper: locked beats done beats upcoming
  const state = (done: boolean, locked: boolean, summary: string): StepState => ({
    status: locked ? 'locked' : done ? 'done' : 'upcoming',
    locked,
    summary,
  });

  return {
    framing: state(goalSet, false, framingSummary),
    variables: state(!!thread.response_variable_id, !goalSet, variablesSummary),
    models: state(
      modelsSet,
      !goalSet,
      modelsSet ? `${modelCount} model${modelCount === 1 ? '' : 's'}` : 'None',
    ),
    datasets: state(datasetsSet, !modelsSet, datasetsSet ? 'All inputs assigned' : 'Pending'),
    parameters: state(parametersSet, !datasetsSet, parametersSet ? 'Configured' : 'Pending'),
    runs: state(runsSet, !parametersSet, runsSummary),
    results: state(false, !resultsAvailable, 'Pending'),
    summary: state(false, false, 'Review'),
  };
}
