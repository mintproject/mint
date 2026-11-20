import { describe, expect, it } from 'vitest';

import type { DataCatalogResource } from '@/lib/data-catalog';
import { buildThreadDataInsert, hashResourceId, newDatasliceId } from '@/lib/thread-datasets';
import { datasliceRegionId } from '@/lib/thread-datasets';

const resources: DataCatalogResource[] = [
  {
    id: 'ckan-res-1',
    name: 'a.tif',
    url: 'http://x/a.tif',
    time_period: { start_date: new Date('2020-01-01'), end_date: new Date('2020-12-31') },
    selected: true,
  },
  { id: 'ckan-res-2', name: 'b.tif', url: 'http://x/b.tif', selected: false },
];

function build() {
  return buildThreadDataInsert({
    threadId: 't1',
    threadName: 'Flood extent',
    regionId: 'texas',
    startDate: '2020-01-01',
    endDate: '2020-12-31',
    datasliceId: 'slice-1',
    dataset: { id: 'ckan-dem', name: 'National DEM' },
    resources,
  });
}

describe('buildThreadDataInsert', () => {
  it('keeps only the selected resources and counts those', () => {
    const insert = build();
    const data = insert.dataslice.data;
    expect(data.resources.data).toHaveLength(1);
    expect(data.resources.data[0]?.resource.data.name).toBe('a.tif');
    // resource_count describes what is bound, not what the package holds.
    expect(data.resource_count).toBe(1);
  });

  it('stores the catalog resource id as dcid and the URL hash as the key', () => {
    const res = build().dataslice.data.resources.data[0]!.resource.data;
    expect(res.dcid).toBe('ckan-res-1');
    expect(res.id).toBe(hashResourceId('http://x/a.tif'));
  });

  it('carries the thread window and region onto the dataslice', () => {
    const data = build().dataslice.data;
    expect(data).toMatchObject({
      id: 'slice-1',
      region_id: 'texas',
      start_date: '2020-01-01',
      end_date: '2020-12-31',
    });
    expect(data.name).toContain('National DEM');
    expect(data.dataset.data).toEqual({ id: 'ckan-dem', name: 'National DEM' });
  });

  it('narrows a resource date to a plain date, which is what the column takes', () => {
    expect(build().dataslice.data.resources.data[0]?.resource.data.start_date).toBe('2020-01-01');
  });

  it('leaves a resource with no coverage null rather than inventing one', () => {
    const insert = buildThreadDataInsert({
      threadId: 't1',
      datasliceId: 'slice-2',
      dataset: { id: 'd', name: 'D' },
      resources: [{ id: 'r', name: 'c.tif', url: 'http://x/c.tif' }],
    });
    const res = insert.dataslice.data.resources.data[0]!.resource.data;
    expect(res.start_date).toBeNull();
    expect(res.end_date).toBeNull();
  });
});

describe('hashResourceId', () => {
  it('is stable for the same URL, so a re-save upserts instead of duplicating', () => {
    expect(hashResourceId('http://x/a.tif')).toBe(hashResourceId('http://x/a.tif'));
    expect(hashResourceId('http://x/a.tif')).not.toBe(hashResourceId('http://x/b.tif'));
  });

  it('agrees with the digest Lit already stored for this file at TACC', () => {
    // Read live from dataslice a342f730-30c1-47e4-8b4d-0226bfea1a30. A different
    // hash would make this app insert a second resource row for the same file.
    expect(
      hashResourceId(
        'https://ckan.tacc.utexas.edu/dataset/ca9b6a10-402f-4a58-b50c-9bf324162958/resource/4de67e7f-9585-4191-9fbd-79019f8d3388/download/heatseekervideo.mp4',
      ),
    ).toBe('e9a1d75696d0158aac85a8bf7f15d2c2');
  });
});

describe('newDatasliceId', () => {
  it('produces a v4-shaped uuid, which the uuid column requires', () => {
    expect(newDatasliceId()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});

describe('datasliceRegionId', () => {
  // Seen on dev: a thread framed for any region could not bind data, because a
  // dataslice must name an existing region and an empty id was sent.
  it("uses the thread's own region first, then the task's, then the problem statement's", () => {
    const ps = { region_id: 'ps-region' };
    expect(
      datasliceRegionId({ region_id: 'r1', task: { region_id: 't', problem_statement: ps } }),
    ).toBe('r1');
    expect(
      datasliceRegionId({ region_id: null, task: { region_id: 't', problem_statement: ps } }),
    ).toBe('t');
    expect(
      datasliceRegionId({ region_id: '', task: { region_id: null, problem_statement: ps } }),
    ).toBe('ps-region');
  });

  it('is null when nothing has a region, never an empty id', () => {
    expect(datasliceRegionId({ region_id: '' })).toBeNull();
    expect(datasliceRegionId({ region_id: null, task: null })).toBeNull();
  });
});

describe('UpdateThreadData', () => {
  it('keeps the models parameter values when the data is saved', async () => {
    const { print } = await import('graphql');
    const { UpdateThreadDataDocument } = await import('@/graphql/generated/modeling');
    const text = print(UpdateThreadDataDocument);
    expect(text).not.toContain('delete_thread_model_parameter');
    // What the data replaces is still cleared.
    expect(text).toContain('delete_thread_model_io');
    expect(text).toContain('delete_thread_model_execution');
  });
});
