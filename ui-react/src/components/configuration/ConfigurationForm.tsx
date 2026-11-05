/**
 * ConfigurationForm — the primary SOW deliverable.
 *
 * Replaces the 5-level nested modal workflow with a single-page form.
 * A user can configure a model input with variable, standard variable, and unit
 * in a SINGLE FORM SUBMISSION.
 *
 * Supports CREATE mode (configId is undefined) and EDIT mode (configId provided).
 * In EDIT mode, the form is pre-populated via GetConfiguration query and saves
 * via a diff-then-mutate strategy (new rows inserted, removed rows deleted).
 *
 * See: .planning/design/DESIGN-DOCUMENT.md §6
 */
import * as React from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm, FormProvider } from 'react-hook-form';
import { Loader2 } from 'lucide-react';

import {
  useGetConfigurationQuery,
  useAddConfigurationInputMutation,
  useAddConfigurationOutputMutation,
  useAddConfigurationParameterMutation,
  useDeleteConfigurationInputMutation,
  useDeleteConfigurationOutputMutation,
  useDeleteConfigurationParameterMutation,
  useUpdateConfigurationMutation,
  useUpdateDatasetSpecificationMutation,
  useUpdateVariablePresentationMutation,
  useInsertVariablePresentationMutation,
  useSetConfigurationInputOptionalMutation,
  useUpdateModelParameterMutation,
  useAddConfigurationAuthorMutation,
  useDeleteConfigurationAuthorMutation,
  useAddConfigurationRegionMutation,
  useDeleteConfigurationRegionMutation,
  type ConfigurationFieldsFragment,
} from '@/graphql/generated/graphql';
import { Button } from '@/components/ui/button';
import { FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import {
  buildAddInputVariables,
  buildAddOutputVariables,
  buildAddParameterVariables,
  buildPresentationInsertForExistingDs,
  toPgTextArray,
  diffInputRows,
  diffParameterRows,
  assignPositions,
} from '@/lib/mutation-builder';
import { configurationFormSchema, type ConfigurationFormSchema } from '@/schemas/configuration';

import { InputOutputSection } from './InputOutputSection';
import { ParameterSection } from './ParameterSection';
import { RegionSection } from './RegionSection';
import { AuthorSection } from './AuthorSection';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Map a loaded configuration to form data. */
function configToFormData(config: ConfigurationFieldsFragment): ConfigurationFormSchema {
  // The edit form is single-presentation: map presentation[0] into a one-element
  // presentations list. Existing inputs with multiple presentations keep the extras
  // intact on save (the diff only touches the first). Full multi-presentation editing
  // is a follow-up — see the register page for the multi-variable UI.
  const toPresentationList = (
    vp:
      | NonNullable<
          NonNullable<
            ConfigurationFieldsFragment['inputs'][number]['input']['presentations']
          >[number]
        >['presentation']
      | undefined,
  ) => [
    {
      existingPresentationId: vp?.id,
      standardVariable: vp?.standard_variable
        ? {
            id: vp.standard_variable.id,
            label: vp.standard_variable.label ?? '',
            description: vp.standard_variable.description ?? null,
          }
        : null,
      unit: vp?.unit ? { id: vp.unit.id, label: vp.unit.label ?? '' } : null,
    },
  ];

  const inputs = config.inputs.map((inp, i) => {
    const ds = inp.input;
    const vp = ds.presentations?.[0]?.presentation;
    return {
      existingId: ds.id,
      label: ds.label ?? '',
      description: ds.description ?? '',
      hasFormat: ds.has_format ?? '',
      hasDimensionality: ds.has_dimensionality ?? undefined,
      position: ds.position ?? i,
      isOptional: inp.is_optional ?? false,
      appInputName: inp.app_input_name ?? null,
      presentations: toPresentationList(vp),
    };
  });

  const outputs = config.outputs.map((out, i) => {
    const ds = out.output;
    const vp = ds.presentations?.[0]?.presentation;
    return {
      existingId: ds.id,
      label: ds.label ?? '',
      description: ds.description ?? '',
      hasFormat: ds.has_format ?? '',
      hasDimensionality: ds.has_dimensionality ?? undefined,
      position: ds.position ?? i,
      isOptional: false,
      presentations: toPresentationList(vp),
    };
  });

  const parameters = config.parameters.map((cp, i) => {
    const p = cp.parameter;
    return {
      existingId: p.id,
      label: p.label ?? '',
      description: p.description ?? '',
      hasDataType: p.has_data_type ?? '',
      hasDefaultValue: p.has_default_value ?? '',
      hasMinimumAcceptedValue: p.has_minimum_accepted_value ?? '',
      hasMaximumAcceptedValue: p.has_maximum_accepted_value ?? '',
      hasFixedValue: p.has_fixed_value ?? '',
      hasAcceptedValues: (p.has_accepted_values as string[] | null) ?? [],
      position: p.position ?? i,
      parameterType: p.parameter_type ?? undefined,
    };
  });

  return {
    label: config.label ?? '',
    description: config.description ?? '',
    inputs,
    outputs,
    parameters,
    authors: config.authors.map((a) => ({
      id: a.person.id,
      label: a.person.label ?? '',
    })),
    regions: config.regions.map((r) => ({
      id: r.region.id,
      label: r.region.label ?? '',
    })),
  };
}

// ─── Main component ───────────────────────────────────────────────────────────

export interface ConfigurationFormProps {
  /** When provided, loads the existing configuration (EDIT mode). */
  configurationId?: string;
  /** Called after a successful save. Passes the configuration id. */
  onSaved?: (configurationId: string) => void;
  /** Called when the user clicks Cancel. */
  onCancel?: () => void;
}

export function ConfigurationForm({ configurationId, onSaved, onCancel }: ConfigurationFormProps) {
  const isEdit = !!configurationId;

  // ─── Queries ────────────────────────────────────────────────────────────────
  const {
    data: configData,
    loading: configLoading,
    refetch: refetchConfig,
  } = useGetConfigurationQuery({
    variables: { id: configurationId! },
    skip: !configurationId,
    fetchPolicy: 'cache-first',
  });

  // ─── Mutations ──────────────────────────────────────────────────────────────
  const [updateConfig, { loading: saving }] = useUpdateConfigurationMutation();
  const [addInput] = useAddConfigurationInputMutation();
  const [addOutput] = useAddConfigurationOutputMutation();
  const [addParameter] = useAddConfigurationParameterMutation();
  const [deleteInput] = useDeleteConfigurationInputMutation();
  const [deleteOutput] = useDeleteConfigurationOutputMutation();
  const [deleteParameter] = useDeleteConfigurationParameterMutation();
  const [updateDatasetSpec] = useUpdateDatasetSpecificationMutation();
  const [updateVarPresentation] = useUpdateVariablePresentationMutation();
  const [insertVarPresentation] = useInsertVariablePresentationMutation();
  const [setInputOptional] = useSetConfigurationInputOptionalMutation();
  const [updateParameter] = useUpdateModelParameterMutation();
  const [addAuthor] = useAddConfigurationAuthorMutation();
  const [deleteAuthor] = useDeleteConfigurationAuthorMutation();
  const [addRegion] = useAddConfigurationRegionMutation();
  const [deleteRegion] = useDeleteConfigurationRegionMutation();

  // ─── Form ────────────────────────────────────────────────────────────────────
  const methods = useForm<ConfigurationFormSchema>({
    resolver: zodResolver(configurationFormSchema),
    defaultValues: {
      label: '',
      description: '',
      inputs: [],
      outputs: [],
      parameters: [],
      authors: [],
      regions: [],
    },
  });

  const { control, handleSubmit, reset, formState } = methods;

  // Populate form when config loads (edit mode)
  const config = configData?.modelcatalog_configuration_by_pk;
  const configLoadedRef = React.useRef(false);
  React.useEffect(() => {
    if (config && !configLoadedRef.current) {
      configLoadedRef.current = true;
      reset(configToFormData(config));
    }
  }, [config, reset]);

  // ─── Submit handler ──────────────────────────────────────────────────────────
  const [saveError, setSaveError] = React.useState<string | null>(null);

  const onSubmit = async (formData: ConfigurationFormSchema) => {
    if (!configurationId) return; // CREATE not implemented yet (requires parent version id)
    setSaveError(null);

    const originalData = config ? configToFormData(config) : null;

    try {
      // 1. Save label + description
      await updateConfig({
        variables: {
          id: configurationId,
          label: formData.label,
          description: formData.description ?? null,
        },
      });

      const inputsWithPos = assignPositions(formData.inputs);
      const outputsWithPos = assignPositions(formData.outputs);
      const paramsWithPos = assignPositions(formData.parameters);

      // 2. Inputs diff
      const inputDiff = originalData
        ? diffInputRows(originalData.inputs, inputsWithPos)
        : { toAdd: inputsWithPos, toRemove: [], toUpdate: inputsWithPos };

      // is_optional lives on the junction row, not the DatasetSpecification, and is the
      // only junction field the form can change. Look the original up to rewrite the row
      // only when that flag actually moved.
      const originalInputById = new Map(
        (originalData?.inputs ?? []).filter((r) => r.existingId).map((r) => [r.existingId!, r]),
      );

      for (const id of inputDiff.toRemove) {
        await deleteInput({ variables: { configurationId, inputId: id } });
      }
      for (const row of inputDiff.toAdd) {
        await addInput({ variables: buildAddInputVariables(configurationId, row) });
      }
      for (const row of inputDiff.toUpdate) {
        // Update DatasetSpecification scalar fields
        await updateDatasetSpec({
          variables: {
            id: row.existingId!,
            label: row.label,
            description: row.description ?? null,
            hasFormat: row.hasFormat ?? null,
            hasDimensionality: row.hasDimensionality ?? null,
            position: row.position,
          },
        });
        // Update the first VariablePresentation if it exists, otherwise insert a new
        // one when the row gained a standard variable/unit (single-presentation edit).
        const vp = row.presentations[0];
        if (vp?.existingPresentationId) {
          await updateVarPresentation({
            variables: {
              id: vp.existingPresentationId,
              label: vp.standardVariable?.label || row.label,
              hasLongName: null,
              hasShortName: null,
              hasStandardVariable: vp.standardVariable?.id ?? null,
              usesUnit: vp.unit?.id ?? null,
            },
          });
        } else {
          const insertVars = buildPresentationInsertForExistingDs(row.existingId!, row);
          if (insertVars) await insertVarPresentation({ variables: insertVars });
        }
        // Rewrite the junction row only when is_optional changed. Touching it on every
        // edit is what made every save fail: the junction row cannot be updated in place
        // under the `user` role, so this replaces it instead (see the mutation's comment).
        const originalInput = originalInputById.get(row.existingId!);
        if (originalInput && originalInput.isOptional !== row.isOptional) {
          await setInputOptional({
            variables: {
              configurationId,
              inputId: row.existingId!,
              isOptional: row.isOptional,
              // Replacing the row must keep the binding the registration wrote.
              appInputName: originalInput.appInputName ?? null,
            },
          });
        }
      }

      // 3. Outputs diff
      const outputDiff = originalData
        ? diffInputRows(originalData.outputs, outputsWithPos)
        : { toAdd: outputsWithPos, toRemove: [], toUpdate: outputsWithPos };

      for (const id of outputDiff.toRemove) {
        await deleteOutput({ variables: { configurationId, outputId: id } });
      }
      for (const row of outputDiff.toAdd) {
        await addOutput({ variables: buildAddOutputVariables(configurationId, row) });
      }
      for (const row of outputDiff.toUpdate) {
        // Update DatasetSpecification scalar fields
        await updateDatasetSpec({
          variables: {
            id: row.existingId!,
            label: row.label,
            description: row.description ?? null,
            hasFormat: row.hasFormat ?? null,
            hasDimensionality: row.hasDimensionality ?? null,
            position: row.position,
          },
        });
        // Update the first VariablePresentation if it exists, otherwise insert a new
        // one when the row gained a standard variable/unit (single-presentation edit).
        const vp = row.presentations[0];
        if (vp?.existingPresentationId) {
          await updateVarPresentation({
            variables: {
              id: vp.existingPresentationId,
              label: vp.standardVariable?.label || row.label,
              hasLongName: null,
              hasShortName: null,
              hasStandardVariable: vp.standardVariable?.id ?? null,
              usesUnit: vp.unit?.id ?? null,
            },
          });
        } else {
          const insertVars = buildPresentationInsertForExistingDs(row.existingId!, row);
          if (insertVars) await insertVarPresentation({ variables: insertVars });
        }
      }

      // 4. Parameters diff
      const paramDiff = originalData
        ? diffParameterRows(originalData.parameters, paramsWithPos)
        : { toAdd: paramsWithPos, toRemove: [], toUpdate: paramsWithPos };

      for (const id of paramDiff.toRemove) {
        await deleteParameter({ variables: { configurationId, parameterId: id } });
      }
      for (const row of paramDiff.toAdd) {
        await addParameter({ variables: buildAddParameterVariables(configurationId, row) });
      }
      for (const row of paramDiff.toUpdate) {
        await updateParameter({
          variables: {
            id: row.existingId!,
            label: row.label,
            description: row.description ?? null,
            hasDataType: row.hasDataType ?? null,
            hasDefaultValue: row.hasDefaultValue ?? null,
            hasMinimumAcceptedValue: row.hasMinimumAcceptedValue ?? null,
            hasMaximumAcceptedValue: row.hasMaximumAcceptedValue ?? null,
            hasFixedValue: row.hasFixedValue ?? null,
            hasAcceptedValues: toPgTextArray(row.hasAcceptedValues),
            position: row.position,
            parameterType: row.parameterType ?? null,
          },
        });
      }

      // 5. Authors diff
      const origAuthorIds = new Set(originalData?.authors.map((a) => a.id) ?? []);
      const newAuthorIds = new Set(formData.authors.map((a) => a.id));

      for (const id of origAuthorIds) {
        if (!newAuthorIds.has(id)) {
          await deleteAuthor({ variables: { configurationId, personId: id } });
        }
      }
      for (const author of formData.authors) {
        if (!origAuthorIds.has(author.id)) {
          await addAuthor({ variables: { configurationId, personId: author.id } });
        }
      }

      // 6. Regions diff
      const origRegionIds = new Set(originalData?.regions.map((r) => r.id) ?? []);
      const newRegionIds = new Set(formData.regions.map((r) => r.id));

      for (const id of origRegionIds) {
        if (!newRegionIds.has(id)) {
          await deleteRegion({ variables: { configurationId, regionId: id } });
        }
      }
      for (const region of formData.regions) {
        if (!origRegionIds.has(region.id)) {
          await addRegion({ variables: { configurationId, regionId: region.id } });
        }
      }

      // ConfigurationDetail reads the same GetConfiguration cache entry this form does,
      // and nothing above writes to the cache. Without this refresh the detail view
      // renders the pre-save entry and the save looks as though it did nothing.
      // A failed refresh must not report a successful save as failed.
      try {
        await refetchConfig();
      } catch {
        // Ignored: every write above already succeeded.
      }

      onSaved?.(configurationId);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to save. Please try again.');
    }
  };

  // ─── Loading states ──────────────────────────────────────────────────────────
  if (isEdit && configLoading) {
    return (
      <div className="flex items-center justify-center p-8">
        <LoadingSpinner />
      </div>
    );
  }

  if (isEdit && !config) {
    return (
      <div className="p-4 text-sm text-destructive">Configuration not found: {configurationId}</div>
    );
  }

  // ─── Render ──────────────────────────────────────────────────────────────────
  return (
    <FormProvider {...methods}>
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-6" noValidate>
        {/* ── Configuration Metadata ── */}
        <section aria-label="Configuration metadata">
          <h3 className="mb-3 text-sm font-semibold">Configuration Details</h3>
          <div className="space-y-3">
            <FormField
              control={control}
              name="label"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Name *</FormLabel>
                  <FormControl>
                    <Input placeholder="Configuration name" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={control}
              name="description"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Description</FormLabel>
                  <FormControl>
                    <Input placeholder="Optional description" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>
        </section>

        <Separator />

        {/* ── Inputs ── */}
        <InputOutputSection prefix="inputs" />

        <Separator />

        {/* ── Outputs ── */}
        <InputOutputSection prefix="outputs" />

        <Separator />

        {/* ── Parameters ── */}
        <ParameterSection />

        <Separator />

        {/* ── Authors ── */}
        <AuthorSection />

        <Separator />

        {/* ── Regions ── */}
        <RegionSection />

        {/* ── Error + Submit ── */}
        {saveError && (
          <p className="text-sm text-destructive" role="alert">
            {saveError}
          </p>
        )}

        <div className="flex justify-end gap-3">
          {onCancel && (
            <Button type="button" variant="outline" onClick={onCancel} disabled={saving}>
              Cancel
            </Button>
          )}
          <Button type="submit" disabled={saving || !formState.isDirty}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {saving ? 'Saving...' : isEdit ? 'Save Changes' : 'Create Configuration'}
          </Button>
        </div>
      </form>
    </FormProvider>
  );
}
