/**
 * Plain-language refusals for a flow run.
 *
 * The Ensemble Manager refuses a flow plan or submit with a machine code and
 * structured details. A person needs the sentence and the specifics (which
 * input, which step, which settings), so this maps one to the other. Pure: no
 * React, no fetch.
 */
import { EnsembleManagerError } from './ensemble-manager';

export interface FlowErrorMessage {
  title: string;
  lines: string[];
  /** The run already in progress, for `FLOW_ALREADY_RUNNING`. */
  runId?: string;
}

export const FLOW_ERROR_CODES = [
  'FLOW_INPUT_UNBOUND',
  'FLOW_FANOUT_UNSUPPORTED',
  'FLOW_SETTINGS_NOT_ACCEPTED',
  'FLOW_ALREADY_RUNNING',
  'FLOW_PLAN_NOT_YOURS',
  'FLOW_ARGUMENT_FIXED',
  'STORED_SOURCE_REFUSED',
  'FLOW_DOES_NOT_CHECK_OUT',
  'FLOW_REGION_INVALID',
  'FLOW_OUTPUTS_UNREPORTED',
  'FLOW_FAILED',
] as const;

type Details = Record<string, unknown>;

function asDetails(details: unknown): Details {
  return details && typeof details === 'object' && !Array.isArray(details)
    ? (details as Details)
    : {};
}

/** A detail field, whether the server nests it under `details` once or twice. */
function field(details: unknown, key: string): unknown {
  const d = asDetails(details);
  return d[key] ?? asDetails(d.details)[key];
}

function text(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** One readable line for a link between settings; unknown shapes fall back to JSON. */
export function describeFlowLink(link: unknown): string {
  if (link && typeof link === 'object') {
    const l = link as Details;
    const from = l.from ?? l.source ?? l.from_step ?? l.source_step;
    const to = l.to ?? l.target ?? l.to_step ?? l.target_step ?? l.name;
    if (from != null && to != null) return `${text(to)} is taken from ${text(from)}`;
  }
  return text(link);
}

/** The author's settings as `name: value` lines then one line per link. */
export function flowSettingsLines(settings: {
  defaults?: Record<string, unknown>;
  links?: unknown[];
}): string[] {
  const defaults = Object.entries(settings.defaults ?? {}).map(
    ([name, value]) => `${name}: ${text(value)}`,
  );
  const links = (settings.links ?? []).map(describeFlowLink);
  return [...defaults, ...links];
}

function problemLines(problems: unknown[]): string[] {
  return problems.map((p) => {
    if (p && typeof p === 'object') {
      const { code, message, step } = p as Details;
      const prefix = step ? `Step ${text(step)}: ` : '';
      const body = text(message) || text(code);
      return `${prefix}${body}${message && code ? ` (${text(code)})` : ''}`;
    }
    return text(p);
  });
}

/** The message for a flow refusal, or null for an error that is not one. */
export function flowErrorMessage(error: unknown): FlowErrorMessage | null {
  if (!(error instanceof EnsembleManagerError)) return null;
  const { code, details } = error;
  const serverMessage = error.message;
  switch (code) {
    case 'FLOW_INPUT_UNBOUND': {
      const input = text(field(details, 'input'));
      return {
        title: 'This flow has an input with no data',
        lines: [
          input
            ? `Choose a dataset for the input "${input}" in the data step, then run again.`
            : 'Choose a dataset for every input of the flow in the data step, then run again.',
        ],
      };
    }
    case 'FLOW_FANOUT_UNSUPPORTED': {
      const input = text(field(details, 'input'));
      const chosen = field(details, 'datasets');
      const count = typeof chosen === 'number' ? chosen : list(chosen).length;
      return {
        title: 'This input takes one file',
        lines: [
          `${input ? `The input "${input}"` : 'An input'} has ${count || 'more than one'} files chosen, and the flow takes one. Keep one in the data step, then run again.`,
        ],
      };
    }
    case 'FLOW_SETTINGS_NOT_ACCEPTED': {
      const settings = flowSettingsLines({
        defaults: asDetails(field(details, 'defaults')),
        links: list(field(details, 'links')),
      });
      return {
        title: "The flow's own settings were not accepted",
        lines: [
          "These were chosen by the flow's author and will be used with your account. Accept them to run.",
          ...settings,
        ],
      };
    }
    case 'FLOW_ALREADY_RUNNING': {
      const runId = text(field(details, 'run_id'));
      return {
        title: 'This flow is already running',
        lines: [
          runId
            ? `Run ${runId} is still in progress. Wait for it to finish, or cancel it, before running again.`
            : 'A run is still in progress. Wait for it to finish, or cancel it, before running again.',
        ],
        ...(runId ? { runId } : {}),
      };
    }
    case 'FLOW_PLAN_NOT_YOURS':
      return {
        title: 'That plan belongs to someone else',
        lines: ['Press Run again to make a new plan with your own account.'],
      };
    case 'FLOW_ARGUMENT_FIXED': {
      const args = list(field(details, 'arguments')).map(text);
      return {
        title: 'A setting is fixed by the flow',
        lines: [
          'The flow does not let a run change these settings. Plan again without them.',
          ...args,
        ],
      };
    }
    case 'STORED_SOURCE_REFUSED': {
      const problems = problemLines(list(field(details, 'problems')));
      return {
        title: 'A piece of this flow is not approved for you',
        lines: [
          "One or more of its pieces is someone else's code that an administrator has not approved, so it will not run with your account.",
          ...problems,
        ],
      };
    }
    case 'FLOW_DOES_NOT_CHECK_OUT': {
      const problems = problemLines(list(field(details, 'problems')));
      return {
        title: 'This flow does not fit its pieces or its data',
        lines: [
          'The steps and the chosen data do not agree, so the run was not started.',
          ...problems,
        ],
      };
    }
    case 'FLOW_REGION_INVALID':
      return {
        title: 'The region is not usable for this flow',
        lines: ['Choose a valid region for the thread, then run again.'],
      };
    case 'FLOW_OUTPUTS_UNREPORTED':
      return {
        title: 'The flow finished but reported no outputs',
        lines: ['Its results cannot be listed. Ask the flow owner to check its output steps.'],
      };
    case 'FLOW_FAILED':
      return {
        title: 'The flow failed',
        lines: serverMessage ? [serverMessage] : ['A step failed. Open the run to see which one.'],
      };
    default:
      return null;
  }
}

/** The message as one string, for the places that show a single line of error. */
export function flowErrorText(message: FlowErrorMessage): string {
  return [message.title, ...message.lines].join(' ');
}
