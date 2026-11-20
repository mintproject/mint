/**
 * useScopedStandardVariables — the option list for a StandardVariableCombobox.
 *
 * The catalog holds far more standard variables than the thread wizard can act
 * on. At TACC it holds 668, of which 147 are produced by a configuration the
 * Models step lists and 161 are taken as an input or adjusted by a parameter.
 * Offering all 668 lets a user pick a legitimate variable and meet a confident
 * zero one step later, which is the failure mode the map already rejected once
 * for dataset search (monorepo#96).
 *
 * So a scope narrows the list:
 *
 * - `all`       — every standard variable. Registration forms use this: they
 *                 describe a model rather than search one, so no row is a dead
 *                 end. This is the default, and it costs no extra query.
 * - `indicator` — the variables a listed configuration produces, plus SVOs
 *                 emitted by registered adapter transforms (thread
 *                 response_variable_id).
 * - `driver`    — with no selected outcome, the variables a listed
 *                 configuration takes as an input, plus the variables its
 *                 parameters adjust. With an outcome selected, this becomes
 *                 the upstream variables reachable through model and ETL
 *                 transforms, including multi-step chains. When the thread
 *                 already has selected model configurations, only those
 *                 model transforms seed the graph; this prevents unrelated
 *                 catalog models from leaking into the driver list.
 *
 * The full catalog is loaded only when it is asked for — scope `all`, or a
 * narrowed picker whose user has clicked the widen link. Measured against TACC,
 * gzipped: the full list is 35.8 KB, the indicator list 22.2 KB and the driver
 * list 20.8 KB. Loading the full list eagerly beside a scoped one would more
 * than double the step's cost for a list most users never open.
 */
import { gql, useQuery } from '@apollo/client';
import { useMemo } from 'react';

import {
  useGetDriverVariableOptionsQuery,
  useGetIndicatorVariableOptionsQuery,
  usePrefetchReferenceDataQuery,
} from '@/graphql/generated/graphql';
import type { StandardVariableOption } from './StandardVariableCombobox';
import {
  inferOutcomeDriverOptions,
  type InferenceVariable,
  type InferenceTransformKind,
  type VariableTransform,
} from '@/lib/modeling/outcome-driver-inference';
import {
  UNNAMED_STANDARD_VARIABLE,
  standardVariableLabelKey,
} from '@/lib/standard-variable-display';
import { slugFromUri } from '@/lib/uri';

export type StandardVariableScope = 'all' | 'indicator' | 'driver';

interface StandardVariableFields {
  id: string;
  label?: string | null;
  description?: string | null;
}

/**
 * Map a catalog row to a combobox option.
 *
 * Shared so that a scoped list and the full list render identically — a row
 * must not change its label just because it arrived through a different query.
 */
export function toStandardVariableOption(sv: StandardVariableFields): StandardVariableOption {
  return {
    id: sv.id,
    label: sv.label?.trim() || UNNAMED_STANDARD_VARIABLE,
    description: sv.description?.trim() || (sv.label ? null : `Catalog ID: ${sv.id}`),
  };
}

function byLabel(a: StandardVariableOption, b: StandardVariableOption) {
  return a.label.localeCompare(b.label);
}

function dedupe(rows: Array<StandardVariableFields | null | undefined>): StandardVariableOption[] {
  const byId = new Map<string, StandardVariableOption>();
  for (const sv of rows) {
    if (sv && !byId.has(sv.id)) byId.set(sv.id, toStandardVariableOption(sv));
  }
  return [...byId.values()].sort(byLabel);
}

/**
 * Kept inline until the generated schema includes the MINT ETL and SVO adapter
 * registries. The model/ETL operation is required for scoped inference; the
 * adapter operation is optional because older Hasura metadata may not expose
 * that registry to the authenticated user role yet.
 */
export const OutcomeDriverModelInferenceDocument = gql`
  query GetOutcomeDriverModelInference {
    modelConfigurations: modelcatalog_configuration(
      where: {
        _or: [
          { software_version_id: { _is_null: false }, _not: { child_configurations: {} } }
          { parent_configuration: { software_version_id: { _is_null: false } } }
        ]
      }
    ) {
      id
      inputs {
        configuration_id
        input_id
        input {
          id
          has_format
          presentations {
            dataset_specification_id
            presentation_id
            presentation {
              id
              standard_variable {
                id
                label
                description
              }
            }
          }
        }
      }
      outputs {
        configuration_id
        output_id
        output {
          id
          has_format
          presentations {
            dataset_specification_id
            presentation_id
            presentation {
              id
              standard_variable {
                id
                label
                description
              }
            }
          }
        }
      }
      parameters {
        configuration_id
        parameter_id
        parameter {
          id
          adjusts_variables {
            parameter_id
            variable_id
            variable {
              id
              standard_variable {
                id
                label
                description
              }
            }
          }
        }
      }
    }
    etlProcesses: modelcatalog_etl_process {
      contracts(order_by: [{ role: asc }, { position: asc }]) {
        role
        standard_variable_uri
        format
      }
    }
  }
`;

/**
 * The adapter registry is optional for the model/ETL inference path. Keep it
 * in a separate operation so a role that cannot see this registry does not
 * make the model and ETL query fail validation as a whole.
 */
export const OutcomeDriverAdapterInferenceDocument = gql`
  query GetOutcomeDriverAdapterInference {
    adapterTransforms: adapter_transform_spec {
      contracts {
        role
        standard_variable_uri
        format
      }
    }
  }
`;

export const IndicatorAdapterInferenceDocument = gql`
  query GetIndicatorAdapterInference {
    adapterTransforms: adapter_transform_spec {
      contracts {
        role
        standard_variable_uri
        format
      }
    }
  }
`;

interface InferenceStandardVariable extends InferenceVariable {
  id: string;
}

interface InferencePresentation {
  presentation?: { standard_variable?: InferenceStandardVariable | null } | null;
}

interface InferenceConfigurationInput {
  input?: { has_format?: string | null; presentations?: InferencePresentation[] | null } | null;
}

interface InferenceConfigurationOutput {
  output?: { has_format?: string | null; presentations?: InferencePresentation[] | null } | null;
}

interface InferenceParameter {
  parameter?: {
    adjusts_variables?: Array<{
      variable?: { standard_variable?: InferenceStandardVariable | null } | null;
    }> | null;
  } | null;
}

interface InferenceModelConfiguration {
  id: string;
  inputs?: InferenceConfigurationInput[] | null;
  outputs?: InferenceConfigurationOutput[] | null;
  parameters?: InferenceParameter[] | null;
}

interface InferenceEtlProcess {
  contracts?: Array<{
    role: string;
    standard_variable_uri?: string | null;
    format?: string | null;
  }> | null;
}

interface OutcomeDriverModelInferenceData {
  modelConfigurations: InferenceModelConfiguration[];
  etlProcesses: InferenceEtlProcess[];
}

interface OutcomeDriverAdapterInferenceData {
  adapterTransforms: InferenceEtlProcess[];
}

function presentationVariables(
  presentations: InferencePresentation[] | null | undefined,
): InferenceVariable[] {
  return (presentations ?? [])
    .map((row) => row.presentation?.standard_variable)
    .filter((variable): variable is InferenceVariable => Boolean(variable?.id));
}

function presentationContracts(
  presentations: InferencePresentation[] | null | undefined,
  format?: string | null,
): InferenceVariable[] {
  const variables = presentationVariables(presentations).map((variable) => ({
    ...variable,
    format: format?.trim() || null,
  }));
  const normalizedFormat = format?.trim();
  if (variables.length === 0 && normalizedFormat) {
    return [{ id: '', label: normalizedFormat, description: null, format: normalizedFormat }];
  }
  return variables;
}

function modelTransforms(
  data: OutcomeDriverModelInferenceData | undefined,
  selectedConfigurationIds: ReadonlyArray<string> = [],
): VariableTransform[] {
  const selectedIds = new Set(selectedConfigurationIds);
  const configurations = (data?.modelConfigurations ?? []).filter(
    (configuration) => selectedIds.size === 0 || selectedIds.has(configuration.id),
  );
  return configurations.map((configuration) => {
    const outputs =
      configuration.outputs?.flatMap((row) =>
        presentationContracts(row.output?.presentations, row.output?.has_format),
      ) ?? [];
    const inputs =
      configuration.inputs?.flatMap((row) =>
        presentationContracts(row.input?.presentations, row.input?.has_format),
      ) ?? [];
    const adjusted =
      configuration.parameters?.flatMap(
        (row) =>
          row.parameter?.adjusts_variables
            ?.map((adjustment) => adjustment.variable?.standard_variable)
            .filter((variable): variable is InferenceVariable => Boolean(variable?.id)) ?? [],
      ) ?? [];
    return { kind: 'model', outputs, inputs: [...inputs, ...adjusted] };
  });
}

function contractTransforms(
  processes: InferenceEtlProcess[] | undefined,
  kind: InferenceTransformKind,
): VariableTransform[] {
  return (processes ?? []).map((process) => {
    const contracts = process.contracts ?? [];
    const toVariable = (
      uri: string | null | undefined,
      format: string | null | undefined,
    ): InferenceVariable | null => {
      const id = uri?.trim();
      const normalizedFormat = format?.trim() || null;
      if (!id && !normalizedFormat) return null;
      return {
        id: id ?? '',
        label: id || normalizedFormat,
        description: null,
        format: normalizedFormat,
      };
    };
    return {
      kind,
      outputs: contracts
        .filter((contract) => contract.role === 'output')
        .map((contract) => toVariable(contract.standard_variable_uri, contract.format))
        .filter((variable): variable is InferenceVariable => Boolean(variable)),
      inputs: contracts
        .filter((contract) => contract.role === 'input')
        .map((contract) => toVariable(contract.standard_variable_uri, contract.format))
        .filter((variable): variable is InferenceVariable => Boolean(variable)),
    };
  });
}

export interface ScopedStandardVariables {
  /** Options for the scope. Equals `all` when the scope is `all`. */
  scoped: StandardVariableOption[];
  /** Every standard variable in the catalog. Empty until `loadAll` is set. */
  all: StandardVariableOption[];
  /** True once `all` holds the catalog, so a caller can print its size. */
  allLoaded: boolean;
  loading: boolean;
}

/**
 * @param scope   which list to offer.
 * @param loadAll fetch the full catalog as well. Forced on for scope `all`.
 */
export function useScopedStandardVariables(
  scope: StandardVariableScope = 'all',
  loadAll = false,
  driverOutcomeId?: string | null,
  driverOutcomeLabel?: string | null,
  selectedConfigurationIds: ReadonlyArray<string> = [],
): ScopedStandardVariables {
  const wantAll = scope === 'all' || loadAll;
  const allQ = usePrefetchReferenceDataQuery({ fetchPolicy: 'cache-first', skip: !wantAll });
  const indicatorQ = useGetIndicatorVariableOptionsQuery({
    fetchPolicy: 'cache-first',
    skip: scope !== 'indicator',
  });
  const indicatorAdapterQ = useQuery<OutcomeDriverAdapterInferenceData>(
    IndicatorAdapterInferenceDocument,
    {
      fetchPolicy: 'cache-first',
      skip: scope !== 'indicator',
    },
  );
  const driverQ = useGetDriverVariableOptionsQuery({
    fetchPolicy: 'cache-first',
    skip: scope !== 'driver',
  });
  const outcomeDriverModelQ = useQuery<OutcomeDriverModelInferenceData>(
    OutcomeDriverModelInferenceDocument,
    {
      fetchPolicy: 'cache-first',
      skip: scope !== 'driver' || !driverOutcomeId,
    },
  );
  const outcomeDriverAdapterQ = useQuery<OutcomeDriverAdapterInferenceData>(
    OutcomeDriverAdapterInferenceDocument,
    {
      fetchPolicy: 'cache-first',
      skip: scope !== 'driver' || !driverOutcomeId,
    },
  );

  const all = useMemo(() => dedupe(allQ.data?.modelcatalog_standard_variable ?? []), [allQ.data]);

  const scoped = useMemo(() => {
    if (scope === 'indicator') {
      const rows = indicatorQ.data?.modelcatalog_dataset_specification_presentation ?? [];
      const adapterOutputs = (indicatorAdapterQ.data?.adapterTransforms ?? []).flatMap((process) =>
        (process.contracts ?? [])
          .filter((contract) => contract.role === 'output' && contract.standard_variable_uri)
          .map((contract) => {
            const id = contract.standard_variable_uri!.trim();
            return { id, label: slugFromUri(id), description: null };
          }),
      );
      const catalog = dedupe(rows.map((r) => r.presentation.standard_variable));
      // An adapter contract names a variable by URI slug, and the catalog holds
      // the same variable under its own id. Keep the catalog row, which carries
      // the description, and add only the adapter outputs it does not already list.
      const listed = new Set(catalog.map((o) => standardVariableLabelKey(o)));
      return dedupe([
        ...catalog,
        ...adapterOutputs.filter((o) => !listed.has(standardVariableLabelKey(o))),
      ]);
    }
    if (scope === 'driver') {
      const inputs = driverQ.data?.inputs ?? [];
      const adjusted = driverQ.data?.adjusted ?? [];
      const legacy = dedupe([
        ...inputs.map((r) => r.presentation.standard_variable),
        ...adjusted.map((r) => r.variable.standard_variable),
      ]);
      if (!driverOutcomeId) return legacy;
      // Once an outcome is selected, never fall back to the global driver
      // list. A missing optional adapter registry must not re-introduce
      // unrelated variables such as air__temperature.
      if (!outcomeDriverModelQ.data) return [];
      const outcome = { id: driverOutcomeId, label: driverOutcomeLabel };
      const etlTransforms = contractTransforms(outcomeDriverModelQ.data.etlProcesses, 'etl');
      const adapterTransforms = contractTransforms(
        outcomeDriverAdapterQ.data?.adapterTransforms,
        'adapter',
      );
      const allModelTransforms = modelTransforms(outcomeDriverModelQ.data);
      const selectedModelTransforms = modelTransforms(
        outcomeDriverModelQ.data,
        selectedConfigurationIds,
      );
      const selectedDrivers =
        selectedConfigurationIds.length > 0
          ? inferOutcomeDriverOptions(outcome, [
              ...selectedModelTransforms,
              ...etlTransforms,
              ...adapterTransforms,
            ])
          : [];

      // Variables is visited before Models and a thread can retain a model
      // selected for a previous outcome. If those models cannot reach the new
      // outcome, show the drivers from the available outcome-producing paths
      // instead of an empty picker.
      const modelTransformsForOutcome =
        selectedDrivers.length > 0 ? selectedModelTransforms : allModelTransforms;
      return dedupe(
        inferOutcomeDriverOptions(outcome, [
          ...modelTransformsForOutcome,
          ...etlTransforms,
          ...adapterTransforms,
        ]),
      );
    }
    return all;
  }, [
    scope,
    indicatorQ.data,
    indicatorAdapterQ.data,
    driverQ.data,
    outcomeDriverModelQ.data,
    outcomeDriverAdapterQ.data,
    driverOutcomeId,
    driverOutcomeLabel,
    selectedConfigurationIds,
    all,
  ]);

  const scopeLoading =
    (scope === 'indicator' && (indicatorQ.loading || indicatorAdapterQ.loading)) ||
    (scope === 'driver' &&
      (driverQ.loading || outcomeDriverModelQ.loading || outcomeDriverAdapterQ.loading));

  return {
    scoped,
    all,
    allLoaded: wantAll && !allQ.loading && allQ.data != null,
    loading: (wantAll && allQ.loading) || scopeLoading,
  };
}
