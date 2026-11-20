import type { ReactNode } from 'react';

import { EnsembleManagerError, type UnifiedRunSnapshot } from '@/lib/ensemble-manager';
import { flowErrorMessage } from '@/lib/flow-errors';

export interface RunFailureNoticeProps {
  /** The run's failure code and message, when the run has a durable record. */
  run?: Pick<UnifiedRunSnapshot, 'failure_code' | 'error_message'>;
  /** What failed inside the run, one line per step, shown under the reason. */
  stepErrors?: string[];
  cancelled?: boolean;
  /** What the viewer can do about it: the restart control, when they may run the model. */
  actions?: ReactNode;
  testId?: string;
}

/**
 * Why a run did not finish, and the way to run it again. The reason is the
 * Ensemble Manager's own failure code and message, in words when the code is a
 * known flow refusal. The way to run it again is passed in as `actions`.
 */
export function RunFailureNotice({
  run,
  stepErrors = [],
  cancelled = false,
  actions,
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
      {actions}
    </div>
  );
}
