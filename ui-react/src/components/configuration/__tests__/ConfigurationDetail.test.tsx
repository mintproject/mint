/**
 * Tests for ConfigurationDetail component.
 */
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GetConfigurationDocument } from '@/graphql/generated/graphql';
import { GET_CONFIGURATION_FLOW } from '@/graphql/queries/flows';
import { clearFlowAvailabilityCache } from '@/lib/flow-availability';
import { setMintConfig } from '@/test/utils/mint-config';
import { renderWithProviders } from '@/test/utils/render';
import { ConfigurationDetail } from '@/components/configuration/ConfigurationDetail';

// ─── Mock data ────────────────────────────────────────────────────────────────

const mockConfig = {
  __typename: 'modelcatalog_configuration' as const,
  id: 'cfg1',
  label: 'Default Configuration',
  description: 'A test configuration',
  software_version_id: 'ver1',
  model_configuration_id: null,
  software_version: {
    __typename: 'modelcatalog_software_version' as const,
    id: 'ver1',
    version_id: '2.0',
    software: {
      __typename: 'modelcatalog_software' as const,
      id: 'm1',
      label: 'TopoFlow',
    },
  },
  time_intervals: [
    {
      __typename: 'modelcatalog_configuration_time_interval' as const,
      time_interval: {
        __typename: 'modelcatalog_time_interval' as const,
        id: 'ti1',
        label: 'Daily',
        description: null,
        interval_unit: 'day',
        interval_value: '1',
      },
    },
  ],
  inputs: [
    {
      __typename: 'modelcatalog_configuration_input' as const,
      is_optional: false,
      input: {
        __typename: 'modelcatalog_dataset_specification' as const,
        id: 'ds1',
        label: 'Precipitation',
        description: 'Daily precipitation',
        has_format: 'CSV',
        has_dimensionality: null,
        position: 0,
        presentations: [
          {
            __typename: 'modelcatalog_dataset_specification_presentation' as const,
            presentation: {
              __typename: 'modelcatalog_variable_presentation' as const,
              id: 'vp1',
              label: 'Precipitation VP',
              has_long_name: null,
              has_short_name: null,
              standard_variable: {
                __typename: 'modelcatalog_standard_variable' as const,
                id: 'sv1',
                label: 'precipitation',
                description: null,
              },
              unit: {
                __typename: 'modelcatalog_unit' as const,
                id: 'u1',
                label: 'mm',
              },
            },
          },
        ],
      },
    },
  ],
  outputs: [],
  parameters: [
    {
      __typename: 'modelcatalog_configuration_parameter' as const,
      parameter: {
        __typename: 'modelcatalog_parameter' as const,
        id: 'param1',
        label: 'Threshold',
        description: null,
        has_data_type: 'float',
        has_default_value: '0.5',
        has_minimum_accepted_value: '0',
        has_maximum_accepted_value: '1',
        has_fixed_value: null,
        has_accepted_values: null,
        position: 0,
        parameter_type: null,
      },
    },
  ],
  authors: [
    {
      __typename: 'modelcatalog_configuration_author' as const,
      person: {
        __typename: 'modelcatalog_person' as const,
        id: 'person1',
        label: 'Alice',
      },
    },
  ],
  regions: [
    {
      __typename: 'modelcatalog_configuration_region' as const,
      region: {
        __typename: 'modelcatalog_region' as const,
        id: 'reg1',
        label: 'Ethiopia',
      },
    },
  ],
};

const configQueryMock = {
  request: {
    query: GetConfigurationDocument,
    variables: { id: 'cfg1' },
  },
  result: {
    data: { modelcatalog_configuration_by_pk: mockConfig },
  },
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('ConfigurationDetail', () => {
  it('renders loading state initially', () => {
    renderWithProviders(<ConfigurationDetail configurationId="cfg1" />, {
      apolloMocks: [configQueryMock],
    });
    // Loading spinner should be present
    expect(
      document.querySelector('[class*=animate-spin]') ?? screen.queryByRole('status'),
    ).toBeTruthy();
  });

  it('renders configuration details after loading', async () => {
    renderWithProviders(<ConfigurationDetail configurationId="cfg1" />, {
      apolloMocks: [configQueryMock],
    });

    await waitFor(() => {
      expect(screen.getByText('Default Configuration')).toBeInTheDocument();
    });

    expect(screen.getByText('A test configuration')).toBeInTheDocument();
    expect(screen.getByText('Precipitation')).toBeInTheDocument();
    expect(screen.getByText('CSV')).toBeInTheDocument();
    expect(screen.getByText('precipitation')).toBeInTheDocument();
    expect(screen.getByText('mm')).toBeInTheDocument();
    expect(screen.getByText('Alice')).toBeInTheDocument();
    expect(screen.getByText('Ethiopia')).toBeInTheDocument();
  });

  it('shows "Required" badge for non-optional inputs', async () => {
    renderWithProviders(<ConfigurationDetail configurationId="cfg1" />, {
      apolloMocks: [configQueryMock],
    });

    await waitFor(() => {
      expect(screen.getByText('Required')).toBeInTheDocument();
    });
  });

  it('shows Edit button when onEdit is provided', async () => {
    const onEdit = vi.fn();
    renderWithProviders(<ConfigurationDetail configurationId="cfg1" onEdit={onEdit} />, {
      apolloMocks: [configQueryMock],
    });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /edit/i })).toBeInTheDocument();
    });

    await userEvent.click(screen.getByRole('button', { name: /edit/i }));
    expect(onEdit).toHaveBeenCalledOnce();
  });

  it('shows and invokes Delete when onDelete is provided', async () => {
    const onDelete = vi.fn();
    renderWithProviders(<ConfigurationDetail configurationId="cfg1" onDelete={onDelete} />, {
      apolloMocks: [configQueryMock],
    });

    const deleteButton = await screen.findByRole('button', { name: /delete/i });
    await userEvent.click(deleteButton);

    expect(onDelete).toHaveBeenCalledWith('Default Configuration');
  });

  it('shows a Configure link to the configure page when onEdit is absent', async () => {
    renderWithProviders(<ConfigurationDetail configurationId="cfg1" />, {
      apolloMocks: [configQueryMock],
    });

    const link = await screen.findByRole('link', { name: /configure/i });
    expect(link).toHaveAttribute('href', expect.stringContaining('/models/configure/'));
    expect(screen.queryByRole('button', { name: /edit/i })).not.toBeInTheDocument();
  });

  it('renders model name, version badge, and time period', async () => {
    renderWithProviders(<ConfigurationDetail configurationId="cfg1" />, {
      apolloMocks: [configQueryMock],
    });

    await waitFor(() => {
      expect(screen.getByText('TopoFlow')).toBeInTheDocument();
    });
    expect(screen.getByText('2.0')).toBeInTheDocument();
    expect(screen.getByText('Time Period')).toBeInTheDocument();
    expect(screen.getByText('Daily')).toBeInTheDocument();
  });

  it('renders parameter details', async () => {
    renderWithProviders(<ConfigurationDetail configurationId="cfg1" />, {
      apolloMocks: [configQueryMock],
    });

    await waitFor(() => {
      expect(screen.getByText('Threshold')).toBeInTheDocument();
    });

    expect(screen.getByText('float')).toBeInTheDocument();
    expect(screen.getByText('0.5')).toBeInTheDocument();
  });
});

// ─── Flows ────────────────────────────────────────────────────────────────────

describe('ConfigurationDetail for a flow', () => {
  const flowMock = (flow: unknown) => ({
    request: { query: GET_CONFIGURATION_FLOW, variables: { id: 'cfg1' } },
    result: { data: { modelcatalog_configuration_flow_by_pk: flow } },
  });
  const piece = (id: string, label: string) => ({
    __typename: 'modelcatalog_etl_process',
    id,
    label,
    description: `${label} description`,
    owner_username: 'alice',
    visibility: 'public',
  });
  const step = (
    position: number,
    etl_process_id: string | null,
    etl_process: unknown,
    extra = {},
  ) => ({
    __typename: 'modelcatalog_configuration_step',
    position,
    etl_process_id,
    etl_process,
    settings_json: {},
    wires_json: [],
    pause_after: false,
    ...extra,
  });
  const flow = {
    __typename: 'modelcatalog_configuration_flow',
    configuration_id: 'cfg1',
    outputs_json: [],
    thread_bindings_json: { region: { input: 'ds1' }, collections: ['ds1'] },
    steps: [
      step(1, 'p1', piece('p1', 'Ingest'), {
        settings_json: { top_n: '25' },
        wires_json: [{ to: { input: 0 }, from: { flow_input: 'ds1' } }],
      }),
      step(2, 'p2', piece('p2', 'Score'), {
        wires_json: [
          { to: { input: 0 }, from: { step: 1, output: 1 } },
          { to: { setting: 'top_n' }, from: { step: 1, value: 'job_uuid' } },
          { to: {}, from: { step: 1 } },
        ],
      }),
      step(3, 'hidden', null, { wires_json: [{ to: { input: 0 }, from: { step: 2, output: 0 } }] }),
    ],
  };

  beforeEach(() => {
    clearFlowAvailabilityCache();
    setMintConfig({});
  });
  afterEach(() => {
    delete (window as { __MINT_CONFIG__?: unknown }).__MINT_CONFIG__;
  });

  it('shows a Steps section with each piece, its owner, settings and readable wires', async () => {
    renderWithProviders(<ConfigurationDetail configurationId="cfg1" />, {
      apolloMocks: [configQueryMock, flowMock(flow)],
    });
    const section = await screen.findByTestId('flow-steps-section');
    expect(section).toHaveTextContent('Steps (3)');
    expect(screen.getByTestId('flow-steps-canvas')).toBeInTheDocument();

    const first = screen.getByTestId('flow-steps-step-1');
    expect(first).toHaveTextContent('1. Ingest');
    expect(first).toHaveTextContent('Ingest description');
    expect(first).toHaveTextContent('Owner: alice');
    expect(first).toHaveTextContent('public');
    expect(first).toHaveTextContent('top_n = 25');
    expect(first).toHaveTextContent('input 0 ← flow input Precipitation');

    const second = screen.getByTestId('flow-steps-step-2');
    expect(second).toHaveTextContent('input 0 ← step 1, output 1');
    expect(second).toHaveTextContent('setting top_n ← step 1, value job_uuid');
    expect(second).toHaveTextContent('runs after step 1');

    expect(screen.getByTestId('flow-steps-step-3')).toHaveTextContent(
      "This step's piece was deleted or is not visible to you.",
    );
    expect(section).toHaveTextContent("The thread's region fills: Precipitation");
    expect(section).toHaveTextContent('Takes a collection of files: Precipitation');
  });

  it('marks each step runnable or not, and says the flow is unavailable, when the adapter answers', async () => {
    setMintConfig({ SVO_ADAPTER_API: 'http://adapter' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          flow_id: 'cfg1',
          available: false,
          steps: [
            { position: 1, runnable: true, reason: null },
            { position: 2, runnable: false, reason: 'not_approved' },
            { position: 3, runnable: false, reason: 'piece_missing' },
          ],
        }),
      })),
    );
    try {
      renderWithProviders(<ConfigurationDetail configurationId="cfg1" />, {
        apolloMocks: [configQueryMock, flowMock(flow)],
      });
      expect(await screen.findByText(/This flow is not available to you/)).toBeInTheDocument();
      expect(screen.getByTestId('flow-steps-step-1')).toHaveTextContent('Runnable');
      expect(screen.getByTestId('flow-steps-step-2')).toHaveTextContent(
        'Not runnable: the piece is not approved for your account',
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('shows no Steps section for a model that is not a flow', async () => {
    renderWithProviders(<ConfigurationDetail configurationId="cfg1" />, {
      apolloMocks: [configQueryMock, flowMock(null)],
    });
    await screen.findByText('Default Configuration');
    await waitFor(() => expect(screen.getByText('Threshold')).toBeInTheDocument());
    expect(screen.queryByTestId('flow-steps-section')).not.toBeInTheDocument();
  });

  it('still renders the page when the flow query fails', async () => {
    renderWithProviders(<ConfigurationDetail configurationId="cfg1" />, {
      apolloMocks: [
        configQueryMock,
        {
          request: { query: GET_CONFIGURATION_FLOW, variables: { id: 'cfg1' } },
          error: new Error('field not found'),
        },
      ],
    });
    expect(await screen.findByText('Default Configuration')).toBeInTheDocument();
    expect(screen.queryByTestId('flow-steps-section')).not.toBeInTheDocument();
  });
});
