/**
 * One input for one setting, chosen from the setting's description: a dropdown when it
 * has choices (with the chosen choice's explanation under it), a number box with its
 * bounds, a checkbox for a yes/no, and text otherwise.
 *
 * It holds its own text unless `value` is given, so a plain `<form>` can read it by
 * `name`: a checkbox is read through its `checked`, and its `value` is `true`.
 */
import { useState } from 'react';

import {
  choiceLabel,
  settingInputKind,
  settingText,
  type SettingChoice,
  type SettingDetails,
} from '@/lib/flow-settings';
import { cn } from '@/lib/utils';

export interface SettingInputProps {
  /** The form field's name, and the base of the test ids. */
  name: string;
  details?: SettingDetails;
  /** Controlled text. Leave out to let the input hold its own. */
  value?: string;
  defaultValue?: string;
  onChange?: (value: string) => void;
  disabled?: boolean;
  /** What a blank text or number box says, such as the default. */
  placeholder?: string;
  /** What a dropdown with no value says. */
  unsetLabel?: string;
  id?: string;
  'data-testid'?: string;
  className?: string;
}

const base =
  'rounded border px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-blue-400 disabled:opacity-50';

export function SettingInput({
  name,
  details,
  value,
  defaultValue = '',
  onChange,
  disabled,
  placeholder,
  unsetLabel = 'Not set',
  id,
  className,
  ...rest
}: SettingInputProps) {
  const [own, setOwn] = useState(defaultValue);
  const current = value ?? own;
  const change = (next: string) => {
    setOwn(next);
    onChange?.(next);
  };
  const testId = rest['data-testid'] ?? `setting-input-${name}`;
  const kind = settingInputKind(details);

  if (kind === 'choice') {
    const choices = details?.choices ?? [];
    const chosen = choices.find((choice) => String(choice.value) === current);
    const known = choices.some((choice) => String(choice.value) === current);
    return (
      <div className={className}>
        <select
          id={id}
          name={name}
          data-testid={testId}
          value={current}
          disabled={disabled}
          onChange={(event) => change(event.target.value)}
          className={cn(base, 'w-full bg-background')}
        >
          {/* A value the choices do not hold (an old one) stays visible rather than
              silently becoming the first choice. */}
          {(current === '' || !known) && <option value={current}>{current || unsetLabel}</option>}
          {choices.map((choice: SettingChoice) => (
            <option key={String(choice.value)} value={String(choice.value)}>
              {choiceLabel(choice)}
            </option>
          ))}
        </select>
        {chosen?.description && (
          <p className="mt-0.5 text-gray-500" data-testid={`${testId}-explanation`}>
            {chosen.description}
          </p>
        )}
      </div>
    );
  }

  if (kind === 'boolean') {
    return (
      <input
        id={id}
        type="checkbox"
        name={name}
        value="true"
        data-testid={testId}
        checked={current === 'true'}
        disabled={disabled}
        onChange={(event) => change(String(event.target.checked))}
        className={className}
      />
    );
  }

  return (
    <input
      id={id}
      type={kind === 'number' ? 'number' : 'text'}
      {...(kind === 'number'
        ? {
            min: details?.minimum,
            max: details?.maximum,
            step: details?.type === 'integer' ? 1 : 'any',
          }
        : {})}
      name={name}
      data-testid={testId}
      value={current}
      placeholder={placeholder ?? (details?.default == null ? '' : settingText(details.default))}
      disabled={disabled}
      onChange={(event) => change(event.target.value)}
      className={cn(base, 'w-full', className)}
    />
  );
}
