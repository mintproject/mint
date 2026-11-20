export type RunDisplayStatus =
  | 'waiting'
  | 'running'
  | 'paused'
  | 'completing'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'unknown';

export type StageDisplayStatus = RunDisplayStatus | 'not-required';

const FAILURE_STATUSES = ['fail', 'failed', 'failure', 'error', 'timeout', 'timed_out', 'expired'];
const CANCELLED_STATUSES = ['cancel', 'cancelled', 'canceled', 'aborted'];
const COMPLETED_STATUSES = ['success', 'succeeded', 'completed', 'model_succeeded'];
const COMPLETING_STATUSES = [
  'output_registering',
  'output_verifying',
  'adapter_dispatching',
  'output_handoff',
];
const RUNNING_STATUSES = [
  'running',
  'model_running',
  'adapter_running',
  'model_submitted',
  'executing',
  'in_progress',
  'submitting',
];
/** A flow stopped for the person's edit; the run is not finished. */
const PAUSED_STATUSES = ['awaiting_edit'];
const WAITING_STATUSES = ['planned', 'queued', 'pending', 'waiting', 'not_started'];

function normalized(value: unknown): string {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_');
}

function includesStatus(value: string, candidates: string[]): boolean {
  return candidates.some((candidate) => value === candidate || value.includes(candidate));
}

/** Convert provider/application states into stable facilitator-facing states. */
export function normalizeRunStatus(raw: unknown): RunDisplayStatus {
  const value = normalized(raw);
  if (!value) return 'unknown';
  if (includesStatus(value, CANCELLED_STATUSES)) return 'cancelled';
  if (includesStatus(value, FAILURE_STATUSES)) return 'failed';
  if (COMPLETED_STATUSES.includes(value)) return 'completed';
  if (PAUSED_STATUSES.includes(value)) return 'paused';
  if (COMPLETING_STATUSES.includes(value)) return 'completing';
  if (RUNNING_STATUSES.includes(value)) return 'running';
  if (WAITING_STATUSES.includes(value)) return 'waiting';
  return 'unknown';
}

export function normalizeStageStatus(raw: unknown): StageDisplayStatus {
  return normalizeRunStatus(raw);
}

export function stageStatusFromLegacyState(
  state: 'success' | 'failure' | 'running' | 'pending' | 'not-required',
): StageDisplayStatus {
  if (state === 'success') return 'completed';
  if (state === 'failure') return 'failed';
  if (state === 'running') return 'running';
  if (state === 'not-required') return 'not-required';
  return 'waiting';
}

export function displayStatusLabel(status: RunDisplayStatus | StageDisplayStatus): string {
  switch (status) {
    case 'waiting':
      return 'Waiting to start';
    case 'running':
      return 'Running';
    case 'paused':
      return 'Waiting for your edit';
    case 'completing':
      return 'Completing';
    case 'completed':
      return 'Completed';
    case 'failed':
      return 'Failed';
    case 'cancelled':
      return 'Cancelled';
    case 'not-required':
      return 'Not required';
    default:
      return 'Needs review';
  }
}

export function statusPillClasses(status: RunDisplayStatus | StageDisplayStatus): string {
  switch (status) {
    case 'completed':
      return 'bg-green-100 text-green-800';
    case 'failed':
    case 'cancelled':
      return 'bg-red-100 text-red-800';
    case 'running':
    case 'completing':
      return 'bg-blue-100 text-blue-800';
    case 'waiting':
      return 'bg-gray-100 text-gray-700';
    case 'not-required':
      return 'bg-gray-100 text-gray-500';
    default:
      return 'bg-amber-100 text-amber-800';
  }
}

export interface RunCounts {
  totalRuns: number;
  submittedRuns: number;
  successfulRuns: number;
  failedRuns: number;
  fallbackStatus?: unknown;
}

/** Apply evidence-based precedence to an aggregate execution summary. */
export function aggregateRunStatus({
  totalRuns,
  submittedRuns,
  successfulRuns,
  failedRuns,
  fallbackStatus,
}: RunCounts): RunDisplayStatus {
  const finishedRuns = successfulRuns + failedRuns;
  const fallback = normalizeRunStatus(fallbackStatus);

  if (failedRuns > 0 && finishedRuns >= totalRuns && totalRuns > 0) return 'failed';
  if (successfulRuns >= totalRuns && totalRuns > 0) return 'completed';
  if (fallback === 'failed' || fallback === 'cancelled') return fallback;
  if (fallback === 'paused') return 'paused';
  if (submittedRuns > 0 || fallback === 'running' || fallback === 'completing') {
    return fallback === 'completing' ? 'completing' : 'running';
  }
  return totalRuns > 0 ? 'waiting' : 'unknown';
}

export function formatDateValue(value: string | null | undefined): string {
  if (!value) return 'Not recorded';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}
