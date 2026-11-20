import { describe, expect, it } from 'vitest';

import {
  boundaryFeatureLabel,
  boundaryGroups,
  buildLayerOptions,
  buildRegionOptions,
  filterBoundaryOptions,
  findBoundaryOption,
  prettyRegionName,
  regionFamilyOf,
} from '@/lib/spatial-boundaries';

const region = (id: string, name: string, category = 'Aquifers'): GeoJSON.Feature => ({
  type: 'Feature',
  properties: { region_id: id, region_name: name, category_name: category },
  geometry: { type: 'Point', coordinates: [0, 0] },
});

describe('boundaryFeatureLabel', () => {
  it('labels a number-only layer from the configured prefix', () => {
    expect(boundaryFeatureLabel({ GMAnum: 1 }, 'GMAnum', { label_prefix: 'GMA ' })).toBe('GMA 1');
  });

  it('adds the name when the layer has one', () => {
    expect(
      boundaryFeatureLabel({ GMAnum: 8, GMAName: 'Gulf Coast' }, 'GMAnum', {
        label_prefix: 'GMA ',
      }),
    ).toBe('GMA 8 — Gulf Coast');
  });

  it('uses the configured label field and suffix for named layers', () => {
    expect(
      boundaryFeatureLabel({ Name: 'Anderson', Fips: 1 }, 'Name', {
        label_field: 'Name',
        label_suffix: ' County',
      }),
    ).toBe('Anderson County');
  });
});

describe('regionFamilyOf', () => {
  it('finds the family of a numbered name', () => {
    expect(regionFamilyOf('TRINITY_53')?.label).toBe('Trinity');
    expect(regionFamilyOf('EDWARDS-TRINITY_3')?.label).toBe('Edwards-Trinity');
  });
  it('ignores names without a base or a number', () => {
    expect(regionFamilyOf('Alwero')).toBeNull();
    expect(regionFamilyOf('1')).toBeNull();
  });
  it('prettifies underscore names only', () => {
    expect(prettyRegionName('SEYMOUR_3')).toBe('Seymour 3');
    expect(prettyRegionName('GMA 12')).toBe('GMA 12');
  });
});

describe('buildRegionOptions', () => {
  const features = [
    region('zz1', 'TRINITY_2'),
    region('zz2', 'TRINITY_10'),
    region('zz3', 'TRINITY_1'),
    region('aa9', 'Alwero', 'Watersheds'),
    region('lone', 'CARRIZO_1'),
    region('1790434732014', '1', 'Watersheds'),
  ];
  const options = buildRegionOptions(features, 'region_id');

  it('never puts an id in a label', () => {
    for (const option of options) {
      expect(option.label).not.toMatch(/zz\d|aa9|lone|1790434732014/);
    }
  });

  it('collapses numbered parts into one family that selects every part', () => {
    const family = options.find((o) => o.label === 'Trinity (3 parts)');
    expect(family?.values.sort()).toEqual(['zz1', 'zz2', 'zz3']);
    expect(family?.parts?.map((p) => p.label)).toEqual(['Trinity 1', 'Trinity 2', 'Trinity 10']);
    expect(options.filter((o) => o.label.startsWith('Trinity'))).toHaveLength(1);
  });

  it('leaves a lone numbered region as itself', () => {
    expect(options.find((o) => o.label === 'Carrizo 1')?.parts).toBeUndefined();
  });

  it('sorts by group then name, and lists the groups', () => {
    expect(options.map((o) => o.label)).toEqual(['Carrizo 1', 'Trinity (3 parts)', '1', 'Alwero']);
    expect(boundaryGroups(options)).toEqual(['Aquifers', 'Watersheds']);
  });

  it('filters by typing, keeping only matching parts of a family', () => {
    const hits = filterBoundaryOptions(options, 'trinity 10');
    expect(hits).toHaveLength(1);
    expect(hits[0]?.parts?.map((p) => p.label)).toEqual(['Trinity 10']);
    expect(filterBoundaryOptions(options, 'alw').map((o) => o.label)).toEqual(['Alwero']);
    expect(filterBoundaryOptions(options, 'nothing')).toEqual([]);
  });

  it('finds a saved single part or family by its value', () => {
    expect(findBoundaryOption(options, 'zz2')?.label).toBe('Trinity 10');
    const family = options.find((o) => o.parts);
    expect(findBoundaryOption(options, family?.value ?? '')?.label).toBe('Trinity (3 parts)');
  });
});

describe('buildLayerOptions', () => {
  it('labels and sorts GMA features', () => {
    const features = [10, 2, 1].map(
      (n): GeoJSON.Feature => ({
        type: 'Feature',
        properties: { GMAnum: n },
        geometry: { type: 'Point', coordinates: [0, 0] },
      }),
    );
    expect(
      buildLayerOptions(features, 'GMAnum', { label_prefix: 'GMA ' }).map((o) => o.label),
    ).toEqual(['GMA 1', 'GMA 2', 'GMA 10']);
  });
});
