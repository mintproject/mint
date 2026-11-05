/**
 * InputRow — single row in the inputs or outputs field array.
 *
 * Fields: label, description, format, isOptional (junction field), and a
 * "Variables" subsection — zero, one, or many VariablePresentations, each linking
 * to an optional standard variable and unit.
 *
 * isOptional is a first-class field — stored on the configuration_input junction row.
 *
 * `allowMultipleVariables` gates the multi-variable UI:
 *   - true  (register): a field array with add/remove — an input can carry many variables.
 *   - false (edit form): a single fixed presentation editor bound to presentations[0],
 *                        preserving the legacy one-presentation-per-input behavior.
 */
import { useFieldArray, useFormContext } from 'react-hook-form';
import type { FieldArrayPath, Path } from 'react-hook-form';
import { PlusCircle, Trash2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import type { ConfigurationFormSchema } from '@/schemas/configuration';
import { emptyPresentationRow } from '@/schemas/configuration';
import { VariablePresentationRow } from './VariablePresentationRow';

export interface InputRowProps {
  /** Index within the inputs or outputs array (for field array paths). */
  index: number;
  /** Field array prefix: "inputs" or "outputs". */
  prefix: 'inputs' | 'outputs';
  /** Called when the user removes this row. */
  onRemove: () => void;
  /** When true, render an add/remove list of variables. Defaults to false. */
  allowMultipleVariables?: boolean;
}

export function InputRow({
  index,
  prefix,
  onRemove,
  allowMultipleVariables = false,
}: InputRowProps) {
  const { control, register, watch } = useFormContext<ConfigurationFormSchema>();

  // Cast to Path<ConfigurationFormSchema> — RHF's generic is too strict for
  // dynamic template literals, but the paths are always valid at runtime.
  const p = (field: string) => `${prefix}.${index}.${field}` as Path<ConfigurationFormSchema>;
  const appInputName = watch(p('appInputName')) as string | null | undefined;

  const presentationsName = `${prefix}.${index}.presentations`;
  const {
    fields: presentationFields,
    append: appendPresentation,
    remove: removePresentation,
  } = useFieldArray({
    control,
    name: presentationsName as FieldArrayPath<ConfigurationFormSchema>,
  });

  return (
    <div className="space-y-3 rounded-md border bg-card p-4">
      {/* Row header: position badge + remove button */}
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {prefix === 'inputs' ? 'Input' : 'Output'} {index + 1}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onRemove}
          className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
          aria-label={`Remove ${prefix === 'inputs' ? 'input' : 'output'} ${index + 1}`}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>

      {/* Label + Format row */}
      <div className="grid grid-cols-2 gap-3">
        <FormField
          control={control}
          name={p('label')}
          render={({ field }) => (
            <FormItem>
              <FormLabel>Label *</FormLabel>
              <FormControl>
                <Input
                  placeholder="e.g. Precipitation"
                  {...field}
                  value={(field.value as string) ?? ''}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={control}
          name={p('hasFormat')}
          render={({ field }) => (
            <FormItem>
              <FormLabel>Format</FormLabel>
              <FormControl>
                <Input
                  placeholder="e.g. CSV, NetCDF"
                  {...field}
                  value={(field.value as string) ?? ''}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
      </div>

      {/* Description */}
      <FormField
        control={control}
        name={p('description')}
        render={({ field }) => (
          <FormItem>
            <FormLabel>Description</FormLabel>
            <FormControl>
              <Input
                placeholder="Optional description"
                {...field}
                value={(field.value as string) ?? ''}
              />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />

      {/* isOptional */}
      <div className="flex items-center gap-2">
        <input
          type="checkbox"
          id={`${prefix}-${index}-isOptional`}
          className="h-4 w-4 cursor-pointer rounded border-input accent-primary"
          {...register(p('isOptional'))}
        />
        <label
          htmlFor={`${prefix}-${index}-isOptional`}
          className="cursor-pointer select-none text-sm text-muted-foreground"
        >
          Optional (not required for model execution)
        </label>
      </div>

      {/* appInputName: set by registration from the Tapis app definition; not editable here */}
      {appInputName ? (
        <p className="text-xs text-muted-foreground">
          Tapis file input: <code>{appInputName}</code>
        </p>
      ) : null}

      {/* Variables (presentations) */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold">Variables</span>
          {allowMultipleVariables && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => appendPresentation(emptyPresentationRow())}
              className="h-7 gap-1.5 text-xs"
            >
              <PlusCircle className="h-3.5 w-3.5" />
              Add Variable
            </Button>
          )}
        </div>

        {/*
          A promoted output carries a label only (#267). Saying so here is what
          stops that from reading as a bug later: the output publishes, but the
          Variables step filters models by standard variable, so a model whose
          outputs carry none never matches a modeling task.
        */}
        {prefix === 'outputs' && presentationFields.length === 0 && (
          <p className="text-xs text-muted-foreground">
            An output with no standard variable still publishes to the data catalog. It cannot match
            a modeling task until you give it one.
          </p>
        )}

        {allowMultipleVariables ? (
          presentationFields.length === 0 ? (
            <p className="rounded-md border py-3 text-center text-xs text-muted-foreground">
              No variables. This {prefix === 'inputs' ? 'input' : 'output'} carries zero standard
              variables. Click &ldquo;Add Variable&rdquo; to add one.
            </p>
          ) : (
            <div className="space-y-2">
              {presentationFields.map((field, pIndex) => (
                <VariablePresentationRow
                  key={field.id}
                  basePath={`${prefix}.${index}.presentations.${pIndex}`}
                  index={pIndex + 1}
                  onRemove={() => removePresentation(pIndex)}
                />
              ))}
            </div>
          )
        ) : (
          // Single-presentation mode (edit form): one fixed editor on presentations[0].
          <VariablePresentationRow basePath={`${prefix}.${index}.presentations.0`} index={1} />
        )}
      </div>
    </div>
  );
}
