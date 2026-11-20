/**
 * CKAN Action API transport.
 *
 * The data catalog is a CKAN instance (e.g. https://ckan.tacc.utexas.edu), not
 * the legacy MINT Data Catalog REST API. CKAN exposes a single read API under
 * `/api/3/action/<action>` with GET query parameters and an envelope of
 * `{ success, result }`.
 *
 * This module owns the transport and the CKAN wire types. Mapping CKAN packages
 * into MINT domain objects lives with each caller, since the two data-catalog
 * clients project into different (historically divergent) domain types.
 *
 * Concept mapping, CKAN vs the old MINT API:
 *   datasets/find        -> package_search  (q, ext_bbox, rows)
 *   datasets/{id}        -> package_show    (id accepts a UUID or a name slug)
 *   resources/find       -> package_show, then read `resources[]`
 *
 * MINT standard variables live on each *resource*, in `mint_standard_variables`
 * — a comma-separated string. Solr does not index it, and it tokenises the names
 * on `_` and `~`, so a free-text `q` matches prose rather than the annotation.
 * Match it client-side instead: see `packagesMatchingVariables`.
 *
 * CKAN resources carry no per-resource spatial/temporal coverage, so resources
 * inherit their parent package's coverage.
 */

import { getAccessToken } from '../auth/token-store';
import { getDataCatalogApiUrl } from '../config';
import { boundingBoxesOverlap, geoJsonBoundingBox, type BoundingBox } from '../geo/bbox';

import type { DateRange, SpatialCoverage } from './types';

// ─── CKAN wire types ──────────────────────────────────────────────────────────

export interface CkanResource {
  id?: string;
  name?: string;
  url?: string;
  description?: string;
  format?: string;
  created?: string;
  last_modified?: string;
  /**
   * MINT standard variable names carried by this resource. TACC writes a single
   * comma-separated string; the field is typed loosely because CKAN does not
   * enforce a shape and other instances have been seen to write a list.
   */
  mint_standard_variables?: string | string[] | null;
}

export interface CkanPackage {
  id?: string;
  name?: string;
  title?: string;
  notes?: string;
  version?: string;
  url?: string;
  author?: string;
  license_title?: string;
  num_resources?: number;
  /** GeoJSON geometry, serialised as a string by ckanext-spatial. */
  spatial?: string;
  temporal_coverage_start?: string;
  temporal_coverage_end?: string;
  tags?: { name?: string }[];
  groups?: { name?: string; title?: string }[];
  organization?: { name?: string; title?: string } | null;
  extras?: { key?: string; value?: string }[];
  resources?: CkanResource[];
}

interface CkanEnvelope<T> {
  success?: boolean;
  result?: T;
  error?: { message?: string };
}

interface CkanSearchResult {
  count?: number;
  results?: CkanPackage[];
}

export type { BoundingBox };

// ─── Transport ────────────────────────────────────────────────────────────────

/**
 * Call a CKAN action endpoint. Throws on transport failure, on a non-2xx
 * response, or when CKAN reports `success: false`.
 */
async function ckanAction<T>(
  action: string,
  params: Record<string, string | number | undefined>,
  init?: { signal?: AbortSignal },
): Promise<T> {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') query.set(key, String(value));
  }

  // Signed in: read as the user, so the catalog's private datasets (an upload the
  // user made, an organisation's own data) are visible to them. Anonymous reads
  // are unchanged. CKAN's Tapis sign-in takes the token as a bearer credential.
  const token = getAccessToken();
  if (token && action === 'package_search') query.set('include_private', 'true');

  const url = `${getDataCatalogApiUrl()}/api/3/action/${action}?${query.toString()}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: { Accept: 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(init?.signal ? { signal: init.signal } : {}),
  });

  if (!res.ok) {
    throw new Error(`CKAN ${action} failed: ${res.status} ${res.statusText}`);
  }

  const body = (await res.json()) as CkanEnvelope<T>;
  if (body.success === false || body.result === undefined) {
    throw new Error(`CKAN ${action} failed: ${body.error?.message ?? 'unknown error'}`);
  }
  return body.result;
}

/** `package_search` — free-text plus optional bounding-box filter. */
export async function searchPackages(opts: {
  q?: string;
  boundingBox?: BoundingBox;
  rows?: number;
  start?: number;
  signal?: AbortSignal;
}): Promise<CkanPackage[]> {
  const { results } = await searchPackagesPage(opts);
  return results;
}

/** One page of `package_search`, with CKAN's total `count` alongside it. */
async function searchPackagesPage(opts: {
  q?: string;
  boundingBox?: BoundingBox;
  rows?: number;
  start?: number;
  signal?: AbortSignal;
}): Promise<{ results: CkanPackage[]; count: number }> {
  const params: Record<string, string | number | undefined> = {
    rows: opts.rows ?? 100,
  };
  if (opts.q) params['q'] = opts.q;
  if (opts.boundingBox) params['ext_bbox'] = formatBbox(opts.boundingBox);
  if (opts.start) params['start'] = opts.start;

  const result = await ckanAction<CkanSearchResult>(
    'package_search',
    params,
    opts.signal ? { signal: opts.signal } : undefined,
  );
  return { results: result.results ?? [], count: result.count ?? 0 };
}

/**
 * How many packages the catalog holds, without fetching any of them.
 *
 * `rows: 0` makes CKAN skip the result set and return only its total.
 */
export async function countPackages(opts: { signal?: AbortSignal } = {}): Promise<number> {
  const { count } = await searchPackagesPage({ rows: 0, ...opts });
  return count;
}

/** CKAN's default `ckan.search.rows_max`; asking for more is silently clamped. */
const CKAN_MAX_ROWS = 1000;

/**
 * Every package matching the filters, paging until CKAN's reported `count` is
 * exhausted. Callers that filter client-side need the whole catalog, and a
 * single `rows=1000` request truncates without saying so once an instance grows
 * past that. TACC holds ~215 packages, so in practice this is one request.
 */
export async function searchAllPackages(opts: {
  q?: string;
  boundingBox?: BoundingBox;
  signal?: AbortSignal;
}): Promise<CkanPackage[]> {
  const all: CkanPackage[] = [];
  let count = Infinity;

  while (all.length < count) {
    const page = await searchPackagesPage({ ...opts, rows: CKAN_MAX_ROWS, start: all.length });
    if (!page.results.length) break; // a short page means CKAN has no more to give
    all.push(...page.results);
    count = page.count;
  }

  return all;
}

/** `package_show` — a single package, including its resources. */
export async function showPackage(id: string, signal?: AbortSignal): Promise<CkanPackage> {
  return ckanAction<CkanPackage>('package_show', { id }, signal ? { signal } : undefined);
}

// ─── Shaping helpers ──────────────────────────────────────────────────────────

/** `ext_bbox` is ordered minx,miny,maxx,maxy — not the xmin/xmax/ymin/ymax of our type. */
function formatBbox(bbox: BoundingBox): string {
  return [bbox.xmin, bbox.ymin, bbox.xmax, bbox.ymax].join(',');
}

/**
 * Build a CKAN `q` string from a dataset name. Returns undefined when there is
 * nothing to search on, which CKAN treats as "match everything".
 *
 * Standard variable names deliberately have no place here. Solr does not index
 * `mint_standard_variables`, so putting a variable name in `q` matches prose
 * instead — which returned datasets carrying no such annotation, and nothing at
 * all for a name holding an `_`. Match variables against the annotation
 * instead: see `packagesMatchingVariables` and `packagesMatchingVariableSubstring`.
 */
export function buildSearchQuery(opts: { name?: string }): string | undefined {
  if (!opts.name) return undefined;
  return quote(opts.name);
}

/** Quote a term so Solr treats it as a phrase and does not choke on its syntax. */
function quote(term: string): string {
  return `"${term.replace(/"/g, '\\"')}"`;
}

export function parseDate(val: unknown): Date | null {
  if (!val || val === 'None') return null;
  const d = new Date(val as string);
  return isNaN(d.getTime()) ? null : d;
}

/** A package's temporal coverage, or null when CKAN carries neither bound. */
export function packageTimePeriod(pkg: CkanPackage): DateRange | null {
  const start = parseDate(pkg.temporal_coverage_start);
  const end = parseDate(pkg.temporal_coverage_end);
  if (!start && !end) return null;
  return { start_date: start, end_date: end };
}

/**
 * Resolve dataset spatial metadata from the canonical CKAN field, with a
 * fallback for legacy `subside_dataset` records that store the same GeoJSON
 * in a package extra named `spatial`.
 */
function packageSpatialValue(pkg: CkanPackage): string | undefined {
  if (pkg.spatial) return pkg.spatial;
  return pkg.extras?.find((extra) => extra.key === 'spatial' && extra.value)?.value;
}

/** Parse ckanext-spatial's stringified GeoJSON geometry. */
export function packageSpatialCoverage(pkg: CkanPackage): SpatialCoverage | undefined {
  const spatial = packageSpatialValue(pkg);
  if (!spatial) return undefined;
  try {
    const geo = JSON.parse(spatial) as { type?: string; coordinates?: unknown };
    if (!geo?.type) return undefined;
    // GeoJSON polygons nest one ring deeper than SpatialCoverage.coordinates allows.
    const ring = Array.isArray(geo.coordinates) ? geo.coordinates[0] : undefined;
    return {
      type: geo.type,
      ...(Array.isArray(ring) ? { coordinates: ring as number[][] } : {}),
    };
  } catch {
    return undefined;
  }
}

/**
 * Where a package sits relative to the region asked for.
 *
 * Three answers, not two: "no location declared" and "a location, elsewhere"
 * are different claims about the data and the Datasets step treats them
 * differently — the first is shown and badged, the second hidden and counted.
 * Collapsing them is what made a third of TACC's annotated catalog invisible.
 */
export type RegionMatch = 'inside' | 'outside' | 'unknown';

/**
 * A package's bounding box, from ckanext-spatial's stringified GeoJSON.
 *
 * Handles every shape TACC actually holds — Polygon, MultiPolygon, Point,
 * Feature and FeatureCollection — unlike `packageSpatialCoverage`, which reads
 * `coordinates[0]` and understands a bare Polygon only.
 */
export function packageBoundingBox(pkg: CkanPackage): BoundingBox | null {
  return geoJsonBoundingBox(packageSpatialValue(pkg));
}

/**
 * Classify a package against a region's bounding box.
 *
 * With no region asked for, everything is `inside`: there is no claim to fail.
 *
 * This is deliberately more forgiving than CKAN's own `ext_bbox`, which is not
 * merely a server-side version of the same test. ckanext-spatial indexes bare
 * geometries only, so `ext_bbox` also drops packages whose `spatial` is a
 * `Feature` or a `FeatureCollection` — at TACC, two annotated packages that are
 * squarely inside Texas.
 */
export function packageRegionMatch(pkg: CkanPackage, region?: BoundingBox | null): RegionMatch {
  if (!region) return 'inside';
  const box = packageBoundingBox(pkg);
  if (!box) return 'unknown';
  return boundingBoxesOverlap(box, region) ? 'inside' : 'outside';
}

/** CKAN's `version` is often the literal string "None". */
export function cleanString(val: unknown): string {
  if (val === undefined || val === null || val === 'None') return '';
  return String(val);
}

// ─── Standard variable matching ───────────────────────────────────────────────

/**
 * The MINT standard variable names on a resource. TACC writes them as one
 * comma-separated string; a list of strings is tolerated, and each entry is
 * split again because CKAN does not stop a list entry containing commas.
 */
export function resourceStandardVariables(row: CkanResource): string[] {
  const raw = row.mint_standard_variables;
  const parts = Array.isArray(raw)
    ? raw.flatMap((v) => (typeof v === 'string' ? v.split(',') : []))
    : typeof raw === 'string'
      ? raw.split(',')
      : [];
  return parts.map((v) => v.trim()).filter(Boolean);
}

/** Normalize SVO identifiers/labels for exact cross-service comparison. */
export function canonicalStandardVariable(value: string): string {
  let decoded = value.trim();
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    // Keep a malformed annotation comparable instead of making the whole listing fail.
  }
  const tail = decoded.split('/').pop() ?? decoded;
  return tail.trim().toLowerCase();
}

/** Exact annotation match after normalizing URI-vs-label representations. */
export function resourceMatchesCanonicalVariables(row: CkanResource, variables: string[]): boolean {
  if (!variables.length) return true;
  const wanted = new Set(variables.map(canonicalStandardVariable).filter(Boolean));
  return resourceStandardVariables(row).some((v) => wanted.has(canonicalStandardVariable(v)));
}

/** Keep packages carrying one of the exact canonical SVO annotations. */
export function packagesMatchingCanonicalVariables(
  packages: CkanPackage[],
  variables: string[],
): CkanPackage[] {
  const wanted = variables.map(canonicalStandardVariable).filter(Boolean);
  if (!wanted.length) return packages;
  return narrowToMatchingResources(packages, (r) => resourceMatchesCanonicalVariables(r, wanted));
}

/** Does this resource carry any of the requested standard variables? */
export function resourceMatchesVariables(row: CkanResource, variables: string[]): boolean {
  if (!variables.length) return true;
  return resourceStandardVariables(row).some((v) => variables.includes(v));
}

/**
 * Does this resource carry a standard variable whose name contains `term`?
 *
 * The substring counterpart of `resourceMatchesVariables`, for the search box
 * where a person types a fragment rather than picking a whole name. Matching is
 * case-insensitive and runs against the raw annotation, so it spans the `_` and
 * `~` that Solr would have split the name on.
 *
 * A blank term means "no variable filter" and matches everything.
 */
export function resourceMatchesVariableSubstring(row: CkanResource, term: string): boolean {
  const needle = term.trim().toLowerCase();
  if (!needle) return true;
  return resourceStandardVariables(row).some((v) => v.toLowerCase().includes(needle));
}

/**
 * Keep only the packages that carry one of `variables`, narrowing each to the
 * resources that actually carry it. This is the standard-variable lookup: CKAN
 * cannot do it server-side (see the module header), so it happens here, as the
 * legacy Lit client does in `ui/src/util/datacatalog/ckan-data-catalog.ts`.
 *
 * An empty `variables` list means "no variable filter" and passes everything
 * through untouched.
 */
export function packagesMatchingVariables(
  packages: CkanPackage[],
  variables: string[],
): CkanPackage[] {
  const wanted = variables.filter(Boolean);
  if (!wanted.length) return packages;
  return narrowToMatchingResources(packages, (r) => resourceMatchesVariables(r, wanted));
}

/**
 * Keep only the packages carrying a standard variable whose name contains
 * `term`, narrowing each to the resources that carry it. The substring
 * counterpart of `packagesMatchingVariables`.
 *
 * A blank term passes everything through untouched.
 */
export function packagesMatchingVariableSubstring(
  packages: CkanPackage[],
  term: string,
): CkanPackage[] {
  if (!term.trim()) return packages;
  return narrowToMatchingResources(packages, (r) => resourceMatchesVariableSubstring(r, term));
}

/**
 * Drop packages with no matching resource, and narrow the survivors to the
 * resources that matched. Narrowing is not cosmetic: a package matches because
 * *some* of its resources carry the variable, and binding the rest hands a model
 * input files it cannot read (see #94 — one TACC package holds 35 resources, of
 * which 1 is annotated).
 *
 * Copies rather than mutates, so callers keep the packages they passed in.
 */
function narrowToMatchingResources(
  packages: CkanPackage[],
  matches: (row: CkanResource) => boolean,
): CkanPackage[] {
  const kept: CkanPackage[] = [];
  for (const pkg of packages) {
    const resources = (pkg.resources ?? []).filter(matches);
    if (resources.length) kept.push({ ...pkg, resources });
  }
  return kept;
}

export function packageTags(pkg: CkanPackage): string[] {
  return (pkg.tags ?? []).map((t) => t.name ?? '').filter(Boolean);
}

/** Read a CKAN `extras` entry as a boolean flag. CKAN stores extras as strings. */
export function packageExtraFlag(pkg: CkanPackage, key: string): boolean {
  return (pkg.extras ?? []).some((e) => e.key === key && e.value === 'true');
}

/**
 * Client-side temporal filter. CKAN's temporal_coverage_* fields are extras and
 * are not reliably indexed for range queries, so we filter after fetching
 * rather than pushing an `fq` that some instances would reject.
 *
 * A package is kept when its coverage overlaps the requested window; packages
 * with no coverage at all are kept rather than silently dropped.
 */
export function overlapsDateRange(
  pkg: CkanPackage,
  start?: Date | null,
  end?: Date | null,
): boolean {
  if (!start && !end) return true;
  const period = packageTimePeriod(pkg);
  if (!period) return true;
  if (end && period.start_date && period.start_date > end) return false;
  if (start && period.end_date && period.end_date < start) return false;
  return true;
}
