import { RotateCcw } from 'lucide-react';
import type { ReactNode } from 'react';

import { EnsembleManagerError, type UnifiedRunSnapshot } from '@/lib/ensemble-manager';
import { flowErrorMessage } from '@/lib/flow-errors';

export interface RunFailureNoticeProps {
  /** The run's failure code and message, when the run has a durable record. */
  run?: Pick<UnifiedRunSnapshot, 'failure_code' | 'error_message'>;
  /** What failed inside the run, one line per step, shown under the reason. */
  stepErrors?: string[];
  cancelled?: boolean;
  /** Sends the model again. Absent means the viewer cannot run it. */
  onRestart?: () => void;
  /** A send is in flight: Restart is disabled so nothing is started twice. */
  restarting?: boolean;
  /** Why the send was refused, shown under the button. */
  problem?: ReactNode;
  testId?: string;
}

/**
 * Why a run did not finish, and the way to run it again. The reason is the
 * Ensemble Manager's own failure code and message, in words when the code is a
 * known flow refusal.
 */
export function RunFailureNotice({
  run,
  stepErrors = [],
  cancelled = false,
  onRestart,
  restarting = false,
  problem,
  testId = 'run-failure',
}: RunFailureNoticeProps) {
  const known = run?.failure_code
    ? flowErrorMessage(new EnsembleManagerError(0, run.error_message ?? '', run.failure_code))
    : null;
  const hasReason = Boolean(known || run?.failure_code || run?.error_message);
  return (
    <div
      role="alert"
      className="space-y-2 rounded border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800"
      data-testid={testId}
    >
      {known ? (
        <div data-testid="flow-run-failure">
          <div className="font-medium">{known.title}</div>
          {known.lines.map((line, index) => (
            <div key={index}>{line}</div>
          ))}
        </div>
      ) : hasReason ? (
        <div data-testid="flow-run-failure">
          {run?.failure_code && <div className="font-medium">Failure: {run.failure_code}</div>}
          {run?.error_message && <div>{run.error_message}</div>}
        </div>
      ) : (
        <div className="font-medium">
          {cancelled ? 'This run was cancelled.' : 'The run did not finish. Open its log for why.'}
        </div>
      )}
      {stepErrors.length > 0 && (
        <ul className="list-disc pl-4" data-testid="run-step-errors">
          {stepErrors.map((line, index) => (
            <li key={index}>{line}</li>
          ))}
        </ul>
      )}
      {onRestart && (
        <button
          type="button"
          onClick={onRestart}
          disabled={restarting}
          className="inline-flex items-center gap-1 rounded border border-red-300 bg-white px-2.5 py-1 font-medium text-red-800 hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-50"
          data-testid={`${testId}-restart`}
        >
          <RotateCcw className={`h-3 w-3 ${restarting ? 'animate-spin' : ''}`} />
          {restarting ? 'Restarting…' : 'Restart'}
        </button>
      )}
      {problem}
    </div>
  );
}
