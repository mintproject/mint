/**
 * Mutation builder: transforms flattened form data into Hasura nested insert variables.
 *
 * This module handles the core innovation of the React UI:
 * converting a single form submission into the nested GraphQL mutation variables
 * that create DatasetSpecification + VariablePresentation + junction rows atomically.
 *
 * See: .planning/design/DESIGN-DOCUMENT.md §6.2–6.3 for design rationale.
 */

import { generateMintUri } from './uri';
import type {
  AddConfigurationInputMutationVariables,
  AddConfigurationOutputMutationVariables,
  AddConfigurationParameterMutationVariables,
  InsertVariablePresentationMutationVariables,
  Modelcatalog_Dataset_Specification_Presentation_Insert_Input,
} from '../graphql/generated/graphql';

// ─── Form data types ──────────────────────────────────────────────────────────

export interface StandardVariableSelection {
  id: string;
  label: string;
  description?: string | null;
}

export interface UnitSelection {
  id: string;
  label: string;
}

export interface PersonSelection {
  id: string;
  label: string;
}

export interface RegionSelection {
  id: string;
  label: string;
}

/**
 * One variable presentation on an input/output. An input can hold zero, one, or
 * many of these — each links to a single (optional) standard variable and unit.
 *
 * The VariablePresentation is hidden from the user: its label/long-name/short-name
 * are derived here rather than collected in the form.
 */
export interface PresentationRow {
  /** Existing VariablePresentation id — present in edit mode. */
  existingPresentationId?: string;
  standardVariable: StandardVariableSelection | null;
  unit: UnitSelection | null;
}

/** One row in the inputs or outputs field array of the configuration form. */
export interface InputRow {
  /** Existing DS id — present in edit mode, absent when adding a new row. */
  existingId?: string;
  label: string;
  description?: string;
  hasFormat?: string;
  hasDimensionality?: number;
  position: number;
  isOptional: boolean;
  /** Zero, one, or many variable presentations — one per standard variable. */
  presentations: PresentationRow[];
}

/**
 * Resolve a presentation's label. VariablePresentation.label is NOT NULL, so every
 * kept presentation must have a non-empty label. Since the presentation is hidden
 * from the user, derive it from the standard variable, falling back to the input label.
 */
function resolvePresentationLabel(row: InputRow, presentation: PresentationRow): string {
  return presentation.standardVariable?.label?.trim() || row.label;
}

/**
 * A presentation row is "empty" — and dropped on submit — when it carries neither a
 * standard variable nor a unit. Empty rows would otherwise create meaningless VPs.
 */
function isEmptyPresentation(p: PresentationRow): boolean {
  return !p.standardVariable && !p.unit;
}

/**
 * Map an input's kept presentations to the nested junction insert objects expected by
 * the `$presentations` mutation variable. Each entry nest-creates a VariablePresentation
 * and its dataset_specification_presentation junction row.
 */
function buildPresentationInserts(
  row: InputRow,
): Modelcatalog_Dataset_Specification_Presentation_Insert_Input[] {
  return row.presentations
    .filter((p) => !isEmptyPresentation(p))
    .map((p) => ({
      presentation: {
        data: {
          id: p.existingPresentationId ?? generateMintUri(),
          label: resolvePresentationLabel(row, p),
          has_long_name: null,
          has_short_name: null,
          has_standard_variable: p.standardVariable?.id ?? null,
          uses_unit: p.unit?.id ?? null,
        },
      },
    }));
}

/**
 * Build variables to insert a NEW VariablePresentation onto an existing dataset
 * specification (input/output) in edit mode.
 *
 * The update path can only UPDATE a presentation that already exists. When a row
 * that had no presentation gains a standard variable/unit, there is nothing to
 * update — without this insert the selection would be silently dropped. Returns
 * null when no insert is needed: the presentation already exists (update handles
 * it) or the row is empty (no standard variable and no unit).
 */
export function buildPresentationInsertForExistingDs(
  datasetSpecificationId: string,
  row: InputRow,
): InsertVariablePresentationMutationVariables | null {
  const p = row.presentations[0];
  if (!p || p.existingPresentationId || isEmptyPresentation(p)) return null;
  return {
    datasetSpecificationId,
    presentationId: generateMintUri(),
    label: resolvePresentationLabel(row, p),
    hasStandardVariable: p.standardVariable?.id ?? null,
    usesUnit: p.unit?.id ?? null,
  };
}

/** One row in the parameters field array. */
export interface ParameterRow {
  /** Existing parameter id — present in edit mode. */
  existingId?: string;
  label: string;
  description?: string;
  hasDataType?: string;
  hasDefaultValue?: string;
  hasMinimumAcceptedValue?: string;
  hasMaximumAcceptedValue?: string;
  hasFixedValue?: string;
  hasAcceptedValues?: string[];
  position: number;
  parameterType?: string;
}

/** Full form data for a model configuration. */
export interface ConfigurationFormData {
  label: string;
  description?: string;
  inputs: InputRow[];
  outputs: InputRow[];
  parameters: ParameterRow[];
  authors: PersonSelection[];
  regions: RegionSelection[];
}

// ─── Builders ────────────────────────────────────────────────────────────────

/**
 * Build mutation variables for adding a new configuration input.
 * Creates DatasetSpecification + VariablePresentation + junction rows in one shot.
 */
export function buildAddInputVariables(
  configurationId: string,
  row: InputRow,
): AddConfigurationInputMutationVariables {
  const inputId = row.existingId ?? generateMintUri();

  return {
    configurationId,
    isOptional: row.isOptional,
    inputId,
    inputLabel: row.label,
    inputDescription: row.description ?? null,
    hasFormat: row.hasFormat ?? null,
    hasDimensionality: row.hasDimensionality ?? null,
    position: row.position,
    presentations: buildPresentationInserts(row),
  };
}

/**
 * Build mutation variables for adding a new configuration output.
 * Creates DatasetSpecification + VariablePresentation + junction rows.
 */
export function buildAddOutputVariables(
  configurationId: string,
  row: InputRow,
): AddConfigurationOutputMutationVariables {
  const outputId = row.existingId ?? generateMintUri();

  return {
    configurationId,
    outputId,
    outputLabel: row.label,
    outputDescription: row.description ?? null,
    hasFormat: row.hasFormat ?? null,
    hasDimensionality: row.hasDimensionality ?? null,
    position: row.position,
    presentations: buildPresentationInserts(row),
  };
}

/**
 * Serialize a string array into a Postgres array literal (e.g. `{"a","b"}`).
 *
 * Hasura's `_text` scalar rejects JSON arrays when passed as a GraphQL variable
 * ("A string is expected for type: _text"); it expects the Postgres literal as a
 * string. Returns null for empty/missing input so the column is left unset.
 */
export function toPgTextArray(values?: string[] | null): string | null {
  const kept = (values ?? []).filter((v) => v.trim().length > 0);
  if (kept.length === 0) return null;
  const escaped = kept.map((v) => `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`);
  return `{${escaped.join(',')}}`;
}

/**
 * Build mutation variables for adding a new parameter to a configuration.
 */
export function buildAddParameterVariables(
  configurationId: string,
  row: ParameterRow,
): AddConfigurationParameterMutationVariables {
  const parameterId = row.existingId ?? generateMintUri();

  return {
    configurationId,
    parameterId,
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
  };
}

/**
 * Assign sequential position values to all rows in a field array.
 *
 * Position is 1-indexed from the array order, never 0. The Ensemble Manager
 * treats a falsy position as an absent one — `_getModelIODetails` in
 * `ExecutionCreation.ts` returns null for it — and refuses the whole run with
 * "Input file missing position". It also builds the component prefix from the
 * number (`-i1`, `-p1`), which the 1-based catalogue already assumes.
 */
export function assignPositions<T extends { position?: number }>(rows: T[]): T[] {
  return rows.map((row, index) => ({ ...row, position: index + 1 }));
}

/**
 * Compute the diff between original and modified input/output rows.
 *
 * Returns:
 * - toAdd: rows that are new (no existingId or existingId not in original)
 * - toRemove: existingIds from original that are missing in modified
 * - toUpdate: rows that exist in both but have changed fields
 */
export function diffInputRows(
  originalRows: InputRow[],
  modifiedRows: InputRow[],
): {
  toAdd: InputRow[];
  toRemove: string[];
  toUpdate: InputRow[];
} {
  const originalMap = new Map(
    originalRows.filter((r) => r.existingId).map((r) => [r.existingId!, r]),
  );
  const modifiedMap = new Map(
    modifiedRows.filter((r) => r.existingId).map((r) => [r.existingId!, r]),
  );

  const toAdd = modifiedRows.filter((r) => !r.existingId);

  const toRemove = [...originalMap.keys()].filter((id) => !modifiedMap.has(id));

  const toUpdate = modifiedRows.filter((r) => {
    if (!r.existingId) return false;
    const orig = originalMap.get(r.existingId);
    if (!orig) return false;
    // The edit form handles a single presentation per input; compare presentations[0].
    const op = orig.presentations[0];
    const mp = r.presentations[0];
    // Detect any change in key fields
    return (
      orig.label !== r.label ||
      orig.description !== r.description ||
      orig.hasFormat !== r.hasFormat ||
      orig.hasDimensionality !== r.hasDimensionality ||
      orig.isOptional !== r.isOptional ||
      op?.standardVariable?.id !== mp?.standardVariable?.id ||
      op?.unit?.id !== mp?.unit?.id
    );
  });

  return { toAdd, toRemove, toUpdate };
}

/**
 * Compute the diff between original and modified parameter rows.
 */
export function diffParameterRows(
  originalRows: ParameterRow[],
  modifiedRows: ParameterRow[],
): {
  toAdd: ParameterRow[];
  toRemove: string[];
  toUpdate: ParameterRow[];
} {
  const originalMap = new Map(
    originalRows.filter((r) => r.existingId).map((r) => [r.existingId!, r]),
  );
  const modifiedMap = new Map(
    modifiedRows.filter((r) => r.existingId).map((r) => [r.existingId!, r]),
  );

  const toAdd = modifiedRows.filter((r) => !r.existingId);

  const toRemove = [...originalMap.keys()].filter((id) => !modifiedMap.has(id));

  const toUpdate = modifiedRows.filter((r) => {
    if (!r.existingId) return false;
    const orig = originalMap.get(r.existingId);
    if (!orig) return false;
    return (
      orig.label !== r.label ||
      orig.description !== r.description ||
      orig.hasDataType !== r.hasDataType ||
      orig.hasDefaultValue !== r.hasDefaultValue ||
      orig.hasMinimumAcceptedValue !== r.hasMinimumAcceptedValue ||
      orig.hasMaximumAcceptedValue !== r.hasMaximumAcceptedValue ||
      orig.hasFixedValue !== r.hasFixedValue ||
      orig.parameterType !== r.parameterType ||
      JSON.stringify(orig.hasAcceptedValues ?? []) !== JSON.stringify(r.hasAcceptedValues ?? [])
    );
  });

  return { toAdd, toRemove, toUpdate };
}
