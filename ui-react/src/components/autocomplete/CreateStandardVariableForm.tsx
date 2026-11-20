/**
 * CreateStandardVariableForm
 *
 * The destination of the picker's create gate. A minimal form to mint a new
 * standard variable when none exists in the catalog. Inserts directly via
 * `insert_modelcatalog_standard_variable_one` (authenticated user role) and
 * hands the new record back through onCreated so the picker can select it.
 *
 * The operation is mirrored in `graphql/mutations/model-catalog.graphql` (the codegen
 * source of truth). It is still issued via an inline `gql` here because regenerating
 * the typed hook needs a live Hasura (admin secret). Once codegen has run, replace
 * this inline `gql` + `useMutation` with the generated `useCreateStandardVariableMutation`.
 *
 * Curation note: the find-before-create gate ("did you mean…") guards entry to
 * this form to avoid adding to the existing duplicate standard-variable rows.
 */

import * as React from 'react';
import { gql, useMutation } from '@apollo/client';

import { generateMintUri } from '@/lib/uri';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { StandardVariableOption } from '@/components/autocomplete/StandardVariableCombobox';

export const CREATE_STANDARD_VARIABLE = gql`
  mutation CreateStandardVariable($id: String!, $label: String!, $description: String) {
    insert_modelcatalog_standard_variable_one(
      object: { id: $id, label: $label, description: $description }
    ) {
      id
      label
      description
    }
  }
`;

export interface CreateStandardVariableFormProps {
  /** Seed for the name field (carried from the search query at the gate). */
  initialName?: string;
  /** Optional phenomenon context carried from the browse selection. */
  initialPhenomenon?: string | null;
  /** Called with the newly created variable once the insert succeeds. */
  onCreated: (variable: StandardVariableOption) => void;
  /** Called when the user backs out without creating. */
  onCancel: () => void;
}

export function CreateStandardVariableForm({
  initialName = '',
  initialPhenomenon = null,
  onCreated,
  onCancel,
}: CreateStandardVariableFormProps) {
  const [label, setLabel] = React.useState(initialName);
  const [description, setDescription] = React.useState('');
  const [createSv, { loading, error }] = useMutation(CREATE_STANDARD_VARIABLE);

  const canSubmit = label.trim() !== '' && !loading;

  const submit = React.useCallback(async () => {
    if (label.trim() === '') return;
    const desc = description.trim() === '' ? null : description.trim();
    let res;
    try {
      res = await createSv({
        variables: { id: generateMintUri(), label: label.trim(), description: desc },
      });
    } catch {
      return; // surfaced through `error` below
    }
    const created = res.data?.insert_modelcatalog_standard_variable_one;
    if (created) {
      onCreated({
        id: created.id,
        label: created.label,
        description: created.description ?? null,
      });
    }
  }, [label, description, createSv, onCreated]);

  return (
    <div className="px-4 py-4">
      <h3 className="text-sm font-semibold">Create a new standard variable</h3>
      {initialPhenomenon && (
        <p className="mt-0.5 text-xs text-muted-foreground">
          Phenomenon: <span className="font-mono text-foreground">{initialPhenomenon}</span>
        </p>
      )}

      <div className="mt-3 space-y-3">
        <div>
          <label htmlFor="new-sv-name" className="text-xs font-semibold text-muted-foreground">
            Name <span className="text-primary">*</span>
          </label>
          <Input
            id="new-sv-name"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="e.g. land_surface__albedo"
            className="mt-1"
          />
        </div>
        <div>
          <label
            htmlFor="new-sv-description"
            className="text-xs font-semibold text-muted-foreground"
          >
            Description
          </label>
          <textarea
            id="new-sv-description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What does this variable represent?"
            rows={2}
            className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-ring"
          />
        </div>
      </div>

      {error && (
        <p role="alert" className="mt-2 text-xs text-destructive">
          Could not create the standard variable: {error.message}
        </p>
      )}

      <div className="mt-4 flex items-center justify-end gap-2">
        <Button type="button" variant="outline" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="button" size="sm" disabled={!canSubmit} onClick={submit}>
          {loading ? 'Creating…' : 'Create variable'}
        </Button>
      </div>
    </div>
  );
}
