import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { CREATE_STANDARD_VARIABLE } from '@/components/autocomplete/CreateStandardVariableForm';
import {
  GetStandardVariablesWithUnitsDocument,
  PrefetchReferenceDataDocument,
} from '@/graphql/generated/graphql';
import { mockUnauthenticatedState } from '@/test/utils/auth-mocks';
import { renderWithProviders } from '@/test/utils/render';

import { VariablesHome } from '../VariablesHome';

vi.mock('@/lib/uri', () => ({ generateMintUri: () => 'sv-new-id' }));
vi.mock('@/hooks/useSemanticSearch', () => ({
  useSemanticSearch: () => ({ results: null, loading: false, error: null }),
}));

const existing = {
  __typename: 'modelcatalog_standard_variable',
  id: 'sv-1',
  label: 'land_surface__elevation',
  description: 'Elevation of land',
  variable_presentations: [],
};

const baseMocks = [
  {
    request: { query: GetStandardVariablesWithUnitsDocument },
    maxUsageCount: Infinity,
    result: { data: { modelcatalog_standard_variable: [existing] } },
  },
  {
    request: { query: PrefetchReferenceDataDocument },
    maxUsageCount: Infinity,
    result: {
      data: {
        modelcatalog_standard_variable: [{ ...existing }],
        modelcatalog_unit: [],
      },
    },
  },
];

const createMock = (error = false) => ({
  request: {
    query: CREATE_STANDARD_VARIABLE,
    variables: { id: 'sv-new-id', label: 'snow_albedo', description: null },
  },
  ...(error
    ? { error: new Error('permission denied for insert') }
    : {
        result: {
          data: {
            insert_modelcatalog_standard_variable_one: {
              __typename: 'modelcatalog_standard_variable',
              id: 'sv-new-id',
              label: 'snow_albedo',
              description: null,
            },
          },
        },
      }),
});

describe('VariablesHome', () => {
  it('links "SVO variable" to the Scientific Variables Ontology site', async () => {
    renderWithProviders(<VariablesHome />, { apolloMocks: baseMocks });
    const link = await screen.findByRole('link', { name: 'SVO variable' });
    expect(link).toHaveAttribute('href', 'https://scientificvariablesontology.org/svo/');
  });

  it('runs the search gate and the form, then shows the new variable', async () => {
    const user = userEvent.setup();
    renderWithProviders(<VariablesHome />, { apolloMocks: [...baseMocks, createMock()] });

    await user.click(await screen.findByRole('button', { name: /create a standard variable/i }));
    const dialog = await screen.findByRole('dialog');

    // The form is not offered until something has been searched.
    expect(within(dialog).getByRole('button', { name: /create/i })).toBeDisabled();
    await user.type(
      within(dialog).getByLabelText(/search for an existing standard variable/i),
      'snow_albedo',
    );
    expect(await within(dialog).findByText(/no standard variable matches/i)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: /create .*snow_albedo/i }));

    expect(within(dialog).getByLabelText(/name/i)).toHaveValue('snow_albedo');
    await user.click(within(dialog).getByRole('button', { name: /create variable/i }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByRole('status')).toHaveTextContent('snow_albedo');
    expect(screen.getAllByText('snow_albedo').length).toBeGreaterThan(0);
  });

  it('shows close matches before offering to create', async () => {
    const user = userEvent.setup();
    renderWithProviders(<VariablesHome />, { apolloMocks: baseMocks });
    await user.click(await screen.findByRole('button', { name: /create a standard variable/i }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText(/search for an existing/i), 'elevation');
    expect(await within(dialog).findByText(/did you mean/i)).toBeInTheDocument();
    expect(within(dialog).getByText('land_surface__elevation')).toBeInTheDocument();
  });

  it('shows the Hasura error plainly when the insert is refused', async () => {
    const user = userEvent.setup();
    renderWithProviders(<VariablesHome />, { apolloMocks: [...baseMocks, createMock(true)] });
    await user.click(await screen.findByRole('button', { name: /create a standard variable/i }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText(/search for an existing/i), 'snow_albedo');
    await user.click(await within(dialog).findByRole('button', { name: /create .*snow_albedo/i }));
    await user.click(within(dialog).getByRole('button', { name: /create variable/i }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'permission denied for insert',
    );
  });

  it('asks signed-out visitors to sign in', async () => {
    renderWithProviders(<VariablesHome />, {
      apolloMocks: baseMocks,
      authState: mockUnauthenticatedState,
    });
    expect(await screen.findByText('Sign in to add a standard variable')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /create a standard variable/i }),
    ).not.toBeInTheDocument();
  });
});
