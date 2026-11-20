import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  choiceLabel,
  fetchFlowSettings,
  settingText,
  settingTitle,
  visibilityOf,
} from '../flow-settings';

const SETTING = {
  name: 'match_mode',
  parameter_id: 'cfg_setting_match_mode',
  visibility: 'shown',
  title: 'How terms are counted',
};

afterEach(() => vi.unstubAllGlobals());

describe('naming and showing a setting', () => {
  it('prefers the piece title and falls back to the name with spaces', () => {
    expect(settingTitle('match_mode', { title: 'How terms are counted' })).toBe(
      'How terms are counted',
    );
    expect(settingTitle('match_mode', {})).toBe('match mode');
    expect(settingTitle('match_mode', { title: '  ' })).toBe('match mode');
    expect(settingTitle('top_n')).toBe('top n');
  });

  it('labels a choice by its title, else its value', () => {
    expect(choiceLabel({ value: 'a', title: 'Automatic' })).toBe('Automatic');
    expect(choiceLabel({ value: 5 })).toBe('5');
  });

  it('writes a value as the text an input shows', () => {
    expect(settingText('x')).toBe('x');
    expect(settingText(25)).toBe('25');
    expect(settingText(false)).toBe('false');
    expect(settingText(undefined)).toBe('');
    expect(settingText(null)).toBe('');
  });

  it('takes the authors choice, else the pieces hint, else shown', () => {
    expect(visibilityOf({ visibility: 'hidden' }, { advanced: true })).toBe('hidden');
    expect(visibilityOf({ fixed: true }, { advanced: true })).toBe('advanced');
    expect(visibilityOf(undefined, {})).toBe('shown');
    expect(visibilityOf({ visibility: 'bogus' as never }, undefined)).toBe('shown');
  });
});

describe('fetchFlowSettings', () => {
  const answers = (body: unknown, ok = true) => {
    const fetchMock = vi.fn().mockResolvedValue({ ok, json: async () => body });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  };

  it('reads the settings of a flow with the callers token', async () => {
    const fetchMock = answers({
      settings: [SETTING, { name: 'broken' }],
      thread_bound: ['start', 3],
    });
    const found = await fetchFlowSettings('https://w3id.org/okn/i/mint/dict', 'tok');
    expect(found?.settings).toEqual([SETTING]);
    expect(found?.thread_bound).toEqual(['start']);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain(
      `/flows/${encodeURIComponent('https://w3id.org/okn/i/mint/dict')}/settings`,
    );
    expect((init as RequestInit).headers).toEqual({ Authorization: 'Bearer tok' });
  });

  it.each([
    ['no token', null, { settings: [] }, true],
    ['a refusal', 'tok', { settings: [] }, false],
    ['a malformed answer', 'tok', { nope: 1 }, true],
  ])('is null for %s', async (_name, token, body, ok) => {
    answers(body, ok);
    expect(await fetchFlowSettings('f', token)).toBeNull();
  });

  it('is null when the adapter cannot be reached', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('down')));
    expect(await fetchFlowSettings('f', 'tok')).toBeNull();
  });
});
