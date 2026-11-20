/**
 * The signed-in user's own saved credentials, kept by the SVO adapter and reached
 * through the Ensemble Manager's `/secrets` routes.
 *
 * A value is sent once with `PUT` and never comes back: the adapter answers
 * with field names only. Nothing here logs, caches or echoes a value, and no
 * thrown message is built from the server's text, so a value cannot leak
 * through an error.
 */
import { getEnsembleManagerApiUrl } from '@/lib/config';
import { getAccessToken } from '@/lib/auth/token-store';

export interface UserSecret {
  name: string;
  fields: string[];
  version?: number;
  created_at?: string;
  updated_at?: string;
  last_used_at?: string | null;
}

export const NAME_PATTERN = /^[a-z0-9_-]{1,64}$/;
export const FIELD_PATTERN = /^[a-z0-9_]{1,32}$/;
export const MAX_FIELDS = 16;
export const MAX_BYTES = 4096;

/** A refused credential call, with a sentence fit to show the user. */
export class UserSecretError extends Error {
  readonly status: number;
  readonly code?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = 'UserSecretError';
    this.status = status;
    this.code = code;
  }
}

const MESSAGES: Record<string, string> = {
  TAPIS_AUTH_REQUIRED: 'Your sign-in has expired. Sign in again, then try once more.',
  SECRETS_NOT_CONFIGURED: 'Saved credentials are not available on this server yet.',
  SECRET_LOCKED_BY_RUN: 'You have a run in progress. Change this credential when it has finished.',
  SECRET_RATE_LIMITED:
    'You have changed credentials too many times. Wait a few minutes, then try again.',
  SECRET_NOT_FOUND: 'That credential no longer exists.',
  SECRET_INVALID: 'The credential was not accepted. Check the name and the fields.',
};

function messageFor(status: number, code?: string): string {
  if (code && MESSAGES[code]) return MESSAGES[code];
  if (status === 401) return MESSAGES.TAPIS_AUTH_REQUIRED!;
  if (status === 404) return MESSAGES.SECRET_NOT_FOUND!;
  if (status === 409) return MESSAGES.SECRET_LOCKED_BY_RUN!;
  if (status === 422) return MESSAGES.SECRET_INVALID!;
  if (status === 429) return MESSAGES.SECRET_RATE_LIMITED!;
  if (status === 503) return MESSAGES.SECRETS_NOT_CONFIGURED!;
  return 'Saved credentials could not be reached. Try again in a moment.';
}

async function refusal(resp: Response): Promise<UserSecretError> {
  const body = (await resp.json().catch(() => undefined)) as
    | { code?: unknown; detail?: { code?: unknown } | unknown }
    | undefined;
  const nested = body?.detail && typeof body.detail === 'object' ? body.detail : undefined;
  const raw = (nested as { code?: unknown } | undefined)?.code ?? body?.code;
  const code = typeof raw === 'string' ? raw : undefined;
  return new UserSecretError(resp.status, messageFor(resp.status, code), code);
}

async function call(path: string, init: RequestInit = {}): Promise<Response> {
  const base = getEnsembleManagerApiUrl();
  if (!base) throw new UserSecretError(0, MESSAGES.SECRETS_NOT_CONFIGURED!);
  const token = getAccessToken();
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (init.body) headers['Content-Type'] = 'application/json';
  let resp: Response;
  try {
    resp = await fetch(`${base}${path}`, { ...init, headers, cache: 'no-store' });
  } catch {
    throw new UserSecretError(0, messageFor(0));
  }
  if (!resp.ok) throw await refusal(resp);
  return resp;
}

export async function listUserSecrets(): Promise<UserSecret[]> {
  const resp = await call('/secrets');
  const body = (await resp.json()) as unknown;
  return Array.isArray(body) ? (body as UserSecret[]) : [];
}

/** Store or replace `name`. Resolves with field names only. */
export async function saveUserSecret(
  name: string,
  fields: Record<string, string>,
): Promise<UserSecret> {
  const resp = await call(`/secrets/${encodeURIComponent(name)}`, {
    method: 'PUT',
    body: JSON.stringify({ fields }),
  });
  return (await resp.json()) as UserSecret;
}

export async function deleteUserSecret(name: string): Promise<void> {
  await call(`/secrets/${encodeURIComponent(name)}`, { method: 'DELETE' });
}

/** The first rule a credential breaks, as a sentence, or null when it is fine. */
/**
 * What may be wrong with a typed value, shown under its box, or null. Spaces at
 * either end are removed when the value is saved; quote marks are kept (a value
 * may hold them), but usually come from copying a key out of a config file.
 */
export function credentialValueWarning(value: string): string | null {
  if (value === '') return null;
  if (value !== value.trim()) {
    return 'This value starts or ends with a space. Spaces at either end are removed when it is saved.';
  }
  if (/^["'`]|["'`]$/.test(value)) {
    return 'This value starts or ends with a quote mark. Remove it unless the quote is part of the value.';
  }
  return null;
}

export function validateUserSecret(
  name: string,
  fields: Array<{ name: string; value: string }>,
): string | null {
  if (!NAME_PATTERN.test(name)) {
    return 'The name must be 1 to 64 characters: lowercase letters, digits, hyphen or underscore.';
  }
  if (fields.length === 0) return 'Add at least one field.';
  if (fields.length > MAX_FIELDS) return `A credential can have at most ${MAX_FIELDS} fields.`;
  const seen = new Set<string>();
  for (const f of fields) {
    if (!FIELD_PATTERN.test(f.name)) {
      return 'Field names must be 1 to 32 characters: lowercase letters, digits or underscore.';
    }
    if (seen.has(f.name)) return 'Each field name can be used only once.';
    seen.add(f.name);
    if (f.value.trim() === '') return `Enter a value for "${f.name}".`;
  }
  const bytes = fields.reduce(
    (n, f) =>
      n + new TextEncoder().encode(f.name).length + new TextEncoder().encode(f.value).length,
    0,
  );
  if (bytes > MAX_BYTES) return `A credential can hold at most ${MAX_BYTES} bytes in total.`;
  return null;
}

/** The first real use: the model server the sensemaking flows call. */
export const MODEL_SERVER_PRESET = {
  name: 'model_server',
  fields: ['api_key', 'chat_base_url', 'embedding_base_url'],
};
