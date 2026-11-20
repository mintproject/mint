/**
 * Tests for MintParameters — parameter sweep configuration step.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
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
      ENSEMBLE_MANAGER_API: 'http://em/v1',
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
    // The layers come from the Ensemble Manager; the browser does not call the adapter.
    expect(fetchMock).toHaveBeenCalledWith(
      'http://em/v1/spatial/layers',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(fetchMock.mock.calls.map(([url]) => String(url))).not.toContain(
      'http://adapter/spatial/layers',
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
      ENSEMBLE_MANAGER_API: 'http://em/v1',
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
  describe('a value with a comma', () => {
    const dataWith = (isFlow: boolean): ThreadExecutionData => ({
      ...mockThreadDataUnconfigured,
      models: {
        'model-1': {
          ...mockThreadDataUnconfigured.models['model-1']!,
          isFlow,
          input_parameters: [{ id: 'param-t', name: 'title', type: 'string' }],
        },
      },
    });
    const saveWith = async (isFlow: boolean) => {
      const onSave = vi.fn().mockResolvedValue(undefined);
      renderWithProviders(
        <MintParameters
          threadData={dataWith(isFlow)}
          canWrite
          canExecute
          onSave={onSave}
          onContinue={vi.fn()}
        />,
      );
      // A flow whose step was saved opens read-only, as a finished step does.
      const edit = screen.queryByTestId('edit-parameters-btn');
      if (edit) fireEvent.click(edit);
      fireEvent.change(screen.getByTestId('param-input-param-t'), {
        target: { value: 'Maps, Charts' },
      });
      fireEvent.click(screen.getByTestId('parameters-save-btn'));
      await waitFor(() => expect(onSave).toHaveBeenCalled());
      return onSave.mock.calls[0]![0] as Record<string, { bindings: Record<string, string[]> }>;
    };

    it('stays one value for a flow', async () => {
      const ensembles = await saveWith(true);
      expect(ensembles['model-1']!.bindings['param-t']).toEqual(['Maps, Charts']);
    });

    it('still splits into a sweep for a model', async () => {
      const ensembles = await saveWith(false);
      expect(ensembles['model-1']!.bindings['param-t']).toEqual(['Maps', 'Charts']);
    });
  });
});

describe('the settings of a flow', () => {
  const MODE = {
    name: 'match_mode',
    parameter_id: 'p-mode',
    visibility: 'shown',
    title: 'How terms are counted',
    description: 'The counting rule.',
    type: 'string',
    default: 'auto',
    choices: [
      { value: 'auto', title: 'Automatic', description: 'Words and phrases.' },
      { value: 'longest', title: 'Longest match', description: 'No double counting.' },
    ],
  };
  const FILES = {
    name: 'max_files',
    title: 'Most files',
    parameter_id: 'p-files',
    visibility: 'advanced',
    type: 'integer',
    minimum: 1,
    maximum: 500,
    default: 200,
  };
  const SECRET = {
    name: 'internal',
    parameter_id: 'p-internal',
    visibility: 'hidden',
    default: 'x',
  };
  const PINNED = {
    name: 'grounding',
    parameter_id: 'p-pinned',
    visibility: 'shown',
    fixed: true,
    default: 'keyword',
  };
  const row = (id: string, name: string, extra = {}) => ({ id, name, type: 'string', ...extra });

  const flowData = (bindings: Record<string, string[]> = {}): ThreadExecutionData => ({
    ...mockThreadDataUnconfigured,
    models: {
      'model-1': {
        ...mockThreadDataUnconfigured.models['model-1']!,
        isFlow: true,
        input_parameters: [
          row('p-mode', 'match_mode', { default: 'auto' }),
          row('p-files', 'max_files', { type: 'integer', default: '200' }),
          row('p-internal', 'internal', { default: 'x' }),
          row('p-pinned', 'grounding', { default: 'keyword' }),
          row('p-plain', 'title'),
        ],
      },
    },
    model_ensembles: { 'model-1': { id: 'ens-1', bindings } },
  });

  const open = async (
    data = flowData(),
    settings: unknown[] = [MODE, FILES, SECRET, PINNED],
    ready = 'How terms are counted',
  ) => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ settings, thread_bound: [] }) }),
    );
    const onSave = vi.fn().mockResolvedValue(undefined);
    renderWithProviders(
      <MintParameters threadData={data} canWrite canExecute onSave={onSave} onContinue={vi.fn()} />,
    );
    // A flow whose step was saved opens read-only, as a finished step does.
    fireEvent.click(await screen.findByTestId('edit-parameters-btn'));
    // The form shows first; the settings answer follows and gives the titles.
    await screen.findByText(ready);
    return onSave;
  };
  const saved = async (onSave: ReturnType<typeof vi.fn>) => {
    fireEvent.click(screen.getByTestId('parameters-save-btn'));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    return (onSave.mock.calls[0]![0] as Record<string, { bindings: Record<string, string[]> }>)[
      'model-1'
    ]!.bindings;
  };

  afterEach(() => vi.unstubAllGlobals());

  it('shows the title, the explanation and a dropdown filled with the default', async () => {
    await open();
    expect(screen.getByText('The counting rule.')).toBeInTheDocument();
    const select = screen.getByTestId('param-input-p-mode') as HTMLSelectElement;
    expect(select.tagName).toBe('SELECT');
    expect(select.value).toBe('auto');
    expect(screen.getByTestId('param-input-p-mode-explanation')).toHaveTextContent(
      'Words and phrases.',
    );
    fireEvent.change(select, { target: { value: 'longest' } });
    expect(screen.getByTestId('param-input-p-mode-explanation')).toHaveTextContent(
      'No double counting.',
    );
  });

  it('keeps advanced settings in a collapsed section, with a number box and its bounds', async () => {
    await open();
    const advanced = screen.getByTestId('advanced-settings-model-1') as HTMLDetailsElement;
    expect(advanced.open).toBe(false);
    expect(advanced).toHaveTextContent('Advanced settings');
    expect(advanced).toContainElement(screen.getByTestId('param-input-p-files'));
    expect(screen.getByTestId('param-input-p-files')).toHaveAttribute('type', 'number');
    expect(screen.getByTestId('param-input-p-files')).toHaveAttribute('max', '500');
    expect(screen.getByTestId('param-input-p-mode').closest('details')).toBeNull();
  });

  it('does not show a hidden setting, and lists a fixed one read-only', async () => {
    await open();
    expect(screen.queryByTestId('param-input-p-internal')).not.toBeInTheDocument();
    expect(screen.queryByText('internal')).not.toBeInTheDocument();
    expect(screen.queryByTestId('param-input-p-pinned')).not.toBeInTheDocument();
    expect(screen.getByText(/expert modeler has selected/i)).toBeInTheDocument();
    expect(screen.getByText('grounding')).toBeInTheDocument();
    expect(screen.getByText('keyword')).toBeInTheDocument();
  });

  it('binds only what the runner changed from the default, and a plain setting as typed', async () => {
    const onSave = await open();
    fireEvent.change(screen.getByTestId('param-input-p-mode'), { target: { value: 'longest' } });
    fireEvent.change(screen.getByTestId('param-input-p-plain'), { target: { value: 'A, B' } });
    const bindings = await saved(onSave);
    expect(bindings['p-mode']).toEqual(['longest']);
    expect(bindings['p-plain']).toEqual(['A, B']);
    // Left at the default: not a value the runner sent, so the flow's default is still
    // listed for acceptance when the run starts.
    expect(bindings['p-files']).toEqual([]);
  });

  it('drops a value bound earlier for a setting that is now hidden or fixed', async () => {
    const onSave = await open(
      flowData({ 'p-internal': ['y'], 'p-pinned': ['z'], 'p-mode': ['auto'] }),
    );
    const bindings = await saved(onSave);
    expect(bindings['p-internal']).toBeUndefined();
    expect(bindings['p-pinned']).toBeUndefined();
  });

  it('refuses a number outside the limits the piece gave', async () => {
    const data = flowData();
    data.models['model-1']!.input_parameters = [
      row('p-files', 'max_files', { type: 'integer', min: '1', max: '500', default: '200' }),
    ];
    const onSave = await open(data, [FILES], 'Most files');
    fireEvent.change(screen.getByTestId('param-input-p-files'), { target: { value: '900' } });
    fireEvent.click(screen.getByTestId('parameters-save-btn'));
    expect(await screen.findByTestId('param-error-p-files')).toHaveTextContent('Max is 500');
    expect(onSave).not.toHaveBeenCalled();
  });

  it('still lists a fixed setting read-only from its row when the settings cannot be read', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) }));
    const data = flowData();
    data.models['model-1']!.input_parameters = [
      row('p-pinned', 'grounding', { default: 'keyword', value: 'keyword' }),
      row('p-plain', 'title'),
    ];
    renderWithProviders(
      <MintParameters
        threadData={data}
        canWrite
        canExecute
        onSave={vi.fn()}
        onContinue={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId('edit-parameters-btn'));
    expect(screen.getByText(/expert modeler has selected/i)).toBeInTheDocument();
    expect(screen.getByText('keyword')).toBeInTheDocument();
    expect(screen.queryByTestId('param-input-p-pinned')).not.toBeInTheDocument();
    expect(screen.getByTestId('param-input-p-plain')).toBeInTheDocument();
  });

  it('still shows a dropdown from the flows parameter rows when the settings cannot be read', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) }));
    const data = flowData();
    data.models['model-1']!.input_parameters = [
      row('p-mode', 'match_mode', { default: 'auto', accepted_values: ['auto', 'longest'] }),
    ];
    renderWithProviders(
      <MintParameters
        threadData={data}
        canWrite
        canExecute
        onSave={vi.fn()}
        onContinue={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId('edit-parameters-btn'));
    const select = screen.getByTestId('param-input-p-mode') as HTMLSelectElement;
    expect(select.tagName).toBe('SELECT');
    expect(select.value).toBe('auto');
    expect(screen.getByText('match mode')).toBeInTheDocument();
  });
});

describe('a model parameter with accepted values', () => {
  const dataWith = (bindings: Record<string, string[]> = {}): ThreadExecutionData => ({
    ...mockThreadDataUnconfigured,
    models: {
      'model-1': {
        ...mockThreadDataUnconfigured.models['model-1']!,
        input_parameters: [
          {
            id: 'param-s',
            name: 'scheme',
            type: 'string',
            accepted_values: ['upstream', 'central', 'tvd'],
            default: 'central',
          },
          { id: 'param-t', name: 'timestep', type: 'int' },
        ],
      },
    },
    model_ensembles: { 'model-1': { id: 'ens-1', bindings } },
  });
  const render_ = (bindings?: Record<string, string[]>) => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    renderWithProviders(
      <MintParameters
        threadData={dataWith(bindings)}
        canWrite
        canExecute
        onSave={onSave}
        onContinue={vi.fn()}
      />,
    );
    return onSave;
  };

  it('is a multi-select with the default selected, and plain parameters stay text boxes', () => {
    render_();
    const select = screen.getByTestId('param-input-param-s') as HTMLSelectElement;
    expect(select.multiple).toBe(true);
    expect(Array.from(select.selectedOptions).map((o) => o.value)).toEqual(['central']);
    expect((screen.getByTestId('param-input-param-t') as HTMLInputElement).type).toBe('text');
  });

  it('makes several selected values several runs', async () => {
    const onSave = render_();
    const select = screen.getByTestId('param-input-param-s') as HTMLSelectElement;
    for (const option of Array.from(select.options)) {
      option.selected = option.value !== 'central';
    }
    fireEvent.click(screen.getByTestId('parameters-save-btn'));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    const bindings = (
      onSave.mock.calls[0]![0] as Record<string, { bindings: Record<string, string[]> }>
    )['model-1']!.bindings;
    expect(bindings['param-s']).toEqual(['upstream', 'tvd']);
    const summary = onSave.mock.calls[0]![1] as Record<string, { total_runs: number }>;
    expect(summary['model-1']!.total_runs).toBe(2);
  });

  it('preselects the values already chosen instead of the default', () => {
    render_({ 'param-s': ['tvd', 'upstream'] });
    const select = screen.getByTestId('param-input-param-s') as HTMLSelectElement;
    expect(Array.from(select.selectedOptions).map((o) => o.value)).toEqual(['upstream', 'tvd']);
  });

  it('keeps a bound value the list does not hold, flagged, and says so on save', async () => {
    // An old model saved comma separated values: one of them is not an accepted value.
    const onSave = render_({ 'param-s': ['central', 'upwind'] });
    const select = screen.getByTestId('param-input-param-s') as HTMLSelectElement;
    expect(
      screen.getByRole('option', { name: 'upwind (not an accepted value)' }),
    ).toBeInTheDocument();
    expect(Array.from(select.selectedOptions).map((o) => o.value)).toEqual(['central', 'upwind']);
    fireEvent.click(screen.getByTestId('parameters-save-btn'));
    expect(await screen.findByTestId('param-error-param-s')).toHaveTextContent('Accepted values');
    expect(onSave).not.toHaveBeenCalled();
  });
});
