/**
 * Scope behaviour of StandardVariableCombobox (monorepo#103).
 *
 * The catalog holds 668 standard variables at TACC; 147 are produced by a model
 * the Models step lists and 161 are taken as an input or adjusted by a
 * parameter. Offering all 668 lets a user pick a legitimate variable and meet
 * "No models found." one step later.
 */
import { MockedProvider } from '@apollo/client/testing';
import { GraphQLError } from 'graphql';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { StandardVariableCombobox } from '@/components/autocomplete/StandardVariableCombobox';
import {
  GetDriverVariableOptionsDocument,
  GetIndicatorVariableOptionsDocument,
  PrefetchReferenceDataDocument,
} from '@/graphql/generated/graphql';
import {
  IndicatorAdapterInferenceDocument,
  OutcomeDriverAdapterInferenceDocument,
  OutcomeDriverModelInferenceDocument,
} from '@/components/autocomplete/useScopedStandardVariables';

const sv = (id: string, label: string, description: string | null = null) => ({
  __typename: 'modelcatalog_standard_variable',
  id,
  label,
  description,
});

/** The whole catalog: one producible, one input-only, one that reaches nothing. */
const prefetchMock = {
  request: { query: PrefetchReferenceDataDocument },
  result: {
    data: {
      modelcatalog_standard_variable: [
        sv('sv-draw', 'drawdown'),
        sv('sv-poro', 'soil__porosity'),
        sv('sv-dead', '100hr_dead_moisture'),
      ],
      modelcatalog_unit: [],
    },
  },
};

const presentationRow = (presId: string, svId: string, label: string) => ({
  __typename: 'modelcatalog_dataset_specification_presentation',
  dataset_specification_id: `ds-${presId}`,
  presentation_id: presId,
  presentation: {
    __typename: 'modelcatalog_variable_presentation',
    id: presId,
    standard_variable: sv(svId, label),
  },
});

const indicatorMock = {
  request: { query: GetIndicatorVariableOptionsDocument },
  result: {
    data: {
      modelcatalog_dataset_specification_presentation: [
        presentationRow('p-draw', 'sv-draw', 'drawdown'),
      ],
    },
  },
};

const indicatorAdapterMock = {
  request: { query: IndicatorAdapterInferenceDocument },
  result: { data: { adapterTransforms: [] } },
};

const springIndicatorAdapterMock = {
  request: { query: IndicatorAdapterInferenceDocument },
  result: {
    data: {
      adapterTransforms: [
        {
          contracts: [
            {
              role: 'output',
              standard_variable_uri: 'https://w3id.org/okn/i/mint/spring__volume_flow_rate',
              format: 'cfs',
            },
          ],
        },
      ],
    },
  },
};

const driverMock = {
  request: { query: GetDriverVariableOptionsDocument },
  result: {
    data: {
      inputs: [
        presentationRow('p-poro', 'sv-poro', 'soil__porosity'),
        presentationRow('p-air', 'sv-air', 'air__temperature'),
      ],
      adjusted: [
        {
          __typename: 'modelcatalog_parameter_adjusts_variable',
          parameter_id: 'param-1',
          variable_id: 'p-draw',
          variable: {
            __typename: 'modelcatalog_variable_presentation',
            id: 'p-draw',
            standard_variable: sv('sv-draw', 'drawdown'),
          },
        },
      ],
    },
  },
};

const outcomeModelInferenceMock = {
  request: { query: OutcomeDriverModelInferenceDocument },
  result: {
    data: {
      modelConfigurations: [
        {
          id: 'cfg-outcome',
          inputs: [
            {
              configuration_id: 'cfg-outcome',
              input_id: 'ds-middle',
              input: {
                id: 'ds-middle',
                has_format: null,
                presentations: [
                  {
                    dataset_specification_id: 'ds-middle',
                    presentation_id: 'pres-middle',
                    presentation: {
                      id: 'pres-middle',
                      standard_variable: sv('sv-middle', 'middle'),
                    },
                  },
                ],
              },
            },
          ],
          outputs: [
            {
              configuration_id: 'cfg-outcome',
              output_id: 'ds-draw',
              output: {
                id: 'ds-draw',
                has_format: null,
                presentations: [
                  {
                    dataset_specification_id: 'ds-draw',
                    presentation_id: 'pres-draw',
                    presentation: {
                      id: 'pres-draw',
                      standard_variable: sv('sv-draw', 'drawdown'),
                    },
                  },
                ],
              },
            },
          ],
          parameters: [],
        },
        {
          id: 'cfg-unrelated',
          inputs: [
            {
              configuration_id: 'cfg-unrelated',
              input_id: 'ds-air',
              input: {
                id: 'ds-air',
                has_format: null,
                presentations: [
                  {
                    dataset_specification_id: 'ds-air',
                    presentation_id: 'pres-air',
                    presentation: {
                      id: 'pres-air',
                      standard_variable: sv('sv-air', 'air__temperature'),
                    },
                  },
                ],
              },
            },
          ],
          outputs: [
            {
              configuration_id: 'cfg-unrelated',
              output_id: 'ds-draw',
              output: {
                id: 'ds-draw',
                has_format: null,
                presentations: [
                  {
                    dataset_specification_id: 'ds-draw',
                    presentation_id: 'pres-draw',
                    presentation: {
                      id: 'pres-draw',
                      standard_variable: sv('sv-draw', 'drawdown'),
                    },
                  },
                ],
              },
            },
          ],
          parameters: [],
        },
        {
          id: 'cfg-incompatible',
          inputs: [
            {
              configuration_id: 'cfg-incompatible',
              input_id: 'sv-only-incompatible',
              input: {
                id: 'sv-only-incompatible',
                has_format: null,
                presentations: [
                  {
                    dataset_specification_id: 'ds-only-incompatible',
                    presentation_id: 'pres-only-incompatible',
                    presentation: {
                      id: 'pres-only-incompatible',
                      standard_variable: sv('sv-only-incompatible', 'only_incompatible'),
                    },
                  },
                ],
              },
            },
          ],
          outputs: [
            {
              configuration_id: 'cfg-incompatible',
              output_id: 'sv-other',
              output: {
                id: 'sv-other',
                has_format: null,
                presentations: [
                  {
                    dataset_specification_id: 'ds-other',
                    presentation_id: 'pres-other',
                    presentation: {
                      id: 'pres-other',
                      standard_variable: sv('sv-other', 'other_outcome'),
                    },
                  },
                ],
              },
            },
          ],
          parameters: [],
        },
      ],
      etlProcesses: [
        {
          contracts: [
            { role: 'input', standard_variable_uri: 'sv-forcing', format: null },
            { role: 'output', standard_variable_uri: 'sv-rain', format: null },
          ],
        },
      ],
    },
  },
};

const outcomeAdapterInferenceMock = {
  request: { query: OutcomeDriverAdapterInferenceDocument },
  result: {
    data: {
      adapterTransforms: [
        {
          contracts: [
            { role: 'input', standard_variable_uri: 'sv-rain', format: null },
            { role: 'output', standard_variable_uri: 'sv-middle', format: null },
          ],
        },
      ],
    },
  },
};

const mocks = [
  prefetchMock,
  indicatorMock,
  indicatorAdapterMock,
  driverMock,
  outcomeModelInferenceMock,
  outcomeAdapterInferenceMock,
];

function renderCombobox(props: Partial<React.ComponentProps<typeof StandardVariableCombobox>>) {
  return render(
    <MockedProvider mocks={mocks}>
      <StandardVariableCombobox value={null} onChange={vi.fn()} {...props} />
    </MockedProvider>,
  );
}

async function openList() {
  const user = userEvent.setup();
  await waitFor(() => expect(screen.getByRole('combobox')).toBeEnabled());
  await user.click(screen.getByRole('combobox'));
  return user;
}

describe('StandardVariableCombobox scope', () => {
  it('offers the whole catalog by default, so registration forms are unchanged', async () => {
    renderCombobox({});
    await openList();
    await waitFor(() => expect(screen.getByText('Drawdown')).toBeInTheDocument());
    expect(screen.getByText('100hr dead moisture')).toBeInTheDocument();
    expect(screen.getByText('Soil — Porosity')).toBeInTheDocument();
  });

  it('places preferred variables before the alphabetical catalog order', async () => {
    renderCombobox({ preferredIds: ['sv-poro', 'sv-draw'] });
    await openList();
    await waitFor(() => expect(screen.getByText('Soil — Porosity')).toBeInTheDocument());

    const labels = screen.getAllByRole('option').map((option) => option.textContent);
    expect(labels[0]).toContain('Soil — Porosity');
    expect(labels[1]).toContain('Drawdown');
  });

  it('offers only producible variables under scope="indicator"', async () => {
    renderCombobox({ scope: 'indicator' });
    await openList();
    await waitFor(() => expect(screen.getByText('Drawdown')).toBeInTheDocument());
    // Reaches no model, so it must not be offered.
    expect(screen.queryByText('100hr dead moisture')).not.toBeInTheDocument();
    // An input-only variable is not an indicator either.
    expect(screen.queryByText('Soil — Porosity')).not.toBeInTheDocument();
  });

  it('offers SVOs produced by registered adapter transforms as outcomes', async () => {
    render(
      <MockedProvider mocks={[indicatorMock, springIndicatorAdapterMock]}>
        <StandardVariableCombobox value={null} onChange={vi.fn()} scope="indicator" />
      </MockedProvider>,
    );
    await openList();
    await waitFor(() => expect(screen.getByText('Spring — Volume flow rate')).toBeInTheDocument());
  });

  it('unions inputs and parameter-adjusted variables under scope="driver"', async () => {
    renderCombobox({ scope: 'driver' });
    await openList();
    // soil__porosity arrives through inputs, drawdown through a parameter.
    await waitFor(() => expect(screen.getByText('Soil — Porosity')).toBeInTheDocument());
    expect(screen.getByText('Drawdown')).toBeInTheDocument();
    expect(screen.queryByText('100hr dead moisture')).not.toBeInTheDocument();
  });

  it('infers drivers from a selected outcome across model and ETL steps', async () => {
    renderCombobox({ scope: 'driver', driverOutcomeId: 'sv-draw' });
    await openList();
    await waitFor(() => expect(screen.getByText('Middle')).toBeInTheDocument());
    expect(screen.getByText('Sv-forcing')).toBeInTheDocument();
    expect(screen.queryByText('Soil — Porosity')).not.toBeInTheDocument();
    expect(screen.queryByText('Drawdown')).not.toBeInTheDocument();
  });

  it('limits outcome inference to the selected model configurations', async () => {
    renderCombobox({
      scope: 'driver',
      driverOutcomeId: 'sv-draw',
      driverConfigurationIds: ['cfg-outcome'],
    });
    await openList();
    await waitFor(() => expect(screen.getByText('Middle')).toBeInTheDocument());
    expect(screen.queryByText('Air — Temperature')).not.toBeInTheDocument();
  });

  it('falls back to outcome-producing models when a retained model is incompatible', async () => {
    renderCombobox({
      scope: 'driver',
      driverOutcomeId: 'sv-draw',
      driverConfigurationIds: ['cfg-incompatible'],
    });
    await openList();
    await waitFor(() => expect(screen.getByText('Middle')).toBeInTheDocument());
    expect(screen.getByText('Air — Temperature')).toBeInTheDocument();
    expect(screen.queryByText('Only incompatible')).not.toBeInTheDocument();
  });

  it('keeps model inference when the optional adapter registry is unavailable', async () => {
    render(
      <MockedProvider
        mocks={[
          driverMock,
          outcomeModelInferenceMock,
          {
            request: { query: OutcomeDriverAdapterInferenceDocument },
            result: {
              errors: [
                new GraphQLError("field 'adapter_transform_spec' not found in type: 'query_root'"),
              ],
            },
          },
        ]}
      >
        <StandardVariableCombobox
          value={null}
          onChange={vi.fn()}
          scope="driver"
          driverOutcomeId="sv-draw"
          driverConfigurationIds={['cfg-outcome']}
        />
      </MockedProvider>,
    );
    await openList();
    await waitFor(() => expect(screen.getByText('Middle')).toBeInTheDocument());
    expect(screen.queryByText('Air — Temperature')).not.toBeInTheDocument();
    expect(screen.queryByText('Soil — Porosity')).not.toBeInTheDocument();
  });

  it('widens to the whole catalog when the escape link is clicked', async () => {
    renderCombobox({ scope: 'indicator', scopeLabel: 'a model produces' });
    const user = await openList();
    await waitFor(() => expect(screen.getByText('Drawdown')).toBeInTheDocument());
    expect(screen.queryByText('100hr dead moisture')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /show every standard variable/i }));

    await waitFor(() => expect(screen.getByText('100hr dead moisture')).toBeInTheDocument());
  });

  it('names the scope and its size in the escape link', async () => {
    renderCombobox({ scope: 'indicator', scopeLabel: 'a model produces' });
    await openList();
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /showing the 1 a model produces/i }),
      ).toBeInTheDocument(),
    );
  });

  // At TACC one live thread stores an indicator no configuration produces. The
  // scope must not make that value disappear from the control.
  it('keeps a stored value visible even when the scope does not carry it', async () => {
    renderCombobox({
      scope: 'indicator',
      value: { id: 'sv-dead', label: '100hr_dead_moisture', description: null },
    });
    await openList();
    await waitFor(() => expect(screen.getByText('Drawdown')).toBeInTheDocument());
    // The trigger also prints the stored label, so assert on the option row.
    const options = screen.getAllByRole('option').map((o) => o.textContent);
    expect(options).toContain('100hr dead moisture');
  });
});
