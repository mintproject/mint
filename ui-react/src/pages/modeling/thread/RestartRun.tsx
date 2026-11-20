/**
 * RestartRun — send a model again after its runs ended without success.
 *
 * What the earlier run used is carried over, never dropped silently: the
 * maximum run time and queue come from its record when it kept them (else the
 * default is shown, and can be changed), and the catalogs it published to are
 * read from its plan and pre-selected, with the publisher's parameters shown to
 * check. A model that ran several times is sent again as a whole, so the button
 * says how many runs, asks to confirm, and says that runs which succeeded are
 * sent again too.
 */
import { RotateCcw } from 'lucide-react';
import { useEffect, useState } from 'react';

import type { ThreadModel } from '@/graphql/generated/execution';
import {
  fetchPlanPublishers,
  type PlanPublisher,
  type UnifiedRunSnapshot,
} from '@/lib/ensemble-manager';
import { flowErrorMessage } from '@/lib/flow-errors';
import { DEFAULT_MAX_MINUTES } from '@/lib/modeling/run-settings';
import {
  priorPublish,
  publishRequestFor,
  selectionFromPrior,
  type PublishRequest,
  type PublishSelection,
} from '@/lib/publish-outputs';
import { secretErrorMessage } from '@/lib/secret-parameters';
import { PublishOutputsControl } from './PublishOutputsControl';

/** What a restart sends; the same as the first send, plus the queue the first run used. */
export interface RestartOptions {
  maxMinutes: number;
  queue?: string;
  publish?: PublishRequest;
}

export interface RestartRunProps {
  modelId: string;
  model: ThreadModel;
  /** The earlier run's record: where its maximum time, queue and plan are read from. */
  run?: UnifiedRunSnapshot;
  /** How many runs the model has; more than one means the whole set is sent again. */
  totalRuns: number;
  successfulRuns: number;
  ensembleManagerApi: string;
  /** A send of this model is in flight (from either step): the button is disabled. */
  inFlight: boolean;
  onRestart: (modelId: string, options: RestartOptions) => Promise<void>;
  /** Follow the run already in progress, when a flow refuses because one is. */
  onOpenFlowRun?: (modelId: string, runId: string) => Promise<void>;
  /** Called once the new run is sent, e.g. to open the Runs step. */
  onRestarted?: () => void;
}

function storedJobOptions(run?: UnifiedRunSnapshot): { maxMinutes?: number; queue?: string } {
  const result = run?.model_result as
    | { __max_minutes?: unknown; __queue?: unknown }
    | null
    | undefined;
  const minutes = Number(result?.__max_minutes);
  return {
    ...(Number.isInteger(minutes) && minutes >= 1 ? { maxMinutes: minutes } : {}),
    ...(typeof result?.__queue === 'string' && result.__queue ? { queue: result.__queue } : {}),
  };
}

export function RestartRun({
  modelId,
  model,
  run,
  totalRuns,
  successfulRuns,
  ensembleManagerApi,
  inFlight,
  onRestart,
  onOpenFlowRun,
  onRestarted,
}: RestartRunProps) {
  const stored = storedJobOptions(run);
  const isFlow = Boolean(model.isFlow);
  const [minutes, setMinutes] = useState(String(stored.maxMinutes ?? DEFAULT_MAX_MINUTES));
  const [publishers, setPublishers] = useState<PlanPublisher[]>([]);
  // undefined: the person has not chosen, so the earlier run's choice stands.
  const [chosen, setChosen] = useState<PublishSelection | null | undefined>(undefined);
  const [confirming, setConfirming] = useState(false);
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState<{ lines: string[]; runId?: string } | null>(null);

  useEffect(() => {
    if (isFlow || !ensembleManagerApi) return;
    const controller = new AbortController();
    fetchPlanPublishers(ensembleManagerApi, modelId, controller.signal)
      .then((response) => setPublishers(response.publishers ?? []))
      .catch(() => undefined);
    return () => controller.abort();
  }, [ensembleManagerApi, modelId, isFlow]);

  const selection =
    chosen !== undefined ? chosen : selectionFromPrior(publishers, priorPublish(run?.plan_id));
  const many = totalRuns > 1;
  const busy = inFlight || sending;
  const minutesValue = Number(minutes);
  const minutesValid = Number.isInteger(minutesValue) && minutesValue >= 1;

  async function send() {
    setConfirming(false);
    if (!isFlow && !minutesValid) {
      setProblem({ lines: ['Enter a positive whole number of minutes.'] });
      return;
    }
    setProblem(null);
    setSending(true);
    try {
      const publish = isFlow ? undefined : publishRequestFor(publishers, selection);
      await onRestart(modelId, {
        maxMinutes: isFlow ? DEFAULT_MAX_MINUTES : minutesValue,
        ...(stored.queue ? { queue: stored.queue } : {}),
        ...(publish ? { publish } : {}),
      });
      onRestarted?.();
    } catch (error) {
      const refusal = isFlow ? flowErrorMessage(error) : null;
      setProblem(
        refusal
          ? { lines: [refusal.title, ...refusal.lines], runId: refusal.runId }
          : {
              lines: [
                secretErrorMessage(error) ??
                  (error instanceof Error ? error.message : String(error)),
              ],
            },
      );
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="space-y-2" data-testid={`restart-${modelId}`}>
      {!isFlow && (
        <label className="flex flex-col gap-1 text-gray-800">
          <span>Maximum run time (minutes)</span>
          <input
            type="number"
            min="1"
            step="1"
            value={minutes}
            disabled={busy}
            onChange={(event) => setMinutes(event.target.value)}
            data-testid={`restart-minutes-${modelId}`}
            aria-label={`Maximum run time for the restart of ${model.name ?? modelId}`}
            className="w-28 rounded border border-gray-300 bg-white px-2 py-1"
          />
          {stored.maxMinutes === undefined && (
            <span className="text-gray-500">
              The earlier run&apos;s time was not kept, so the default is shown.
            </span>
          )}
        </label>
      )}
      {!isFlow && publishers.length > 0 && (
        <PublishOutputsControl
          modelId={modelId}
          publishers={publishers}
          outputs={model.output_files}
          selection={selection}
          disabled={busy}
          onChange={setChosen}
        />
      )}
      {confirming ? (
        <div className="space-y-1" data-testid={`restart-confirm-${modelId}`}>
          <p>
            This sends all {totalRuns} runs again
            {successfulRuns > 0 ? `, including the ${successfulRuns} that succeeded` : ''}.
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => void send()}
              disabled={busy}
              className="rounded border border-red-400 bg-red-600 px-2 py-1 text-white hover:bg-red-700 disabled:opacity-50"
              data-testid={`restart-confirm-yes-${modelId}`}
            >
              Yes, restart all {totalRuns} runs
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              className="rounded border border-gray-300 bg-white px-2 py-1 text-gray-800 hover:bg-gray-100"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => (many ? setConfirming(true) : void send())}
          disabled={busy}
          className="inline-flex items-center gap-1 rounded border border-red-300 bg-white px-2.5 py-1 font-medium text-red-800 hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-50"
          data-testid={`restart-run-${modelId}`}
        >
          <RotateCcw className={`h-3 w-3 ${busy ? 'animate-spin' : ''}`} />
          {busy ? 'Restarting…' : many ? `Restart all ${totalRuns} runs` : 'Restart'}
        </button>
      )}
      {problem && (
        <div
          className="space-y-1 text-red-700"
          role="alert"
          data-testid={`restart-error-${modelId}`}
        >
          {problem.lines.map((line, index) => (
            <p key={index} className={index === 0 && problem.lines.length > 1 ? 'font-medium' : ''}>
              {line}
            </p>
          ))}
          {problem.runId && onOpenFlowRun && (
            <button
              type="button"
              className="text-blue-700 underline"
              onClick={() => void onOpenFlowRun(modelId, problem.runId!)}
            >
              Open the run in progress
            </button>
          )}
        </div>
      )}
    </div>
  );
}
