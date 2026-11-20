/**
 * Choosing an outcome ranks the rows that produce it first, flows included,
 * then the rows that can be transformed into it, and says why on each card.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockedResponse } from '@apollo/client/testing';
import userEvent from '@testing-library/user-event';
import { renderWithProviders, screen, waitFor } from '@/test/utils/render';
import { GetModelTreeWithRegionsDocument, type Thread } from '@/graphql/generated/modeling';
import { ModelOutcomeAdapterInferenceDocument, ModelsStep } from '../ModelsStep';

vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('@/hooks/useFlowAvailability', () => ({ useFlowAvailability: () => null }));

const semantic = vi.hoisted(() => ({
  results: null as Array<{ id: string }> | null,
}));
vi.mock('@/hooks/useSemanticSearch', () => ({
  useSemanticSearch: (query: string) => ({
    results: query.trim() ? semantic.results : null,
    loading: false,
    error: null,
  }),
}));

const REPORT = 'https://w3id.org/okn/i/mint/document_collection__sensemaking_report';
const RAW = 'https://w3id.org/okn/i/mint/document_collection__raw_text';

function config(id: string, label: string, outId: string, outLabel: string, isFlow = false) {
  return {
    id,
    label,
    ...(isFlow ? { flow: { __typename: 'x', configuration_id: id } } : {}),
    regions: [],
    inputs: [],
    outputs: [
      {
        configuration_id: id,
        output_id: `${id}-out`,
        output: {
          id: `${id}-out`,
          label: outLabel,
          has_format: null,
          presentations: [
            {
              dataset_specification_id: `${id}-out`,
              presentation_id: `${id}-vp`,
              presentation: { id: `${id}-vp`, standard_variable: { id: outId, label: outLabel } },
            },
          ],
        },
      },
    ],
    child_configurations: [],
  };
}

const treeMock: MockedResponse = {
  request: { query: GetModelTreeWithRegionsDocument },
  result: {
    data: {
      modelcatalog_software: [
        {
          id: 'sw',
          label: 'Sensemaking',
          versions: [
            {
              id: 'v',
              label: '1',
              configurations: [
                config('alpha', 'Alpha model', RAW, 'document_collection__raw_text'),
                config('mid', 'Mid model', REPORT, 'document_collection__sensemaking_report'),
                // Registered under another namespace: only the name matches.
                config(
                  'zeta',
                  'Zeta flow',
                  'https://example.org/vocab/document_collection__sensemaking_report',
                  'document_collection__sensemaking_report',
                  true,
                ),
              ],
            },
          ],
        },
      ],
    },
  },
};

const adapterMock: MockedResponse = {
  request: { query: ModelOutcomeAdapterInferenceDocument },
  result: {
    data: {
      adapterTransforms: [
        {
          id: 't1',
          name: 'raw-to-report',
          description: null,
          contracts: [
            { id: 'c1', role: 'input', standard_variable_uri: RAW, format: null, unit: null },
            { id: 'c2', role: 'output', standard_variable_uri: REPORT, format: null, unit: null },
          ],
        },
      ],
    },
  },
};

const thread = {
  __typename: 'thread',
  id: 't1',
  name: 'Report',
  task_id: 'task1',
  start_date: '2000-01-01',
  end_date: '2026-01-01',
  region_id: null,
  driving_variable_id: null,
  response_variable_id: REPORT,
  response_variable: { id: REPORT, label: 'document_collection__sensemaking_report' },
  events: [],
  permissions: [{ __typename: 'thread_permission', user_id: 'testuser', read: true, write: true }],
  thread_models: [],
} as unknown as Thread;

function renderStep() {
  return renderWithProviders(
    <ModelsStep thread={thread} onUpdated={vi.fn()} onContinue={vi.fn()} onBack={vi.fn()} />,
    { apolloMocks: [treeMock, adapterMock] },
  );
}

const cardNames = () =>
  screen
    .getAllByRole('checkbox')
    .map((box) => box.getAttribute('aria-label')?.replace(/^Select /, ''));

describe('ModelsStep outcome ranking', () => {
  beforeEach(() => {
    semantic.results = null;
  });

  it('puts the rows that produce the outcome first, flows included, then transforms', async () => {
    renderStep();
    await screen.findByText('Zeta flow');
    // Tree order is alphabetical (Alpha, Mid, Zeta); the producers lead.
    await waitFor(() => expect(cardNames()).toEqual(['Mid model', 'Zeta flow', 'Alpha model']));
  });

  it('says why each row is listed', async () => {
    renderStep();
    await screen.findByText('Zeta flow');
    await waitFor(() => expect(screen.getAllByTestId('outcome-reason')).toHaveLength(3));
    const reasons = screen.getAllByTestId('outcome-reason').map((el) => el.textContent);
    expect(reasons).toEqual([
      'Produces document_collection__sensemaking_report',
      'Produces document_collection__sensemaking_report',
      'Can be transformed into document_collection__sensemaking_report',
    ]);
  });

  it('keeps exact matches ahead of semantic-only hits, and keeps a row the index lacks', async () => {
    // The index ranks the transformed row first and does not carry the flow.
    semantic.results = [{ id: 'alpha' }, { id: 'mid' }];
    renderStep();
    await screen.findByText('Zeta flow');
    await userEvent.type(screen.getByPlaceholderText(/filter models/i), 'e');
    await waitFor(() => expect(cardNames()).toEqual(['Mid model', 'Zeta flow', 'Alpha model']));
  });
});
