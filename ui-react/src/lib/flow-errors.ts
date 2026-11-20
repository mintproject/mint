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
  'FLOW_COLLECTION_REFUSED',
  'FLOW_COLLECTION_RESOURCE_REFUSED',
  'FLOW_STAGING_UNRESOLVED',
  'FLOW_SECRET_MISSING',
  'FLOW_SECRET_CHANGED',
  'SECRET_PIECE_UNSUPPORTED',
  'SECRET_PIECE_NOT_TRUSTED',
  'GATHER_RESOURCE_NEEDS_LOGIN',
  'GATHER_ADDRESS_REFUSED',
  'GATHER_TOO_LARGE',
  'GATHER_RESOURCE_FAILED',
  'GATHER_STAGING_FAILED',
  'GATHER_FILE_INVALID',
  'FLOW_NOT_AWAITING_EDIT',
  'FLOW_RESUME_NOT_YOURS',
  'RUN_RESUME_FORBIDDEN',
  'FLOW_REPLACEMENT_INVALID',
  'FLOW_REPLACEMENT_NOT_EDITABLE',
  'FLOW_REPLACEMENT_REFUSED',
  'FLOW_RESUME_VALUE_MISSING',
  'FLOW_RESUME_VALUE_REFUSED',
  'FLOW_RESUME_ARGUMENT_CLASH',
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

/** A flow's plan asks for settings the thread has no value for. */
export class FlowSettingsMissingError extends Error {
  constructor(readonly settings: string[]) {
    super(`This flow needs a value for: ${settings.join(', ')}`);
    this.name = 'FlowSettingsMissingError';
  }
}

/**
 * The settings a flow's plan requires that have neither a default nor a value
 * from the thread. Settings the service fills in itself are left out.
 */
export function missingFlowSettings(plan: {
  parameters?: Array<{ name: string; required?: boolean; default?: unknown; managed?: boolean }>;
  parameter_values?: Record<string, unknown>;
}): string[] {
  const given = plan.parameter_values ?? {};
  return (plan.parameters ?? [])
    .filter((p) => p.required && !p.managed && (p.default === undefined || p.default === null))
    .filter((p) => given[p.name] === undefined || given[p.name] === null || given[p.name] === '')
    .map((p) => p.name);
}

const GATHER_TITLES: Record<string, string> = {
  GATHER_RESOURCE_NEEDS_LOGIN: 'A file needs a login this flow does not have',
  GATHER_ADDRESS_REFUSED: 'A file location was refused',
  GATHER_TOO_LARGE: 'The files are too large to gather',
  GATHER_RESOURCE_FAILED: 'A file could not be fetched',
  GATHER_STAGING_FAILED: 'The files could not be placed on the computing system',
  GATHER_FILE_INVALID: 'The edited file cannot be used',
};

/** A failed gather step: the title for its code, with the file and host when known. */
function gatherMessage(code: string, serverMessage: string, details: unknown): FlowErrorMessage {
  const lines: string[] = [];
  if (code === 'GATHER_RESOURCE_NEEDS_LOGIN') {
    const file = text(field(details, 'index') ?? field(details, 'file'));
    const host = text(field(details, 'host'));
    const found = /file\s+(\d+)\s+on\s+(\S+)/i.exec(serverMessage);
    const n = file || found?.[1];
    const on = host || found?.[2];
    lines.push(
      n && on
        ? `One of the files needs a login this flow does not have: file ${n} on ${on}`
        : 'One of the files needs a login this flow does not have.',
    );
  } else if (serverMessage) {
    lines.push(serverMessage);
  }
  if (lines.length === 0) lines.push('Open the run to see which file.');
  return { title: GATHER_TITLES[code] ?? code, lines };
}

const GATHER_CODE = /\bGATHER_[A-Z_]+\b/;

const SECRET_FETCH_FAILED = 'STEP_SECRET_FETCH_FAILED';

/**
 * A failed step's error text in plain words when it carries a gather code,
 * otherwise the text unchanged.
 */
export function stepErrorText(raw: string): string {
  if (raw.includes(SECRET_FETCH_FAILED)) {
    return 'A step could not fetch your saved credential. Check it still exists, then run again.';
  }
  const code = GATHER_CODE.exec(raw)?.[0];
  if (!code || !(code in GATHER_TITLES)) return raw;
  return flowErrorText(gatherMessage(code, raw, undefined));
}

/** The message for a flow refusal, or null for an error that is not one. */
export function flowErrorMessage(error: unknown): FlowErrorMessage | null {
  if (error instanceof FlowSettingsMissingError) {
    return {
      title: 'This flow needs a setting filled in',
      lines: [
        'Give these a value in the Parameters step, save, then run again.',
        ...error.settings,
      ],
    };
  }
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
    case 'FLOW_COLLECTION_REFUSED': {
      const input = text(field(details, 'input'));
      const reason = text(field(details, 'reason')) || serverMessage;
      return {
        title: 'The files chosen for this input cannot be read together',
        lines: [
          input ? `Input "${input}": ${reason}` : reason,
          'Change the selection in the data step, then run again.',
        ].filter(Boolean),
      };
    }
    case 'FLOW_COLLECTION_RESOURCE_REFUSED': {
      const index = field(details, 'index');
      const reason = text(field(details, 'reason')) || serverMessage;
      const which = typeof index === 'number' ? `File ${index + 1}` : 'One of the files';
      return {
        title: 'One of the files cannot be used',
        lines: [`${which}: ${reason}`, 'Deselect it in the data step, then run again.'].filter(
          Boolean,
        ),
      };
    }
    case 'FLOW_STAGING_UNRESOLVED':
      return {
        title: 'Your scratch folder was not found',
        lines: [
          'We could not find your scratch folder on the computing system. Run any job there once, then try again.',
          ...(serverMessage ? [serverMessage] : []),
        ],
      };
    case 'FLOW_SECRET_MISSING': {
      const secrets = list(field(details, 'secrets')).map((s) => {
        const d = asDetails(s);
        const fields = list(d.fields).map(text);
        return fields.length > 0 ? `${text(d.name)} (${fields.join(', ')})` : text(d.name);
      });
      return {
        title: 'This flow needs credentials you have not saved',
        lines: ['Save these under Saved credentials, then run again.', ...secrets],
      };
    }
    case 'FLOW_SECRET_CHANGED': {
      const name = text(field(details, 'name'));
      return {
        title: 'A saved credential changed',
        lines: [
          `${name ? `The credential "${name}"` : 'A credential'} changed after this run was planned. Press Run again.`,
        ],
      };
    }
    case 'SECRET_PIECE_UNSUPPORTED': {
      const step = text(field(details, 'step'));
      return {
        title: 'A step cannot use saved credentials',
        lines: [
          `${step ? `Step ${step}` : 'A step'} needs a credential but its piece cannot receive one. Ask the flow owner to fix it.`,
        ],
      };
    }
    case 'SECRET_PIECE_NOT_TRUSTED': {
      const step = text(field(details, 'step'));
      return {
        title: 'A step is not approved to use saved credentials',
        lines: [
          `${step ? `Step ${step}` : 'A step'} needs a credential, and its piece has not been approved by an administrator to receive one.`,
        ],
      };
    }
    case 'FLOW_NOT_AWAITING_EDIT':
      return {
        title: 'This run is not waiting for an edit',
        lines: ['It may already have continued, or been cancelled. Refresh the run to see.'],
      };
    case 'FLOW_RESUME_NOT_YOURS':
    case 'RUN_RESUME_FORBIDDEN':
      return {
        title: 'Only the user who started this run can continue it',
        lines: ['You can watch the run, but the edit and the continue button are theirs.'],
      };
    case 'FLOW_REPLACEMENT_INVALID':
    case 'FLOW_REPLACEMENT_NOT_EDITABLE':
      return {
        title: 'That is not the file this run stopped for',
        lines: [
          'Upload the edited copy of the file shown above, one file only.',
          ...(serverMessage ? [serverMessage] : []),
        ],
      };
    case 'FLOW_REPLACEMENT_REFUSED':
      return {
        title: 'The edited file was refused',
        lines: [
          'It must be a file in the data catalog, uploaded from this page.',
          ...(serverMessage ? [serverMessage] : []),
        ],
      };
    case 'FLOW_RESUME_VALUE_REFUSED':
    case 'FLOW_RESUME_ARGUMENT_CLASH':
      return {
        title: 'The run cannot be continued safely',
        lines: [
          'Something the first part reported cannot be passed on. Cancel the run and run the flow again.',
        ],
      };
    case 'FLOW_RESUME_VALUE_MISSING':
      return {
        title: 'The first part of the run did not leave what the rest needs',
        lines: ['The run cannot continue. Cancel it and run the flow again.'],
      };
    case 'GATHER_RESOURCE_NEEDS_LOGIN':
    case 'GATHER_FILE_INVALID':
    case 'GATHER_ADDRESS_REFUSED':
    case 'GATHER_TOO_LARGE':
    case 'GATHER_RESOURCE_FAILED':
    case 'GATHER_STAGING_FAILED':
      return gatherMessage(code, serverMessage, details);
    case 'INVALID_PARAMETERS': {
      // The adapter's answer when a setting is missing or has the wrong form.
      const wrong = Object.entries(asDetails(field(details, 'parameters'))).map(
        ([name, why]) => `${name}: ${text(why)}`,
      );
      if (wrong.length === 0) return null;
      return {
        title: 'A setting of this flow is missing or not usable',
        lines: ['Correct these in the Parameters step, save, then run again.', ...wrong],
      };
    }
    default:
      return null;
  }
}

/** The message as one string, for the places that show a single line of error. */
export function flowErrorText(message: FlowErrorMessage): string {
  return [message.title, ...message.lines].join(' ');
}
