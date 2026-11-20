/**
 * Registering a piece from a repository commit, and approving pieces.
 *
 * Both go through the Ensemble Manager's `/etl-pieces` routes, which forward the
 * signed-in user's bearer token (and the service secret) to the SVO adapter and
 * return the adapter's status, error body and `Retry-After` as they came. The
 * browser never holds source code: the adapter fetches the named file from a public
 * GitHub repository at a pinned commit, and this module only sends the address and
 * the declarations.
 *
 * Design: docs/design/2026-11-20-flow-authoring-in-the-ui.md, parts D1 and D2.
 */
import { getEnsembleManagerApiUrl } from './config';
import { getAccessToken } from './auth/token-store';

export const COMMIT_PATTERN = /^[0-9a-fA-F]{40}$/;
export const ARGUMENT_TYPES = ['string', 'number', 'integer', 'boolean'] as const;
export type ArgumentType = (typeof ARGUMENT_TYPES)[number];
export type PieceVisibility = 'private' | 'shared' | 'public';

export interface PieceContract {
  standard_variable_uri: string;
  format?: string;
  unit?: string;
}

export interface PieceArgument {
  name: string;
  type: ArgumentType;
  default?: string | number | boolean;
  description?: string;
  required?: boolean;
}

export interface PieceSecret {
  name: string;
  label: string;
  /** Task input name to secret field name. */
  env: Record<string, string>;
}

export interface PieceSends {
  service: string;
  what: string;
}

export interface PieceFromRepositoryRequest {
  label: string;
  description: string;
  version: string;
  visibility: PieceVisibility;
  repository: string;
  commit: string;
  path: string;
  entrypoint: string;
  inputs: PieceContract[];
  outputs: PieceContract[];
  arguments: PieceArgument[];
  secrets: PieceSecret[];
  sends_data_to: PieceSends[];
  dry_run: boolean;
}

export interface PieceOrigin {
  repository: string;
  commit: string;
  path: string;
  url: string;
  sha256: string;
  fetched_at: string;
  /** The branch whose history holds the commit, when GitHub confirmed it. */
  verified_on_branch?: string | null;
}

/** What the adapter says it will store (dry run) or has stored (live). */
export interface PiecePreview {
  dry_run: boolean;
  /** Present once registered; the id is chosen by the adapter at that point. */
  process_id?: string;
  label: string;
  description: string;
  version: string;
  visibility: PieceVisibility;
  origin: PieceOrigin;
  entrypoint: string;
  source: string;
  source_sha256: string;
  source_bytes: number;
  contracts: Array<{ role: 'input' | 'output'; position: number } & PieceContract>;
  arguments: Record<string, { type: string; default?: unknown; description?: string }>;
  required: string[];
  env_from_args: Record<string, string>;
  secrets: PieceSecret[];
  sends_data_to: PieceSends[];
  warnings: string[];
  approval_sha256: string | null;
  status?: 'created';
  owner_username?: string;
  in_registry?: boolean;
}

export interface ApprovalState {
  approved: boolean;
  /** An approval was recorded but the piece no longer matches it. */
  lapsed: boolean;
  approved_sha256: string | null;
  approval_sha256: string | null;
  approved_by: string | null;
  approved_at: string | null;
}

export interface PieceSummary extends ApprovalState {
  spec_id: string;
  label: string | null;
  version: string | null;
  owner_username: string | null;
  visibility: PieceVisibility;
  source_sha256: string;
  origin: PieceOrigin | null;
}

export interface PieceApprovalDetail extends PieceSummary {
  is_admin: boolean;
  description: string | null;
  process_id: string | null;
  source: string;
  entrypoint: string | null;
  env_from_args: Record<string, string>;
  arguments: { properties?: Record<string, { type?: string; default?: unknown }> } & Record<
    string,
    unknown
  >;
  secrets: PieceSecret[];
  sends_data_to: PieceSends[];
  contracts: Array<{
    role: string;
    standard_variable_uri: string;
    unit: string | null;
    format: string | null;
  }>;
  history: Array<{ approved: boolean; sha256: string | null; by: string; at: string | null }>;
}

export class PieceApiError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = 'PieceApiError';
    this.status = status;
    this.code = code;
  }
}

function headers(json = false): HeadersInit {
  const token = getAccessToken();
  if (!token) throw new PieceApiError(401, 'You must be signed in.', 'TAPIS_AUTH_REQUIRED');
  return {
    Authorization: `Bearer ${token}`,
    ...(json ? { 'Content-Type': 'application/json' } : {}),
  };
}

function base(): string {
  const url = getEnsembleManagerApiUrl();
  if (!url) throw new PieceApiError(0, 'The Ensemble Manager address is not configured.');
  return url;
}

async function failure(response: Response): Promise<PieceApiError> {
  let message = `The adapter answered ${response.status}.`;
  let code: string | undefined;
  try {
    const payload = (await response.json()) as { detail?: unknown };
    const detail = payload.detail;
    if (typeof detail === 'string') {
      message = detail;
    } else if (detail && typeof detail === 'object') {
      const record = detail as Record<string, unknown>;
      if (typeof record.message === 'string') message = record.message;
      if (typeof record.code === 'string') code = record.code;
      if (Array.isArray(record.variables)) message += ` (${record.variables.join(', ')})`;
    } else if (Array.isArray(detail)) {
      message = 'The request was not understood by the adapter.';
    }
  } catch {
    // Keep the status message when the body is not JSON.
  }
  return new PieceApiError(response.status, message, code);
}

async function call<T>(path: string, init: RequestInit): Promise<T> {
  const response = await fetch(`${base()}${path}`, init);
  if (!response.ok) throw await failure(response);
  return (await response.json()) as T;
}

const enc = encodeURIComponent;

export async function registerPiece(request: PieceFromRepositoryRequest): Promise<PiecePreview> {
  return call('/etl-pieces/from-repository', {
    method: 'POST',
    headers: headers(true),
    body: JSON.stringify(request),
  });
}

export async function listApprovals(): Promise<{ is_admin: boolean; pieces: PieceSummary[] }> {
  return call('/etl-pieces/approvals', { headers: headers() });
}

export async function getApproval(specId: string): Promise<PieceApprovalDetail> {
  return call(`/etl-pieces/${enc(specId)}/approval`, { headers: headers() });
}

/** Approve (with the hash that was shown) or withdraw. */
export async function setApproval(
  specId: string,
  approved: boolean,
  reviewedSha256?: string,
): Promise<{ approved: boolean; approved_by?: string; approved_at?: string }> {
  return call(`/etl-pieces/${enc(specId)}/approval`, {
    method: 'PUT',
    headers: headers(true),
    body: JSON.stringify({ approved, reviewed_sha256: reviewedSha256 }),
  });
}

// ---------------------------------------------------------------------------
// The form
// ---------------------------------------------------------------------------
export interface ContractField {
  standardVariableUri: string;
  format: string;
  unit: string;
}

export interface ArgumentField {
  name: string;
  type: ArgumentType;
  defaultText: string;
  description: string;
  required: boolean;
}

export interface SecretField {
  name: string;
  label: string;
  /** One `INPUT_NAME=field` per line. */
  envText: string;
}

export interface PieceFormState {
  label: string;
  description: string;
  version: string;
  visibility: PieceVisibility;
  repository: string;
  commit: string;
  path: string;
  entrypoint: string;
  inputs: ContractField[];
  outputs: ContractField[];
  arguments: ArgumentField[];
  secrets: SecretField[];
  sends: PieceSends[];
}

export const emptyContract = (): ContractField => ({
  standardVariableUri: '',
  format: '',
  unit: '',
});

export function initialPieceForm(): PieceFormState {
  return {
    label: '',
    description: '',
    version: '1.0.0',
    visibility: 'private',
    repository: '',
    commit: '',
    path: '',
    entrypoint: 'run',
    inputs: [emptyContract()],
    outputs: [emptyContract()],
    arguments: [],
    secrets: [],
    sends: [],
  };
}

/** A pasted GitHub URL or `owner/name`, as `owner/name`. */
export function normalizeRepository(text: string): string {
  const trimmed = text
    .trim()
    .replace(/\/+$/, '')
    .replace(/\.git$/, '');
  const match = /^https:\/\/github\.com\/([^/]+\/[^/]+)$/.exec(trimmed);
  return match?.[1] ?? trimmed;
}

function argumentDefault(field: ArgumentField): string | number | boolean | undefined {
  const text = field.defaultText.trim();
  if (text === '') return undefined;
  if (field.type === 'boolean') return text.toLowerCase() === 'true';
  if (field.type === 'integer' || field.type === 'number') return Number(text);
  return field.defaultText;
}

function parseEnv(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const [key, ...rest] = line.split('=');
    if (key?.trim()) env[key.trim()] = rest.join('=').trim();
  }
  return env;
}

/** Problems with the form the author can fix before asking the adapter. */
export function formProblems(form: PieceFormState): string[] {
  const problems: string[] = [];
  if (!form.label.trim()) problems.push('Give the piece a name.');
  if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(normalizeRepository(form.repository))) {
    problems.push('The repository is written owner/name, for a public GitHub repository.');
  }
  if (!COMMIT_PATTERN.test(form.commit.trim())) {
    problems.push(
      'The commit is the full 40-character SHA. A branch, a tag or a short SHA is not accepted, because it can move.',
    );
  }
  if (!form.path.trim().endsWith('.py')) problems.push('The path is a .py file in the repository.');
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(form.entrypoint.trim())) {
    problems.push('The entrypoint is the name of a function in that file.');
  }
  if (!form.inputs.some((c) => c.standardVariableUri)) problems.push('Choose an input variable.');
  if (!form.outputs.some((c) => c.standardVariableUri)) problems.push('Choose an output variable.');
  for (const field of form.arguments) {
    if ((field.type === 'integer' || field.type === 'number') && field.defaultText.trim() !== '') {
      if (Number.isNaN(Number(field.defaultText))) {
        problems.push(`The default of ${field.name || 'an argument'} is not a number.`);
      }
    }
  }
  return problems;
}

export function buildRequest(form: PieceFormState, dryRun: boolean): PieceFromRepositoryRequest {
  const contract = (field: ContractField): PieceContract => ({
    standard_variable_uri: field.standardVariableUri,
    ...(field.format.trim() ? { format: field.format.trim() } : {}),
    ...(field.unit.trim() ? { unit: field.unit.trim() } : {}),
  });
  return {
    label: form.label.trim(),
    description: form.description.trim(),
    version: form.version.trim() || '1.0.0',
    visibility: form.visibility,
    repository: normalizeRepository(form.repository),
    commit: form.commit.trim().toLowerCase(),
    path: form.path.trim(),
    entrypoint: form.entrypoint.trim(),
    inputs: form.inputs.filter((c) => c.standardVariableUri).map(contract),
    outputs: form.outputs.filter((c) => c.standardVariableUri).map(contract),
    arguments: form.arguments
      .filter((field) => field.name.trim())
      .map((field) => ({
        name: field.name.trim(),
        type: field.type,
        ...(argumentDefault(field) !== undefined ? { default: argumentDefault(field) } : {}),
        ...(field.description.trim() ? { description: field.description.trim() } : {}),
        ...(field.required ? { required: true } : {}),
      })),
    secrets: form.secrets
      .filter((field) => field.name.trim())
      .map((field) => ({
        name: field.name.trim(),
        label: field.label.trim() || field.name.trim(),
        env: parseEnv(field.envText),
      })),
    sends_data_to: form.sends.filter((s) => s.service.trim() && s.what.trim()),
    dry_run: dryRun,
  };
}

/** What the page may say about where a piece's code came from. */
export function originVerification(origin: PieceOrigin | null | undefined): string {
  if (!origin) return 'UNVERIFIED — read the source';
  return origin.verified_on_branch
    ? `verified in ${origin.repository}'s ${origin.verified_on_branch} history`
    : 'UNVERIFIED — read the source';
}
