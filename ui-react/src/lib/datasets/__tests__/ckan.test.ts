/**
 * Tests for the CKAN Action API transport and its shaping helpers.
 *
 * Fixtures mirror the wire shape of a real CKAN instance
 * (ckan.tacc.utexas.edu), including its quirks: `version: "None"` as a string,
 * `spatial` as stringified GeoJSON, and temporal coverage as bare date strings.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '@/test/msw/server';
import {
  buildSearchQuery,
  canonicalStandardVariable,
  cleanString,
  overlapsDateRange,
  packageExtraFlag,
  packageBoundingBox,
  packageSpatialCoverage,
  packageTags,
  packagesMatchingVariables,
  packagesMatchingVariableSubstring,
  packageTimePeriod,
  packagesMatchingCanonicalVariables,
  parseDate,
  resourceMatchesVariables,
  resourceMatchesCanonicalVariables,
  resourceMatchesVariableSubstring,
  resourceStandardVariables,
  searchAllPackages,
  searchPackages,
  showPackage,
  type CkanPackage,
} from '../ckan';

const CKAN_HOST = 'https://ckan.example.org';

/** Capture the URL of the last intercepted request so we can assert on params. */
let lastUrl: URL | null = null;

function stubSearch(results: CkanPackage[]) {
  server.use(
    http.get('*/api/3/action/package_search', ({ request }) => {
      lastUrl = new URL(request.url);
      return HttpResponse.json({ success: true, result: { count: results.length, results } });
    }),
  );
}

beforeEach(() => {
  lastUrl = null;
  window.__MINT_CONFIG__ = { DATA_CATALOG_API: CKAN_HOST } as never;
});

afterEach(() => {
  delete (window as { __MINT_CONFIG__?: unknown }).__MINT_CONFIG__;
});

// ─── Transport ────────────────────────────────────────────────────────────────

describe('searchPackages', () => {
  it('unwraps the CKAN envelope and returns the results array', async () => {
    stubSearch([{ id: 'a', name: 'pkg-a' }]);
    const packages = await searchPackages({});
    expect(packages).toHaveLength(1);
    expect(packages[0]?.name).toBe('pkg-a');
  });

  it('defaults to 100 rows and omits q when no query is given', async () => {
    stubSearch([]);
    await searchPackages({});
    expect(lastUrl?.searchParams.get('rows')).toBe('100');
    expect(lastUrl?.searchParams.has('q')).toBe(false);
  });

  it('sends ext_bbox as minx,miny,maxx,maxy', async () => {
    stubSearch([]);
    await searchPackages({ boundingBox: { xmin: -100, xmax: -97, ymin: 29, ymax: 31 } });
    // Not xmin,xmax,ymin,ymax — CKAN interleaves the axes.
    expect(lastUrl?.searchParams.get('ext_bbox')).toBe('-100,29,-97,31');
  });

  it('hits the /api/3/action path on the configured host', async () => {
    stubSearch([]);
    await searchPackages({ q: 'rain' });
    expect(lastUrl?.origin).toBe(CKAN_HOST);
    expect(lastUrl?.pathname).toBe('/api/3/action/package_search');
    expect(lastUrl?.searchParams.get('q')).toBe('rain');
  });

  it('throws on a non-2xx response', async () => {
    server.use(
      http.get('*/api/3/action/package_search', () => new HttpResponse(null, { status: 500 })),
    );
    await expect(searchPackages({})).rejects.toThrow(/package_search failed/);
  });

  it('throws when CKAN reports success: false', async () => {
    server.use(
      http.get('*/api/3/action/package_search', () =>
        HttpResponse.json({ success: false, error: { message: 'Bad request' } }),
      ),
    );
    await expect(searchPackages({})).rejects.toThrow(/Bad request/);
  });

  it('throws when the envelope carries no result', async () => {
    server.use(
      http.get('*/api/3/action/package_search', () => HttpResponse.json({ success: true })),
    );
    await expect(searchPackages({})).rejects.toThrow(/package_search failed/);
  });
});

describe('searchAllPackages', () => {
  /** Serve `total` packages in pages of `rows`, honouring `start`. */
  function stubPagedSearch(total: number, requests: URL[]) {
    server.use(
      http.get('*/api/3/action/package_search', ({ request }) => {
        const url = new URL(request.url);
        requests.push(url);
        const start = Number(url.searchParams.get('start') ?? 0);
        const rows = Number(url.searchParams.get('rows') ?? 100);
        const results = Array.from(
          { length: Math.max(0, Math.min(rows, total - start)) },
          (_, i) => ({
            id: `pkg-${start + i}`,
          }),
        );
        return HttpResponse.json({ success: true, result: { count: total, results } });
      }),
    );
  }

  it('makes a single request when the catalog fits in one page', async () => {
    const requests: URL[] = [];
    stubPagedSearch(215, requests);
    const packages = await searchAllPackages({});
    expect(packages).toHaveLength(215);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.searchParams.get('rows')).toBe('1000');
  });

  it('pages past CKANs 1000-row cap rather than truncating silently', async () => {
    const requests: URL[] = [];
    stubPagedSearch(2300, requests);
    const packages = await searchAllPackages({});
    expect(packages).toHaveLength(2300);
    expect(requests.map((u) => u.searchParams.get('start'))).toEqual([null, '1000', '2000']);
    // Every package is distinct: the pages were offset, not refetched.
    expect(new Set(packages.map((p) => p.id)).size).toBe(2300);
  });

  it('stops rather than looping forever when CKAN reports a count it will not serve', async () => {
    server.use(
      http.get('*/api/3/action/package_search', () =>
        HttpResponse.json({ success: true, result: { count: 5000, results: [] } }),
      ),
    );
    await expect(searchAllPackages({})).resolves.toEqual([]);
  });

  it('carries the bounding box onto every page', async () => {
    const requests: URL[] = [];
    stubPagedSearch(1500, requests);
    await searchAllPackages({ boundingBox: { xmin: -100, xmax: -97, ymin: 29, ymax: 31 } });
    expect(requests.map((u) => u.searchParams.get('ext_bbox'))).toEqual([
      '-100,29,-97,31',
      '-100,29,-97,31',
    ]);
  });
});

describe('showPackage', () => {
  it('passes the id through and returns the package', async () => {
    server.use(
      http.get('*/api/3/action/package_show', ({ request }) => {
        lastUrl = new URL(request.url);
        return HttpResponse.json({ success: true, result: { id: 'x', name: 'my-slug' } });
      }),
    );
    const pkg = await showPackage('my-slug');
    expect(lastUrl?.searchParams.get('id')).toBe('my-slug');
    expect(pkg.name).toBe('my-slug');
  });

  it('throws a not-found error through the envelope', async () => {
    server.use(
      http.get('*/api/3/action/package_show', () =>
        HttpResponse.json({ success: false, error: { message: 'Not found' } }),
      ),
    );
    await expect(showPackage('nope')).rejects.toThrow(/Not found/);
  });
});

// ─── Query building ───────────────────────────────────────────────────────────

describe('buildSearchQuery', () => {
  it('returns undefined when there is nothing to search on', () => {
    expect(buildSearchQuery({})).toBeUndefined();
    expect(buildSearchQuery({ name: '' })).toBeUndefined();
  });

  it('quotes a single name as a phrase', () => {
    expect(buildSearchQuery({ name: 'soil moisture' })).toBe('"soil moisture"');
  });

  it('escapes embedded quotes so Solr does not see an unbalanced phrase', () => {
    expect(buildSearchQuery({ name: 'say "hi"' })).toBe('"say \\"hi\\""');
  });
});

// ─── Shaping helpers ──────────────────────────────────────────────────────────

describe('cleanString', () => {
  it('treats CKANs literal "None" as empty', () => {
    expect(cleanString('None')).toBe('');
  });

  it('maps null and undefined to empty', () => {
    expect(cleanString(null)).toBe('');
    expect(cleanString(undefined)).toBe('');
  });

  it('passes real values through', () => {
    expect(cleanString('1.0')).toBe('1.0');
    expect(cleanString(0)).toBe('0');
  });
});

describe('parseDate', () => {
  it('parses an ISO date', () => {
    expect(parseDate('2023-01-01')?.getUTCFullYear()).toBe(2023);
  });

  it('returns null for "None", empty, and unparseable input', () => {
    expect(parseDate('None')).toBeNull();
    expect(parseDate('')).toBeNull();
    expect(parseDate(undefined)).toBeNull();
    expect(parseDate('not-a-date')).toBeNull();
  });
});

describe('packageTimePeriod', () => {
  it('returns null when neither bound is present', () => {
    expect(packageTimePeriod({})).toBeNull();
  });

  it('returns a period when only one bound is present', () => {
    const period = packageTimePeriod({ temporal_coverage_start: '2023-01-01' });
    expect(period?.start_date).toBeInstanceOf(Date);
    expect(period?.end_date).toBeNull();
  });

  it('reads both bounds', () => {
    const period = packageTimePeriod({
      temporal_coverage_start: '2023-01-01',
      temporal_coverage_end: '2023-12-31',
    });
    expect(period?.start_date?.getUTCFullYear()).toBe(2023);
    expect(period?.end_date?.getUTCMonth()).toBe(11);
  });
});

describe('packageSpatialCoverage', () => {
  const polygon = JSON.stringify({
    type: 'Polygon',
    coordinates: [
      [
        [-97.7, 30.3],
        [-97.7, 30.4],
        [-97.6, 30.4],
        [-97.6, 30.3],
        [-97.7, 30.3],
      ],
    ],
  });

  it('unwraps the outer GeoJSON polygon ring', () => {
    const coverage = packageSpatialCoverage({ spatial: polygon });
    expect(coverage?.type).toBe('Polygon');
    // One level shallower than the GeoJSON nesting.
    expect(coverage?.coordinates?.[0]).toEqual([-97.7, 30.3]);
    expect(coverage?.coordinates).toHaveLength(5);
  });

  it('reads legacy package spatial extras when canonical spatial is absent', () => {
    const packageWithExtra = { extras: [{ key: 'spatial', value: polygon }] };
    const coverage = packageSpatialCoverage(packageWithExtra);
    expect(coverage?.type).toBe('Polygon');
    expect(packageBoundingBox(packageWithExtra)).toEqual({
      xmin: -97.7,
      xmax: -97.6,
      ymin: 30.3,
      ymax: 30.4,
    });
  });

  it('returns undefined when spatial is absent', () => {
    expect(packageSpatialCoverage({})).toBeUndefined();
  });

  it('returns undefined rather than throwing on malformed JSON', () => {
    expect(packageSpatialCoverage({ spatial: '{not json' })).toBeUndefined();
  });

  it('returns undefined when the geometry has no type', () => {
    expect(packageSpatialCoverage({ spatial: '{"coordinates":[]}' })).toBeUndefined();
  });
});

// ─── Standard variable matching ───────────────────────────────────────────────

describe('resourceStandardVariables', () => {
  it('splits the comma-separated string TACC writes', () => {
    expect(
      resourceStandardVariables({
        mint_standard_variables: 'groundwater__hydraulic_head,aquifer__transmissivity',
      }),
    ).toEqual(['groundwater__hydraulic_head', 'aquifer__transmissivity']);
  });

  it('trims whitespace around each name', () => {
    expect(resourceStandardVariables({ mint_standard_variables: ' a , b ' })).toEqual(['a', 'b']);
  });

  it('is empty for an unannotated resource', () => {
    expect(resourceStandardVariables({})).toEqual([]);
    expect(resourceStandardVariables({ mint_standard_variables: null })).toEqual([]);
    // CKAN writes the empty string on resources that were never annotated.
    expect(resourceStandardVariables({ mint_standard_variables: '' })).toEqual([]);
  });

  it('accepts a list, and splits list entries that themselves hold commas', () => {
    expect(resourceStandardVariables({ mint_standard_variables: ['a', 'b,c'] })).toEqual([
      'a',
      'b',
      'c',
    ]);
  });
});

describe('resourceMatchesVariables', () => {
  const annotated = { mint_standard_variables: 'groundwater__hydraulic_head' };

  it('matches on the exact name', () => {
    expect(resourceMatchesVariables(annotated, ['groundwater__hydraulic_head'])).toBe(true);
  });

  it('does not match a name that merely shares tokens', () => {
    // Solr splits on _ and ~, which is exactly how the free-text search went wrong.
    expect(resourceMatchesVariables(annotated, ['groundwater__initial_head'])).toBe(false);
    expect(resourceMatchesVariables(annotated, ['groundwater'])).toBe(false);
  });

  it('matches when any one of several requested variables is carried', () => {
    expect(resourceMatchesVariables(annotated, ['nope', 'groundwater__hydraulic_head'])).toBe(true);
  });

  it('never matches an unannotated resource against a real request', () => {
    expect(resourceMatchesVariables({ format: 'CSV' }, ['groundwater__hydraulic_head'])).toBe(
      false,
    );
  });

  it('passes everything through when no variable is requested', () => {
    expect(resourceMatchesVariables({ format: 'CSV' }, [])).toBe(true);
  });

  it('keeps version-specific MODFLOW archive labels distinct', () => {
    const modflow6 = {
      mint_standard_variables: 'groundwater_model_modflow6_simulation_archive',
    };
    expect(
      resourceMatchesVariables(modflow6, ['groundwater_model_modflow6_simulation_archive']),
    ).toBe(true);
    expect(
      resourceMatchesVariables(modflow6, ['groundwater_model_modflow2000_simulation_archive']),
    ).toBe(false);
  });
});

describe('canonical standard-variable matching', () => {
  it('normalizes labels, URI tails, and case for exact matching', () => {
    expect(
      canonicalStandardVariable('https://w3id.org/okn/i/mint/Groundwater__Hydraulic_Head'),
    ).toBe('groundwater__hydraulic_head');
    expect(
      resourceMatchesCanonicalVariables(
        { mint_standard_variables: 'https://w3id.org/okn/i/mint/groundwater__hydraulic_head' },
        ['Groundwater__Hydraulic_Head'],
      ),
    ).toBe(true);
  });

  it('keeps malformed percent-encoding from breaking discovery', () => {
    expect(canonicalStandardVariable('rain%fall')).toBe('rain%fall');
  });

  it('does not turn a prose or partial match into an SVO match', () => {
    expect(
      resourceMatchesCanonicalVariables(
        { mint_standard_variables: 'groundwater__hydraulic_head' },
        ['groundwater'],
      ),
    ).toBe(false);
  });

  it('keeps only resources carrying one of the requested SVOs', () => {
    const packageWithTwoResources: CkanPackage = {
      name: 'annotated-dataset',
      resources: [
        { id: 'match', mint_standard_variables: 'https://w3id.org/okn/i/mint/rainfall' },
        { id: 'other', mint_standard_variables: 'temperature' },
      ],
    };
    expect(
      packagesMatchingCanonicalVariables([packageWithTwoResources], ['rainfall'])[0]?.resources,
    ).toEqual([{ id: 'match', mint_standard_variables: 'https://w3id.org/okn/i/mint/rainfall' }]);
  });
});

describe('packagesMatchingVariables', () => {
  const wanted = ['groundwater__initial_head'];

  const carrier: CkanPackage = {
    name: 'capitan-reef-complex-aquifer-gam-files',
    resources: [
      { id: 'r1', mint_standard_variables: 'groundwater__initial_head' },
      { id: 'r2', mint_standard_variables: 'aquifer__transmissivity' },
      { id: 'r3' },
    ],
  };

  /** Matches the words of the variable name in prose, but carries no annotation. */
  const falsePositive: CkanPackage = {
    name: 'groundwater-initial-head-report',
    notes: 'A report on groundwater initial head across the basin.',
    resources: [{ id: 'r4', mint_standard_variables: '' }],
  };

  it('keeps a package whose resource carries the variable', () => {
    expect(packagesMatchingVariables([carrier], wanted).map((p) => p.name)).toEqual([carrier.name]);
  });

  it('drops the prose match that free-text search returned', () => {
    expect(packagesMatchingVariables([falsePositive], wanted)).toEqual([]);
  });

  it('narrows the kept package to the resources that carry the variable', () => {
    const [pkg] = packagesMatchingVariables([carrier], wanted);
    expect(pkg?.resources?.map((r) => r.id)).toEqual(['r1']);
  });

  it('leaves the input package untouched', () => {
    packagesMatchingVariables([carrier], wanted);
    expect(carrier.resources).toHaveLength(3);
  });

  it('passes everything through when no variable is requested', () => {
    const all = [carrier, falsePositive];
    expect(packagesMatchingVariables(all, [])).toBe(all);
    expect(packagesMatchingVariables(all, [''])).toBe(all);
  });

  it('drops a package with no resources at all', () => {
    expect(packagesMatchingVariables([{ name: 'empty' }], wanted)).toEqual([]);
  });
});

describe('resourceMatchesVariableSubstring', () => {
  const annotated = { mint_standard_variables: 'groundwater__hydraulic_head' };

  it('matches a fragment of the variable name', () => {
    expect(resourceMatchesVariableSubstring(annotated, 'hydraulic')).toBe(true);
    expect(resourceMatchesVariableSubstring(annotated, 'groundwater')).toBe(true);
  });

  it('matches across the underscores Solr tokenises on', () => {
    // The whole point: `q` cannot find this, because Solr splits the name up.
    expect(resourceMatchesVariableSubstring(annotated, 'water__hydraulic')).toBe(true);
  });

  it('ignores case on both sides', () => {
    expect(resourceMatchesVariableSubstring(annotated, 'Hydraulic HEAD'.slice(0, 9))).toBe(true);
    expect(
      resourceMatchesVariableSubstring({ mint_standard_variables: 'Corpus_NLP' }, 'corpus_nlp'),
    ).toBe(true);
  });

  it('does not match a term absent from the annotation', () => {
    expect(resourceMatchesVariableSubstring(annotated, 'porosity')).toBe(false);
  });

  it('never matches an unannotated resource against a real term', () => {
    expect(resourceMatchesVariableSubstring({ format: 'CSV' }, 'groundwater')).toBe(false);
  });

  it('passes everything through when the term is empty or blank', () => {
    expect(resourceMatchesVariableSubstring({ format: 'CSV' }, '')).toBe(true);
    expect(resourceMatchesVariableSubstring({ format: 'CSV' }, '   ')).toBe(true);
  });
});

describe('packagesMatchingVariableSubstring', () => {
  const carrier: CkanPackage = {
    name: 'capitan-reef-complex-aquifer-gam-files',
    resources: [
      { id: 'r1', mint_standard_variables: 'groundwater__initial_head' },
      { id: 'r2', mint_standard_variables: 'aquifer__transmissivity' },
      { id: 'r3' },
    ],
  };

  /** Reads as a match in prose, carries no annotation. This is what `q` returned. */
  const falsePositive: CkanPackage = {
    name: 'groundwater-initial-head-report',
    notes: 'A report on groundwater initial head across the basin.',
    resources: [{ id: 'r4', mint_standard_variables: '' }],
  };

  it('keeps a package whose resource carries a variable containing the term', () => {
    expect(packagesMatchingVariableSubstring([carrier], 'head').map((p) => p.name)).toEqual([
      carrier.name,
    ]);
  });

  it('drops the prose match that free-text search returned', () => {
    expect(packagesMatchingVariableSubstring([falsePositive], 'groundwater')).toEqual([]);
  });

  it('finds an underscored name that free-text search cannot', () => {
    // `corpus_nlp` returned 0 through Solr while 17 TACC datasets carried it.
    const pkg: CkanPackage = {
      name: 'nlp-corpus',
      resources: [{ id: 'r5', mint_standard_variables: 'corpus_nlp' }],
    };
    expect(packagesMatchingVariableSubstring([pkg], 'corpus_nlp')).toHaveLength(1);
  });

  it('narrows the kept package to the resources that carry the term', () => {
    const [pkg] = packagesMatchingVariableSubstring([carrier], 'transmissivity');
    expect(pkg?.resources?.map((r) => r.id)).toEqual(['r2']);
  });

  it('keeps every resource whose annotation contains the term', () => {
    const [pkg] = packagesMatchingVariableSubstring([carrier], 'a');
    expect(pkg?.resources?.map((r) => r.id)).toEqual(['r1', 'r2']);
  });

  it('leaves the input package untouched', () => {
    packagesMatchingVariableSubstring([carrier], 'head');
    expect(carrier.resources).toHaveLength(3);
  });

  it('passes everything through when the term is empty', () => {
    const all = [carrier, falsePositive];
    expect(packagesMatchingVariableSubstring(all, '')).toBe(all);
    expect(packagesMatchingVariableSubstring(all, '  ')).toBe(all);
  });

  it('drops a package with no resources at all', () => {
    expect(packagesMatchingVariableSubstring([{ name: 'empty' }], 'head')).toEqual([]);
  });
});

describe('packageTags', () => {
  it('extracts tag names and drops empty ones', () => {
    expect(packageTags({ tags: [{ name: 'climate' }, { name: '' }, {}] })).toEqual(['climate']);
  });

  it('returns an empty array when there are no tags', () => {
    expect(packageTags({})).toEqual([]);
  });
});

describe('packageExtraFlag', () => {
  it('is true only for the string "true"', () => {
    const pkg: CkanPackage = {
      extras: [
        { key: 'is_cached', value: 'true' },
        { key: 'dataset_repr', value: 'false' },
      ],
    };
    expect(packageExtraFlag(pkg, 'is_cached')).toBe(true);
    expect(packageExtraFlag(pkg, 'dataset_repr')).toBe(false);
    expect(packageExtraFlag(pkg, 'missing')).toBe(false);
  });

  it('is false when there are no extras', () => {
    expect(packageExtraFlag({}, 'is_cached')).toBe(false);
  });
});

describe('overlapsDateRange', () => {
  const pkg: CkanPackage = {
    temporal_coverage_start: '2023-01-01',
    temporal_coverage_end: '2023-12-31',
  };

  it('keeps everything when no window is requested', () => {
    expect(overlapsDateRange(pkg)).toBe(true);
  });

  it('keeps packages with no coverage rather than dropping them', () => {
    expect(overlapsDateRange({}, new Date('2020-01-01'), new Date('2020-12-31'))).toBe(true);
  });

  it('keeps an overlapping package', () => {
    expect(overlapsDateRange(pkg, new Date('2023-06-01'), new Date('2024-06-01'))).toBe(true);
  });

  it('drops a package entirely after the window', () => {
    expect(overlapsDateRange(pkg, new Date('2019-01-01'), new Date('2020-01-01'))).toBe(false);
  });

  it('drops a package entirely before the window', () => {
    expect(overlapsDateRange(pkg, new Date('2025-01-01'), new Date('2026-01-01'))).toBe(false);
  });

  it('treats a touching boundary as an overlap', () => {
    expect(overlapsDateRange(pkg, new Date('2023-12-31'), new Date('2024-06-01'))).toBe(true);
  });
});

// ─── Private datasets for a signed-in user ────────────────────────────────────

describe('reading the catalog as a signed-in user', () => {
  afterEach(() => localStorage.clear());

  it('sends the bearer token and asks for private datasets when a token exists', async () => {
    localStorage.setItem('mint.access_token', 'USER-TOKEN');
    let auth: string | null = null;
    server.use(
      http.get('*/api/3/action/package_search', ({ request }) => {
        lastUrl = new URL(request.url);
        auth = request.headers.get('authorization');
        return HttpResponse.json({ success: true, result: { count: 0, results: [] } });
      }),
      http.get('*/api/3/action/package_show', ({ request }) => {
        auth = request.headers.get('authorization');
        return HttpResponse.json({ success: true, result: { id: 'p' } });
      }),
    );
    await searchPackages({});
    expect(auth).toBe('Bearer USER-TOKEN');
    expect(lastUrl!.searchParams.get('include_private')).toBe('true');
    auth = null;
    await showPackage('p');
    expect(auth).toBe('Bearer USER-TOKEN');
  });

  it('is unchanged when anonymous', async () => {
    let auth: string | null = 'unset';
    server.use(
      http.get('*/api/3/action/package_search', ({ request }) => {
        lastUrl = new URL(request.url);
        auth = request.headers.get('authorization');
        return HttpResponse.json({ success: true, result: { count: 0, results: [] } });
      }),
    );
    await searchPackages({});
    expect(auth).toBeNull();
    expect(lastUrl!.searchParams.has('include_private')).toBe(false);
  });
});
