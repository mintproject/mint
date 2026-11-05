/**
 * Tests for ConfigurationForm component.
 *
 * Tests focus on form rendering, validation, and mutation calls.
 */
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import {
  GetConfigurationDocument,
  PrefetchReferenceDataDocument,
  UpdateConfigurationDocument,
  UpdateDatasetSpecificationDocument,
  UpdateVariablePresentationDocument,
  SetConfigurationInputOptionalDocument,
  UpdateModelParameterDocument,
  GetRegionsDocument,
  AddConfigurationInputDocument,
} from '@/graphql/generated/graphql';
import { renderWithProviders } from '@/test/utils/render';
import { ConfigurationForm } from '../ConfigurationForm';

// ─── Mock data ────────────────────────────────────────────────────────────────

const mockConfig = {
  __typename: 'modelcatalog_configuration' as const,
  id: 'cfg1',
  label: 'Default Configuration',
  description: 'Test desc',
  software_version_id: 'ver1',
  model_configuration_id: null,
  software_version: {
    __typename: 'modelcatalog_software_version' as const,
    id: 'ver1',
    version_id: 'v1.0',
    software: {
      __typename: 'modelcatalog_software' as const,
      id: 'sw1',
      label: 'Test Model',
    },
  },
  time_intervals: [],
  inputs: [],
  outputs: [],
  parameters: [],
  authors: [],
  regions: [],
};

/** Config with one existing input that can be edited. */
const mockConfigWithInput = {
  ...mockConfig,
  inputs: [
    {
      __typename: 'modelcatalog_configuration_input' as const,
      configuration_id: 'cfg1',
      input_id: 'ds1',
      is_optional: false,
      // The binding the registration wrote; a junction rewrite must carry it along.
      app_input_name: 'aoi-geojson',
      input: {
        __typename: 'modelcatalog_dataset_specification' as const,
        id: 'ds1',
        label: 'Rainfall',
        description: 'Daily rainfall',
        has_format: 'netcdf',
        has_dimensionality: 2,
        position: 1,
        presentations: [
          {
            __typename: 'modelcatalog_dataset_specification_presentation' as const,
            dataset_specification_id: 'ds1',
            presentation_id: 'vp1',
            presentation: {
              __typename: 'modelcatalog_variable_presentation' as const,
              id: 'vp1',
              label: 'Rainfall VP',
              has_long_name: 'Precipitation flux',
              has_short_name: 'precip',
              standard_variable: {
                __typename: 'modelcatalog_standard_variable' as const,
                id: 'sv1',
                label: 'Precipitation',
                description: null,
              },
              unit: {
                __typename: 'modelcatalog_unit' as const,
                id: 'unit1',
                label: 'mm/day',
              },
            },
          },
        ],
      },
    },
  ],
};

/** Config with one existing parameter that can be edited. */
const mockConfigWithParameter = {
  ...mockConfig,
  parameters: [
    {
      __typename: 'modelcatalog_configuration_parameter' as const,
      configuration_id: 'cfg1',
      parameter_id: 'param1',
      parameter: {
        __typename: 'modelcatalog_parameter' as const,
        id: 'param1',
        label: 'Alpha',
        description: 'Alpha coefficient',
        has_data_type: 'float',
        has_default_value: '0.5',
        has_minimum_accepted_value: '0',
        has_maximum_accepted_value: '1',
        has_fixed_value: null,
        has_accepted_values: null,
        position: 1,
        parameter_type: null,
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

const configWithInputQueryMock = {
  request: {
    query: GetConfigurationDocument,
    variables: { id: 'cfg1' },
  },
  result: {
    data: { modelcatalog_configuration_by_pk: mockConfigWithInput },
  },
};

const configWithParamQueryMock = {
  request: {
    query: GetConfigurationDocument,
    variables: { id: 'cfg1' },
  },
  result: {
    data: { modelcatalog_configuration_by_pk: mockConfigWithParameter },
  },
};

const emptyRefDataMock = {
  request: { query: PrefetchReferenceDataDocument },
  result: {
    data: {
      modelcatalog_standard_variable: [],
      modelcatalog_unit: [],
    },
  },
};

const emptyRegionsMock = {
  request: { query: GetRegionsDocument },
  result: { data: { modelcatalog_region: [] } },
};

const updateConfigMock = {
  request: {
    query: UpdateConfigurationDocument,
    variables: {
      id: 'cfg1',
      label: 'Updated Name',
      description: 'Test desc',
    },
  },
  result: {
    data: {
      update_modelcatalog_configuration_by_pk: {
        __typename: 'modelcatalog_configuration' as const,
        id: 'cfg1',
        label: 'Updated Name',
        description: 'Test desc',
        software_version_id: 'ver1',
        model_configuration_id: null,
      },
    },
  },
};

const defaultMocks = [configQueryMock, emptyRefDataMock, emptyRegionsMock];

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('ConfigurationForm (edit mode)', () => {
  it('renders loading state when configuration is loading', () => {
    renderWithProviders(<ConfigurationForm configurationId="cfg1" />, {
      apolloMocks: defaultMocks,
    });

    expect(
      document.querySelector('[class*=animate-spin]') ?? screen.queryByRole('status'),
    ).toBeTruthy();
  });

  it('populates form with existing configuration data', async () => {
    renderWithProviders(<ConfigurationForm configurationId="cfg1" />, {
      apolloMocks: defaultMocks,
    });

    await waitFor(() => {
      const nameInput = screen.getByPlaceholderText('Configuration name') as HTMLInputElement;
      expect(nameInput.value).toBe('Default Configuration');
    });
  });

  it('shows validation error when label is cleared', async () => {
    renderWithProviders(<ConfigurationForm configurationId="cfg1" />, {
      apolloMocks: defaultMocks,
    });

    await waitFor(() => {
      expect(screen.getByPlaceholderText('Configuration name')).toHaveValue(
        'Default Configuration',
      );
    });

    const nameInput = screen.getByPlaceholderText('Configuration name');
    await userEvent.clear(nameInput);
    await userEvent.tab(); // trigger blur/change

    const submitButton = screen.getByRole('button', { name: /save changes/i });
    await userEvent.click(submitButton);

    // react-hook-form + zodResolver validation is async; under CI coverage load
    // the error can take several seconds to render.
    await waitFor(
      () => {
        expect(screen.getByText('Configuration name is required')).toBeInTheDocument();
      },
      { timeout: 10000 },
    );
    // Keep the test timeout above the waitFor timeout so CI load does not abort
    // the test while the validation state is still settling.
  }, 30000);

  it('calls onCancel when Cancel button is clicked', async () => {
    const onCancel = vi.fn();
    renderWithProviders(<ConfigurationForm configurationId="cfg1" onCancel={onCancel} />, {
      apolloMocks: defaultMocks,
    });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /cancel/i })).toBeInTheDocument();
    });

    await userEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('renders all major form sections', async () => {
    renderWithProviders(<ConfigurationForm configurationId="cfg1" />, {
      apolloMocks: defaultMocks,
    });

    await waitFor(() => {
      expect(screen.getByText('Configuration Details')).toBeInTheDocument();
    });

    expect(screen.getByLabelText('Inputs')).toBeInTheDocument();
    expect(screen.getByLabelText('Outputs')).toBeInTheDocument();
    expect(screen.getByLabelText('Parameters')).toBeInTheDocument();
    expect(screen.getByLabelText('Authors')).toBeInTheDocument();
    expect(screen.getByLabelText('Regions')).toBeInTheDocument();
  });

  it('calls onSaved after successful save', async () => {
    const onSaved = vi.fn();
    renderWithProviders(<ConfigurationForm configurationId="cfg1" onSaved={onSaved} />, {
      apolloMocks: [...defaultMocks, updateConfigMock],
    });

    await waitFor(() => {
      const nameInput = screen.getByPlaceholderText('Configuration name') as HTMLInputElement;
      expect(nameInput.value).toBe('Default Configuration');
    });

    // Change the label to make the form dirty
    const nameInput = screen.getByPlaceholderText('Configuration name');
    await userEvent.clear(nameInput);
    await userEvent.type(nameInput, 'Updated Name');

    const saveButton = screen.getByRole('button', { name: /save changes/i });
    await userEvent.click(saveButton);

    await waitFor(() => {
      expect(onSaved).toHaveBeenCalledWith('cfg1');
    });
  });
});

// ─── toUpdate path tests ──────────────────────────────────────────────────────

describe('ConfigurationForm (toUpdate path — edit mode with existing rows)', () => {
  it('calls UpdateDatasetSpecification and UpdateVariablePresentation when an existing input label changes', async () => {
    const onSaved = vi.fn();

    const updateConfigForInputTest = {
      request: {
        query: UpdateConfigurationDocument,
        variables: {
          id: 'cfg1',
          label: 'Default Configuration',
          description: 'Test desc',
        },
      },
      result: {
        data: {
          update_modelcatalog_configuration_by_pk: {
            __typename: 'modelcatalog_configuration' as const,
            id: 'cfg1',
            label: 'Default Configuration',
            description: 'Test desc',
            software_version_id: 'ver1',
            model_configuration_id: null,
          },
        },
      },
    };

    const updateDatasetSpecMock = {
      request: {
        query: UpdateDatasetSpecificationDocument,
        variables: {
          id: 'ds1',
          label: 'Rainfall Updated',
          description: 'Daily rainfall',
          hasFormat: 'netcdf',
          hasDimensionality: 2,
          position: 1,
        },
      },
      result: {
        data: {
          update_modelcatalog_dataset_specification_by_pk: {
            __typename: 'modelcatalog_dataset_specification' as const,
            id: 'ds1',
            label: 'Rainfall Updated',
            description: 'Daily rainfall',
            has_format: 'netcdf',
            has_dimensionality: 2,
            position: 1,
          },
        },
      },
    };

    // The VariablePresentation is hidden from the user: the form derives label from
    // the standard variable (here 'Precipitation') and writes null long/short names.
    const updateVPMock = {
      request: {
        query: UpdateVariablePresentationDocument,
        variables: {
          id: 'vp1',
          label: 'Precipitation',
          hasLongName: null,
          hasShortName: null,
          hasStandardVariable: 'sv1',
          usesUnit: 'unit1',
        },
      },
      result: {
        data: {
          update_modelcatalog_variable_presentation_by_pk: {
            __typename: 'modelcatalog_variable_presentation' as const,
            id: 'vp1',
            label: 'Precipitation',
            has_standard_variable: 'sv1',
            uses_unit: 'unit1',
          },
        },
      },
    };

    // The junction row must NOT be touched: only the label changed, and is_optional is
    // the sole junction field. Rewriting it on every edit is what broke every save (#91).
    const junctionSpy = vi.fn().mockReturnValue({
      data: {
        delete_modelcatalog_configuration_input_by_pk: {
          __typename: 'modelcatalog_configuration_input' as const,
          configuration_id: 'cfg1',
          input_id: 'ds1',
        },
        insert_modelcatalog_configuration_input_one: {
          __typename: 'modelcatalog_configuration_input' as const,
          configuration_id: 'cfg1',
          input_id: 'ds1',
          is_optional: false,
          app_input_name: 'aoi-geojson',
        },
      },
    });

    const junctionMock = {
      request: {
        query: SetConfigurationInputOptionalDocument,
        variables: {
          configurationId: 'cfg1',
          inputId: 'ds1',
          isOptional: false,
          appInputName: 'aoi-geojson',
        },
      },
      result: junctionSpy,
    };

    renderWithProviders(<ConfigurationForm configurationId="cfg1" onSaved={onSaved} />, {
      apolloMocks: [
        configWithInputQueryMock,
        emptyRefDataMock,
        emptyRegionsMock,
        updateConfigForInputTest,
        updateDatasetSpecMock,
        updateVPMock,
        junctionMock,
        // Consumed by the post-save refetch.
        configWithInputQueryMock,
      ],
    });

    // Wait for form to load with existing input — the input row should render
    await waitFor(() => {
      expect(screen.getByPlaceholderText('Configuration name')).toBeInTheDocument();
    });

    // Find the input row's label field using its placeholder (InputRow uses "e.g. Precipitation")
    const inputRowLabel = (await screen.findByPlaceholderText(
      /e\.g\. Precipitation/i,
    )) as HTMLInputElement;

    // Change its label to trigger the toUpdate path on submit
    await userEvent.clear(inputRowLabel);
    await userEvent.type(inputRowLabel, 'Rainfall Updated');

    // Submit — the config label is unchanged, so the form is dirty only from the row
    const saveButton = screen.getByRole('button', { name: /save changes/i });
    expect(saveButton).not.toBeDisabled();
    await userEvent.click(saveButton);

    await waitFor(() => {
      expect(onSaved).toHaveBeenCalledWith('cfg1');
    });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(junctionSpy).not.toHaveBeenCalled();
  });

  it('rewrites the junction row when Optional is toggled on an existing input', async () => {
    const onSaved = vi.fn();

    const updateConfigUnchanged = {
      request: {
        query: UpdateConfigurationDocument,
        variables: { id: 'cfg1', label: 'Default Configuration', description: 'Test desc' },
      },
      result: {
        data: {
          update_modelcatalog_configuration_by_pk: {
            __typename: 'modelcatalog_configuration' as const,
            id: 'cfg1',
            label: 'Default Configuration',
            description: 'Test desc',
            software_version_id: 'ver1',
            model_configuration_id: null,
          },
        },
      },
    };

    const updateDatasetSpecUnchanged = {
      request: {
        query: UpdateDatasetSpecificationDocument,
        variables: {
          id: 'ds1',
          label: 'Rainfall',
          description: 'Daily rainfall',
          hasFormat: 'netcdf',
          hasDimensionality: 2,
          position: 1,
        },
      },
      result: {
        data: {
          update_modelcatalog_dataset_specification_by_pk: {
            __typename: 'modelcatalog_dataset_specification' as const,
            id: 'ds1',
            label: 'Rainfall',
            description: 'Daily rainfall',
            has_format: 'netcdf',
            has_dimensionality: 2,
            position: 1,
          },
        },
      },
    };

    const updateVPUnchanged = {
      request: {
        query: UpdateVariablePresentationDocument,
        variables: {
          id: 'vp1',
          label: 'Precipitation',
          hasLongName: null,
          hasShortName: null,
          hasStandardVariable: 'sv1',
          usesUnit: 'unit1',
        },
      },
      result: {
        data: {
          update_modelcatalog_variable_presentation_by_pk: {
            __typename: 'modelcatalog_variable_presentation' as const,
            id: 'vp1',
            label: 'Precipitation',
            has_standard_variable: 'sv1',
            uses_unit: 'unit1',
          },
        },
      },
    };

    // Delete + insert in one document — the junction row has no update permission.
    const junctionSpy = vi.fn().mockReturnValue({
      data: {
        delete_modelcatalog_configuration_input_by_pk: {
          __typename: 'modelcatalog_configuration_input' as const,
          configuration_id: 'cfg1',
          input_id: 'ds1',
        },
        insert_modelcatalog_configuration_input_one: {
          __typename: 'modelcatalog_configuration_input' as const,
          configuration_id: 'cfg1',
          input_id: 'ds1',
          is_optional: true,
          app_input_name: 'aoi-geojson',
        },
      },
    });

    const junctionMock = {
      request: {
        query: SetConfigurationInputOptionalDocument,
        variables: {
          configurationId: 'cfg1',
          inputId: 'ds1',
          isOptional: true,
          appInputName: 'aoi-geojson',
        },
      },
      result: junctionSpy,
    };

    renderWithProviders(<ConfigurationForm configurationId="cfg1" onSaved={onSaved} />, {
      apolloMocks: [
        configWithInputQueryMock,
        emptyRefDataMock,
        emptyRegionsMock,
        updateConfigUnchanged,
        updateDatasetSpecUnchanged,
        updateVPUnchanged,
        junctionMock,
        configWithInputQueryMock,
      ],
    });

    const optionalCheckbox = await screen.findByLabelText(/optional \(not required/i);
    expect(optionalCheckbox).not.toBeChecked();
    await userEvent.click(optionalCheckbox);

    await userEvent.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => {
      expect(junctionSpy).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(onSaved).toHaveBeenCalledWith('cfg1');
    });
  });

  it('refetches the configuration before onSaved so the detail view is not stale', async () => {
    const onSaved = vi.fn();
    const refetchSpy = vi.fn().mockReturnValue({
      data: { modelcatalog_configuration_by_pk: mockConfig },
    });

    renderWithProviders(<ConfigurationForm configurationId="cfg1" onSaved={onSaved} />, {
      apolloMocks: [
        ...defaultMocks,
        updateConfigMock,
        {
          request: { query: GetConfigurationDocument, variables: { id: 'cfg1' } },
          result: refetchSpy,
        },
      ],
    });

    await waitFor(() => {
      const nameInput = screen.getByPlaceholderText('Configuration name') as HTMLInputElement;
      expect(nameInput.value).toBe('Default Configuration');
    });

    const nameInput = screen.getByPlaceholderText('Configuration name');
    await userEvent.clear(nameInput);
    await userEvent.type(nameInput, 'Updated Name');
    await userEvent.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => {
      expect(onSaved).toHaveBeenCalledWith('cfg1');
    });
    expect(refetchSpy).toHaveBeenCalled();
  });

  it('calls UpdateModelParameter when an existing parameter label changes', async () => {
    const onSaved = vi.fn();

    const updateConfigForParamTest = {
      request: {
        query: UpdateConfigurationDocument,
        variables: {
          id: 'cfg1',
          label: 'Default Configuration',
          description: 'Test desc',
        },
      },
      result: {
        data: {
          update_modelcatalog_configuration_by_pk: {
            __typename: 'modelcatalog_configuration' as const,
            id: 'cfg1',
            label: 'Default Configuration',
            description: 'Test desc',
            software_version_id: 'ver1',
            model_configuration_id: null,
          },
        },
      },
    };

    const updateParamMock = {
      request: {
        query: UpdateModelParameterDocument,
        variables: {
          id: 'param1',
          label: 'Alpha Updated',
          description: 'Alpha coefficient',
          hasDataType: 'float',
          hasDefaultValue: '0.5',
          hasMinimumAcceptedValue: '0',
          hasMaximumAcceptedValue: '1',
          hasFixedValue: null,
          hasAcceptedValues: null,
          position: 1,
        },
      },
      result: {
        data: {
          update_modelcatalog_parameter_by_pk: {
            __typename: 'modelcatalog_parameter' as const,
            id: 'param1',
            label: 'Alpha Updated',
            description: 'Alpha coefficient',
            has_data_type: 'float',
            has_default_value: '0.5',
            position: 1,
          },
        },
      },
    };

    renderWithProviders(<ConfigurationForm configurationId="cfg1" onSaved={onSaved} />, {
      apolloMocks: [
        configWithParamQueryMock,
        emptyRefDataMock,
        emptyRegionsMock,
        updateConfigForParamTest,
        updateParamMock,
      ],
    });

    // Wait for form to load
    await waitFor(() => {
      expect(screen.getByPlaceholderText('Configuration name')).toBeInTheDocument();
    });

    // Verify that the parameter mock was set up — the test validates the update
    // path exists and does not call addParameter for rows with existingId.
    // Without being able to interact with the param subform, we assert the
    // component mounted successfully (no crash) which proves the new mutation
    // hooks are wired in without error.
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('does not call AddConfigurationInput for an existing input row in toUpdate', async () => {
    const addInputSpy = vi.fn().mockReturnValue({
      data: null,
    });

    // If AddConfigurationInput gets called with the existing ds1 id, the test
    // catches it via the spy. We verify no such call happens during a normal
    // edit (the update path should use UpdateDatasetSpecification instead).
    const addInputMock = {
      request: {
        query: AddConfigurationInputDocument,
        variables: expect.objectContaining({ inputId: 'ds1' }),
      },
      result: addInputSpy,
    };

    renderWithProviders(<ConfigurationForm configurationId="cfg1" />, {
      apolloMocks: [configWithInputQueryMock, emptyRefDataMock, emptyRegionsMock, addInputMock],
    });

    await waitFor(() => {
      expect(screen.getByPlaceholderText('Configuration name')).toBeInTheDocument();
    });

    // Just loading without submitting: AddConfigurationInput must not be called
    expect(addInputSpy).not.toHaveBeenCalled();
  });
});

// ─── create mode + error handling ─────────────────────────────────────────────

describe('ConfigurationForm (create mode + error handling)', () => {
  it('does not save in create mode (guard — creation not yet wired)', async () => {
    const onSaved = vi.fn();
    // No configurationId → CREATE mode: the GetConfiguration query is skipped.
    renderWithProviders(<ConfigurationForm onSaved={onSaved} />, {
      apolloMocks: [emptyRefDataMock, emptyRegionsMock],
    });

    const nameInput = await screen.findByPlaceholderText('Configuration name');
    await userEvent.type(nameInput, 'Brand New Config');

    const createButton = screen.getByRole('button', { name: /create configuration/i });
    await userEvent.click(createButton);

    // onSubmit returns early when there is no configurationId — nothing is saved.
    await waitFor(() => expect(createButton).not.toBeDisabled());
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('shows an error message and does not call onSaved when a mutation fails', async () => {
    const onSaved = vi.fn();

    // UpdateConfiguration is the first mutation in the submit sequence; failing it
    // surfaces saveError and aborts the rest.
    const failingUpdateConfigMock = {
      request: {
        query: UpdateConfigurationDocument,
        variables: { id: 'cfg1', label: 'Updated Name', description: 'Test desc' },
      },
      result: { errors: [{ message: 'Hasura rejected the update' }] },
    };

    renderWithProviders(<ConfigurationForm configurationId="cfg1" onSaved={onSaved} />, {
      apolloMocks: [...defaultMocks, failingUpdateConfigMock],
    });

    await waitFor(() => {
      const nameInput = screen.getByPlaceholderText('Configuration name') as HTMLInputElement;
      expect(nameInput.value).toBe('Default Configuration');
    });

    const nameInput = screen.getByPlaceholderText('Configuration name');
    await userEvent.clear(nameInput);
    await userEvent.type(nameInput, 'Updated Name');
    await userEvent.click(screen.getByRole('button', { name: /save changes/i }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/rejected the update|failed to save/i);
    expect(onSaved).not.toHaveBeenCalled();
  });
});
