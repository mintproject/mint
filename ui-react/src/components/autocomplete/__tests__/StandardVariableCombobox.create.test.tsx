import { MockedProvider } from '@apollo/client/testing';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { CREATE_STANDARD_VARIABLE } from '@/components/autocomplete/CreateStandardVariableForm';
import {
  StandardVariableCombobox,
  type StandardVariableOption,
} from '@/components/autocomplete/StandardVariableCombobox';
import { PrefetchReferenceDataDocument } from '@/graphql/generated/graphql';

vi.mock('@/lib/uri', () => ({ generateMintUri: () => 'sv-new-id' }));
vi.mock('@/hooks/useSemanticSearch', () => ({
  useSemanticSearch: () => ({ results: null, loading: false, error: null }),
}));

const mocks = [
  {
    request: { query: PrefetchReferenceDataDocument },
    maxUsageCount: Infinity,
    result: {
      data: {
        modelcatalog_standard_variable: [
          {
            __typename: 'modelcatalog_standard_variable',
            id: 'sv-draw',
            label: 'drawdown',
            description: null,
          },
        ],
        modelcatalog_unit: [],
      },
    },
  },
  {
    request: {
      query: CREATE_STANDARD_VARIABLE,
      variables: { id: 'sv-new-id', label: 'zzz_new', description: null },
    },
    result: {
      data: {
        insert_modelcatalog_standard_variable_one: {
          __typename: 'modelcatalog_standard_variable',
          id: 'sv-new-id',
          label: 'zzz_new',
          description: null,
        },
      },
    },
  },
];

function Harness({ onChange }: { onChange: (v: StandardVariableOption | null) => void }) {
  const [value, setValue] = React.useState<StandardVariableOption | null>(null);
  return (
    <StandardVariableCombobox
      value={value}
      requireLabel
      allowCreate
      onChange={(v) => {
        setValue(v);
        onChange(v);
      }}
    />
  );
}

describe('StandardVariableCombobox create', () => {
  it('offers create on an empty search and selects the new variable', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <MockedProvider mocks={mocks}>
        <Harness onChange={onChange} />
      </MockedProvider>,
    );

    await user.click(await screen.findByRole('combobox'));
    await user.type(screen.getByPlaceholderText(/search standard variables/i), 'zzz_new');
    await user.click(await screen.findByRole('button', { name: /create a standard variable/i }));

    const dialog = await screen.findByRole('dialog');
    // The search carries over, so the gate has already found nothing.
    expect(await within(dialog).findByText(/no standard variable matches/i)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: /create .*zzz_new/i }));
    await user.click(within(dialog).getByRole('button', { name: /create variable/i }));

    await waitFor(() =>
      expect(onChange).toHaveBeenCalledWith({
        id: 'sv-new-id',
        label: 'zzz_new',
        description: null,
      }),
    );
    expect(screen.getByRole('combobox')).toHaveTextContent(/zzz_new/i);
  });

  it('does not offer create unless asked to', async () => {
    const user = userEvent.setup();
    render(
      <MockedProvider mocks={mocks}>
        <StandardVariableCombobox value={null} onChange={() => {}} />
      </MockedProvider>,
    );
    await user.click(await screen.findByRole('combobox'));
    await user.type(screen.getByPlaceholderText(/search standard variables/i), 'zzz_new');
    expect(await screen.findByText(/no matching standard variables/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /create a standard variable/i })).toBeNull();
  });
});
