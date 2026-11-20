/**
 * Every option leads with a readable title (the humanized label), shows its
 * description as smaller secondary text, and is listed once.
 */
import { MockedProvider } from '@apollo/client/testing';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { StandardVariableCombobox } from '@/components/autocomplete/StandardVariableCombobox';
import { IndicatorAdapterInferenceDocument } from '@/components/autocomplete/useScopedStandardVariables';
import {
  GetIndicatorVariableOptionsDocument,
  PrefetchReferenceDataDocument,
} from '@/graphql/generated/graphql';

const semantic = vi.hoisted(() => ({
  results: null as Array<{
    id: string;
    label?: string | null;
    description?: string | null;
  }> | null,
}));
vi.mock('@/hooks/useSemanticSearch', () => ({
  useSemanticSearch: (query: string) => ({
    results: query.trim() ? semantic.results : null,
    loading: false,
    error: null,
  }),
}));

const sv = (id: string, label: string | null, description: string | null = null) => ({
  __typename: 'modelcatalog_standard_variable',
  id,
  label,
  description,
});

const TERM_COUNT = 'https://w3id.org/okn/i/mint/document_lexicon_group__term_count';
const DESCRIPTION = "For each document and lexicon group, how often the group's terms occur.";

const catalogMock = {
  request: { query: PrefetchReferenceDataDocument },
  result: {
    data: {
      modelcatalog_standard_variable: [
        sv(TERM_COUNT, 'document_lexicon_group__term_count', DESCRIPTION),
      ],
      modelcatalog_unit: [],
    },
  },
};

async function open(mocks: unknown[]) {
  render(
    <MockedProvider mocks={mocks as never[]}>
      <StandardVariableCombobox value={null} onChange={() => {}} scope="all" />
    </MockedProvider>,
  );
  await userEvent.click(await screen.findByRole('combobox'));
}

describe('StandardVariableCombobox option titles and repeats', () => {
  beforeEach(() => {
    semantic.results = null;
  });

  it('leads with the humanized label and keeps the description as secondary text', async () => {
    await open([catalogMock]);
    const title = await screen.findByText('Document lexicon group — Term count');
    expect(title).toHaveClass('font-medium');
    const description = screen.getByText(DESCRIPTION);
    expect(description).toHaveClass('text-xs', 'line-clamp-1');
    expect(screen.getAllByRole('option')).toHaveLength(1);
  });

  it('gives a search hit with no label the catalog title, and lists each variable once', async () => {
    // The service answers with an empty label, then again under the same id.
    semantic.results = [
      { id: TERM_COUNT, label: '', description: DESCRIPTION },
      { id: TERM_COUNT, label: 'document_lexicon_group__term_count', description: null },
    ];
    await open([catalogMock]);
    await userEvent.type(screen.getByPlaceholderText(/search standard variables/i), 'term');
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(1));
    expect(screen.getByText('Document lexicon group — Term count')).toBeInTheDocument();
  });

  it('titles a search hit that has only an id from the id tail', async () => {
    semantic.results = [{ id: 'https://w3id.org/okn/i/mint/air__daily_max_of_temperature' }];
    await open([catalogMock]);
    await userEvent.type(screen.getByPlaceholderText(/search standard variables/i), 'air');
    expect(await screen.findByText('Air — Daily max of temperature')).toBeInTheDocument();
  });

  it('lists a variable once when the catalog and an adapter contract both name it', async () => {
    const ID = 'https://w3id.org/okn/i/mint/air__daily_max_of_temperature';
    const mocks = [
      {
        request: { query: GetIndicatorVariableOptionsDocument },
        result: {
          data: {
            modelcatalog_dataset_specification_presentation: [
              {
                __typename: 'modelcatalog_dataset_specification_presentation',
                dataset_specification_id: 'ds',
                presentation_id: 'p',
                presentation: {
                  __typename: 'modelcatalog_variable_presentation',
                  id: 'p',
                  standard_variable: sv(
                    'catalog-uuid-1',
                    'air__daily_max_of_temperature',
                    'Daily max',
                  ),
                },
              },
            ],
          },
        },
      },
      {
        request: { query: IndicatorAdapterInferenceDocument },
        result: {
          data: {
            adapterTransforms: [
              { contracts: [{ role: 'output', standard_variable_uri: ID, format: null }] },
            ],
          },
        },
      },
    ];
    render(
      <MockedProvider mocks={mocks as never[]}>
        <StandardVariableCombobox value={null} onChange={() => {}} scope="indicator" />
      </MockedProvider>,
    );
    await waitFor(() => expect(screen.getByRole('combobox')).toBeEnabled());
    await userEvent.click(screen.getByRole('combobox'));
    expect(await screen.findByText('Air — Daily max of temperature')).toBeInTheDocument();
    expect(screen.getAllByRole('option')).toHaveLength(1);
    expect(screen.getByText('Daily max')).toBeInTheDocument();
  });
});
