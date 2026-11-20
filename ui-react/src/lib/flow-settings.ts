/**
 * What a runner or a flow's author needs to know about a setting of a flow: the piece's
 * description of it (a title, an explanation, a type, explained choices, bounds), the value
 * a run starts from, and what the author decided (fixed, and whether it is shown, advanced
 * or hidden).
 *
 * The description comes from the piece's JSON Schema through the adapter, and the author's
 * decisions from the flow. Every key is optional: an older piece has only a type and a
 * description, and a setting without them is described by its name.
 */
import { getModelCatalogApiUrl } from './config';

export const VISIBILITIES = ['shown', 'advanced', 'hidden'] as const;
export type Visibility = (typeof VISIBILITIES)[number];

export interface SettingChoice {
  value: string | number | boolean;
  title?: string;
  description?: string;
}

/** The piece's own description of one setting. */
export interface SettingDetails {
  type?: string;
  default?: unknown;
  description?: string;
  title?: string;
  choices?: SettingChoice[];
  minimum?: number;
  maximum?: number;
  /** The piece suggests keeping it out of the way. */
  advanced?: boolean;
}

/** What the author decided about one setting of the flow. */
export interface SettingRule {
  visibility?: Visibility;
  fixed?: boolean;
}

/** One setting of a stored flow as a runner meets it. */
export interface FlowSetting extends SettingDetails {
  name: string;
  /** The flow parameter row the thread binds a value to. */
  parameter_id: string;
  visibility: Visibility;
  fixed?: boolean;
}

export interface FlowSettings {
  settings: FlowSetting[];
  /** Settings the thread fills in itself (the dates). */
  thread_bound: string[];
}

export type SettingInputKind = 'choice' | 'number' | 'boolean' | 'text';

/** Which input suits a setting: a dropdown for choices, a number box, a tick box, or text. */
export function settingInputKind(details: SettingDetails | undefined): SettingInputKind {
  if (details?.choices?.length) return 'choice';
  if (details?.type === 'integer' || details?.type === 'number') return 'number';
  if (details?.type === 'boolean') return 'boolean';
  return 'text';
}

/** The name a person reads: the piece's title, else the name with its underscores spaced. */
export function settingTitle(name: string, details?: Pick<SettingDetails, 'title'>): string {
  return details?.title?.trim() || name.replace(/_/g, ' ');
}

export const choiceLabel = (choice: SettingChoice): string => choice.title ?? String(choice.value);

/** A value as a person reads it: the title of the choice it is, else the value itself. */
export function choiceText(
  details: Pick<SettingDetails, 'choices'> | undefined,
  value: string,
): string {
  const choice = details?.choices?.find((c) => String(c.value) === value);
  return choice ? choiceLabel(choice) : value;
}

/** The value a setting starts from, as the text an input shows. */
export function settingText(value: unknown): string {
  if (value === undefined || value === null) return '';
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/** Where a setting belongs in the form, from the author's choice or the piece's hint. */
export function visibilityOf(rule: SettingRule | undefined, details?: SettingDetails): Visibility {
  if (rule?.visibility && VISIBILITIES.includes(rule.visibility)) return rule.visibility;
  return details?.advanced ? 'advanced' : 'shown';
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function isSetting(value: unknown): value is FlowSetting {
  return (
    isRecord(value) &&
    typeof value.name === 'string' &&
    typeof value.parameter_id === 'string' &&
    typeof value.visibility === 'string' &&
    (VISIBILITIES as readonly string[]).includes(value.visibility)
  );
}

/**
 * The adapter's answer for a flow, or null when it cannot be had (no token, no adapter,
 * a catalog without the route, a malformed answer). The form then falls back to the flow's
 * parameter rows, which carry the defaults, choices and bounds but not titles, explanations
 * or the author's visibility.
 */
export async function fetchFlowSettings(
  flowId: string,
  token: string | null,
  signal?: AbortSignal,
): Promise<FlowSettings | null> {
  const base = getModelCatalogApiUrl();
  if (!base || !token) return null;
  try {
    const response = await fetch(`${base}/flows/${encodeURIComponent(flowId)}/settings`, {
      headers: { Authorization: `Bearer ${token}` },
      signal,
    });
    if (!response.ok) return null;
    const body: unknown = await response.json();
    if (!isRecord(body) || !Array.isArray(body.settings)) return null;
    return {
      settings: body.settings.filter(isSetting),
      thread_bound: Array.isArray(body.thread_bound)
        ? body.thread_bound.filter((name): name is string => typeof name === 'string')
        : [],
    };
  } catch {
    return null;
  }
}
