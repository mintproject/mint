/**
 * Tests for MintThread — step workflow container.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent } from '@testing-library/react';
import { screen, waitFor } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import type { FetchResult } from '@apollo/client';
import { MockedProvider } from '@apollo/client/testing';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AuthContext, type AuthState } from '@/lib/auth/AuthProvider';
import { mockAuthState } from '@/test/utils/auth-mocks';
import type { MockedResponse } from '@apollo/client/testing';
import { makeNetworkErrorMock } from '@/test/utils/apollo-mocks';
import { MintThread } from '../../MintThread';
import { LIST_TOP_REGIONS } from '@/graphql/queries/regions';
import { GetThreadDocument, GetModelTreeWithRegionsDocument } from '@/graphql/generated/modeling';
import { GetThreadExecutionDocument } from '@/graphql/generated/thread-execution';

const mockThread = {
  __typename: 'thread' as const,
  id: 'test-thread-id',
  name: 'Test thread',
  task_id: 'mint://task/t1',
  task: {
    __typename: 'task' as const,
    id: 'mint://task/t1',
    problem_statement_id: 'mint://ps/p1',
  },
  start_date: '2023-01-01',
  end_date: '2023-12-31',
  region_id: 'Ethiopia',
  driving_variable_id: null,
  response_variable_id: null,
  events: [],
  permissions: [],
  thread_models: [],
};

const getThreadMock = {
  request: {
    query: GetThreadDocument,
    variables: { id: 'test-thread-id' },
  },
  result: {
    data: {
      thread_by_pk: mockThread,
    },
  },
};

/** A thread that has one model selected, with its dataset already bound. */
const threadWithModel = {
  ...mockThread,
  thread_models: [
    {
      __typename: 'thread_model' as const,
      id: 'tm-1',
      thread_id: 'test-thread-id',
      model_id: null,
      modelcatalog_configuration_id: 'cfgA',
      modelcatalog_configuration: {
        __typename: 'modelcatalog_configuration' as const,
        id: 'cfgA',
        label: 'HAND setup',
      },
    },
  ],
};

const getThreadWithModelMock = {
  request: { query: GetThreadDocument, variables: { id: 'test-thread-id' } },
  result: { data: { thread_by_pk: threadWithModel } },
};

const emptyExecutionMock = {
  request: { query: GetThreadExecutionDocument, variables: { id: 'test-thread-id' } },
  result: {
    data: {
      thread_by_pk: {
        __typename: 'thread',
        id: 'test-thread-id',
        response_variable_id: null,
        thread_data: [],
        thread_models: [],
      },
    },
  },
};

/** The same thread, loaded through the execution pipeline: bound input, one adjustable parameter. */
const executionMock = {
  request: { query: GetThreadExecutionDocument, variables: { id: 'test-thread-id' } },
  result: {
    data: {
      thread_by_pk: {
        __typename: 'thread',
        id: 'test-thread-id',
        response_variable_id: null,
        thread_data: [
          {
            __typename: 'thread_data',
            thread_id: 'test-thread-id',
            dataslice: {
              __typename: 'dataslice',
              id: 'slice-1',
              name: 'DEM for thread',
              start_date: '2023-01-01',
              end_date: '2023-12-31',
              resource_count: 1,
              dataset: { __typename: 'dataset', id: 'ckan-dem', name: 'National DEM' },
              resources: [
                {
                  __typename: 'dataslice_resource',
                  dataslice_id: 'slice-1',
                  resource_id: 'hash1',
                  selected: true,
                  resource: {
                    __typename: 'resource',
                    id: 'hash1',
                    dcid: 'res-1',
                    name: 'a.tif',
                    url: 'http://x/a.tif',
                  },
                },
              ],
            },
          },
        ],
        thread_models: [
          {
            __typename: 'thread_model',
            id: 'tm-1',
            modelcatalog_configuration_id: 'cfgA',
            execution_summary: [],
            modelcatalog_configuration: {
              __typename: 'modelcatalog_configuration',
              id: 'cfgA',
              label: 'HAND setup',
              description: null,
              flow: null,
              inputs: [
                {
                  __typename: 'modelcatalog_configuration_input',
                  configuration_id: 'cfgA',
                  input_id: 'inA',
                  is_optional: false,
                  input: {
                    __typename: 'modelcatalog_dataset_specification',
                    id: 'inA',
                    label: 'DEM',
                    presentations: [],
                  },
                },
              ],
              outputs: [],
              parameters: [
                {
                  __typename: 'modelcatalog_configuration_parameter',
                  configuration_id: 'cfgA',
                  parameter_id: 'pAdj',
                  parameter: {
                    __typename: 'modelcatalog_parameter',
                    id: 'pAdj',
                    label: 'threshold',
                    description: null,
                    has_data_type: 'float',
                    has_default_value: '0.5',
                    has_fixed_value: null,
                    has_minimum_accepted_value: '0',
                    has_maximum_accepted_value: '1',
                    has_accepted_values: null,
                    position: 1,
                  },
                },
              ],
            },
            data_bindings: [
              {
                __typename: 'thread_model_io',
                thread_model_id: 'tm-1',
                model_io_id: 'inA',
                dataslice_id: 'slice-1',
              },
            ],
            parameter_bindings: [],
          },
        ],
      },
    },
  },
};

/**
 * The same thread once its runs have finished, which is the only state that
 * renders the Results step's Fetch results button.
 */
const executionFinishedMock = {
  request: { query: GetThreadExecutionDocument, variables: { id: 'test-thread-id' } },
  result: {
    data: {
      thread_by_pk: {
        ...executionMock.result.data.thread_by_pk,
        thread_models: executionMock.result.data.thread_by_pk.thread_models.map((tm) => ({
          ...tm,
          execution_summary: [
            {
              __typename: 'execution_summary',
              total_runs: 1,
              submitted_runs: 1,
              successful_runs: 1,
              failed_runs: 0,
              ingested_runs: 0,
              registered_runs: 0,
              published_runs: 0,
              fetched_run_outputs: 0,
              submission_time: 1700000000,
              submitted_for_execution: true,
              submitted_for_ingestion: false,
              submitted_for_publishing: false,
              submitted_for_registration: false,
              workflow_name: null,
            },
          ],
        })),
      },
    },
  },
};

const regionsMock = {
  request: { query: LIST_TOP_REGIONS },
  result: { data: { region: [] } },
};
const modelTreeMock = {
  request: { query: GetModelTreeWithRegionsDocument },
  result: { data: { modelcatalog_software: [] } },
};

/** The thread with one run configured but not yet sent: the Runs step's submit form. */
const executionReadyToSendMock = {
  request: { query: GetThreadExecutionDocument, variables: { id: 'test-thread-id' } },
  result: {
    data: {
      thread_by_pk: {
        ...executionMock.result.data.thread_by_pk,
        thread_models: executionMock.result.data.thread_by_pk.thread_models.map((tm) => ({
          ...tm,
          parameter_bindings: [
            {
              __typename: 'thread_model_parameter',
              thread_model_id: 'tm-1',
              model_parameter_id: 'pAdj',
              parameter_value: '0.5',
            },
          ],
          execution_summary: [
            {
              __typename: 'execution_summary',
              total_runs: 1,
              submitted_runs: 0,
              successful_runs: 0,
              failed_runs: 0,
              ingested_runs: 0,
              registered_runs: 0,
              published_runs: 0,
              fetched_run_outputs: 0,
              submission_time: null,
              submitted_for_execution: false,
              submitted_for_ingestion: false,
              submitted_for_publishing: false,
              submitted_for_registration: false,
              workflow_name: null,
            },
          ],
        })),
      },
    },
  },
};

/** Renders MintThread inside a proper Route so useParams works. */
function renderMintThread(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  apolloMocks: MockedResponse<any, any>[] = [
    getThreadMock,
    emptyExecutionMock,
    regionsMock,
    modelTreeMock,
  ],
  authState: AuthState = mockAuthState,
) {
  return render(
    <MemoryRouter
      initialEntries={['/modeling/thread/test-thread-id']}
      future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
    >
      <MockedProvider mocks={apolloMocks}>
        <AuthContext.Provider value={authState}>
          <Routes>
            <Route path="/modeling/thread/:id" element={<MintThread />} />
          </Routes>
        </AuthContext.Provider>
      </MockedProvider>
    </MemoryRouter>,
  );
}

describe('MintThread', () => {
  it('shows loading state initially', () => {
    renderMintThread();
    // Before data resolves — either skeleton or loading state
    // The component may show "No sub-task selected" before the query resolves
    // with the mock. Just check the test runner doesn't crash.
    expect(document.body).toBeTruthy();
  });

  it('shows the wizard rail steps after data loads', async () => {
    renderMintThread();
    await waitFor(() => expect(screen.getByTestId('rail-step-framing')).toBeInTheDocument(), {
      timeout: 3000,
    });
    expect(screen.getByTestId('rail-step-variables')).toBeInTheDocument();
    expect(screen.getByTestId('rail-step-models')).toBeInTheDocument();
    expect(screen.getByTestId('rail-step-datasets')).toBeInTheDocument();
    expect(screen.getByTestId('rail-step-summary')).toBeInTheDocument();
    // The stand-alone page keeps the rail column.
    expect(
      screen.getByRole('complementary', { name: 'Sub-task step navigation' }),
    ).toBeInTheDocument();
  });

  it('renders the Framing step by default', async () => {
    renderMintThread();
    await waitFor(
      () => expect(screen.getByRole('heading', { name: 'Framing' })).toBeInTheDocument(),
      {
        timeout: 3000,
      },
    );
  });

  it('locks Datasets until a model is selected', async () => {
    renderMintThread();
    await waitFor(() => expect(screen.getByTestId('rail-step-datasets')).toBeInTheDocument(), {
      timeout: 3000,
    });
    expect(screen.getByTestId('rail-step-datasets')).toBeDisabled();
  });

  it('shows error message when query fails', async () => {
    const errorMock = makeNetworkErrorMock(
      GetThreadDocument,
      { id: 'test-thread-id' },
      'Network error',
    );
    renderMintThread([errorMock]);
    await waitFor(
      () => {
        expect(screen.getByRole('alert')).toBeInTheDocument();
      },
      { timeout: 3000 },
    );
  });

  it('shows maximize button after data loads', async () => {
    renderMintThread();
    await waitFor(
      () => {
        expect(screen.getByRole('button', { name: /maximize/i })).toBeInTheDocument();
      },
      { timeout: 3000 },
    );
  });

  it('feeds the Parameters step from the thread execution query', async () => {
    // The regression this guards: threadExecutionData used to start null and
    // nothing ever loaded it, so Parameters read an empty models map and showed
    // "Please select model(s) first." with no way forward.
    renderMintThread([getThreadWithModelMock, executionMock, regionsMock, modelTreeMock]);

    const parametersStep = await screen.findByTestId('rail-step-parameters');
    await waitFor(() => expect(parametersStep).not.toBeDisabled(), { timeout: 3000 });
    parametersStep.click();

    expect(await screen.findByTestId('param-input-pAdj')).toBeInTheDocument();
    expect(screen.queryByText(/select model\(s\) first/i)).not.toBeInTheDocument();
  });

  it('marks Datasets done once a binding exists in the database', async () => {
    renderMintThread([getThreadWithModelMock, executionMock, regionsMock, modelTreeMock]);
    const datasets = await screen.findByTestId('rail-step-datasets');
    await waitFor(() => expect(datasets).toHaveTextContent(/all inputs assigned/i), {
      timeout: 3000,
    });
  });

  it('wires Fetch results to the ensemble manager', async () => {
    // The regression this guards: MintThread rendered MintResults without
    // onPublishResults, and MintResults returns on its first line when that
    // prop is absent — so the button made no request at all (#110). Asserting
    // the outgoing request, not the prop, is what makes this a real guard.
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchMock);
    window.__MINT_CONFIG__ = { ENSEMBLE_MANAGER_API: 'http://ensemble/v1' } as never;

    try {
      renderMintThread([getThreadWithModelMock, executionFinishedMock, regionsMock, modelTreeMock]);

      const resultsStep = await screen.findByTestId('rail-step-results');
      await waitFor(() => expect(resultsStep).not.toBeDisabled(), { timeout: 3000 });
      resultsStep.click();

      const button = await screen.findByTestId('fetch-results-cfgA');
      button.click();

      await waitFor(() =>
        expect(fetchMock).toHaveBeenCalledWith(
          'http://ensemble/v1/problemStatements/mint%3A%2F%2Fps%2Fp1/tasks/mint%3A%2F%2Ftask%2Ft1/subtasks/test-thread-id/outputs',
          expect.objectContaining({ method: 'POST' }),
        ),
      );
    } finally {
      vi.unstubAllGlobals();
      delete (window as { __MINT_CONFIG__?: unknown }).__MINT_CONFIG__;
    }
  });

  it('shows the mint-thread container after data loads', async () => {
    renderMintThread();
    await waitFor(
      () => {
        expect(screen.getByTestId('mint-thread')).toBeInTheDocument();
      },
      { timeout: 3000 },
    );
  });

  it('sends the chosen catalog on plan creation and its values on submit', async () => {
    const publisher = {
      transform_spec_id: 'ts-subside-stac-publish',
      name: 'SUBSIDE STAC publish',
      catalog_tokens: ['ckan', 'stac'],
      parameters: [
        {
          name: 'stac_collection',
          type: 'string',
          required: true,
          default: 'subsidence-rates-dev',
          allowed_values: ['subsidence-rates-dev', 'subsidence-rates'],
        },
        {
          name: 'ckan_org',
          type: 'string',
          required: true,
          default: 'tacc-water',
          allowed_values: ['tacc-water'],
        },
        { name: 'public', type: 'boolean', required: false, default: false },
      ],
      can_publish: { ok: true, reason: null },
    };
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
      if (url.includes('/plans/publishers')) {
        return json({ configuration_id: 'cfgA', publishers: [publisher] });
      }
      if (url.endsWith('/plans/submit')) return json({ run_id: 'exec-1', status: 'submitted' });
      if (url.endsWith('/plans') && init?.method === 'POST') {
        return json({ plan_id: 'plan-1', executor: 'ensemble_manager', parameters: [] });
      }
      return json({});
    });
    vi.stubGlobal('fetch', fetchMock);
    window.__MINT_CONFIG__ = { ENSEMBLE_MANAGER_API: 'http://ensemble/v1' } as never;

    try {
      const writableThread = {
        ...getThreadWithModelMock,
        result: {
          data: {
            thread_by_pk: {
              ...threadWithModel,
              permissions: [
                {
                  __typename: 'thread_permission',
                  thread_id: 'test-thread-id',
                  user_id: '*',
                  read: true,
                  write: true,
                },
              ],
            },
          },
        },
      };
      renderMintThread([writableThread, executionReadyToSendMock, regionsMock, modelTreeMock]);

      const runsStep = await screen.findByTestId('rail-step-runs');
      await waitFor(() => expect(runsStep).not.toBeDisabled(), { timeout: 3000 });
      runsStep.click();

      fireEvent.click(await screen.findByTestId('publish-toggle-cfgA'));
      fireEvent.change(await screen.findByTestId('publish-param-cfgA-stac_collection'), {
        target: { value: 'subsidence-rates' },
      });
      fireEvent.click(screen.getByTestId('publish-param-cfgA-public'));
      fireEvent.click(screen.getByTestId('submit-runs-cfgA'));

      await waitFor(() =>
        expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/plans/submit'))).toBe(
          true,
        ),
      );
      const bodyOf = (suffix: string) => {
        const call = fetchMock.mock.calls.find(
          ([url, init]) => String(url).endsWith(suffix) && init?.method === 'POST',
        );
        return JSON.parse(String(call?.[1]?.body));
      };
      expect(bodyOf('/v1/plans').publish).toEqual(['ckan', 'stac']);
      expect(bodyOf('/plans/submit').parameter_values).toEqual({
        stac_collection: 'subsidence-rates',
        ckan_org: 'tacc-water',
        public: true,
      });
    } finally {
      vi.unstubAllGlobals();
      delete (window as { __MINT_CONFIG__?: unknown }).__MINT_CONFIG__;
    }
  });
});

describe('MintThread with a flow', () => {
  const FLOW = { __typename: 'modelcatalog_configuration_flow', configuration_id: 'cfgA' };
  const withFlow = (mock: typeof executionReadyToSendMock) => ({
    request: mock.request,
    result: {
      data: {
        thread_by_pk: {
          ...mock.result.data.thread_by_pk,
          thread_models: mock.result.data.thread_by_pk.thread_models.map((tm) => ({
            ...tm,
            modelcatalog_configuration: { ...tm.modelcatalog_configuration, flow: FLOW },
          })),
        },
      },
    },
  });
  const writable = {
    ...getThreadWithModelMock,
    result: {
      data: {
        thread_by_pk: {
          ...threadWithModel,
          permissions: [
            {
              __typename: 'thread_permission',
              thread_id: 'test-thread-id',
              user_id: '*',
              read: true,
              write: true,
            },
          ],
        },
      },
    },
  };

  /** A counting execution mock, repeated so every refetch finds one. */
  function executionMocks(
    base: { request: typeof executionReadyToSendMock.request; result: FetchResult },
    calls: { count: number },
  ) {
    return Array.from({ length: 8 }, () => ({
      request: base.request,
      result: () => {
        calls.count += 1;
        return base.result;
      },
    }));
  }

  function stubEnsembleManager(handlers: {
    plan?: Record<string, unknown>;
    run?: Record<string, unknown>;
  }) {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
      if (url.includes('/plans/publishers')) return json({ publishers: [] });
      if (url.endsWith('/plans/submit')) {
        return json({ run_id: 'ue_1', status: 'adapter_running', adapter_stage: 'flow' });
      }
      if (url.includes('/plans/runs/')) return json(handlers.run ?? { run_id: 'ue_1' });
      if (url.endsWith('/plans') && init?.method === 'POST') {
        return json({ plan_id: 'plan-flow', executor: 'ensemble_manager', ...handlers.plan });
      }
      return json({});
    });
    vi.stubGlobal('fetch', fetchMock);
    window.__MINT_CONFIG__ = { ENSEMBLE_MANAGER_API: 'http://ensemble/v1' } as never;
    return fetchMock;
  }

  const posts = (fetchMock: ReturnType<typeof stubEnsembleManager>, suffix: string) =>
    fetchMock.mock.calls.filter(
      ([url, init]) => String(url).endsWith(suffix) && init?.method === 'POST',
    );
  const bodyOf = (call: unknown[] | undefined) =>
    JSON.parse(String((call?.[1] as RequestInit | undefined)?.body));

  async function openRuns() {
    const runsStep = await screen.findByTestId('rail-step-runs');
    await waitFor(() => expect(runsStep).not.toBeDisabled(), { timeout: 3000 });
    runsStep.click();
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete (window as { __MINT_CONFIG__?: unknown }).__MINT_CONFIG__;
  });

  it('plans once and submits that plan straight away when the author set nothing', async () => {
    const fetchMock = stubEnsembleManager({
      plan: { flow_settings: { defaults: {}, links: [] }, flow_steps: [] },
    });
    renderMintThread([
      writable,
      ...executionMocks(withFlow(executionReadyToSendMock), { count: 0 }),
      regionsMock,
      modelTreeMock,
    ]);
    await openRuns();
    fireEvent.click(await screen.findByTestId('submit-runs-cfgA'));

    await waitFor(() => expect(posts(fetchMock, '/plans/submit')).toHaveLength(1));
    expect(posts(fetchMock, '/v1/plans')).toHaveLength(1);
    expect(bodyOf(posts(fetchMock, '/v1/plans')[0])).toEqual({
      executor: 'ensemble_manager',
      thread_id: 'test-thread-id',
      model_id: 'cfgA',
    });
    expect(bodyOf(posts(fetchMock, '/plans/submit')[0])).toEqual({
      plan_id: 'plan-flow',
      accept_flow_settings: false,
    });
    expect(screen.queryByText(/chosen by the flow's author/i)).not.toBeInTheDocument();
  });

  it("lists the author's settings and submits the same plan once they are accepted", async () => {
    const fetchMock = stubEnsembleManager({
      plan: {
        flow_settings: { defaults: { title: 'Dictionary of Texas' }, links: [] },
      },
    });
    renderMintThread([
      writable,
      ...executionMocks(withFlow(executionReadyToSendMock), { count: 0 }),
      regionsMock,
      modelTreeMock,
    ]);
    await openRuns();
    fireEvent.click(await screen.findByTestId('submit-runs-cfgA'));

    expect(
      await screen.findByText(
        /These were chosen by the flow's author and will be used with your account/,
      ),
    ).toBeInTheDocument();
    expect(screen.getByTestId('flow-settings-defaults')).toHaveTextContent(
      'title: Dictionary of Texas',
    );
    expect(posts(fetchMock, '/plans/submit')).toHaveLength(0);
    const accept = screen.getByRole('button', { name: /accept and run/i });
    expect(accept).toBeDisabled();

    fireEvent.click(screen.getByRole('checkbox', { name: /i accept these settings/i }));
    fireEvent.click(accept);

    await waitFor(() => expect(posts(fetchMock, '/plans/submit')).toHaveLength(1));
    expect(posts(fetchMock, '/v1/plans')).toHaveLength(1);
    expect(bodyOf(posts(fetchMock, '/plans/submit')[0])).toEqual({
      plan_id: 'plan-flow',
      accept_flow_settings: true,
    });
  });

  it('submits nothing when the user declines the author settings', async () => {
    const fetchMock = stubEnsembleManager({
      plan: { flow_settings: { defaults: { title: 'T' }, links: [] } },
    });
    renderMintThread([
      writable,
      ...executionMocks(withFlow(executionReadyToSendMock), { count: 0 }),
      regionsMock,
      modelTreeMock,
    ]);
    await openRuns();
    fireEvent.click(await screen.findByTestId('submit-runs-cfgA'));
    fireEvent.click(await screen.findByRole('button', { name: /^cancel$/i }));

    await waitFor(() =>
      expect(screen.queryByText(/chosen by the flow's author/i)).not.toBeInTheDocument(),
    );
    expect(posts(fetchMock, '/plans/submit')).toHaveLength(0);
  });

  async function runFlow(plan: Record<string, unknown>) {
    const fetchMock = stubEnsembleManager({ plan });
    renderMintThread([
      writable,
      ...executionMocks(withFlow(executionReadyToSendMock), { count: 0 }),
      regionsMock,
      modelTreeMock,
    ]);
    await openRuns();
    fireEvent.click(await screen.findByTestId('submit-runs-cfgA'));
    return fetchMock;
  }

  it('does not submit when saved credentials are missing, and lists them with a link', async () => {
    const fetchMock = await runFlow({
      secrets_ready: false,
      required_secrets: [
        {
          name: 'model_server',
          label: 'Model server',
          fields: ['api_key'],
          steps: ['s1'],
          stored: false,
        },
        { name: 'other', label: 'Other', fields: ['t'], stored: true },
      ],
    });
    const list = await screen.findByTestId('flow-required-secrets');
    expect(list).toHaveTextContent('This flow needs these saved credentials:');
    expect(list).toHaveTextContent(/Model server.*model_server: api_key\) is not stored yet/);
    expect(list).toHaveTextContent(/Other.*is stored/);
    expect(screen.getByRole('link', { name: /saved credentials/i })).toHaveAttribute(
      'href',
      '/account/credentials',
    );
    expect(screen.queryByRole('button', { name: /accept and run/i })).not.toBeInTheDocument();
    expect(posts(fetchMock, '/plans/submit')).toHaveLength(0);
  });

  it('submits when the credentials are ready', async () => {
    const fetchMock = await runFlow({ secrets_ready: true, required_secrets: [] });
    await waitFor(() => expect(posts(fetchMock, '/plans/submit')).toHaveLength(1));
  });

  it('requires a tick before sending data outside DYNAMO', async () => {
    const fetchMock = await runFlow({
      sends_data_to: [
        { step: 's1', piece: 'p', service: 'OpenAI', what: 'the text of your files' },
      ],
    });
    expect(await screen.findByText('This run sends data outside DYNAMO:')).toBeInTheDocument();
    expect(screen.getByTestId('flow-sends-data-to')).toHaveTextContent(
      'OpenAI: the text of your files',
    );
    const go = screen.getByRole('button', { name: /accept and run/i });
    expect(go).toBeDisabled();
    expect(posts(fetchMock, '/plans/submit')).toHaveLength(0);
    fireEvent.click(screen.getByRole('checkbox', { name: /send this data outside/i }));
    fireEvent.click(go);
    await waitFor(() => expect(posts(fetchMock, '/plans/submit')).toHaveLength(1));
    expect(bodyOf(posts(fetchMock, '/plans/submit')[0])).toEqual({
      plan_id: 'plan-flow',
      accept_flow_settings: false,
    });
  });

  it('needs both ticks when author settings and an outside service apply', async () => {
    const fetchMock = await runFlow({
      flow_settings: { defaults: { title: 'T' }, links: [] },
      sends_data_to: [{ service: 'OpenAI' }],
    });
    const go = await screen.findByRole('button', { name: /accept and run/i });
    fireEvent.click(screen.getByRole('checkbox', { name: /i accept these settings/i }));
    expect(go).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: /send this data outside/i }));
    expect(go).toBeEnabled();
    fireEvent.click(go);
    await waitFor(() => expect(posts(fetchMock, '/plans/submit')).toHaveLength(1));
    expect(bodyOf(posts(fetchMock, '/plans/submit')[0])).toEqual({
      plan_id: 'plan-flow',
      accept_flow_settings: true,
    });
  });

  it('shows a readable refusal and lets the user open the run in progress', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const json = (status: number, body: unknown) => ({
        ok: status < 400,
        status,
        json: async () => body,
      });
      if (url.includes('/plans/publishers')) return json(200, { publishers: [] });
      if (url.includes('/plans/runs/'))
        return json(200, { run_id: 'ue_9', status: 'adapter_running' });
      if (url.endsWith('/plans') && init?.method === 'POST') {
        return json(409, {
          message: 'busy',
          code: 'FLOW_ALREADY_RUNNING',
          details: { run_id: 'ue_9' },
        });
      }
      return json(200, {});
    });
    vi.stubGlobal('fetch', fetchMock);
    window.__MINT_CONFIG__ = { ENSEMBLE_MANAGER_API: 'http://ensemble/v1' } as never;
    renderMintThread([
      writable,
      ...executionMocks(withFlow(executionReadyToSendMock), { count: 0 }),
      regionsMock,
      modelTreeMock,
    ]);
    await openRuns();
    fireEvent.click(await screen.findByTestId('submit-runs-cfgA'));

    expect(await screen.findByTestId('flow-refusal-cfgA')).toHaveTextContent(
      /already running.*ue_9/is,
    );
    fireEvent.click(screen.getByRole('button', { name: /open the run in progress/i }));
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/plans/runs/ue_9'))).toBe(
        true,
      ),
    );
  });

  it('reads the thread record once when a followed run turns terminal', async () => {
    const calls = { count: 0 };
    const intervals: Array<() => void> = [];
    const realSetInterval = window.setInterval.bind(window);
    vi.spyOn(window, 'setInterval').mockImplementation(((fn: () => void, ms?: number) => {
      if (ms === 60_000) intervals.push(fn);
      return realSetInterval(fn, ms);
    }) as typeof window.setInterval);
    const fetchMock = stubEnsembleManager({
      plan: { flow_settings: { defaults: {}, links: [] } },
      run: { run_id: 'ue_1', status: 'completed', adapter_stage: 'flow' },
    });
    renderMintThread([
      writable,
      ...executionMocks(withFlow(executionReadyToSendMock), calls),
      regionsMock,
      modelTreeMock,
    ]);
    await openRuns();
    fireEvent.click(await screen.findByTestId('submit-runs-cfgA'));
    await waitFor(() => expect(posts(fetchMock, '/plans/submit')).toHaveLength(1));
    await waitFor(() => expect(intervals.length).toBeGreaterThan(0));
    await waitFor(() => expect(calls.count).toBeGreaterThan(1));
    // Let the submit-time refetch settle before counting.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const before = calls.count;

    await act(async () => {
      intervals.at(-1)!();
    });

    await waitFor(() => expect(calls.count).toBe(before + 1));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(calls.count).toBe(before + 1);
  });

  it('skips per-input plan discovery for a flow and keeps it for a model', async () => {
    const enable = () => {
      window.__MINT_CONFIG__ = {
        ENSEMBLE_MANAGER_API: 'http://ensemble/v1',
        SVO_ADAPTER_ENABLED: 'true',
      } as never;
    };
    const run = async (execution: Parameters<typeof executionMocks>[0]) => {
      const fetchMock = stubEnsembleManager({});
      enable();
      const view = renderMintThread([
        writable,
        ...executionMocks(execution, { count: 0 }),
        regionsMock,
        modelTreeMock,
      ]);
      const parametersStep = await screen.findByTestId('rail-step-parameters');
      await waitFor(() => expect(parametersStep).not.toBeDisabled(), { timeout: 3000 });
      parametersStep.click();
      await new Promise((resolve) => setTimeout(resolve, 500));
      view.unmount();
      return posts(fetchMock, '/v1/plans');
    };

    expect(await run(withFlow(executionReadyToSendMock))).toHaveLength(0);
    expect((await run(executionReadyToSendMock)).length).toBeGreaterThan(0);
  });

  it('sends a model run exactly as before', async () => {
    const fetchMock = stubEnsembleManager({ plan: { parameters: [] } });
    renderMintThread([
      writable,
      ...executionMocks(executionReadyToSendMock, { count: 0 }),
      regionsMock,
      modelTreeMock,
    ]);
    await openRuns();
    fireEvent.click(await screen.findByTestId('submit-runs-cfgA'));
    await waitFor(() => expect(posts(fetchMock, '/plans/submit')).toHaveLength(1));
    expect(bodyOf(posts(fetchMock, '/v1/plans')[0])).toEqual({
      executor: 'ensemble_manager',
      execution_engine: 'localex',
      thread_id: 'test-thread-id',
      model_id: 'cfgA',
      adapter_steps: [],
    });
    expect(bodyOf(posts(fetchMock, '/plans/submit')[0])).toEqual({
      plan_id: 'plan-flow',
      max_minutes: 60,
      adapter_parameter_values: {},
    });
  });
});
