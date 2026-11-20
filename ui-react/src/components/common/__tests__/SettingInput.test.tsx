import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { settingInputKind } from '@/lib/flow-settings';

import { SettingInput } from '../SettingInput';

const choices = [
  { value: 'auto', title: 'Automatic', description: 'Words and phrases.' },
  { value: 'longest', title: 'Longest match', description: 'No double counting.' },
];

describe('SettingInput', () => {
  it('picks the input from the description', () => {
    expect(settingInputKind({ choices })).toBe('choice');
    expect(settingInputKind({ type: 'integer' })).toBe('number');
    expect(settingInputKind({ type: 'number' })).toBe('number');
    expect(settingInputKind({ type: 'boolean' })).toBe('boolean');
    expect(settingInputKind({ type: 'string' })).toBe('text');
    expect(settingInputKind(undefined)).toBe('text');
  });

  it('shows choices by their titles and explains the chosen one', () => {
    render(<SettingInput name="mode" details={{ choices }} defaultValue="auto" />);
    const select = screen.getByTestId('setting-input-mode') as HTMLSelectElement;
    expect(select.value).toBe('auto');
    expect(Array.from(select.options).map((option) => option.textContent)).toEqual([
      'Automatic',
      'Longest match',
    ]);
    expect(screen.getByTestId('setting-input-mode-explanation')).toHaveTextContent(
      'Words and phrases.',
    );
    fireEvent.change(select, { target: { value: 'longest' } });
    expect(screen.getByTestId('setting-input-mode-explanation')).toHaveTextContent(
      'No double counting.',
    );
  });

  it('shows plain choices (an enum) with no explanation', () => {
    render(<SettingInput name="c" details={{ choices: [{ value: 'red' }, { value: 'green' }] }} />);
    expect(screen.queryByTestId('setting-input-c-explanation')).not.toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'green' })).toBeInTheDocument();
  });

  it('keeps a value the choices do not hold, and says what an empty dropdown means', () => {
    const { rerender } = render(<SettingInput name="m" details={{ choices }} value="old" />);
    expect(screen.getByRole('option', { name: 'old' })).toBeInTheDocument();
    rerender(<SettingInput name="m" details={{ choices }} value="" unsetLabel="Piece default" />);
    expect(screen.getByRole('option', { name: 'Piece default' })).toBeInTheDocument();
  });

  it('gives a number box its bounds, and whole steps for an integer', () => {
    render(
      <SettingInput
        name="n"
        details={{ type: 'integer', minimum: 1, maximum: 500, default: 200 }}
      />,
    );
    const input = screen.getByTestId('setting-input-n');
    expect(input).toHaveAttribute('type', 'number');
    expect(input).toHaveAttribute('min', '1');
    expect(input).toHaveAttribute('max', '500');
    expect(input).toHaveAttribute('step', '1');
    expect(input).toHaveAttribute('placeholder', '200');
  });

  it('is a checkbox for a yes or no', () => {
    const onChange = vi.fn();
    render(
      <SettingInput name="b" details={{ type: 'boolean' }} value="false" onChange={onChange} />,
    );
    const box = screen.getByTestId('setting-input-b') as HTMLInputElement;
    expect(box.type).toBe('checkbox');
    expect(box.checked).toBe(false);
    fireEvent.click(box);
    expect(onChange).toHaveBeenCalledWith('true');
  });

  it('is text otherwise, and reports what is typed', () => {
    const onChange = vi.fn();
    render(<SettingInput name="t" details={{ type: 'string' }} onChange={onChange} />);
    fireEvent.change(screen.getByTestId('setting-input-t'), { target: { value: 'x' } });
    expect(onChange).toHaveBeenCalledWith('x');
    expect((screen.getByTestId('setting-input-t') as HTMLInputElement).value).toBe('x');
  });

  it('follows `value` when it is given', () => {
    const { rerender } = render(<SettingInput name="t" value="a" onChange={vi.fn()} />);
    rerender(<SettingInput name="t" value="b" onChange={vi.fn()} />);
    expect((screen.getByTestId('setting-input-t') as HTMLInputElement).value).toBe('b');
  });
});
