/**
 * Upload a user's files into the data catalog (CKAN), from the browser.
 *
 * A dataset is made in an organisation the user may create datasets in (private
 * unless they choose otherwise) and each file becomes one resource, sent straight
 * to CKAN with the user's own Tapis token as a bearer credential. The input is
 * then bound to that dataset like any catalog dataset; a flow's gather step reads
 * a private file with the runner's token.
 *
 * Nothing falls back to another route: if the browser cannot reach the catalog
 * from this site (CORS or the network), the upload stops and says so.
 */
import { getAccessToken } from './auth/token-store';
import { getDataCatalogApiUrl } from './config';
import type { DataCatalogResource } from './data-catalog';
import { resourceStandardVariables, showPackage } from './datasets/ckan';
import { geoJsonBoundingBox, unionBoundingBox, type BoundingBox } from './geo/bbox';

export const UPLOAD_FILE_CAP = 500;
export const UPLOAD_BYTES_CAP = 2 * 1024 * 1024 * 1024;
export const UPLOAD_UNREACHABLE_MESSAGE =
  'Your browser could not send files to the catalog from this site.';

/** The longest file name kept (the gather task's limit). */
const MAX_NAME = 200;

export interface UploadOrganization {
  id: string;
  name: string;
  title: string;
}

export interface UploadedDataset {
  /** Things the person should know about how the files were accepted. */
  notes: string[];
  /** The catalog id the data step uses (the dataset's name slug). */
  datasetId: string;
  datasetName: string;
  /** Whether the catalog says the dataset is private, as read back after the upload. */
  isPrivate: boolean;
  resources: DataCatalogResource[];
}

export interface UploadProgress {
  /** Index of the file being sent, and how many in all. */
  index: number;
  count: number;
  /** Bytes of the whole batch sent so far, and its total. */
  sent: number;
  total: number;
  perFile: number[];
}

/** The upload stopped for a reason a person can act on. */
export class UploadError extends Error {
  constructor(
    message: string,
    /** True when the browser never reached the catalog (CORS or network). */
    readonly unreachable = false,
  ) {
    super(message);
    this.name = 'UploadError';
  }
}

/** The adapter's file-name rule (gather_fetch.py `_clean`): `[A-Za-z0-9._-]`, no leading dot. */
function cleanName(text: string): string {
  let cleaned = text.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '');
  if (cleaned.length > MAX_NAME) {
    const dot = cleaned.lastIndexOf('.');
    const stem = dot > 0 ? cleaned.slice(0, dot) : '';
    const extension = dot > 0 ? cleaned.slice(dot + 1) : '';
    cleaned =
      stem && extension.length <= 20
        ? `${stem.slice(0, MAX_NAME - extension.length - 1)}.${extension}`
        : cleaned.slice(0, MAX_NAME);
  }
  return cleaned.replace(/\./g, '') ? cleaned : '';
}

/**
 * Safe, distinct names for the files, in order: characters outside
 * `[A-Za-z0-9._-]` become `_`, and a repeat (compared without regard to case)
 * gets `-2`, `-3` before its extension. The same rule the gather task applies.
 */
export function sanitizeUploadNames(names: string[]): string[] {
  const taken = new Set<string>();
  return names.map((original, index) => {
    const name = cleanName(original.trim()) || `resource-${index}`;
    let candidate = name;
    for (let number = 2; taken.has(candidate.toLowerCase()); number += 1) {
      const dot = name.lastIndexOf('.');
      const suffix = `-${number}`;
      candidate =
        dot > 0
          ? `${name.slice(0, dot).slice(0, MAX_NAME - suffix.length - (name.length - dot))}${suffix}${name.slice(dot)}`
          : `${name.slice(0, MAX_NAME - suffix.length)}${suffix}`;
    }
    taken.add(candidate.toLowerCase());
    return candidate;
  });
}

/** Why a batch of files may not be uploaded, or null when it may. */
export function uploadBatchProblem(files: Array<{ size: number }>): string | null {
  if (files.length === 0) return 'Choose at least one file.';
  if (files.length > UPLOAD_FILE_CAP) {
    return `At most ${UPLOAD_FILE_CAP} files can be uploaded at once; you chose ${files.length}.`;
  }
  if (files.reduce((sum, file) => sum + file.size, 0) > UPLOAD_BYTES_CAP) {
    return 'At most 2 GB can be uploaded at once.';
  }
  return null;
}

/** Extensions that name the same format. */
const EXTENSION_ALIASES: Record<string, string> = {
  yml: 'yaml',
  jpeg: 'jpg',
  tiff: 'tif',
  markdown: 'md',
  htm: 'html',
  text: 'txt',
};

function canonicalExtension(text: string): string {
  const lower = text.trim().toLowerCase().replace(/^\./, '');
  return EXTENSION_ALIASES[lower] ?? lower;
}

/** A declared format as an extension, or null when it is not a file extension. */
function declaredExtension(format: string): string | null {
  const text = format.trim().toLowerCase();
  const tail = text.includes('/') ? (text.split('/').pop() ?? '') : text;
  return /^[a-z0-9+.-]{1,20}$/.test(tail) ? canonicalExtension(tail.replace(/^.*\+/, '')) : null;
}

/**
 * Whether the files fit the input, before anything is created. The rule:
 * - the input must name a standard variable (its datasets are found by it), unless
 *   `variableOptional` (a file edited in place of a step's output belongs to no input);
 * - an input that takes one file takes exactly one;
 * - a missing format accepts any file, with a note saying so;
 * - the format `directory` (also `folder`, `any`, `*`) on a collection accepts any
 *   files; on a single-file input it is refused (a file is not a folder);
 * - any other format is a file extension (`json`, `.csv`, `text/csv`): every file's
 *   last extension must equal it, ignoring case (`yml`/`yaml`, `jpg`/`jpeg`,
 *   `tif`/`tiff`, `md`/`markdown`, `htm`/`html`, `txt`/`text` count as the same).
 * Returns the reason it is refused, or null with notes for the person.
 */
export function checkUploadAgainstInput(params: {
  files: Array<{ name: string }>;
  format?: string | null;
  variables: string[];
  multiple: boolean;
  inputName: string;
  /** A file that is no input's data (an edit) needs no standard variable. */
  variableOptional?: boolean;
}): { error: string | null; notes: string[] } {
  const { files, inputName } = params;
  const refuse = (error: string) => ({ error, notes: [] });
  if (!params.variableOptional && params.variables.filter(Boolean).length === 0) {
    return refuse(
      `The input "${inputName}" names no standard variable, so a dataset made for it could not be found or read by a run. Nothing was uploaded.`,
    );
  }
  if (!params.multiple && files.length > 1) {
    return refuse(`The input "${inputName}" takes one file; you chose ${files.length}.`);
  }
  const format = (params.format ?? '').trim();
  const lower = format.toLowerCase();
  if (!format) {
    return {
      error: null,
      notes: [
        `The input "${inputName}" does not declare a file format, so the files are accepted as they are.`,
      ],
    };
  }
  if (['directory', 'folder', 'any', '*'].includes(lower)) {
    return params.multiple
      ? { error: null, notes: [] }
      : refuse(
          `The input "${inputName}" reads a folder (format ${format}); one file cannot fill it.`,
        );
  }
  const wanted = declaredExtension(format);
  if (!wanted) {
    return {
      error: null,
      notes: [
        `The input's format "${format}" is not a file extension, so the files are accepted as they are.`,
      ],
    };
  }
  for (const file of files) {
    const dot = file.name.lastIndexOf('.');
    const have = dot > 0 ? canonicalExtension(file.name.slice(dot + 1)) : '';
    if (have !== wanted) {
      return refuse(
        `The input "${inputName}" reads ${format} files, but "${file.name}" is ${have ? `a .${have} file` : 'a file with no extension'}.`,
      );
    }
  }
  return { error: null, notes: [] };
}

/** A bounding box as the one polygon a dataset's `spatial` field can hold. */
export function boundingBoxToSpatial(box: BoundingBox): string {
  const { xmin, ymin, xmax, ymax } = box;
  return JSON.stringify({
    type: 'Polygon',
    coordinates: [
      [
        [xmin, ymin],
        [xmax, ymin],
        [xmax, ymax],
        [xmin, ymax],
        [xmin, ymin],
      ],
    ],
  });
}

/** The region as the one bounding polygon a dataset's `spatial` field can hold, or null. */
export function regionToSpatial(regionGeometry: unknown): string | null {
  const box = Array.isArray(regionGeometry)
    ? unionBoundingBox(regionGeometry)
    : geoJsonBoundingBox(regionGeometry);
  return box ? boundingBoxToSpatial(box) : null;
}

/** The format CKAN records for a file: its extension, upper-cased, or empty. */
export function formatFromName(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toUpperCase() : '';
}

function requireToken(): string {
  const token = getAccessToken();
  if (!token) throw new UploadError('Sign in to upload files.');
  return token;
}

function actionUrl(action: string, query = ''): string {
  return `${getDataCatalogApiUrl()}/api/3/action/${action}${query}`;
}

/** The message CKAN gave for a failed action, or '' when it gave none. */
function ckanMessage(body: unknown): string {
  const error = (body as { error?: Record<string, unknown> } | null)?.error;
  if (!error) return '';
  if (typeof error['message'] === 'string') return error['message'];
  const parts = Object.entries(error)
    .filter(([key]) => key !== '__type')
    .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(', ') : String(value)}`);
  return parts.join('; ');
}

interface CkanResult {
  result?: { id?: string; name?: string; url?: string };
}

function parseJson(text: string): CkanResult | null {
  try {
    return JSON.parse(text) as CkanResult;
  } catch {
    return null;
  }
}

/** The organisations the signed-in user may create datasets in. */
export async function listUploadOrganizations(): Promise<UploadOrganization[]> {
  const token = requireToken();
  let resp: Response;
  try {
    resp = await fetch(actionUrl('organization_list_for_user', '?permission=create_dataset'), {
      headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
    });
  } catch {
    throw new UploadError(UPLOAD_UNREACHABLE_MESSAGE, true);
  }
  if (!resp.ok)
    throw new UploadError(`The catalog would not list your organisations (HTTP ${resp.status}).`);
  const body = (await resp.json()) as { result?: Array<Record<string, unknown>> };
  return (body.result ?? [])
    .map((org) => ({
      id: String(org['id'] ?? ''),
      name: String(org['name'] ?? ''),
      title: String(org['title'] || org['display_name'] || org['name'] || ''),
    }))
    .filter((org) => org.id)
    .sort((a, b) => a.title.localeCompare(b.title));
}

async function createPackage(params: {
  organizationId: string;
  isPublic: boolean;
  title: string;
  notes: string;
  now: Date;
  startDate: string;
  endDate: string;
  spatial: string | null;
}): Promise<{ id: string; name: string; title: string }> {
  const day = params.now.toISOString().slice(0, 10);
  const random = Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
  const name = `dynamo-upload-${day}-${random}`;
  let resp: Response;
  try {
    resp = await fetch(actionUrl('package_create'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${requireToken()}`,
      },
      body: JSON.stringify({
        type: 'dataset',
        name,
        title: params.title,
        notes: params.notes,
        owner_org: params.organizationId,
        private: !params.isPublic,
        temporal_coverage_start: params.startDate,
        temporal_coverage_end: params.endDate,
        ...(params.spatial ? { spatial: params.spatial } : {}),
        tag_string: 'dynamo-upload',
      }),
    });
  } catch {
    throw new UploadError(UPLOAD_UNREACHABLE_MESSAGE, true);
  }
  const body = parseJson(await resp.text().catch(() => ''));
  if (!resp.ok || !body?.result?.id) {
    const detail = ckanMessage(body);
    throw new UploadError(
      `The catalog would not make the dataset (HTTP ${resp.status})${detail ? `: ${detail}` : ''}.`,
    );
  }
  return { id: body.result.id, name: body.result.name ?? name, title: params.title };
}

/** One file as a resource, multipart, with progress. Resolves with CKAN's new resource. */
function sendResource(
  token: string,
  fields: Record<string, string>,
  file: Blob,
  name: string,
  onBytes: (sent: number) => void,
): Promise<{ id: string; url: string }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', actionUrl('resource_create'));
    xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.upload.onprogress = (event) => onBytes(event.loaded);
    xhr.onerror = () => reject(new UploadError(UPLOAD_UNREACHABLE_MESSAGE, true));
    xhr.ontimeout = () => reject(new UploadError(UPLOAD_UNREACHABLE_MESSAGE, true));
    xhr.onabort = () => reject(new UploadError('The upload was cancelled.'));
    xhr.onload = () => {
      const body = parseJson(xhr.responseText);
      if (xhr.status === 0) {
        reject(new UploadError(UPLOAD_UNREACHABLE_MESSAGE, true));
      } else if (xhr.status >= 200 && xhr.status < 300 && body?.result?.id) {
        resolve({ id: body.result.id, url: body.result.url ?? '' });
      } else {
        const detail = ckanMessage(body);
        reject(new UploadError(`HTTP ${xhr.status}${detail ? `: ${detail}` : ''}`));
      }
    };
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) form.append(key, value);
    form.append('upload', file, name);
    xhr.send(form);
  });
}

/**
 * Make a catalog dataset and put `files` in it, one resource each, one at a time.
 *
 * If a file fails the upload stops and the error names it and the dataset, which
 * is left in the catalog (the user can delete it there). When the browser cannot
 * reach the catalog at all the error is `unreachable` and nothing else is tried.
 */
export async function uploadFilesToCatalog(params: {
  files: File[];
  organizationId: string;
  isPublic: boolean;
  flowName: string;
  inputName: string;
  /** The input's standard variable name(s): how the data step finds the dataset. */
  variables: string[];
  /** The input's declared file format, checked against the files. */
  format?: string | null;
  /** An input that takes a collection takes many files; any other takes one. */
  multiple: boolean;
  /** No standard variable is recorded or checked: for a file that replaces a step's output. */
  variableOptional?: boolean;
  /** What the dataset is for, in its notes. Defaults to the flow and input. */
  notes?: string;
  /** The thread's dates and region, which the dataset is made to cover. */
  startDate?: string | null;
  endDate?: string | null;
  regionGeometry?: unknown;
  /** A ready `spatial` polygon (see boundingBoxToSpatial); wins over `regionGeometry`. */
  spatial?: string | null;
  /** The dataset's title. Defaults to "Uploaded files, <day>, <username>". */
  title?: string;
  username: string;
  now?: Date;
  onProgress?: (progress: UploadProgress) => void;
}): Promise<UploadedDataset> {
  const { files, onProgress } = params;
  const problem = uploadBatchProblem(files);
  if (problem) throw new UploadError(problem);
  const fit = checkUploadAgainstInput({
    files,
    format: params.format,
    variables: params.variables,
    multiple: params.multiple,
    inputName: params.inputName,
    variableOptional: params.variableOptional,
  });
  if (fit.error) throw new UploadError(fit.error);
  if (!params.organizationId) throw new UploadError('Choose an organisation.');
  const variable = params.variables.filter(Boolean).join(',');
  const token = requireToken();
  const now = params.now ?? new Date();
  const day = now.toISOString().slice(0, 10);
  // The thread's own dates when it has both, else today.
  const start = (params.startDate ?? '').slice(0, 10);
  const end = (params.endDate ?? '').slice(0, 10);
  const threadDates = /^\d{4}-\d{2}-\d{2}$/.test(start) && /^\d{4}-\d{2}-\d{2}$/.test(end);

  const pkg = await createPackage({
    organizationId: params.organizationId,
    isPublic: params.isPublic,
    title: params.title?.trim() || `Uploaded files, ${day}, ${params.username}`,
    notes: params.notes ?? `Uploaded through DYNAMO for ${params.flowName} / ${params.inputName}.`,
    now,
    startDate: threadDates ? start : day,
    endDate: threadDates ? end : day,
    spatial: params.spatial !== undefined ? params.spatial : regionToSpatial(params.regionGeometry),
  });

  const names = sanitizeUploadNames(files.map((file) => file.name));
  const total = files.reduce((sum, file) => sum + file.size, 0);
  const perFile = files.map(() => 0);
  const report = (index: number) =>
    onProgress?.({
      index,
      count: files.length,
      sent: perFile.reduce((sum, bytes) => sum + bytes, 0),
      total,
      perFile: [...perFile],
    });

  const resources: DataCatalogResource[] = [];
  for (const [index, file] of files.entries()) {
    const name = names[index]!;
    report(index);
    try {
      const made = await sendResource(
        token,
        {
          package_id: pkg.id,
          name,
          format: formatFromName(name),
          ...(variable ? { mint_standard_variables: variable } : {}),
        },
        file,
        name,
        (sent) => {
          perFile[index] = Math.min(sent, file.size);
          report(index);
        },
      );
      perFile[index] = file.size;
      report(index);
      resources.push({ id: made.id, name, url: made.url, selected: true });
    } catch (err) {
      const reason = err instanceof UploadError ? err.message : String(err);
      const unreachable = err instanceof UploadError && err.unreachable;
      const left = `The dataset "${pkg.title}" was created and keeps the files sent before it; you can delete it in the catalog.`;
      throw new UploadError(
        unreachable && index === 0
          ? `${UPLOAD_UNREACHABLE_MESSAGE} ${left}`
          : `Could not upload ${name}: ${reason}. ${left}`,
        unreachable,
      );
    }
  }

  // Read it back as the user: it must be what a run will find, not what was sent.
  const shown = await showPackage(pkg.id);
  const missing: string[] = [];
  for (const made of resources) {
    const row = (shown.resources ?? []).find((r) => r.id === made.id);
    if (!row) missing.push(`${made.name}: not in the dataset`);
    else {
      if (!row.url) missing.push(`${made.name}: no download address`);
      const have = resourceStandardVariables(row);
      if (!params.variables.filter(Boolean).every((v) => have.includes(v))) {
        missing.push(`${made.name}: the standard variable is not recorded`);
      }
    }
  }
  if (missing.length > 0) {
    throw new UploadError(
      `The files were sent but the dataset "${pkg.title}" is not ready for a run (${missing.join('; ')}). It was left in the catalog; fix or delete it there.`,
    );
  }
  const urls = new Map((shown.resources ?? []).map((r) => [r.id, r.url ?? '']));
  return {
    datasetId: pkg.name,
    datasetName: pkg.title,
    isPrivate: typeof shown.private === 'boolean' ? shown.private : !params.isPublic,
    resources: resources.map((r) => ({ ...r, url: urls.get(r.id) || r.url })),
    notes: fit.notes,
  };
}
