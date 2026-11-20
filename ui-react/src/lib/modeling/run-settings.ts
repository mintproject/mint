/**
 * What a run was given: the parameter values it used, and how runs of one model
 * compare. Pure functions shared by the Runs and Results steps.
 */
import type { Execution } from '@/graphql/generated/execution';

/** The longest a model job may run unless the person chose another time. */
export const DEFAULT_MAX_MINUTES = 60;

export interface RunParam {
  id?: string | null;
  name?: string | null;
  default?: string | null;
}

export function humanizeName(name?: string | null): string {
  return (name ?? '').replace(/[-_]/g, ' ');
}

/** The value a run shows for a parameter: its binding, else the default. */
export function runParamValue(param: RunParam, execution: Execution): string {
  let value = execution.bindings[param.id ?? ''] as unknown;
  if (value == null) value = param.default ?? null;
  if (typeof value === 'string' && value.startsWith('__region_geojson')) {
    return 'Region GeoJSON';
  }
  if (value == null || value === '') return '—';
  return String(value);
}

/**
 * Split parameters into those that tell the listed runs apart (they get a
 * column) and those every run shares (they are summarised above the table).
 */
export function splitRunParams<P extends RunParam>(
  params: P[],
  executions: Execution[],
): { varying: P[]; common: Array<{ param: P; value: string }> } {
  const varying: P[] = [];
  const common: Array<{ param: P; value: string }> = [];
  for (const param of params) {
    const values = new Set(executions.map((e) => runParamValue(param, e)));
    if (values.size > 1) {
      varying.push(param);
    } else {
      const value = executions[0] ? runParamValue(param, executions[0]) : '—';
      if (value !== '—') common.push({ param, value });
    }
  }
  return { varying, common };
}

export interface UsedSetting {
  id: string;
  label: string;
  value: string;
  /** The run used a value other than the parameter's default. */
  changed: boolean;
}

/**
 * The settings one run used, those changed from their default first. A setting
 * with no value (no binding, no default) is left out.
 */
export function settingsUsed(params: RunParam[], execution: Execution): UsedSetting[] {
  const used = params.flatMap((param, index) => {
    const value = runParamValue(param, execution);
    if (value === '—') return [];
    const bound = execution.bindings[param.id ?? ''] as unknown;
    const changed = bound != null && bound !== '' && String(bound) !== String(param.default ?? '');
    return [{ id: param.id ?? String(index), label: humanizeName(param.name), value, changed }];
  });
  return [...used.filter((s) => s.changed), ...used.filter((s) => !s.changed)];
}

/** How long a run took, or null while it is unfinished or its times are unknown. */
export function runDuration(
  start: string | null | undefined,
  end: string | null | undefined,
): string | null {
  if (!start || !end) return null;
  const ms = Date.parse(end) - Date.parse(start);
  if (!Number.isFinite(ms) || ms < 0) return null;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} min`;
}
