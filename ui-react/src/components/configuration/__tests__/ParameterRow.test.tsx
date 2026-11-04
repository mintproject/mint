/**
 * Tests for ParameterRow — focuses on the "Lock to a fixed value" toggle, which
 * is the headline UX for parameter editing: locking carries the default into the
 * fixed value and clears the adjustable fields; unlocking reverses it.
 */
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { useForm, FormProvider } from 'react-hook-form';

import { render } from '@/test/utils/render';
import type { ConfigurationFormSchema } from '@/schemas/configuration';
import { parameterRowSchema } from '@/schemas/configuration';
import { ParameterRow } from '../ParameterRow';

function emptyParam(overrides: Record<string, unknown> = {}) {
  return {
    label: 'Alpha',
    description: '',
    hasDataType: 'float',
    hasDefaultValue: '',
    hasMinimumAcceptedValue: '',
    hasMaximumAcceptedValue: '',
    hasFixedValue: '',
    hasAcceptedValues: [],
    position: 0,
    ...overrides,
  };
}

/** Renders one ParameterRow with a live JSON readout of its form state. */
function Harness({ param }: { param: Record<string, unknown> }) {
  const methods = useForm<ConfigurationFormSchema>({
    defaultValues: {
      label: 'Config',
      description: '',
      inputs: [],
      outputs: [],
      parameters: [param as never],
      authors: [],
      regions: [],
    },
  });
  const p = methods.watch('parameters.0');
  return (
    <FormProvider {...methods}>
      <ParameterRow index={0} onRemove={() => {}} />
      <output data-testid="state">{JSON.stringify(p)}</output>
    </FormProvider>
  );
}

const state = () => JSON.parse(screen.getByTestId('state').textContent || '{}');

describe('ParameterRow — secret type', () => {
  it('hides the default value and clears stale values when switched to secret', async () => {
    render(<Harness param={emptyParam({ hasDefaultValue: '0.5' })} />);
    expect(screen.getByText('Default Value')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('switch', { name: /secret credential/i }));

    await waitFor(() => {
      expect(state().parameterType).toBe('secret');
      expect(state().hasDefaultValue).toBe('');
    });
    expect(screen.queryByText('Default Value')).not.toBeInTheDocument();
    expect(screen.getByText(/accepted values \(field=ENV_KEY\)/i)).toBeInTheDocument();
  });
});

describe('parameterRowSchema — secret rows', () => {
  const secretRow = (hasAcceptedValues: string[]) => ({
    label: 'earthdata',
    position: 1,
    parameterType: 'secret',
    hasAcceptedValues,
  });

  it('accepts field=ENV_KEY entries', () => {
    expect(parameterRowSchema.safeParse(secretRow(['username=EARTHDATA_USERNAME'])).success).toBe(
      true,
    );
  });

  it('rejects a malformed entry', () => {
    const result = parameterRowSchema.safeParse(secretRow(['username:EARTHDATA_USERNAME']));
    expect(result.success).toBe(false);
  });
});

describe('ParameterRow — lock to a fixed value', () => {
  it('moves the default into the fixed value and clears adjustable fields on lock', async () => {
    render(
      <Harness
        param={emptyParam({
          hasDefaultValue: '0.5',
          hasMinimumAcceptedValue: '0',
          hasMaximumAcceptedValue: '1',
        })}
      />,
    );

    await userEvent.click(screen.getByRole('switch', { name: /lock to a fixed value/i }));

    await waitFor(() => {
      const s = state();
      expect(s.hasFixedValue).toBe('0.5');
      expect(s.hasDefaultValue).toBe('');
      expect(s.hasMinimumAcceptedValue).toBe('');
      expect(s.hasMaximumAcceptedValue).toBe('');
    });
  });

  it('returns the fixed value to the default on unlock', async () => {
    // Starts locked because hasFixedValue is set.
    render(<Harness param={emptyParam({ hasDefaultValue: '', hasFixedValue: '3.0' })} />);

    await userEvent.click(screen.getByRole('switch', { name: /lock to a fixed value/i }));

    await waitFor(() => {
      const s = state();
      expect(s.hasDefaultValue).toBe('3.0');
      expect(s.hasFixedValue).toBe('');
    });
  });
});
