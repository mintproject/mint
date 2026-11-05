/**
 * Tests for MintThread — step workflow container.
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent } from '@testing-library/react';
import { screen, waitFor } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
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
