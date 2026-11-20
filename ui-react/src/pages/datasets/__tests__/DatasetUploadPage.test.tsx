import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setMintConfig } from '@/test/utils/mint-config';
import { renderWithProviders } from '@/test/utils/render';

import { gql } from '@apollo/client';

import { clearLicenseCache } from '@/lib/ckan-upload';

import { DatasetUploadPage } from '../DatasetUploadPage';

const CKAN = 'https://ckan.example.org';

// The picker itself is covered elsewhere; here it just chooses a variable.
vi.mock('@/components/autocomplete/StandardVariableCombobox', () => ({
  StandardVariableCombobox: ({
    value,
    preferredIds,
    onChange,
  }: {
    value: { label: string } | null;
    preferredIds?: string[];
    onChange: (v: { id: string; label: string; description: string | null }) => void;
  }) => (
    <>
      <button
        type="button"
        onClick={() => onChange({ id: 'sv-1', label: 'precipitation_flux', description: null })}
      >
        pick variable
      </button>
      <output data-testid="picked">{value?.label ?? ''}</output>
      <output data-testid="picker-ranking">{(preferredIds ?? []).join(',')}</output>
    </>
  ),
}));

// The map is covered by its own use elsewhere; here it draws one fixed box and
// shows what the page hands it.
vi.mock('@/components/datasets/DatasetSpatialMap', () => ({
  DatasetSpatialMap: ({
    value,
    outline,
    onChange,
  }: {
    value: { xmin: number; ymin: number; xmax: number; ymax: number } | null;
    outline?: unknown;
    onChange: (v: { xmin: number; ymin: number; xmax: number; ymax: number } | null) => void;
  }) => (
    <div>
      <button
        type="button"
        onClick={() => onChange({ xmin: -98.5, ymin: 29.25, xmax: -97.5, ymax: 30.5 })}
      >
        draw on map
      </button>
      <output data-testid="map-value">{JSON.stringify(value)}</output>
      <output data-testid="map-outline">{JSON.stringify(outline ?? null)}</output>
    </div>
  ),
}));

// The chosen variable's units, read once it is picked.
const unitsMock = {
  request: {
    query: gql`
      query GetStandardVariableUnits($id: String!) {
        modelcatalog_standard_variable(where: { id: { _eq: $id } }, limit: 1) {
          id
          variable_presentations {
            id
            unit {
              id
              label
            }
          }
        }
      }
    `,
    variables: { id: 'sv-1' },
  },
  maxUsageCount: Infinity,
  result: {
    data: {
      modelcatalog_standard_variable: [
        {
          __typename: 'modelcatalog_standard_variable',
          id: 'sv-1',
          variable_presentations: [
            {
              __typename: 'modelcatalog_variable_presentation',
              id: 'p1',
              unit: { __typename: 'modelcatalog_unit', id: 'u1', label: 'mm/day' },
            },
          ],
        },
      ],
    },
  },
};

function renderPage() {
  return renderWithProviders(<DatasetUploadPage />, { apolloMocks: [unitsMock] });
}

const tree = {
  modelcatalog_software: [
    {
      id: 's1',
      label: 'Soft',
      versions: [
        {
          id: 'v1',
          label: 'V',
          configurations: [
            {
              id: 'flow-1',
              label: 'Rain flow',
              flow: { configuration_id: 'flow-1' },
              regions: [],
              outputs: [],
              child_configurations: [],
              inputs: [
                {
                  input: {
                    id: 'in-1',
                    label: 'Rain',
                    has_format: 'csv',
                    presentations: [
                      {
                        presentation: {
                          id: 'p1',
                          standard_variable: { id: 'sv-1', label: 'precipitation_flux' },
                        },
                      },
                    ],
                  },
                },
              ],
            },
            {
              id: 'flow-2',
              label: 'Wet flow',
              flow: { configuration_id: 'flow-2' },
              regions: [],
              outputs: [],
              child_configurations: [],
              inputs: [
                {
                  input: {
                    id: 'in-3',
                    label: 'Rainfall',
                    has_format: 'csv',
                    presentations: [
                      {
                        presentation: {
                          id: 'p2',
                          standard_variable: { id: 'sv-2', label: 'rainfall_amount' },
                        },
                      },
                    ],
                  },
                },
              ],
            },
            {
              id: 'model-1',
              label: 'Rain model',
              flow: null,
              regions: [],
              outputs: [],
              child_configurations: [],
              inputs: [
                {
                  input: {
                    id: 'in-2',
                    label: 'Rain grid',
                    has_format: 'tif',
                    presentations: [
                      {
                        presentation: {
                          id: 'p1',
                          standard_variable: { id: 'sv-1', label: 'precipitation_flux' },
                        },
                      },
                    ],
                  },
                },
              ],
            },
          ],
        },
      ],
    },
  ],
};

vi.mock('@/graphql/generated/modeling', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/graphql/generated/modeling')>()),
  useGetModelTreeWithRegionsQuery: () => ({ data: tree, loading: false }),
}));
vi.mock('@/graphql/generated/graphql', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/graphql/generated/graphql')>()),
  useListRegionCategoriesQuery: () => ({
    data: { region_category: [{ id: 'c1', name: 'Counties' }] },
  }),
  useListRegionsByCategoryQuery: () => ({
    data: {
      region: [
        {
          id: 'r1',
          name: 'Travis',
          geometries: [
            {
              geometry: {
                type: 'Polygon',
                coordinates: [
                  [
                    [-98, 30],
                    [-97, 30],
                    [-97, 31],
                    [-98, 31],
                    [-98, 30],
                  ],
                ],
              },
            },
          ],
        },
      ],
    },
  }),
}));

interface Sent {
  form: FormData;
}
let sent: Sent[] = [];
let calls: string[] = [];
let createStatus = 200;
let order: string[] = [];
let licenseCalls = 0;
let semantic: (url: string) => ReturnType<typeof json>;

class FakeXhr {
  upload = { onprogress: null as null | ((e: { loaded: number }) => void) };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  status = 0;
  responseText = '';
  open() {}
  setRequestHeader() {}
  send(form: FormData) {
    sent.push({ form });
    order.push('resource_create');
    const n = sent.length;
    queueMicrotask(() => {
      this.status = 200;
      this.responseText = JSON.stringify({
        success: true,
        result: { id: `res-${n}`, url: `${CKAN}/d/${n}` },
      });
      this.onload?.();
    });
  }
}

function json(body: unknown, status = 200) {
  return {
    ok: status < 400,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  };
}

beforeEach(() => {
  sent = [];
  calls = [];
  order = [];
  licenseCalls = 0;
  semantic = () => json({ results: [] });
  clearLicenseCache();
  createStatus = 200;
  localStorage.setItem('mint.access_token', 'SECRET-USER-TOKEN');
  setMintConfig({ AUTH_PROVIDER: 'tapis', DATA_CATALOG_API: CKAN } as never);
  vi.stubGlobal('XMLHttpRequest', FakeXhr);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      calls.push(u);
      if (u.includes('/search?') || u.includes('/similar?')) return semantic(u);
      if (u.includes('license_list')) {
        licenseCalls += 1;
        return json({
          success: true,
          result: [
            { id: 'notspecified', title: 'License not specified' },
            { id: 'cc-by', title: 'Creative Commons Attribution' },
            { id: 'odc-by', title: 'Open Data Commons Attribution License' },
          ],
        });
      }
      if (u.includes('organization_list_for_user')) {
        return json({ success: true, result: [{ id: 'org-1', name: 'a', title: 'Org A' }] });
      }
      if (u.includes('package_create')) {
        order.push('package_create');
        (calls as string[] & { body?: unknown }).body = JSON.parse(String(init?.body));
        if (createStatus >= 400) {
          return json(
            {
              success: false,
              error: { message: 'Authorization Error: not allowed in this organization' },
            },
            createStatus,
          );
        }
        return json({ success: true, result: { id: 'pkg-1', name: 'dynamo-upload-x' } });
      }
      if (u.includes('package_show')) {
        order.push('package_show');
        return json({
          success: true,
          result: {
            id: 'pkg-1',
            private: true,
            resources: sent.map((_, i) => ({
              id: `res-${i + 1}`,
              url: `${CKAN}/d/${i + 1}`,
              mint_standard_variables: 'precipitation_flux',
            })),
          },
        });
      }
      return json({ success: true, result: [] });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

async function fill(files: File[]) {
  renderPage();
  await screen.findByRole('option', { name: 'Org A' });
  await userEvent.selectOptions(screen.getByLabelText('Organisation'), 'org-1');
  await userEvent.type(screen.getByLabelText('Title'), 'Rain 2020');
  await userEvent.type(
    screen.getByLabelText('Description'),
    'Daily rain, gauge data, gaps in 2020',
  );
  await userEvent.click(screen.getByText('pick variable'));
  fireEvent.change(screen.getByLabelText('Start date'), { target: { value: '2020-01-01' } });
  fireEvent.change(screen.getByLabelText('End date'), { target: { value: '2020-12-31' } });
  await userEvent.upload(screen.getByLabelText('Choose files to upload'), files);
}

const csv = (name: string) => new File(['a,b'], name);

describe('DatasetUploadPage', () => {
  it('validates the required fields and sends nothing', async () => {
    renderPage();
    await screen.findByRole('option', { name: 'Org A' });
    await userEvent.click(screen.getByRole('button', { name: 'Upload' }));
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Choose at least one file.');
    expect(alert).toHaveTextContent('Enter a title.');
    expect(alert).toHaveTextContent('Enter a description.');
    expect(alert).toHaveTextContent('Choose a standard variable.');
    expect(alert).toHaveTextContent('Enter a start and an end date.');
    expect(sent).toHaveLength(0);
    expect(calls.some((c) => c.includes('package_create'))).toBe(false);
  });

  it('is private by default', async () => {
    renderPage();
    expect(screen.getByLabelText('Make public')).not.toBeChecked();
    expect(screen.getByText(/can only read public files/)).toBeInTheDocument();
  });

  it('puts the one standard variable on every file of a collection', async () => {
    await fill([csv('a.csv'), csv('b.csv'), csv('c.csv')]);
    await userEvent.click(screen.getByRole('button', { name: 'Upload' }));
    await screen.findByTestId('upload-success');
    expect(sent).toHaveLength(3);
    for (const s of sent) {
      expect(s.form.get('mint_standard_variables')).toBe('precipitation_flux');
      expect(s.form.get('format')).toBe('CSV');
    }
    const body = (calls as string[] & { body?: Record<string, unknown> }).body!;
    expect(body['private']).toBe(true);
    expect(body['title']).toBe('Rain 2020');
    expect(body['temporal_coverage_start']).toBe('2020-01-01');
    expect(body['temporal_coverage_end']).toBe('2020-12-31');
  });

  it('uploads a single file and shows the name, state and links', async () => {
    await fill([csv('only.csv')]);
    await userEvent.click(screen.getByRole('button', { name: 'Upload' }));
    await screen.findByTestId('upload-success');
    expect(sent).toHaveLength(1);
    expect(screen.getByText('dynamo-upload-x')).toBeInTheDocument();
    expect(screen.getByTestId('upload-state')).toHaveTextContent('Private');
    const href = screen.getByRole('link', { name: 'Use in a thread' }).getAttribute('href')!;
    expect(href.startsWith('/modeling/problem-statements/start?')).toBe(true);
    expect(new URLSearchParams(href.split('?')[1]).get('datasetId')).toBe('dynamo-upload-x');
    expect(screen.getByRole('link', { name: /dataset page/ })).toHaveAttribute(
      'href',
      '/datasets/browse/dynamo-upload-x',
    );
    expect(document.body.textContent).not.toContain('SECRET-USER-TOKEN');
  });

  it('reads the dataset back before it shows success', async () => {
    await fill([csv('only.csv')]);
    await userEvent.click(screen.getByRole('button', { name: 'Upload' }));
    await screen.findByTestId('upload-success');
    expect(order).toEqual(['package_create', 'resource_create', 'package_show']);
  });

  it('lists the flows and models that take the variable, with the format fit', async () => {
    renderPage();
    await userEvent.click(screen.getByText('pick variable'));
    const panel = screen.getByTestId('who-can-use');
    expect(panel).toHaveTextContent('Rain flow');
    expect(panel).toHaveTextContent('Rain model');
    await userEvent.upload(screen.getByLabelText('Choose files to upload'), [csv('x.csv')]);
    expect(screen.getByTestId('who-can-use')).toHaveTextContent(/Rain flow.*the format fits/);
    expect(screen.getByTestId('who-can-use')).toHaveTextContent(
      /Rain model.*the format does not fit/,
    );
  });

  describe('semantic recommendations', () => {
    const suggestions = {
      results: [
        {
          id: 'sv-2',
          label: 'rainfall_amount',
          description: 'Rain that fell in a day',
          score: 0.9,
        },
        { id: 'sv-1', label: 'precipitation_flux', description: 'Water falling', score: 0.8 },
      ],
    };

    it('suggests variables from the description and never picks one itself', async () => {
      semantic = (u) => (u.includes('/search?') ? json(suggestions) : json({ results: [] }));
      renderPage();
      await userEvent.type(screen.getByLabelText('Description'), 'Daily rain gauge readings');
      const panel = await screen.findByTestId('suggested-variables');
      expect(panel).toHaveTextContent('Suggested standard variables');
      expect(panel).toHaveTextContent('Rain that fell in a day');
      expect(
        calls.some((u) => u.includes('/search?') && u.includes('target=svo') && u.includes('rain')),
      ).toBe(true);
      expect(screen.getByTestId('picked')).toHaveTextContent('');
      // The picker's own list is ranked by the same suggestions.
      expect(screen.getByTestId('picker-ranking')).toHaveTextContent('sv-2,sv-1');
    });

    it('"Use this" sets the picker', async () => {
      semantic = (u) => (u.includes('/search?') ? json(suggestions) : json({ results: [] }));
      renderPage();
      await userEvent.type(screen.getByLabelText('Description'), 'Daily rain gauge readings');
      await userEvent.click(
        await screen.findByRole('button', { name: 'Use rainfall_amount as the standard variable' }),
      );
      expect(screen.getByTestId('picked')).toHaveTextContent('rainfall_amount');
      expect(screen.getByTestId('who-can-use')).toHaveTextContent('Wet flow');
    });

    it('lists close matches under the exact list, labelled not exact', async () => {
      semantic = (u) =>
        u.includes('/similar?')
          ? json({ target: 'svo', id: 'sv-1', results: [{ id: 'sv-2', label: 'rainfall_amount' }] })
          : json({ results: [] });
      renderPage();
      await userEvent.click(screen.getByText('pick variable'));
      const close = await screen.findByTestId('close-matches');
      expect(close).toHaveTextContent('Close matches (not an exact fit)');
      expect(close).toHaveTextContent(/Wet flow.*matched on rainfall_amount/);
      expect(close).not.toHaveTextContent('Rain flow');
      expect(screen.getByTestId('who-can-use')).toHaveTextContent('Rain flow');
    });

    it('"Use in a thread" opens guided setup with the dataset, exact models and close matches', async () => {
      semantic = (u) =>
        u.includes('/similar?')
          ? json({ target: 'svo', id: 'sv-1', results: [{ id: 'sv-2', label: 'rainfall_amount' }] })
          : json({ results: [] });
      await fill([csv('only.csv')]);
      await screen.findByTestId('close-matches');
      await userEvent.click(screen.getByRole('button', { name: 'Upload' }));
      await screen.findByTestId('upload-success');
      const href = screen.getByRole('link', { name: 'Use in a thread' }).getAttribute('href')!;
      expect(href.startsWith('/modeling/problem-statements/start?')).toBe(true);
      const params = new URLSearchParams(href.split('?')[1]);
      expect(params.get('datasetId')).toBe('dynamo-upload-x');
      expect(params.get('modelIds')?.split(',')).toEqual(['flow-1', 'model-1']);
      expect(params.get('closeModelIds')).toBe('flow-2');
      expect(params.get('variable')).toBe('precipitation_flux');
      expect(params.get('goal')).toBe('Rain 2020');
      expect(params.get('startDate')).toBe('2020-01-01');
      expect(params.get('endDate')).toBe('2020-12-31');
      expect(JSON.parse(params.get('modelNames')!)).toMatchObject({ 'flow-2': 'Wet flow' });
    });

    it('hides the suggestion sections quietly when the service is down', async () => {
      semantic = () => json({ error: 'down' }, 503);
      renderPage();
      await userEvent.type(screen.getByLabelText('Description'), 'Daily rain gauge readings');
      await userEvent.click(screen.getByText('pick variable'));
      await waitFor(() =>
        expect(screen.getByText(/Suggestions are unavailable/)).toBeInTheDocument(),
      );
      expect(screen.queryByTestId('suggested-variables')).toBeNull();
      expect(screen.queryByTestId('close-matches')).toBeNull();
      expect(screen.getByTestId('who-can-use')).toHaveTextContent('Rain flow');
      expect(screen.getByRole('button', { name: 'Upload' })).toBeEnabled();
    });
  });

  it('warns about mixed extensions', async () => {
    renderPage();
    await userEvent.upload(screen.getByLabelText('Choose files to upload'), [
      csv('a.csv'),
      csv('b.json'),
    ]);
    expect(screen.getByTestId('mixed-formats')).toBeInTheDocument();
  });

  it('shows a CKAN refusal plainly', async () => {
    createStatus = 403;
    await fill([csv('only.csv')]);
    await userEvent.click(screen.getByRole('button', { name: 'Upload' }));
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        /would not make the dataset \(HTTP 403\).*not allowed in this organization/,
      ),
    );
    expect(screen.queryByTestId('upload-success')).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain('SECRET-USER-TOKEN');
  });

  it('loads the license list once, defaults to CC-BY and makes a license required', async () => {
    renderPage();
    await screen.findByRole('option', { name: 'Open Data Commons Attribution License' });
    const select = screen.getByLabelText('License') as HTMLSelectElement;
    expect(select.value).toBe('cc-by');
    expect(licenseCalls).toBe(1);
    await userEvent.selectOptions(select, '');
    await userEvent.click(screen.getByRole('button', { name: 'Upload' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Choose a license.');
  });

  it('requires a description', async () => {
    await fill([csv('only.csv')]);
    await userEvent.clear(screen.getByLabelText('Description'));
    await userEvent.click(screen.getByRole('button', { name: 'Upload' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a description.');
    expect(sent).toHaveLength(0);
  });

  it('a box drawn on the map fills the coordinates, and typing moves the map box', async () => {
    renderPage();
    await userEvent.click(screen.getByText('draw on map'));
    expect(screen.getByLabelText('West')).toHaveValue('-98.5');
    expect(screen.getByLabelText('North')).toHaveValue('30.5');
    expect(JSON.parse(screen.getByTestId('map-value').textContent!)).toEqual({
      xmin: -98.5,
      ymin: 29.25,
      xmax: -97.5,
      ymax: 30.5,
    });
    fireEvent.change(screen.getByLabelText('East'), { target: { value: '-96' } });
    expect(JSON.parse(screen.getByTestId('map-value').textContent!).xmax).toBe(-96);
  });

  it('outlines a chosen region on the map', async () => {
    renderPage();
    await userEvent.selectOptions(screen.getByLabelText('Spatial coverage'), 'region');
    await userEvent.selectOptions(screen.getByLabelText('Region category'), 'c1');
    await userEvent.selectOptions(screen.getByLabelText('Region'), 'r1');
    expect(JSON.parse(screen.getByTestId('map-outline').textContent!)).toEqual({
      xmin: -98,
      ymin: 30,
      xmax: -97,
      ymax: 31,
    });
  });

  it('sends the new fields to package_create and resource_create', async () => {
    await fill([csv('a.csv'), csv('b.csv')]);
    await userEvent.click(screen.getByText('draw on map'));
    await userEvent.type(screen.getByLabelText('Tags'), 'rain,gauge{Enter}');
    await userEvent.type(screen.getByLabelText(/Source or citation link/), 'https://doi.org/x');
    await userEvent.type(screen.getByLabelText(/Version/), '2.1');
    await userEvent.type(screen.getByLabelText(/Contact email/), 'me@example.org');
    await userEvent.type(screen.getByLabelText(/About a\.csv/), 'Station A');
    await userEvent.click(screen.getByRole('button', { name: 'Upload' }));
    await screen.findByTestId('upload-success');
    const body = (calls as string[] & { body?: Record<string, unknown> }).body!;
    expect(body['license_id']).toBe('cc-by');
    expect(body['tag_string']).toBe('dynamo-upload,rain,gauge');
    expect(body['url']).toBe('https://doi.org/x');
    expect(body['version']).toBe('2.1');
    expect(body['author']).toBe('testuser');
    expect(body['maintainer_email']).toBe('me@example.org');
    expect(body['notes']).toBe('Daily rain, gauge data, gaps in 2020');
    expect(JSON.parse(String(body['spatial']))['type']).toBe('Polygon');
    expect(sent[0]!.form.get('description')).toBe('Station A');
    expect(sent[1]!.form.has('description')).toBe(false);
  });

  it('sends nothing for empty optional fields', async () => {
    await fill([csv('only.csv')]);
    await userEvent.clear(screen.getByLabelText('Author'));
    await userEvent.click(screen.getByRole('button', { name: 'Upload' }));
    await screen.findByTestId('upload-success');
    const body = (calls as string[] & { body?: Record<string, unknown> }).body!;
    for (const key of ['url', 'version', 'author', 'maintainer_email', 'spatial']) {
      expect(body).not.toHaveProperty(key);
    }
    expect(body['tag_string']).toBe('dynamo-upload');
    expect(sent[0]!.form.has('description')).toBe(false);
  });

  it('shows the chosen values in the summary card', async () => {
    await fill([csv('only.csv')]);
    await userEvent.type(screen.getByLabelText('Tags'), 'rain{Enter}');
    await userEvent.click(screen.getByLabelText('Make public'));
    const card = screen.getByTestId('upload-summary');
    expect(card).toHaveTextContent('Rain 2020');
    expect(card).toHaveTextContent('Org A');
    expect(card).toHaveTextContent('Public');
    expect(card).toHaveTextContent('Creative Commons Attribution');
    expect(card).toHaveTextContent('Daily rain, gauge data, gaps in 2020');
    expect(card).toHaveTextContent('2020-01-01 to 2020-12-31');
    expect(card).toHaveTextContent('only.csv (CSV; precipitation_flux)');
    expect(card).toHaveTextContent('rain');
  });

  it('does not show the thread-input format note after an upload', async () => {
    await fill([csv('only.csv')]);
    await userEvent.click(screen.getByRole('button', { name: 'Upload' }));
    await screen.findByTestId('upload-success');
    expect(document.body.textContent).not.toContain('does not declare a file format');
  });

  it('shows the chosen variable with its description and units, read-only', async () => {
    renderPage();
    await userEvent.click(screen.getByText('pick variable'));
    const details = screen.getByTestId('variable-details');
    expect(details).toHaveTextContent('precipitation_flux');
    expect(await screen.findByText('mm/day')).toBeInTheDocument();
  });
});
