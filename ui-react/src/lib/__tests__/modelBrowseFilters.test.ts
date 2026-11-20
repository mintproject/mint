import { describe, expect, it } from 'vitest';

import {
  buildConfigurationWhere,
  filterRowsByKind,
  filtersToParams,
  hasActiveFilters,
  parseFilters,
  type ModelBrowseFilters,
} from '@/lib/modelBrowseFilters';

const base: ModelBrowseFilters = {
  q: '',
  regionIds: [],
  categoryIds: [],
  variableIds: [],
  kind: 'all',
};

describe('buildConfigurationWhere', () => {
  it('returns an empty where when no filters are active', () => {
    expect(buildConfigurationWhere(base)).toEqual({});
  });

  it('matches own label and model label for text search', () => {
    const where = buildConfigurationWhere({ ...base, q: 'flow' });
    expect(where._and).toHaveLength(1);
    expect(where._and![0]!._or).toEqual([
      { label: { _ilike: '%flow%' } },
      { software_version: { software: { label: { _ilike: '%flow%' } } } },
      { parent_configuration: { software_version: { software: { label: { _ilike: '%flow%' } } } } },
    ]);
  });

  it('ignores whitespace-only text', () => {
    expect(buildConfigurationWhere({ ...base, q: '   ' })).toEqual({});
  });

  it('adds category, region, and output-variable clauses', () => {
    const where = buildConfigurationWhere({
      ...base,
      categoryIds: ['cat1'],
      regionIds: ['r1', 'r2'],
      variableIds: ['v1'],
      kind: 'all',
    });
    expect(where._and).toContainEqual({ categories: { category_id: { _in: ['cat1'] } } });
    expect(where._and).toContainEqual({ regions: { region_id: { _in: ['r1', 'r2'] } } });
    expect(where._and).toContainEqual({
      outputs: {
        output: { presentations: { presentation: { standard_variable: { id: { _in: ['v1'] } } } } },
      },
    });
  });

  it('omits a facet clause when its id list is empty', () => {
    const where = buildConfigurationWhere({ ...base, categoryIds: ['cat1'] });
    expect(where._and).toHaveLength(1);
  });
});

describe('hasActiveFilters', () => {
  it('is false for empty filters', () => {
    expect(hasActiveFilters(base)).toBe(false);
  });
  it('is true when any dimension is set', () => {
    expect(hasActiveFilters({ ...base, q: 'x' })).toBe(true);
    expect(hasActiveFilters({ ...base, regionIds: ['r1'] })).toBe(true);
  });
});

describe('parseFilters', () => {
  it('reads q and repeated facet params', () => {
    const params = new URLSearchParams('q=modflow&region=r1&region=r2&category=c1&variable=v1');
    expect(parseFilters(params)).toEqual({
      q: 'modflow',
      regionIds: ['r1', 'r2'],
      categoryIds: ['c1'],
      variableIds: ['v1'],
      kind: 'all',
    });
  });

  it('defaults to empty filters', () => {
    expect(parseFilters(new URLSearchParams())).toEqual(base);
  });
});

describe('the models / flows kind', () => {
  it('reads and writes the type param, leaving it out for "all"', () => {
    expect(parseFilters(new URLSearchParams('type=flows')).kind).toBe('flows');
    expect(parseFilters(new URLSearchParams('type=models')).kind).toBe('models');
    expect(parseFilters(new URLSearchParams('type=bogus')).kind).toBe('all');
    expect(filtersToParams({ ...base, kind: 'flows' }).get('type')).toBe('flows');
    expect(filtersToParams(base).has('type')).toBe(false);
  });

  it('counts as an active filter and does not change the Hasura where', () => {
    expect(hasActiveFilters({ ...base, kind: 'flows' })).toBe(true);
    expect(buildConfigurationWhere({ ...base, kind: 'flows' })).toEqual({});
  });

  it('keeps flows or models, a setup taking its parent configuration kind', () => {
    const rows = [
      { id: 'flow-1' },
      { id: 'model-1' },
      { id: 'setup-of-model', model_configuration_id: 'model-1' },
    ];
    const flowIds = new Set(['flow-1']);
    expect(filterRowsByKind(rows, 'flows', flowIds).map((r) => r.id)).toEqual(['flow-1']);
    expect(filterRowsByKind(rows, 'models', flowIds).map((r) => r.id)).toEqual([
      'model-1',
      'setup-of-model',
    ]);
    expect(filterRowsByKind(rows, 'all', flowIds)).toHaveLength(3);
  });
});
