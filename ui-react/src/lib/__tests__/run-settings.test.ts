import { describe, expect, it } from 'vitest';

import type { Execution } from '@/graphql/generated/execution';
import { runDuration, settingsUsed, splitRunParams } from '../modeling/run-settings';

const run = (bindings: Record<string, unknown>): Execution => ({
  id: 'e',
  modelid: 'm',
  status: 'SUCCESS',
  bindings,
  results: {},
});

const params = [
  { id: 'p1', name: 'flood_depth', default: '10' },
  { id: 'p2', name: 'match_mode', default: 'longest' },
  { id: 'p3', name: 'unset_thing', default: null },
];

describe('settingsUsed', () => {
  it('lists changed settings first, leaves out those with no value', () => {
    const used = settingsUsed(params, run({ p2: 'shortest' }));
    expect(used.map((s) => [s.label, s.value, s.changed])).toEqual([
      ['match mode', 'shortest', true],
      ['flood depth', '10', false],
    ]);
  });

  it('does not call a binding that equals the default changed', () => {
    expect(settingsUsed(params, run({ p1: '10' }))[0]?.changed).toBe(false);
  });
});

describe('splitRunParams', () => {
  it('gives a column to what differs and summarises the rest', () => {
    const { varying, common } = splitRunParams(params, [run({ p1: '1' }), run({ p1: '2' })]);
    expect(varying.map((p) => p.id)).toEqual(['p1']);
    expect(common.map((c) => c.param.id)).toEqual(['p2']);
  });
});

describe('runDuration', () => {
  it('words a duration, and is null while unfinished', () => {
    expect(runDuration('2026-01-01T00:00:00Z', '2026-01-01T00:00:42Z')).toBe('42 s');
    expect(runDuration('2026-01-01T00:00:00Z', '2026-01-01T00:03:10Z')).toBe('3 min');
    expect(runDuration('2026-01-01T00:00:00Z', '2026-01-01T02:05:00Z')).toBe('2 h 05 min');
    expect(runDuration('2026-01-01T00:00:00Z', null)).toBeNull();
  });
});
