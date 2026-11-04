/**
 * Tests for MintParameters — parameter sweep configuration step.
 */
import { describe, expect, it, vi } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { renderWithProviders } from '@/test/utils/render';
import { LIST_REGISTERED_BOUNDARY_REGIONS } from '@/graphql/queries/regions';
import { MintParameters } from '../MintParameters';
import { SpatialScopeMap } from '../SpatialScopeMap';
import type { ThreadExecutionData } from '@/graphql/generated/execution';
import type { ThreadAdapterPlan } from '@/lib/adapter-execution';

vi.mock('leaflet', () => ({
  default: {
    geoJSON: vi.fn(() => ({
      getBounds: () => ({ isValid: () => false }),
    })),
  },
  geoJSON: vi.fn(),
}));

vi.mock('react-leaflet', () => ({
  MapContainer: ({ children }: { children?: ReactNode }) => (
    <div data-testid="spatial-scope-map">{children}</div>
  ),
  TileLayer: () => <div data-testid="map-tiles" />,
  GeoJSON: () => <div data-testid="map-boundary" />,
  useMap: () => ({ fitBounds: vi.fn() }),
}));

vi.mock('leaflet/dist/leaflet.css', () => ({}));

// ─── Mock data ────────────────────────────────────────────────────────────────

const mockThreadDataNoModels: ThreadExecutionData = {
  id: 'thread-1',
  models: {},
  model_ensembles: {},
  execution_summary: {},
  data: {},
};

const mockThreadDataWithModel: ThreadExecutionData = {
  id: 'thread-1',
  models: {
    'model-1': {
      id: 'model-1',
      name: 'FloodModel',
      input_parameters: [
        {
          id: 'param-1',
          name: 'flood_depth',
          description: 'Depth threshold',
          type: 'float',
          min: '0',
          max: '100',
          default: '10',
        },
        {
          id: 'param-fixed',
          name: 'fixed_param',
          type: 'string',
          value: 'expert_value',
        },
      ],
      input_files: [],
      output_files: [],
    },
  },
  model_ensembles: {
    'model-1': {
      id: 'ensemble-1',
      bindings: {
        'param-1': ['10', '20'],
      },
    },
  },
  execution_summary: {
    'model-1': {
      total_runs: 2,
      submitted_runs: 0,
      failed_runs: 0,
      successful_runs: 0,
    },
  },
  data: {},
};

const mockThreadDataUnconfigured: ThreadExecutionData = {
  id: 'thread-1',
  models: {
    'model-1': {
      id: 'model-1',
      name: 'DroughtModel',
      input_parameters: [
        {
          id: 'param-a',
          name: 'threshold',
          type: 'int',
          min: '1',
          max: '50',
          default: '5',
        },
      ],
      input_files: [],
      output_files: [],
    },
  },
  model_ensembles: {
    'model-1': { id: 'ens-1', bindings: {} },
  },
  execution_summary: {
    'model-1': { total_runs: 0, submitted_runs: 0, failed_runs: 0, successful_runs: 0 },
  },
  data: {},
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('MintParameters', () => {
  it('loads the backend spatial layer catalog for the cartographic map', async () => {
    window.__MINT_CONFIG__ = {
      HASURA_ENDPOINT: 'http://hasura/graphql',
      AUTH_SERVER: '',
      AUTH_CLIENT_ID: '',
      AUTH_REALM: '',
      AUTH_PROVIDER: 'keycloak',
      SVO_ADAPTER_API: 'http://adapter',
    };
    const fetchMock = vi.fn().mockImplementation((input: string | URL) => {
      const requestUrl = String(input);
      return Promise.resolve({
        ok: true,
        json: async () =>
          requestUrl.endsWith('/spatial/layers')
            ? {
                layers: [
                  {
                    id: 'twdb_gma_boundaries',
                    label: 'TWDB Statewide GMA Boundaries',
                    uri: 'https://example.test/FeatureServer/4',
                    default_filter_field: 'GMAnum',
                    tags: ['twdb', 'gma', 'boundary'],
                  },
                ],
              }
            : {
                type: 'FeatureCollection',
                features: [
                  {
                    type: 'Feature',
                    properties: { GMAnum: '8', GMAName: 'Gulf Coast' },
                    geometry: {
                      type: 'Polygon',
                      coordinates: [
                        [
                          [-96, 28],
                          [-95, 28],
                          [-95, 29],
                          [-96, 29],
                          [-96, 28],
                        ],
                      ],
                    },
                  },
                  {
                    type: 'Feature',
                    properties: { GMAnum: '2', GMAName: 'Central High Plains' },
                    geometry: {
                      type: 'Polygon',
                      coordinates: [
                        [
                          [-102, 32],
                          [-101, 32],
                          [-101, 33],
                          [-102, 33],
                          [-102, 32],
                        ],
                      ],
                    },
                  },
                ],
              },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    renderWithProviders(<SpatialScopeMap geometries={[]} label="Texas" scopeId="texas" />, {
      apolloMocks: [
        {
          request: {
            query: LIST_REGISTERED_BOUNDARY_REGIONS,
            variables: { categoryIds: ['hydrology'] },
          },
          result: { data: { region: [] } },
        },
      ],
    });

    await waitFor(() =>
      expect(screen.getByLabelText('Spatial boundary layer')).toBeInTheDocument(),
    );
    expect(
      screen.getByRole('option', { name: 'TWDB Statewide GMA Boundaries' }),
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByRole('option', { name: '8 — Gulf Coast' })).toBeInTheDocument();
      expect(
        Array.from(
          screen.getByLabelText('Spatial boundary feature').querySelectorAll('option'),
        ).map((option) => option.textContent),
      ).toEqual(['All boundaries', '2 — Central High Plains', '8 — Gulf Coast']);
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://adapter/spatial/layers',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );

    vi.unstubAllGlobals();
    Reflect.deleteProperty(window, '__MINT_CONFIG__');
  });

  it('prefers registered MINT boundary geometries when available', async () => {
    window.__MINT_CONFIG__ = {
      HASURA_ENDPOINT: 'http://hasura/graphql',
      AUTH_SERVER: '',
      AUTH_CLIENT_ID: '',
      AUTH_REALM: '',
      AUTH_PROVIDER: 'keycloak',
      SVO_ADAPTER_API: 'http://adapter',
    };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          layers: [
            {
              id: 'twdb_gma_boundaries',
              label: 'TWDB Statewide GMA Boundaries',
              uri: 'https://example.test/FeatureServer/4',
              tags: ['twdb', 'gma', 'boundary'],
            },
          ],
        }),
      }),
    );

    renderWithProviders(<SpatialScopeMap />, {
      apolloMocks: [
        {
          request: {
            query: LIST_REGISTERED_BOUNDARY_REGIONS,
            variables: { categoryIds: ['hydrology'] },
          },
          result: {
            data: {
              region: [
                {
                  id: 'ethiopia__12',
                  name: 'GMA 12',
                  category_id: 'hydrology',
                  region_category: { id: 'hydrology', name: 'Hydrology' },
                  geometries: [
                    {
                      geometry: {
                        type: 'Polygon',
                        coordinates: [
                          [
                            [-98, 29],
                            [-97, 29],
                            [-97, 30],
                            [-98, 30],
                            [-98, 29],
                          ],
                        ],
                      },
                    },
                  ],
                },
                {
                  id: 'ethiopia__gams_12',
                  name: 'GMA 12',
                  category_id: 'ground_water_availability_models',
                  region_category: {
                    id: 'ground_water_availability_models',
                    name: 'Ground water Availability Models',
                  },
                  geometries: [
                    {
                      geometry: {
                        type: 'Polygon',
                        coordinates: [
                          [
                            [-98, 29],
                            [-97, 29],
                            [-97, 30],
                            [-98, 30],
                            [-98, 29],
                          ],
                        ],
                      },
                    },
                  ],
                },
              ],
            },
          },
        },
      ],
    });

    expect(
      await screen.findByRole('option', { name: 'MINT registered boundaries' }),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole('option', { name: 'Ground water Availability Models' }),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Spatial boundary layer'), {
      target: { value: 'mint_registered_ground_water_availability_models' },
    });
    expect(await screen.findByRole('option', { name: 'gams_12 — GMA 12' })).toBeInTheDocument();

    vi.unstubAllGlobals();
    Reflect.deleteProperty(window, '__MINT_CONFIG__');
  });

  it('renders placeholder when no models are selected', () => {
    renderWithProviders(
      <MintParameters
        threadData={mockThreadDataNoModels}
        canWrite
        canExecute
        onSave={vi.fn()}
        onContinue={vi.fn()}
      />,
    );
    expect(screen.getByText(/please select model/i)).toBeInTheDocument();
  });

  it('shows one credentials line, without the secret name, only for a config with a secret', () => {
    const withSecret: ThreadExecutionData = {
      ...mockThreadDataWithModel,
      models: {
        'model-1': {
          ...mockThreadDataWithModel.models['model-1']!,
          input_parameters: [
            ...mockThreadDataWithModel.models['model-1']!.input_parameters,
            { id: 'sec-1', name: 'earthdata', parameter_type: 'secret' },
          ],
        },
      },
    };
    const { unmount } = renderWithProviders(
      <MintParameters
        threadData={withSecret}
        canWrite
        canExecute
        onSave={vi.fn()}
        onContinue={vi.fn()}
      />,
    );
    expect(screen.getByTestId('secret-readiness-model-1')).toHaveTextContent(
      'Credentials provided by the model owner',
    );
    expect(screen.queryByText('earthdata')).not.toBeInTheDocument();
    unmount();

    renderWithProviders(
      <MintParameters
        threadData={mockThreadDataWithModel}
        canWrite
        canExecute
        onSave={vi.fn()}
        onContinue={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('secret-readiness-model-1')).not.toBeInTheDocument();
  });

  it('renders model name when models exist', () => {
    renderWithProviders(
      <MintParameters
        threadData={mockThreadDataWithModel}
        canWrite
        canExecute
        onSave={vi.fn()}
        onContinue={vi.fn()}
      />,
    );
    expect(screen.getByText('FloodModel')).toBeInTheDocument();
  });

  it('shows the fixed expert parameter table', () => {
    renderWithProviders(
      <MintParameters
        threadData={mockThreadDataWithModel}
        canWrite
        canExecute
        onSave={vi.fn()}
        onContinue={vi.fn()}
      />,
    );
    expect(screen.getByText(/expert modeler has selected/i)).toBeInTheDocument();
    expect(screen.getByText('fixed param')).toBeInTheDocument();
  });

  it('shows the Continue button when parameters are already configured', () => {
    renderWithProviders(
      <MintParameters
        threadData={mockThreadDataWithModel}
        canWrite
        canExecute
        onSave={vi.fn()}
        onContinue={vi.fn()}
      />,
    );
    expect(screen.getByTestId('parameters-continue-btn')).toBeInTheDocument();
  });

  it('calls onContinue when Continue is clicked', () => {
    const onContinue = vi.fn();
    renderWithProviders(
      <MintParameters
        threadData={mockThreadDataWithModel}
        canWrite
        canExecute
        onSave={vi.fn()}
        onContinue={onContinue}
      />,
    );
    fireEvent.click(screen.getByTestId('parameters-continue-btn'));
    expect(onContinue).toHaveBeenCalledOnce();
  });

  it('shows edit button and switches to edit mode when canWrite=true and params not done', () => {
    renderWithProviders(
      <MintParameters
        threadData={mockThreadDataUnconfigured}
        canWrite
        canExecute
        onSave={vi.fn()}
        onContinue={vi.fn()}
      />,
    );
    // In edit mode (isDone=false) — the save button should be present
    expect(screen.getByTestId('parameters-save-btn')).toBeInTheDocument();
  });

  it('renders adjustable parameter input field in edit mode', () => {
    renderWithProviders(
      <MintParameters
        threadData={mockThreadDataUnconfigured}
        canWrite
        canExecute
        onSave={vi.fn()}
        onContinue={vi.fn()}
      />,
    );
    expect(screen.getByTestId('param-input-param-a')).toBeInTheDocument();
  });

  it('renders "no adjustments possible" for model with only fixed params', () => {
    const dataOnlyFixed: ThreadExecutionData = {
      ...mockThreadDataWithModel,
      models: {
        'model-1': {
          id: 'model-1',
          name: 'StaticModel',
          input_parameters: [{ id: 'p1', name: 'fixed', type: 'string', value: 'fixed_val' }],
          input_files: [],
          output_files: [],
        },
      },
      model_ensembles: { 'model-1': { id: 'ens1', bindings: {} } },
    };
    renderWithProviders(
      <MintParameters
        threadData={dataOnlyFixed}
        canWrite
        canExecute
        onSave={vi.fn()}
        onContinue={vi.fn()}
      />,
    );
    expect(screen.getByText(/no adjustments possible/i)).toBeInTheDocument();
  });

  it('renders adapter-inferred parameters separately and saves their values with the plan', () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const adapterPlan: ThreadAdapterPlan = {
      thread_model_id: 'ensemble-1',
      model_io_id: 'input-1',
      source_resource_id: 'resource-1',
      executor: 'svo_adapter',
      adapter_plan_id: 'adapter-plan-1',
      status: 'transform_required',
      plan_json: {
        plan_id: 'svo_adapter-plan-1',
        executor: 'svo_adapter',
        version: 1,
        status: 'transform_required',
        parameters: [
          {
            name: 'springflow_layer',
            type: 'integer',
            required: true,
            minimum: 0,
            description: 'Layer containing springflow',
          },
          {
            name: 'allocation',
            type: 'string',
            required: false,
            default: 'PT2050-DataX',
            managed: true,
          },
        ],
        parameter_values: {},
      },
      parameter_values: {},
    };
    const data: ThreadExecutionData = {
      ...mockThreadDataWithModel,
      models: {
        ...mockThreadDataWithModel.models,
        'model-1': {
          ...mockThreadDataWithModel.models['model-1']!,
          input_files: [{ id: 'input-1', name: 'springflow', variables: ['springflow'] }],
        },
      },
      adapter_plans: { 'model-1': [adapterPlan] },
    };

    renderWithProviders(
      <MintParameters
        threadData={data}
        canWrite
        canExecute
        onSave={onSave}
        onContinue={vi.fn()}
        spatialScopeName="Texas"
      />,
    );

    expect(screen.getByText('SVO adapter parameters')).toBeInTheDocument();
    const input = screen.getByTestId('adapter-param-input-springflow_layer');
    expect(screen.queryByTestId('adapter-param-input-allocation')).not.toBeInTheDocument();
    fireEvent.change(input, { target: { value: '3' } });
    fireEvent.click(screen.getByTestId('parameters-save-btn'));

    expect(onSave).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.any(String), [
      expect.objectContaining({ parameter_values: { springflow_layer: 3 } }),
    ]);
  });
});
