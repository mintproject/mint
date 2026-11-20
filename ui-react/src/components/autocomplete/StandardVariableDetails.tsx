import { gql, useQuery } from '@apollo/client';

import { standardVariableDescription, standardVariableName } from '@/lib/standard-variable-display';
import type { StandardVariableOption } from './StandardVariableCombobox';

/** The units this standard variable is presented in. Kept inline: it is a read-only aid. */
const StandardVariableUnitsDocument = gql`
  query GetStandardVariableUnits($id: String!) {
    modelcatalog_standard_variable(where: { id: { _eq: $id } }, limit: 1) {
      id
      variable_presentations {
        id
        unit {
          id
          label
        }
      }
    }
  }
`;

interface UnitsData {
  modelcatalog_standard_variable: Array<{
    variable_presentations: Array<{ unit?: { label?: string | null } | null }>;
  }>;
}

/** A read-only look at a chosen standard variable (description, units) so it can be confirmed. */
export function StandardVariableDetails({ variable }: { variable: StandardVariableOption }) {
  const { data } = useQuery<UnitsData>(StandardVariableUnitsDocument, {
    variables: { id: variable.id },
    // Units are an aid: a deployment that cannot answer just shows none.
    errorPolicy: 'ignore',
  });
  const units = [
    ...new Set(
      (data?.modelcatalog_standard_variable[0]?.variable_presentations ?? [])
        .map((p) => p.unit?.label?.trim() ?? '')
        .filter(Boolean),
    ),
  ];
  return (
    <dl className="rounded-md border bg-muted/40 p-3 text-sm" data-testid="variable-details">
      <div className="flex gap-2">
        <dt className="font-medium">Name</dt>
        <dd>{standardVariableName(variable)}</dd>
      </div>
      <div className="flex gap-2">
        <dt className="font-medium">Description</dt>
        <dd>{standardVariableDescription(variable) ?? 'No description in the catalog.'}</dd>
      </div>
      <div className="flex gap-2">
        <dt className="font-medium">Units</dt>
        <dd>{units.length > 0 ? units.join(', ') : 'No units recorded.'}</dd>
      </div>
    </dl>
  );
}
