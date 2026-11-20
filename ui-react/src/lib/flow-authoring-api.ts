/**
 * The three calls the flow form makes, each with the signed-in user's token. The
 * browser does not call the SVO adapter (its front door is on); the first two go
 * through the Ensemble Manager's allowlisted forward, `/v1/adapter/...`:
 *
 * - the adapter's `POST /flows/check`, for the live check (problems on the step
 *   and link they are on, and what each piece takes and returns);
 * - the adapter's `POST /flows/propose`, for proposals, exact from the contracts;
 * - the model catalog API's `POST /flows`, to save. It asks the adapter's check
 *   again first, so a save never depends on what this form believes.
 */
import { getEnsembleManagerApiUrl, getModelCatalogApiUrl } from './config';
import type { FlowProblem, ProposedChain, ProposedSource, WireJson } from './flow-authoring';

export interface PieceSummary {
  inputs: number[];
  outputs: number[];
  settings: string[];
  values: string[];
  input_contracts: Record<
    string,
    { standard_variable_uri?: string; unit?: string; format?: string }
  >;
  output_contracts: Record<
    string,
    { standard_variable_uri?: string; unit?: string; format?: string }
  >;
  setting_details: Record<string, { type?: string; default?: unknown; description?: string }>;
}

export interface FlowCheck {
  ok: boolean;
  problems: FlowProblem[];
  pieces: Record<string, PieceSummary>;
}

export type CheckBody = Record<string, unknown>;

export interface PieceRef {
  piece: string;
  label?: string | null;
  approval?: string | null;
}

/** Suggestions for an unmet need. They never make the need met. */
export interface NeedProviders {
  models: {
    configuration_id: string;
    label?: string | null;
    /** The output's position. */
    output?: string | number | null;
    format?: string | null;
    /** The standard variable the output carries, and its readable label. */
    variable?: string | null;
    output_label?: string | null;
  }[];
  datasets: {
    data_object_id: string;
    label?: string | null;
    /** A readable name (the label is sometimes a variable's URI). */
    name?: string | null;
    /** Where the data is (its resource location). */
    url?: string | null;
    format?: string | null;
  }[];
}

export interface Proposal {
  direct: { source: ProposedSource; fits: boolean; wire: WireJson }[];
  chains: (ProposedChain & {
    pieces: (PieceRef & { position: number; output: number })[];
    length: number;
    lossy: boolean;
  })[];
  next: (PieceRef & { input: number })[];
  produces: (PieceRef & {
    output: number;
    complete: boolean;
    /** What the piece makes, and whether it only converts (same variable in and out). */
    output_variable?: string | null;
    output_label?: string | null;
    output_format?: string | null;
    output_unit?: string | null;
    converter?: boolean;
    inputs: {
      input: number;
      met: boolean;
      /** What the input takes. */
      variable?: string | null;
      variable_label?: string | null;
      format?: string | null;
      unit?: string | null;
      direct: { source: ProposedSource; wire: WireJson }[];
      chains: ProposedChain[];
      providers?: NeedProviders;
    }[];
  })[];
  cut: boolean;
  warnings: { code: string; piece: string; input?: number; fields?: string[] }[];
}

export type Purpose =
  | { step: number; input: number }
  | { step: number; output: number }
  | { contract: { standard_variable_uri?: string; format?: string } };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function headers(token: string): HeadersInit {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
}

async function post(url: string, token: string, body: unknown, signal?: AbortSignal) {
  const response = await fetch(url, {
    method: 'POST',
    headers: headers(token),
    body: JSON.stringify(body),
    signal,
  });
  const json: unknown = await response.json().catch(() => null);
  return { response, json };
}

/** The adapter's check, or null when it cannot be had (no adapter, no answer). */
export async function checkFlow(
  body: CheckBody,
  token: string,
  signal?: AbortSignal,
): Promise<FlowCheck | null> {
  const base = getEnsembleManagerApiUrl();
  if (!base) return null;
  try {
    const { response, json } = await post(`${base}/adapter/flows/check`, token, body, signal);
    if (!response.ok || !isRecord(json) || typeof json.ok !== 'boolean') return null;
    return {
      ok: json.ok,
      problems: Array.isArray(json.problems) ? (json.problems as FlowProblem[]) : [],
      pieces: isRecord(json.pieces) ? (json.pieces as Record<string, PieceSummary>) : {},
    };
  } catch {
    return null;
  }
}

export type ProposeResult = { proposal: Proposal } | { error: string };

export async function proposeForFlow(
  body: CheckBody,
  purpose: Purpose,
  token: string,
  signal?: AbortSignal,
): Promise<ProposeResult> {
  const base = getEnsembleManagerApiUrl();
  if (!base) return { error: 'This deployment has no Ensemble Manager to propose with.' };
  try {
    const { response, json } = await post(
      `${base}/adapter/flows/propose`,
      token,
      { ...body, purpose, max_chain: 3, max_results: 20 },
      signal,
    );
    if (!response.ok || !isRecord(json)) {
      const detail = isRecord(json) && isRecord(json.detail) ? json.detail : null;
      return { error: typeof detail?.message === 'string' ? detail.message : 'No proposals.' };
    }
    const list = (key: string) => (Array.isArray(json[key]) ? json[key] : []);
    return {
      proposal: {
        direct: list('direct'),
        chains: list('chains'),
        next: list('next'),
        produces: list('produces'),
        cut: json.cut === true,
        warnings: list('warnings'),
      } as Proposal,
    };
  } catch {
    return { error: 'The Ensemble Manager could not be reached.' };
  }
}

export type SaveResult =
  | { ok: true; configurationId: string }
  | { ok: false; code: string; message: string; problems: FlowProblem[] };

export async function saveFlow(body: unknown, token: string): Promise<SaveResult> {
  try {
    const { response, json } = await post(`${getModelCatalogApiUrl()}/flows`, token, body);
    const reply = isRecord(json) ? json : {};
    if (response.ok && typeof reply.configuration_id === 'string') {
      return { ok: true, configurationId: reply.configuration_id };
    }
    return {
      ok: false,
      code: typeof reply.code === 'string' ? reply.code : `HTTP_${response.status}`,
      message: typeof reply.error === 'string' ? reply.error : 'The flow could not be saved.',
      problems: Array.isArray(reply.problems) ? (reply.problems as FlowProblem[]) : [],
    };
  } catch {
    return {
      ok: false,
      code: 'NETWORK',
      message: 'The model catalog could not be reached.',
      problems: [],
    };
  }
}
