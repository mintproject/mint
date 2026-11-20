import { describe, expect, it } from 'vitest';
import { EnsembleManagerError } from '@/lib/ensemble-manager';
import {
  flowErrorMessage,
  FLOW_ERROR_CODES,
  FlowSettingsMissingError,
  missingFlowSettings,
} from '@/lib/flow-errors';

const refuse = (code: string, details?: unknown) =>
  flowErrorMessage(new EnsembleManagerError(422, 'refused', code, details));

describe('flowErrorMessage', () => {
  it('is null for an error that is not a flow refusal', () => {
    expect(flowErrorMessage(new Error('boom'))).toBeNull();
    expect(flowErrorMessage(new EnsembleManagerError(500, 'x', 'SOMETHING_ELSE'))).toBeNull();
    expect(flowErrorMessage(new EnsembleManagerError(500, 'x'))).toBeNull();
  });

  it('has a message for every flow code', () => {
    for (const code of FLOW_ERROR_CODES) {
      const message = refuse(code);
      expect(message?.title, code).toBeTruthy();
      expect(message?.lines.length, code).toBeGreaterThan(0);
    }
  });

  it('names the unbound input', () => {
    const m = refuse('FLOW_INPUT_UNBOUND', { input: 'dem' });
    expect(m?.lines.join(' ')).toContain('"dem"');
  });

  it('names the input that takes one dataset and the datasets chosen', () => {
    // The Ensemble Manager sends how many files were chosen, as a number.
    const m = refuse('FLOW_FANOUT_UNSUPPORTED', { input: 'dem', datasets: 2 });
    expect(m?.title).toMatch(/one file/i);
    expect(m?.lines.join('\n')).toContain('"dem"');
    expect(m?.lines.join('\n')).toContain('2 files chosen');
  });

  it("lists the author's settings", () => {
    const m = refuse('FLOW_SETTINGS_NOT_ACCEPTED', {
      defaults: { title: 'Dictionary', n: 3 },
      links: [{ from: 'a.out', to: 'b.in' }],
    });
    expect(m?.lines.join('\n')).toContain("chosen by the flow's author");
    expect(m?.lines).toEqual(
      expect.arrayContaining(['title: Dictionary', 'n: 3', 'b.in is taken from a.out']),
    );
  });

  it('reads details nested under a second details key', () => {
    const m = refuse('FLOW_INPUT_UNBOUND', { details: { input: 'dem' } });
    expect(m?.lines.join(' ')).toContain('"dem"');
  });

  it('carries the run already in progress', () => {
    const m = refuse('FLOW_ALREADY_RUNNING', { run_id: 'ue_7' });
    expect(m?.runId).toBe('ue_7');
    expect(m?.lines.join(' ')).toContain('ue_7');
    expect(refuse('FLOW_ALREADY_RUNNING')?.runId).toBeUndefined();
  });

  it("asks to plan again when the plan is not the caller's or an argument is fixed", () => {
    expect(refuse('FLOW_PLAN_NOT_YOURS')?.lines.join(' ')).toMatch(/run again/i);
    const fixed = refuse('FLOW_ARGUMENT_FIXED', { arguments: ['title'] });
    expect(fixed?.lines).toContain('title');
  });

  it('lists the pieces that are not approved and the problems with their steps', () => {
    const stored = refuse('STORED_SOURCE_REFUSED', {
      problems: [{ code: 'NOT_APPROVED', message: 'piece p1 is not approved', step: 'clean' }],
    });
    expect(stored?.lines.join('\n')).toContain('Step clean: piece p1 is not approved');
    const checks = refuse('FLOW_DOES_NOT_CHECK_OUT', {
      problems: [{ code: 'TYPE_MISMATCH', message: 'csv into raster', step: 'join' }, 'loose text'],
    });
    expect(checks?.lines).toEqual(
      expect.arrayContaining(['Step join: csv into raster (TYPE_MISMATCH)', 'loose text']),
    );
  });

  it('shows the server message for a failed flow', () => {
    const m = flowErrorMessage(new EnsembleManagerError(500, 'step two died', 'FLOW_FAILED'));
    expect(m?.lines).toEqual(['step two died']);
  });
});

describe('settings a flow run must supply', () => {
  const plan = {
    parameters: [
      { name: 'output_uri', required: true },
      { name: 'top_n', required: false },
      { name: 'title', required: true, default: 'Dictionary' },
      { name: 'source_uri', required: true, managed: true },
    ],
  };

  it('names a required setting with no default and no value from the thread', () => {
    expect(missingFlowSettings(plan)).toEqual(['output_uri']);
    expect(missingFlowSettings({ ...plan, parameter_values: { output_uri: '' } })).toEqual([
      'output_uri',
    ]);
  });

  it('is satisfied by a value the thread holds', () => {
    expect(
      missingFlowSettings({ ...plan, parameter_values: { output_uri: 'tapis://sys/out' } }),
    ).toEqual([]);
  });

  it('reads as an instruction, with the settings named', () => {
    const m = flowErrorMessage(new FlowSettingsMissingError(['output_uri']));
    expect(m?.title).toMatch(/needs a setting/i);
    expect(m?.lines).toContain('output_uri');
  });

  it("explains the adapter's refusal of a missing or malformed setting", () => {
    const m = flowErrorMessage(
      new EnsembleManagerError(422, 'x', 'INVALID_PARAMETERS', {
        parameters: { output_uri: 'required' },
      }),
    );
    expect(m?.lines).toContain('output_uri: required');
  });
});
