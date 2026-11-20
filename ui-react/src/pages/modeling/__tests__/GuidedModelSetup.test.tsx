import userEvent from '@testing-library/user-event';
import { screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { LIST_TOP_REGIONS } from '@/graphql/queries/regions';
import { renderWithProviders } from '@/test/utils/render';
import { GuidedModelSetup } from '../GuidedModelSetup';

const { recommendProblemStatement, findDatasetsByVariables, fetchDatasetDetail } = vi.hoisted(
  () => ({
    recommendProblemStatement: vi.fn(),
    findDatasetsByVariables: vi.fn(),
    fetchDatasetDetail: vi.fn(),
  }),
);

vi.mock('@/lib/modeling/problemStatementRecommendations', () => ({
  recommendProblemStatement,
}));
vi.mock('@/lib/data-catalog', () => ({
  findDatasetsByVariables,
}));
vi.mock('@/lib/datasets/data-catalog-api', () => ({
  fetchDatasetDetail,
}));
vi.mock('@/graphql/generated/modeling', () => ({
  generateModelingId: vi.fn(() => 'ps-1'),
  useInsertProblemStatementMutation: vi.fn(() => [vi.fn()]),
  useInsertProblemStatementProvenanceMutation: vi.fn(() => [vi.fn()]),
  useInsertTaskMutation: vi.fn(() => [vi.fn()]),
  useInsertTaskProvenanceMutation: vi.fn(() => [vi.fn()]),
  useInsertThreadMutation: vi.fn(() => [vi.fn()]),
  useInsertThreadProvenanceMutation: vi.fn(() => [vi.fn()]),
  useListProblemStatementsQuery: vi.fn(() => ({ data: { problem_statement: [] }, loading: false })),
  useSetThreadModelsMutation: vi.fn(() => [vi.fn()]),
  useUpdateThreadMutation: vi.fn(() => [vi.fn()]),
}));
vi.mock('@/lib/modeling/provisionTask', () => ({
  provisionTask: vi.fn().mockResolvedValue({ taskId: 'task-1', threadId: 'thread-1' }),
}));

describe('GuidedModelSetup', () => {
  beforeEach(() => {
    recommendProblemStatement.mockResolvedValue({
      status: 'ok',
      results: {
        svo: [
          {
            id: 'sv-head',
            label: 'Groundwater hydraulic head',
            description: 'Water level',
            evidence: [{ source: 'model_configuration', label: 'MODFLOW', relation: 'input' }],
          },
        ],
        model_configuration: [
          {
            id: 'model-2',
            label: 'MODFLOW configuration',
            description: 'Groundwater model',
            standard_variables: [
              { id: 'sv-head', label: 'Groundwater hydraulic head', role: 'input' },
            ],
            evidence: [],
          },
        ],
      },
    });
    findDatasetsByVariables.mockResolvedValue([]);
    fetchDatasetDetail.mockResolvedValue(null);
  });

  it('asks framing questions before requesting recommendations', async () => {
    const user = userEvent.setup();
    renderWithProviders(<GuidedModelSetup />, {
      initialEntries: ['/modeling/problem-statements/start'],
      apolloMocks: [
        {
          request: { query: LIST_TOP_REGIONS },
          result: {
            data: {
              region: [{ id: 'texas', name: 'Texas', model_catalog_uri: null, geometries: [] }],
            },
          },
        },
      ],
    });

    expect(screen.getByRole('button', { name: 'Find recommendations' })).toBeDisabled();
    await user.type(
      screen.getByLabelText(/what are you trying/i),
      'Understand groundwater availability',
    );
    await user.click(screen.getByRole('combobox', { name: 'Region' }));
    await user.click(screen.getByRole('option', { name: 'Texas' }));

    await user.click(screen.getByRole('button', { name: 'Find recommendations' }));

    await waitFor(() => expect(recommendProblemStatement).toHaveBeenCalledTimes(1));
    expect(screen.getByText('Groundwater hydraulic head')).toBeInTheDocument();
    expect(screen.getByText('MODFLOW configuration')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /confirm and start setup/i })).toBeDisabled();
  });

  it('preserves and displays initiating model and dataset context', () => {
    renderWithProviders(<GuidedModelSetup />, {
      initialEntries: ['/modeling/problem-statements/start?modelId=model-1&datasetId=dataset-1'],
      apolloMocks: [
        {
          request: { query: LIST_TOP_REGIONS },
          result: { data: { region: [] } },
        },
      ],
    });

    expect(screen.getByRole('button', { name: /model: model-1/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /dataset: dataset-1/i })).toBeInTheDocument();
  });

  it('prefills framing dates and region from selected dataset metadata', async () => {
    fetchDatasetDetail.mockResolvedValue({
      id: 'dataset-1',
      name: 'Texas groundwater observations',
      region: '',
      variables: ['groundwater__hydraulic_head'],
      datatype: 'CSV',
      time_period: {
        start_date: new Date('2012-01-01T00:00:00Z'),
        end_date: new Date('2020-12-31T00:00:00Z'),
      },
      description: '',
      version: '',
      limitations: '',
      source: { name: '', url: '', type: '' },
      resources: [],
      spatial_coverage: {
        type: 'BoundingBox',
        value: { xmin: -106, xmax: -93, ymin: 25, ymax: 37 },
      },
    });

    renderWithProviders(<GuidedModelSetup initialDatasetId="dataset-1" />, {
      initialEntries: ['/modeling/problem-statements/start?datasetId=dataset-1'],
      apolloMocks: [
        {
          request: { query: LIST_TOP_REGIONS },
          result: {
            data: {
              region: [
                {
                  id: 'texas',
                  name: 'Texas',
                  model_catalog_uri: null,
                  geometries: [
                    {
                      geometry: {
                        type: 'Polygon',
                        coordinates: [
                          [
                            [-106, 25],
                            [-93, 25],
                            [-93, 37],
                            [-106, 37],
                            [-106, 25],
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

    await waitFor(() => {
      expect(screen.getByLabelText('Start date *')).toHaveValue('2012-01-01');
      expect(screen.getByLabelText('End date *')).toHaveValue('2020-12-31');
      expect(screen.getByRole('combobox', { name: 'Region' })).toHaveTextContent('Texas');
    });
    expect(screen.getByText(/prefilled from the selected dataset metadata/i)).toBeInTheDocument();
  });

  describe('opened from an upload', () => {
    const entry =
      '/modeling/problem-statements/start?datasetId=my-upload' +
      '&modelIds=flow-1,model-1&closeModelIds=flow-2&variable=precipitation_flux' +
      '&modelNames=' +
      encodeURIComponent(JSON.stringify({ 'flow-1': 'Rain flow', 'flow-2': 'Wet flow' })) +
      '&goal=Rain%202020&startDate=2020-01-01&endDate=2020-12-31';
    const regionsMock = {
      request: { query: LIST_TOP_REGIONS },
      result: { data: { region: [] } },
    };

    it('preselects the dataset and lists recommended models first, with the reason', () => {
      renderWithProviders(<GuidedModelSetup />, {
        initialEntries: [entry],
        apolloMocks: [regionsMock],
      });
      expect(screen.getByRole('button', { name: /dataset: my-upload ✓/i })).toBeInTheDocument();
      expect(fetchDatasetDetail).toHaveBeenCalledWith('my-upload');
      const section = screen.getByRole('region', { name: 'Models for your uploaded data' });
      const text = section.textContent ?? '';
      expect(text.indexOf('Recommended')).toBeLessThan(text.indexOf('Close matches'));
      expect(text.indexOf('Rain flow')).toBeLessThan(text.indexOf('Wet flow'));
      expect(text).toContain('Takes precipitation_flux, the variable of your uploaded data');
      expect(text).toContain('Close match, not an exact fit');
      expect(screen.getByRole('button', { name: /Rain flow/ })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      expect(screen.getByRole('button', { name: /Wet flow/ })).toHaveAttribute(
        'aria-pressed',
        'false',
      );
    });

    it('prefills the question and period, leaves them editable and confirms nothing', async () => {
      const user = userEvent.setup();
      renderWithProviders(<GuidedModelSetup />, {
        initialEntries: [entry],
        apolloMocks: [regionsMock],
      });
      const goal = screen.getByLabelText(/what are you trying/i);
      expect(goal).toHaveValue('Rain 2020');
      expect(screen.getByLabelText('Start date *')).toHaveValue('2020-01-01');
      expect(screen.getByLabelText('End date *')).toHaveValue('2020-12-31');
      await user.clear(goal);
      await user.type(goal, 'Something else');
      expect(goal).toHaveValue('Something else');
      expect(screen.queryByRole('button', { name: /confirm and start setup/i })).toBeNull();
    });

    it('lets a close match be added to the selection', async () => {
      const user = userEvent.setup();
      renderWithProviders(<GuidedModelSetup />, {
        initialEntries: [entry],
        apolloMocks: [regionsMock],
      });
      await user.click(screen.getByRole('button', { name: /Wet flow/ }));
      expect(screen.getByRole('button', { name: /Wet flow/ })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
    });
  });
});
