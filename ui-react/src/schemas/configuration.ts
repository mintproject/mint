/**
 * Zod validation schemas for the ConfigurationForm.
 *
 * Each schema corresponds to a section of the flattened form.
 * The configurationFormSchema is the root schema used with React Hook Form.
 *
 * See: .planning/design/DESIGN-DOCUMENT.md §6.4
 */
import { SECRET_PARAMETER_TYPE, secretEntriesError } from '@/lib/secret-parameters';
import { z } from 'zod';

// ─── Reference entity selections ─────────────────────────────────────────────

export const standardVariableSelectionSchema = z.object({
  id: z.string().min(1),
  label: z.string(),
  description: z.string().nullable().optional(),
});

export const unitSelectionSchema = z.object({
  id: z.string().min(1),
  label: z.string(),
});

export const personSelectionSchema = z.object({
  id: z.string().min(1),
  label: z.string(),
});

export const regionSelectionSchema = z.object({
  id: z.string().min(1),
  label: z.string(),
});

// ─── Variable presentation row ─────────────────────────────────────────────────
// An input (DatasetSpecification) can hold zero, one, or many VariablePresentations.
// Each presentation links to a single standard variable + unit. The VariablePresentation
// itself is hidden from the user: its label/long-name/short-name are derived on submit
// (see mutation-builder), so the form only collects the standard variable + unit.
// This is the ontological path for "an input has many standard variables".

export const presentationRowSchema = z.object({
  /** Present in edit mode (existing VariablePresentation id). */
  existingPresentationId: z.string().optional(),
  standardVariable: standardVariableSelectionSchema.nullable().default(null),
  unit: unitSelectionSchema.nullable().default(null),
});

export type PresentationRowSchema = z.infer<typeof presentationRowSchema>;

// ─── Input / Output row ───────────────────────────────────────────────────────

export const inputRowSchema = z.object({
  /** Present in edit mode (existing DatasetSpecification id). */
  existingId: z.string().optional(),
  label: z.string().min(1, 'Input label is required'),
  description: z.string().optional(),
  hasFormat: z.string().optional(),
  hasDimensionality: z.number().int().min(0).optional(),
  position: z.number().int().min(0),
  /** First-class form field — stored on the junction row. */
  isOptional: z.boolean().default(false),
  /** Zero, one, or many standard variables — one per VariablePresentation. */
  presentations: z.array(presentationRowSchema).default([]),
});

export type InputRowSchema = z.infer<typeof inputRowSchema>;

// ─── Parameter row ────────────────────────────────────────────────────────────

/** Parse a min/max bound to a comparable number for ordered types. */
function parseBound(dataType: string | undefined, raw: string): number | null {
  if (!raw.trim()) return null;
  if (dataType === 'integer' || dataType === 'float') {
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }
  if (dataType === 'datetime') {
    const t = Date.parse(raw);
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

export const parameterRowSchema = z
  .object({
    /** Present in edit mode. */
    existingId: z.string().optional(),
    label: z.string().min(1, 'Parameter label is required'),
    description: z.string().optional(),
    hasDataType: z.string().optional(),
    hasDefaultValue: z.string().optional(),
    hasMinimumAcceptedValue: z.string().optional(),
    hasMaximumAcceptedValue: z.string().optional(),
    hasFixedValue: z.string().optional(),
    hasAcceptedValues: z.array(z.string()).optional(),
    position: z.number().int().min(0),
    parameterType: z.string().optional(),
  })
  .superRefine((row, ctx) => {
    // A secret row names a credential: no value, and an explicit field=ENV_KEY map.
    if (row.parameterType === SECRET_PARAMETER_TYPE) {
      const entriesError = secretEntriesError(row.hasAcceptedValues);
      if (entriesError) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: entriesError,
          path: ['hasAcceptedValues'],
        });
      }
      return;
    }
    // For ordered types, a present min must not exceed a present max.
    const min = parseBound(row.hasDataType, row.hasMinimumAcceptedValue ?? '');
    const max = parseBound(row.hasDataType, row.hasMaximumAcceptedValue ?? '');
    if (min !== null && max !== null && min > max) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Min value must be less than or equal to Max value',
        path: ['hasMaximumAcceptedValue'],
      });
    }
  });

export type ParameterRowSchema = z.infer<typeof parameterRowSchema>;

// ─── Root form ────────────────────────────────────────────────────────────────

export const configurationFormSchema = z.object({
  label: z.string().min(1, 'Configuration name is required'),
  description: z.string().optional(),
  inputs: z.array(inputRowSchema),
  outputs: z.array(inputRowSchema),
  parameters: z.array(parameterRowSchema),
  authors: z.array(personSelectionSchema),
  regions: z.array(regionSelectionSchema),
});

export type ConfigurationFormSchema = z.infer<typeof configurationFormSchema>;

// ─── Default / empty row factories ───────────────────────────────────────────

export function emptyPresentationRow(): PresentationRowSchema {
  return {
    standardVariable: null,
    unit: null,
  };
}

export function emptyInputRow(position: number): InputRowSchema {
  return {
    label: '',
    description: '',
    hasFormat: '',
    position,
    isOptional: false,
    // Start with zero variables — the user adds them explicitly with "Add Variable".
    presentations: [],
  };
}

export function emptyParameterRow(position: number): ParameterRowSchema {
  return {
    label: '',
    description: '',
    hasDataType: '',
    hasDefaultValue: '',
    hasMinimumAcceptedValue: '',
    hasMaximumAcceptedValue: '',
    hasFixedValue: '',
    hasAcceptedValues: [],
    position,
  };
}
