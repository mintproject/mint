/**
 * Tapis application catalogue — the component location source for a Tapis
 * deployment.
 *
 * A model configuration records where its executable component lives in
 * `has_component_location`. When the Ensemble Manager runs on Tapis, that value
 * must be the canonical app URL
 * `https://{tenant}.tapis.io/v3/apps/{id}/{version}`:
 * `ExecutionCreation.loadComponentFromTapis` splits it back into an id and a
 * version, so a URL missing either one fails the run. The sharing endpoint
 * `/v3/apps/share/{id}` carries neither and must never be stored.
 *
 * Every call here goes from the browser straight to Tapis with the signed-in
 * user's own token in `X-Tapis-Token`; the model catalog API is not involved.
 * The base URL is built from the deployment's configured tenant, never from a
 * value the user types, so a pasted definition cannot change where the token
 * is sent. Tapis allows browser calls from any origin.
 */
import { getAccessToken } from './auth/token-store';
import { getRuntimeConfig } from './config';

/** Identity of one Tapis application version. */
export interface TapisAppRef {
  tenant: string;
  id: string;
  version: string;
}

/** One Tapis file input, as the app declares it. */
export interface TapisFileInput {
  name?: string;
  description?: string;
  /** REQUIRED, OPTIONAL or FIXED. A FIXED input is supplied by the app itself. */
  inputMode?: string;
}

/** One Tapis application argument, as the app declares it. */
export interface TapisAppArg {
  name?: string;
  description?: string;
  inputMode?: string;
  /** The default command-line value. */
  arg?: string;
  notes?: { fieldType?: string };
}

/** The subset of a Tapis application the seed needs. */
export interface TapisApp extends TapisAppRef {
  jobAttributes?: {
    execSystemId?: string;
    fileInputs?: TapisFileInput[];
    parameterSet?: { appArgs?: TapisAppArg[] };
  };
}

/** Model rows derived from a Tapis application. */
export interface TapisAppSeed {
  inputs: { label: string; description: string; isOptional: boolean }[];
  parameters: {
    label: string;
    description: string;
    hasDefaultValue: string;
    hasDataType: string;
  }[];
}

/**
 * The canonical Tapis app URL. Same pattern the legacy UI used
 * (`ui/src/screens/models/configure/resources/tapis-app.ts`), so a value written
 * by either app parses in both.
 */
export const TAPIS_APP_URL_PATTERN = /^https:\/\/([^.]+)\.tapis\.io\/v3\/apps\/([^/]+)\/([^/]+)$/;

export function buildTapisAppUrl(app: TapisAppRef): string {
  return `https://${app.tenant}.tapis.io/v3/apps/${app.id}/${app.version}`;
}

/**
 * Splits a component location back into an app reference, or null when it is
 * not one.
 *
 * `share` is not an app id: `/v3/apps/share/{id}` is the Tapis sharing
 * endpoint, and it has the same shape as an app URL. It answers
 * `{"publicShare": true}` and names no version, so a job built from it has no
 * app to run. Tapis owns that path segment, so no reachable app uses it as an
 * id.
 */
export function parseTapisAppUrl(url: string): TapisAppRef | null {
  const m = TAPIS_APP_URL_PATTERN.exec(url.trim());
  if (!m) return null;
  const [, tenant, id, version] = m;
  if (!tenant || !id || !version) return null;
  if (id === 'share') return null;
  return { tenant, id, version };
}

/**
 * The Tapis tenant this deployment signs in against, or null when it does not
 * use Tapis. Derived from AUTH_SERVER rather than configured separately: one
 * deployment has one Tapis tenant, and a second key could disagree with it.
 */
export function getTapisTenant(): string | null {
  const config = getRuntimeConfig();
  if (config.AUTH_PROVIDER !== 'tapis') return null;
  const m = /^https:\/\/([^.]+)\.tapis\.io\/?$/.exec(config.AUTH_SERVER ?? '');
  return m?.[1] ?? null;
}

/**
 * True when a new model's component should be picked from the Tapis app
 * catalogue. The deployment's execution engine decides it, the user does not —
 * the same value that already selects the run-submission route.
 */
export function usesTapisComponents(): boolean {
  return getRuntimeConfig().EXECUTION_ENGINE === 'tapis' && getTapisTenant() !== null;
}

/** The Tapis base URL for a tenant. Built from configuration, not from user input. */
function tapisBase(tenant: string): string {
  return `https://${tenant}.tapis.io`;
}

function tapisHeaders(): Record<string, string> {
  const token = getAccessToken();
  if (!token) {
    throw new Error('Sign in to use Tapis applications.');
  }
  return { 'X-Tapis-Token': token };
}

/**
 * Reads the message out of a failed Tapis response. Tapis answers
 * `{"status":"error","message":"..."}`; anything else falls back to the status.
 */
async function tapisError(resp: Response): Promise<Error> {
  let detail = '';
  try {
    const body = (await resp.json()) as { message?: unknown };
    if (typeof body?.message === 'string') detail = body.message;
  } catch {
    // Not JSON: the status alone is the message.
  }
  return new Error(`Tapis returned ${resp.status}${detail ? `: ${detail}` : ''}`);
}

async function tapisRequest(
  tenant: string,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<unknown> {
  const headers: Record<string, string> = { ...tapisHeaders() };
  if (init.body !== undefined) headers['Content-Type'] = 'application/json';
  const resp = await fetch(`${tapisBase(tenant)}${path}`, {
    method: init.method ?? 'GET',
    headers,
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  if (!resp.ok) throw await tapisError(resp);
  return resp.json().catch(() => ({}));
}

/**
 * Lists every application the signed-in user may see in one tenant: their own,
 * those shared with them, and public ones.
 *
 * `listType=ALL` matters: Tapis lists only the caller's own apps by default, so
 * an app made public by someone else would never appear. `limit=-1` matters too:
 * Tapis stops at 100 otherwise and silently drops the rest.
 */
export async function listTapisApps(tenant: string): Promise<TapisAppRef[]> {
  const body = (await tapisRequest(tenant, '/v3/apps?listType=ALL&limit=-1&select=id,version')) as {
    result?: Partial<TapisAppRef>[];
  };
  const rows = Array.isArray(body?.result) ? body.result : [];
  // An app with no version cannot be run, so it is not offerable.
  return rows
    .filter((a): a is TapisAppRef => Boolean(a?.id && a?.version))
    .map((a) => ({ tenant, id: a.id, version: a.version }));
}

/** Reads one application, with the job attributes the seed needs. */
export async function getTapisApp(ref: TapisAppRef): Promise<TapisApp> {
  const body = (await tapisRequest(
    ref.tenant,
    `/v3/apps/${encodeURIComponent(ref.id)}/${encodeURIComponent(ref.version)}`,
  )) as { result?: Omit<TapisApp, keyof TapisAppRef> };
  return { ...ref, ...(body?.result ?? {}) };
}

/**
 * Creates an application from a Tapis definition. The new app belongs to the
 * signed-in user. Returns the reference Tapis reports, falling back to the
 * posted id and version.
 */
export async function createTapisApp(
  tenant: string,
  definition: Record<string, unknown>,
): Promise<TapisAppRef> {
  const body = (await tapisRequest(tenant, '/v3/apps', { method: 'POST', body: definition })) as {
    result?: { url?: string };
  };
  const fromUrl = body?.result?.url ? parseTapisAppUrl(body.result.url) : null;
  return (
    fromUrl ?? {
      tenant,
      id: String(definition.id),
      version: String(definition.version),
    }
  );
}

/**
 * Makes an application public: every user in the tenant can see its definition
 * and run it. Tapis shares by id, so this covers every version of that id, and
 * sharing an id that is already public is not an error. DYNAMO cannot undo it;
 * only the owner or an administrator can, in Tapis.
 */
export async function shareTapisAppPublic(tenant: string, id: string): Promise<void> {
  try {
    await tapisRequest(tenant, `/v3/apps/share_public/${encodeURIComponent(id)}`, {
      method: 'POST',
    });
  } catch (err) {
    if (err instanceof Error && /already/i.test(err.message)) return;
    throw err;
  }
}

/**
 * Turns an application into the model's inputs and parameters.
 *
 * Every label is the Tapis name, unchanged. `TapisJobService` matches a model
 * input label against `fileInput.name` and a model parameter label against
 * `appArgs.name`, so a reworded label makes the run throw. A FIXED file input
 * gets no model input: the app supplies it and the user cannot override it.
 */
export function buildSeedFromTapisApp(app: TapisApp): TapisAppSeed {
  const job = app.jobAttributes ?? {};

  const inputs = (job.fileInputs ?? [])
    .filter((f) => Boolean(f.name) && f.inputMode !== 'FIXED')
    .map((f) => ({
      label: f.name ?? '',
      description: f.description ?? '',
      isOptional: f.inputMode === 'OPTIONAL',
    }));

  const parameters = (job.parameterSet?.appArgs ?? [])
    .filter((a) => Boolean(a.name) && a.inputMode !== 'FIXED')
    .map((a) => ({
      label: a.name ?? '',
      description: a.description ?? '',
      hasDefaultValue: a.arg ?? '',
      // Tapis states the widget type, not a data type. 'number' is the only one
      // it uses, and the form's nearest type is float.
      hasDataType: a.notes?.fieldType === 'number' ? 'float' : 'string',
    }));

  return { inputs, parameters };
}

// ---------------------------------------------------------------------------
// Reading a pasted definition
// ---------------------------------------------------------------------------

/** An app.json is a few kilobytes. Anything this large is not one. */
export const MAX_APP_DEFINITION_BYTES = 256 * 1024;

/**
 * Keys a definition may not set. Tapis takes the owner from the token, and the
 * app is made public by its own step, so a pasted definition must not decide
 * either. `"owner": "${apiUserId}"` is allowed: the Tapis templates carry it,
 * and Tapis resolves that macro to the requester.
 */
const REJECTED_KEYS = ['tenant', 'isPublic', 'deleted'] as const;
const OWNER_MACRO = '${apiUserId}';

/** Top-level keys the Tapis templates use. Others are flagged, not refused. */
const COMMON_KEYS = new Set([
  'id',
  'version',
  'description',
  'owner',
  'enabled',
  'runtime',
  'runtimeVersion',
  'runtimeOptions',
  'containerImage',
  'jobType',
  'maxJobs',
  'maxJobsPerUser',
  'strictFileInputs',
  'jobAttributes',
  'tags',
  'notes',
]);

export interface TapisAppSummary {
  id: string;
  version: string;
  containerImage: string;
  execSystemId: string | null;
  inputs: TapisAppSeed['inputs'];
  parameters: TapisAppSeed['parameters'];
  maxMinutes: number | null;
  memoryMB: number | null;
  coresPerNode: number | null;
  nodeCount: number | null;
}

export type ParsedTapisAppDefinition =
  | {
      ok: true;
      definition: Record<string, unknown>;
      summary: TapisAppSummary;
      /** Things worth a second look. They do not block Create. */
      warnings: string[];
    }
  | { ok: false; error: string };

/** True when the image names a tag or digest, and the tag is not `latest`. */
function imageIsPinned(image: string): boolean {
  const name = image.replace(/^[a-z]+:\/\//i, '');
  if (name.includes('@')) return true;
  const last = name.slice(name.lastIndexOf('/') + 1);
  const colon = last.lastIndexOf(':');
  return colon > 0 && last.slice(colon + 1) !== 'latest' && last.slice(colon + 1) !== '';
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Reads pasted or uploaded app.json text. Tapis stays the validator; these
 * checks only make the common mistakes fast and clear. They run in the browser,
 * so they guide the author and are not a security boundary.
 */
export function parseTapisAppDefinition(text: string): ParsedTapisAppDefinition {
  if (new Blob([text]).size > MAX_APP_DEFINITION_BYTES) {
    return {
      ok: false,
      error: 'That is too large to be an app.json. Check you chose the right file.',
    };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: 'That is not valid JSON. Paste the contents of your app.json.' };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, error: 'An app.json is a single JSON object, wrapped in { }.' };
  }
  const def = raw as Record<string, unknown>;

  const text_ = (key: string, max: number): string | null => {
    const v = def[key];
    return typeof v === 'string' && v.trim() !== '' && v.length <= max ? v.trim() : null;
  };
  const id = text_('id', 80);
  const version = text_('version', 64);
  const containerImage = text_('containerImage', 512);
  if (!id) return { ok: false, error: 'The definition needs an "id", a short unique name.' };
  if (!version) return { ok: false, error: 'The definition needs a "version", such as "0.1.0".' };
  if (!containerImage) {
    return {
      ok: false,
      error: 'The definition needs a "containerImage", the packaged model to run.',
    };
  }
  if (id.includes('/') || version.includes('/')) {
    return { ok: false, error: 'The "id" and "version" cannot contain a "/".' };
  }
  if (id === 'share')
    return { ok: false, error: '"share" is reserved by Tapis. Choose another id.' };
  if (!imageIsPinned(containerImage)) {
    return {
      ok: false,
      error:
        'The "containerImage" needs a version tag, such as ":0.1.0". Untagged and ":latest" images change over time, so earlier results could not be reproduced.',
    };
  }
  for (const key of REJECTED_KEYS) {
    if (key in def) {
      return { ok: false, error: `Remove "${key}" from the definition. Tapis and DYNAMO set it.` };
    }
  }
  if ('owner' in def && def.owner !== OWNER_MACRO) {
    return {
      ok: false,
      error: `Remove "owner", or set it to "${OWNER_MACRO}". The app is always created under your own account.`,
    };
  }

  const job = (def.jobAttributes ?? {}) as TapisApp['jobAttributes'] & Record<string, unknown>;
  const asApp: TapisApp = { tenant: '', id, version, jobAttributes: job };
  const seed = buildSeedFromTapisApp(asApp);

  const warnings: string[] = [];
  const unnamed =
    (job.fileInputs ?? []).filter((f) => !f.name && f.inputMode !== 'FIXED').length +
    (job.parameterSet?.appArgs ?? []).filter((a) => !a.name && a.inputMode !== 'FIXED').length;
  if (unnamed > 0) {
    warnings.push(
      `${unnamed} input file(s) or setting(s) have no "name". DYNAMO matches them by name, so this app would not run from a model configuration until each has one.`,
    );
  }
  const env = (job.parameterSet as { envVariables?: unknown[] } | undefined)?.envVariables;
  if (Array.isArray(env) && env.length > 0) {
    warnings.push(
      'The definition sets environment variables. The app will be public, so everyone can read them. Do not put passwords or keys there.',
    );
  }
  const odd = Object.keys(def).filter((k) => !COMMON_KEYS.has(k));
  if (odd.length > 0) {
    warnings.push(`Uncommon fields: ${odd.join(', ')}. Check you meant to include them.`);
  }

  const num = (k: string) => asNumber((job as Record<string, unknown>)[k]);
  return {
    ok: true,
    definition: def,
    summary: {
      id,
      version,
      containerImage,
      execSystemId: typeof job.execSystemId === 'string' ? job.execSystemId : null,
      inputs: seed.inputs,
      parameters: seed.parameters,
      maxMinutes: num('maxMinutes'),
      memoryMB: num('memoryMB'),
      coresPerNode: num('coresPerNode'),
      nodeCount: num('nodeCount'),
    },
    warnings,
  };
}
