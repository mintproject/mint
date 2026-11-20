/**
 * Rows with no label used to read as a bare catalog id: the option mapper gave
 * them the description "Catalog ID: <uuid>" and that was the only line shown.
 */
import { MockedProvider } from '@apollo/client/testing';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { StandardVariableCombobox } from '@/components/autocomplete/StandardVariableCombobox';
import { PrefetchReferenceDataDocument } from '@/graphql/generated/graphql';

const sv = (id: string, label: string | null, description: string | null = null) => ({
  __typename: 'modelcatalog_standard_variable',
  id,
  label,
  description,
});

const UUID = '06100430-298a-49d7-9834-590783d62379';

const mocks = [
  {
    request: { query: PrefetchReferenceDataDocument },
    result: {
      data: {
        modelcatalog_standard_variable: [sv(UUID, ''), sv('sv-draw', 'drawdown')],
        modelcatalog_unit: [],
      },
    },
  },
];

async function open(props: { requireLabel?: boolean } = {}) {
  render(
    <MockedProvider mocks={mocks}>
      <StandardVariableCombobox value={null} onChange={() => {}} {...props} />
    </MockedProvider>,
  );
  await userEvent.click(await screen.findByRole('combobox'));
}

describe('StandardVariableCombobox unlabeled rows', () => {
  it('shows a readable name, never the bare id', async () => {
    await open();
    expect(await screen.findByText('…83d62379 (no label)')).toBeInTheDocument();
    expect(screen.getByText('Drawdown')).toBeInTheDocument();
    expect(screen.queryByText(/Catalog ID/)).not.toBeInTheDocument();
    expect(screen.queryByText(UUID)).not.toBeInTheDocument();
  });

  it('leaves unlabeled rows out when the caller needs a label', async () => {
    await open({ requireLabel: true });
    expect(await screen.findByText('Drawdown')).toBeInTheDocument();
    expect(screen.queryByText(/no label/)).not.toBeInTheDocument();
  });
});
