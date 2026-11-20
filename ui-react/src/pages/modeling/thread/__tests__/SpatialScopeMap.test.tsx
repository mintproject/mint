import { fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LIST_REGISTERED_BOUNDARY_REGIONS } from '@/graphql/queries/regions';
import { renderWithProviders } from '@/test/utils/render';
import { SpatialScopeMap } from '../SpatialScopeMap';

// jsdom has no SVG renderer for Leaflet vectors; the picker is what is under test.
vi.mock('react-leaflet', () => ({
  MapContainer: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  TileLayer: () => null,
  GeoJSON: () => null,
  useMap: () => ({ fitBounds: () => undefined }),
}));

const square = (x: number) => ({
  type: 'Polygon',
  coordinates: [
    [
      [x, 29],
      [x + 1, 29],
      [x + 1, 30],
      [x, 30],
      [x, 29],
    ],
  ],
});

const region = (id: string, name: string, categoryId: string, categoryName: string, x: number) => ({
  id: `mint__${id}`,
  name,
  category_id: categoryId,
  region_category: { id: categoryId, name: categoryName },
  geometries: [{ geometry: square(x) }],
});

const REGIONS = [
  region('0B4wIEBZthkf9gclJk1F', 'SEYMOUR_3', 'hydrology', 'Hydrology', -100),
  region('1ap0Inly6Lq3jYZgDDKy', 'TRINITY_53', 'hydrology', 'Hydrology', -99),
  region('2ap0Inly6Lq3jYZgDDKy', 'TRINITY_2', 'hydrology', 'Hydrology', -98),
  region('3wKEpR6sL8AtkDM8hXAo', 'Alwero', 'hydrology', 'Hydrology', -97),
];

function mount(props: Parameters<typeof SpatialScopeMap>[0] = {}) {
  return renderWithProviders(<SpatialScopeMap {...props} />, {
    apolloMocks: [
      {
        request: {
          query: LIST_REGISTERED_BOUNDARY_REGIONS,
          variables: { categoryIds: ['hydrology'] },
        },
        result: { data: { region: REGIONS } },
      },
    ],
  });
}

async function openPicker() {
  fireEvent.click(await screen.findByRole('combobox', { name: 'Spatial boundary feature' }));
}

describe('SpatialScopeMap boundary picker', () => {
  beforeEach(() => {
    window.__MINT_CONFIG__ = {
      HASURA_ENDPOINT: 'http://hasura/graphql',
      AUTH_SERVER: '',
      AUTH_CLIENT_ID: '',
      AUTH_REALM: '',
      AUTH_PROVIDER: 'keycloak',
      ENSEMBLE_MANAGER_API: 'http://em/v1',
    };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ layers: [] }) }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    Reflect.deleteProperty(window, '__MINT_CONFIG__');
  });

  it('shows region names sorted, with no ids, and one entry for a numbered family', async () => {
    mount();
    await openPicker();
    const labels = within(await screen.findByRole('listbox'))
      .getAllByRole('option')
      .map((option) => option.textContent);
    expect(labels).toEqual(['All boundaries', 'Alwero', 'Seymour 3', 'Trinity (2 parts)']);
    expect(document.body.textContent).not.toMatch(/0B4wIEBZthkf9gclJk1F|1ap0Inly6Lq3jYZgDDKy/);
  });

  it('groups the options under their category', async () => {
    mount();
    await openPicker();
    expect(await screen.findByText('Hydrology')).toBeInTheDocument();
  });

  it('selects the whole family, and lets the user expand to one part', async () => {
    const onFeatureSelect = vi.fn();
    mount({ onFeatureSelect });
    await openPicker();
    fireEvent.click(await screen.findByText('Trinity (2 parts)'));
    expect(onFeatureSelect).toHaveBeenCalledTimes(1);
    const whole = onFeatureSelect.mock.calls[0]?.[0];
    expect(whole.label).toBe('Trinity (2 parts)');
    expect(whole.filterField).toBe('region_id');
    expect(whole.filterValue.split(',').sort()).toEqual([
      '1ap0Inly6Lq3jYZgDDKy',
      '2ap0Inly6Lq3jYZgDDKy',
    ]);
    expect(whole.geometry.type).toBe('GeometryCollection');
    expect(whole.geometry.geometries).toHaveLength(2);

    await openPicker();
    fireEvent.click(screen.getByRole('button', { name: 'Expand Trinity (2 parts)' }));
    fireEvent.click(await screen.findByText('Trinity 53'));
    expect(onFeatureSelect).toHaveBeenCalledTimes(2);
    expect(onFeatureSelect.mock.calls[1]?.[0].filterValue).toBe('1ap0Inly6Lq3jYZgDDKy');
    expect(onFeatureSelect.mock.calls[1]?.[0].geometry.type).toBe('Polygon');
  });

  it('filters as the user types', async () => {
    mount();
    await openPicker();
    fireEvent.change(await screen.findByPlaceholderText('Search boundaries...'), {
      target: { value: 'sey' },
    });
    const labels = within(screen.getByRole('listbox'))
      .getAllByRole('option')
      .map((option) => option.textContent);
    expect(labels).toEqual(['Seymour 3']);
  });

  it('still shows a saved region by its readable name', async () => {
    mount({
      scopeId: 'a-region-hash-id',
      label: 'Texas Panhandle',
      geometries: [square(-101)],
    });
    const picker = await screen.findByRole('combobox', { name: 'Spatial boundary feature' });
    expect(picker).toHaveTextContent('Texas Panhandle');
    expect(document.body.textContent).not.toContain('a-region-hash-id');
  });

  it('shows a saved boundary selection by name', async () => {
    mount({
      filterField: 'region_id',
      filterValue: '3wKEpR6sL8AtkDM8hXAo',
      label: 'Alwero',
      scopeId: '3wKEpR6sL8AtkDM8hXAo',
    });
    const picker = await screen.findByRole('combobox', { name: 'Spatial boundary feature' });
    await vi.waitFor(() => expect(picker).toHaveTextContent('Alwero'));
  });
});
