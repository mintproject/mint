/**
 * Tests for StandardVariableCombobox and UnitCombobox components.
 *
 * These tests verify:
 * - Renders placeholder when no value is selected (after data loads)
 * - Shows selected label when a value is provided
 * - Opens the dropdown and lists options from Apollo mock
 * - Calls onChange when an option is selected
 * - Calls onChange(null) when already-selected item is clicked (deselect)
 * - Shows "No matching" text when filter yields no results
 */

import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { StandardVariableCombobox } from '@/components/autocomplete/StandardVariableCombobox';
import { UnitCombobox } from '@/components/autocomplete/UnitCombobox';
import { PrefetchReferenceDataDocument } from '@/graphql/generated/graphql';
import { renderWithProviders } from '../test/utils/render';

// ─── Mock data ──────────────────────────────────────────────────────────────

const mockStandardVariables = [
  {
    __typename: 'modelcatalog_standard_variable' as const,
    id: 'https://w3id.org/okn/i/mint/sv1',
    label: 'Precipitation',
    description: 'Amount of precipitation',
  },
  {
    __typename: 'modelcatalog_standard_variable' as const,
    id: 'https://w3id.org/okn/i/mint/sv2',
    label: 'Temperature',
    description: null,
  },
  {
    __typename: 'modelcatalog_standard_variable' as const,
    id: 'https://w3id.org/okn/i/mint/sv3',
    label: 'Evapotranspiration',
    description: 'Water lost to atmosphere',
  },
];

const mockUnits = [
  {
    __typename: 'modelcatalog_unit' as const,
    id: 'https://w3id.org/okn/i/mint/u1',
    label: 'mm/day',
  },
  {
    __typename: 'modelcatalog_unit' as const,
    id: 'https://w3id.org/okn/i/mint/u2',
    label: 'Celsius',
  },
];

const prefetchMock = {
  request: {
    query: PrefetchReferenceDataDocument,
    variables: {},
  },
  result: {
    data: {
      __typename: 'query_root',
      modelcatalog_standard_variable: mockStandardVariables,
      modelcatalog_unit: mockUnits,
    },
  },
};

// ─── StandardVariableCombobox ──────────────────────────────────────────────

describe('StandardVariableCombobox', () => {
  afterEach(() => {
    Reflect.deleteProperty(window, '__MINT_CONFIG__');
    vi.restoreAllMocks();
  });

  it('shows placeholder after data loads when no value is selected', async () => {
    renderWithProviders(<StandardVariableCombobox value={null} onChange={vi.fn()} />, {
      apolloMocks: [prefetchMock],
    });
    // After Apollo resolves the mock, loading ends and placeholder appears
    await waitFor(() => {
      expect(screen.getByText('Search standard variables...')).toBeInTheDocument();
    });
    expect(screen.getByRole('combobox')).not.toBeDisabled();
  });

  it('shows the humanized title when a value is provided', async () => {
    const selected = {
      id: 'https://w3id.org/okn/i/mint/sv1',
      label: 'Precipitation',
      description: 'Amount of precipitation',
    };
    renderWithProviders(<StandardVariableCombobox value={selected} onChange={vi.fn()} />, {
      apolloMocks: [prefetchMock],
    });
    // Wait for loading to complete
    await waitFor(() => {
      expect(screen.getByRole('combobox')).toHaveTextContent('Precipitation');
    });
  });

  it('opens popover and shows options when trigger is clicked', async () => {
    const user = userEvent.setup();
    renderWithProviders(<StandardVariableCombobox value={null} onChange={vi.fn()} />, {
      apolloMocks: [prefetchMock],
    });

    // Wait for data to load
    await waitFor(() => expect(screen.getByRole('combobox')).not.toBeDisabled());

    const trigger = screen.getByRole('combobox');
    await user.click(trigger);

    await waitFor(() => {
      expect(screen.getByText('Precipitation')).toBeInTheDocument();
      expect(screen.getByText('Temperature')).toBeInTheDocument();
      expect(screen.getByText('Evapotranspiration')).toBeInTheDocument();
    });
  });

  it('shows description text for standard variables that have one', async () => {
    const user = userEvent.setup();
    renderWithProviders(<StandardVariableCombobox value={null} onChange={vi.fn()} />, {
      apolloMocks: [prefetchMock],
    });

    await waitFor(() => expect(screen.getByRole('combobox')).not.toBeDisabled());
    await user.click(screen.getByRole('combobox'));

    await waitFor(() => {
      expect(screen.getByText('Amount of precipitation')).toBeInTheDocument();
    });
  });

  it('calls onChange with the selected item when an option is clicked', async () => {
    const user = userEvent.setup();
    const handleChange = vi.fn();

    renderWithProviders(<StandardVariableCombobox value={null} onChange={handleChange} />, {
      apolloMocks: [prefetchMock],
    });

    await waitFor(() => expect(screen.getByRole('combobox')).not.toBeDisabled());
    await user.click(screen.getByRole('combobox'));

    await waitFor(() => screen.getByText('Precipitation'));
    await user.click(screen.getByText('Precipitation'));

    expect(handleChange).toHaveBeenCalledWith({
      id: 'https://w3id.org/okn/i/mint/sv1',
      label: 'Precipitation',
      description: 'Amount of precipitation',
    });
  });

  it('sends semantic searches to the configured service', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ results: [] }),
    } as Response);
    window.__MINT_CONFIG__ = {
      HASURA_ENDPOINT: '',
      AUTH_SERVER: '',
      AUTH_CLIENT_ID: '',
      AUTH_REALM: '',
      AUTH_PROVIDER: 'tapis',
      SEMANTIC_SEARCH_API: 'https://semantic.example.test/',
    };

    renderWithProviders(<StandardVariableCombobox value={null} onChange={vi.fn()} />, {
      apolloMocks: [prefetchMock],
    });

    await waitFor(() => expect(screen.getByRole('combobox')).not.toBeDisabled());
    await user.click(screen.getByRole('combobox'));
    await user.type(screen.getByPlaceholderText('Search standard variables...'), 'temperature');

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        'https://semantic.example.test/search?q=temperature&target=svo&limit=50',
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });
  });

  it('calls onChange(null) when already-selected item is clicked (deselect)', async () => {
    const user = userEvent.setup();
    const handleChange = vi.fn();
    const selected = {
      id: 'https://w3id.org/okn/i/mint/sv1',
      label: 'Precipitation',
      description: 'Amount of precipitation',
    };

    renderWithProviders(<StandardVariableCombobox value={selected} onChange={handleChange} />, {
      apolloMocks: [prefetchMock],
    });

    await waitFor(() => expect(screen.getByRole('combobox')).not.toBeDisabled());
    await user.click(screen.getByRole('combobox'));
    await waitFor(() => {
      expect(screen.getByRole('option', { name: /Precipitation/ })).toBeInTheDocument();
    });

    // Click on the already-selected item (the one inside the list)
    await user.click(screen.getByRole('option', { name: /Precipitation/ }));

    expect(handleChange).toHaveBeenCalledWith(null);
  });

  it('is disabled when disabled prop is true', () => {
    renderWithProviders(
      <StandardVariableCombobox value={null} onChange={vi.fn()} disabled={true} />,
      { apolloMocks: [prefetchMock] },
    );
    // disabled prop always disables regardless of loading state
    expect(screen.getByRole('combobox')).toBeDisabled();
  });

  it('supports custom placeholder', async () => {
    renderWithProviders(
      <StandardVariableCombobox value={null} onChange={vi.fn()} placeholder="Pick a variable..." />,
      { apolloMocks: [prefetchMock] },
    );
    await waitFor(() => {
      expect(screen.getByText('Pick a variable...')).toBeInTheDocument();
    });
  });
});

// ─── UnitCombobox ───────────────────────────────────────────────────────────

describe('UnitCombobox', () => {
  it('shows placeholder after data loads when no value is selected', async () => {
    renderWithProviders(<UnitCombobox value={null} onChange={vi.fn()} />, {
      apolloMocks: [prefetchMock],
    });
    await waitFor(() => {
      expect(screen.getByText('Search units...')).toBeInTheDocument();
    });
    expect(screen.getByRole('combobox')).not.toBeDisabled();
  });

  it('shows selected label when a value is provided', async () => {
    const selected = { id: 'https://w3id.org/okn/i/mint/u1', label: 'mm/day' };
    renderWithProviders(<UnitCombobox value={selected} onChange={vi.fn()} />, {
      apolloMocks: [prefetchMock],
    });
    await waitFor(() => {
      expect(screen.getByText('mm/day')).toBeInTheDocument();
    });
  });

  it('opens popover and shows options when trigger is clicked', async () => {
    const user = userEvent.setup();
    renderWithProviders(<UnitCombobox value={null} onChange={vi.fn()} />, {
      apolloMocks: [prefetchMock],
    });

    await waitFor(() => expect(screen.getByRole('combobox')).not.toBeDisabled());
    await user.click(screen.getByRole('combobox'));

    await waitFor(() => {
      expect(screen.getByText('mm/day')).toBeInTheDocument();
      expect(screen.getByText('Celsius')).toBeInTheDocument();
    });
  });

  it('calls onChange with the selected unit when an option is clicked', async () => {
    const user = userEvent.setup();
    const handleChange = vi.fn();

    renderWithProviders(<UnitCombobox value={null} onChange={handleChange} />, {
      apolloMocks: [prefetchMock],
    });

    await waitFor(() => expect(screen.getByRole('combobox')).not.toBeDisabled());
    await user.click(screen.getByRole('combobox'));
    await waitFor(() => screen.getByText('mm/day'));
    await user.click(screen.getByText('mm/day'));

    expect(handleChange).toHaveBeenCalledWith({
      id: 'https://w3id.org/okn/i/mint/u1',
      label: 'mm/day',
    });
  });

  it('calls onChange(null) when already-selected item is clicked', async () => {
    const user = userEvent.setup();
    const handleChange = vi.fn();
    const selected = { id: 'https://w3id.org/okn/i/mint/u1', label: 'mm/day' };

    renderWithProviders(<UnitCombobox value={selected} onChange={handleChange} />, {
      apolloMocks: [prefetchMock],
    });

    await waitFor(() => expect(screen.getByRole('combobox')).not.toBeDisabled());
    await user.click(screen.getByRole('combobox'));
    await waitFor(() => screen.getAllByText('mm/day'));

    const items = screen.getAllByText('mm/day');
    await user.click(items[items.length - 1]!);

    expect(handleChange).toHaveBeenCalledWith(null);
  });

  it('is disabled when disabled prop is true', () => {
    renderWithProviders(<UnitCombobox value={null} onChange={vi.fn()} disabled={true} />, {
      apolloMocks: [prefetchMock],
    });
    expect(screen.getByRole('combobox')).toBeDisabled();
  });
});
