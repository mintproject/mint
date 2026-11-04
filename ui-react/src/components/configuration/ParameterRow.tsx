/**
 * ParameterRow — single row in the parameters field array.
 *
 * A parameter is either:
 *  - adjustable: has a default value, optionally bounded by min/max, or
 *  - fixed: locked to a single value (not adjustable when the model runs).
 *
 * The "Lock to a fixed value" switch converts the typed default into the fixed
 * value and hides the adjustable fields. The lock state is derived from whether
 * `hasFixedValue` is set, so it round-trips in edit mode.
 *
 * Value inputs adapt to the selected data type (number / datetime-local /
 * true-false select / text). Min/Max only apply to ordered types
 * (integer, float, datetime).
 */
import { useState } from 'react';
import { useFormContext, useWatch } from 'react-hook-form';
import type { ControllerRenderProps, Path } from 'react-hook-form';
import { Trash2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { SECRET_PARAMETER_TYPE } from '@/lib/secret-parameters';
import type { ConfigurationFormSchema } from '@/schemas/configuration';

const DATA_TYPES = ['string', 'integer', 'float', 'boolean', 'url', 'datetime'];

/** Types for which a Min/Max range is meaningful. */
const NUMERIC_OR_DATE_TYPES = ['integer', 'float', 'datetime'];

/** Shared styling for native <select> controls (matches the data-type select). */
const SELECT_CLASS =
  'flex h-10 w-full items-center justify-between whitespace-nowrap rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-50';

type ParameterField = ControllerRenderProps<ConfigurationFormSchema, Path<ConfigurationFormSchema>>;

export interface ParameterRowProps {
  index: number;
  onRemove: () => void;
}

export function ParameterRow({ index, onRemove }: ParameterRowProps) {
  const { control, getValues, setValue } = useFormContext<ConfigurationFormSchema>();

  // Cast to Path<ConfigurationFormSchema> — RHF generic is too strict for
  // dynamic template literals, but the paths are always valid at runtime.
  const p = (field: string) => `parameters.${index}.${field}` as Path<ConfigurationFormSchema>;

  const dataType = (useWatch({ control, name: p('hasDataType') }) as string | undefined) ?? '';
  const isBounded = NUMERIC_OR_DATE_TYPES.includes(dataType);
  const isSecret =
    (useWatch({ control, name: p('parameterType') }) as string | undefined) ===
    SECRET_PARAMETER_TYPE;

  /** Switching to a secret drops any value: a secret row never carries one. */
  const handleSecretChange = (next: boolean) => {
    setValue(p('parameterType'), next ? SECRET_PARAMETER_TYPE : undefined, { shouldDirty: true });
    if (next) {
      for (const field of [
        'hasDefaultValue',
        'hasFixedValue',
        'hasMinimumAcceptedValue',
        'hasMaximumAcceptedValue',
      ]) {
        setValue(p(field), '', { shouldDirty: true });
      }
      setLocked(false);
    }
  };

  // A parameter starts "locked" when it already carries a fixed value (edit mode).
  const [locked, setLocked] = useState(() => Boolean(getValues(p('hasFixedValue'))));

  /** Toggle between adjustable and fixed, carrying the value across. */
  const handleLockChange = (next: boolean) => {
    if (next) {
      // Fixing: the default becomes the fixed value; clear adjustable fields.
      const current = (getValues(p('hasDefaultValue')) as string | undefined) ?? '';
      setValue(p('hasFixedValue'), current, { shouldDirty: true });
      setValue(p('hasDefaultValue'), '', { shouldDirty: true });
      setValue(p('hasMinimumAcceptedValue'), '', { shouldDirty: true });
      setValue(p('hasMaximumAcceptedValue'), '', { shouldDirty: true });
    } else {
      // Unlocking: the fixed value returns to being the default.
      const current = (getValues(p('hasFixedValue')) as string | undefined) ?? '';
      setValue(p('hasDefaultValue'), current, { shouldDirty: true });
      setValue(p('hasFixedValue'), '', { shouldDirty: true });
    }
    setLocked(next);
  };

  /** When the type can't be bounded, drop any stale min/max so they aren't submitted. */
  const clearBoundsIfUnbounded = (next: string | undefined) => {
    if (!NUMERIC_OR_DATE_TYPES.includes(next ?? '')) {
      setValue(p('hasMinimumAcceptedValue'), '', { shouldDirty: true });
      setValue(p('hasMaximumAcceptedValue'), '', { shouldDirty: true });
    }
  };

  /**
   * Render a value control whose type matches the selected data type.
   *
   * `dateBound` applies to datetime Min/Max: those are date-only pickers whose
   * stored value is normalized to the start (00:00:00) or end (23:59:59) of the
   * chosen day, so a range always spans whole days.
   */
  const renderValueControl = (
    field: ParameterField,
    placeholder: string,
    dateBound?: 'start' | 'end',
  ) => {
    const value = (field.value as string) ?? '';

    if (dataType === 'datetime' && dateBound) {
      const datePart = value.split('T')[0] ?? '';
      const suffix = dateBound === 'start' ? 'T00:00:00' : 'T23:59:59';
      return (
        <Input
          type="date"
          placeholder={placeholder}
          name={field.name}
          ref={field.ref}
          value={datePart}
          onBlur={field.onBlur}
          onChange={(e) =>
            field.onChange(e.target.value ? `${e.target.value}${suffix}` : undefined)
          }
        />
      );
    }

    if (dataType === 'boolean') {
      return (
        <select
          className={SELECT_CLASS}
          name={field.name}
          value={value}
          onChange={(e) => field.onChange(e.target.value || undefined)}
          onBlur={field.onBlur}
        >
          <option value="">Select value</option>
          <option value="true">true</option>
          <option value="false">false</option>
        </select>
      );
    }

    const type =
      dataType === 'integer' || dataType === 'float'
        ? 'number'
        : dataType === 'datetime'
          ? 'datetime-local'
          : dataType === 'url'
            ? 'url'
            : 'text';
    const step = dataType === 'integer' ? '1' : dataType === 'float' ? 'any' : undefined;
    const inputMode =
      dataType === 'integer' ? 'numeric' : dataType === 'float' ? 'decimal' : undefined;

    return (
      <Input
        type={type}
        step={step}
        inputMode={inputMode}
        placeholder={placeholder}
        {...field}
        value={value}
      />
    );
  };

  return (
    <div className="space-y-3 rounded-md border bg-card p-4">
      {/* Row header */}
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Parameter {index + 1}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onRemove}
          className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
          aria-label={`Remove parameter ${index + 1}`}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>

      {/* Label + Data type */}
      <div className="grid grid-cols-2 gap-3">
        <FormField
          control={control}
          name={p('label')}
          render={({ field }) => (
            <FormItem>
              <FormLabel>Label *</FormLabel>
              <FormControl>
                <Input
                  placeholder="e.g. Threshold"
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
          name={p('hasDataType')}
          render={({ field }) => (
            <FormItem>
              <FormLabel>Data Type</FormLabel>
              <FormControl>
                <select
                  className={SELECT_CLASS}
                  value={(field.value as string) ?? ''}
                  onChange={(e) => {
                    const next = e.target.value || undefined;
                    field.onChange(next);
                    clearBoundsIfUnbounded(next);
                  }}
                >
                  <option value="">Select type</option>
                  {DATA_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
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

      {/* Parameter type — `secret` is an owner-registered credential, not a runner input */}
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-0.5">
          <span className="text-sm font-medium text-foreground">Secret credential</span>
          <p className="text-xs text-muted-foreground">
            Secret: the label is the secret name; list one field=ENV_KEY per line.
          </p>
        </div>
        <Switch
          checked={isSecret}
          onCheckedChange={handleSecretChange}
          aria-label="Secret credential"
        />
      </div>

      {/* Value area — secret map, fixed (locked), or default + optional min/max (adjustable) */}
      {isSecret ? (
        <FormField
          control={control}
          name={p('hasAcceptedValues')}
          render={({ field }) => (
            <FormItem>
              <FormLabel>Accepted values (field=ENV_KEY)</FormLabel>
              <FormControl>
                <textarea
                  className="flex min-h-[72px] w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring"
                  placeholder={'username=EARTHDATA_USERNAME\npassword=EARTHDATA_PASSWORD'}
                  name={field.name}
                  ref={field.ref}
                  onBlur={field.onBlur}
                  value={((field.value as string[] | undefined) ?? []).join('\n')}
                  onChange={(e) => field.onChange(e.target.value.split('\n'))}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
      ) : locked ? (
        <FormField
          control={control}
          name={p('hasFixedValue')}
          render={({ field }) => (
            <FormItem>
              <FormLabel>Fixed Value</FormLabel>
              <FormControl>{renderValueControl(field, 'Fixed value')}</FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
      ) : (
        <>
          <FormField
            control={control}
            name={p('hasDefaultValue')}
            render={({ field }) => (
              <FormItem>
                <FormLabel>Default Value</FormLabel>
                <FormControl>{renderValueControl(field, 'Default')}</FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          {isBounded && (
            <div className="grid grid-cols-2 gap-3">
              <FormField
                control={control}
                name={p('hasMinimumAcceptedValue')}
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Min Value</FormLabel>
                    <FormControl>{renderValueControl(field, 'Minimum', 'start')}</FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={control}
                name={p('hasMaximumAcceptedValue')}
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Max Value</FormLabel>
                    <FormControl>{renderValueControl(field, 'Maximum', 'end')}</FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
          )}
        </>
      )}

      {/* Lock toggle */}
      {!isSecret && (
        <div className="flex items-start justify-between gap-4 border-t pt-3">
          <div className="space-y-0.5">
            <span className="text-sm font-medium text-foreground">Lock to a fixed value</span>
            <p className="text-xs text-muted-foreground">
              Fixed parameters can&rsquo;t be changed when running the model.
            </p>
          </div>
          <Switch
            checked={locked}
            onCheckedChange={handleLockChange}
            aria-label="Lock to a fixed value"
          />
        </div>
      )}
    </div>
  );
}
