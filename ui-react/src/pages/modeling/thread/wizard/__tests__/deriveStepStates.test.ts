import { describe, expect, it } from 'vitest';
import type { Thread } from '@/graphql/generated/modeling';
import { deriveStepStates } from '../deriveStepStates';

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    __typename: 'thread',
    id: 't1',
    name: '',
    task_id: 'task1',
    start_date: '2000-01-01',
    end_date: '2026-01-01',
    region_id: null,
    driving_variable_id: null,
    response_variable_id: null,
    events: [],
    permissions: [],
    thread_models: [],
    ...overrides,
  };
}

describe('deriveStepStates', () => {
  it('locks Variables, Models and everything after when Goal is empty', () => {
    const s = deriveStepStates(makeThread({ name: '' }));
    expect(s.framing.locked).toBe(false);
    expect(s.variables.locked).toBe(true);
    expect(s.models.locked).toBe(true);
    expect(s.datasets.locked).toBe(true);
    expect(s.summary.locked).toBe(false); // always viewable
  });

  it('unlocks Models as soon as a Goal exists (Variables skippable)', () => {
    const s = deriveStepStates(makeThread({ name: 'Flood extent' }));
    expect(s.framing.status).toBe('done');
    expect(s.models.locked).toBe(false);
    expect(s.datasets.locked).toBe(true); // still needs >=1 model
  });

  it('marks Models done and unlocks Datasets when >=1 model is selected', () => {
    const s = deriveStepStates(
      makeThread({
        name: 'Flood extent',
        thread_models: [
          {
            __typename: 'thread_model',
            id: 'tm1',
            thread_id: 't1',
            modelcatalog_configuration_id: 'cfg1',
          },
        ],
      }),
    );
    expect(s.models.status).toBe('done');
    expect(s.datasets.locked).toBe(false);
    expect(s.datasets.status).toBe('upcoming');
  });

  it('uses opts.datasetsComplete to mark Datasets done and unlock Parameters', () => {
    const thread = makeThread({
      name: 'Flood extent',
      thread_models: [
        {
          __typename: 'thread_model',
          id: 'tm1',
          thread_id: 't1',
          modelcatalog_configuration_id: 'cfg1',
        },
      ],
    });
    const s = deriveStepStates(thread, { datasetsComplete: true });
    expect(s.datasets.status).toBe('done');
    expect(s.parameters.locked).toBe(false);
  });

  it('summarizes Framing as "<goal> · <region>" with "any region" when unset', () => {
    expect(deriveStepStates(makeThread({ name: 'Flood extent' })).framing.summary).toBe(
      'Flood extent · any region',
    );
    expect(
      deriveStepStates(makeThread({ name: 'Flood extent', region_id: 'Texas Gulf' })).framing
        .summary,
    ).toBe('Flood extent · Texas Gulf');
  });

  it('summarizes Variables by indicator, or "No indicator" when unset', () => {
    expect(deriveStepStates(makeThread({ name: 'X' })).variables.summary).toBe('No indicator');
    expect(
      deriveStepStates(makeThread({ name: 'X', response_variable_id: 'sv-flood' })).variables
        .summary,
    ).toBe('sv-flood');
  });

  // #106: the stored id is a standard variable URI, which reads as noise in a
  // one-line step summary.
  it('summarizes Variables by the standard variable label when there is one', () => {
    expect(
      deriveStepStates(
        makeThread({
          name: 'X',
          response_variable_id: 'https://w3id.org/okn/i/mint/DRAWDOWN',
          response_variable: {
            __typename: 'modelcatalog_standard_variable',
            id: 'https://w3id.org/okn/i/mint/DRAWDOWN',
            label: 'drawdown',
          },
        }),
      ).variables.summary,
    ).toBe('drawdown');
  });

  describe('Results with partly finished runs', () => {
    const thread = makeThread({
      name: 'X',
      thread_models: [{ id: 'tm' } as never],
    });
    const base = { datasetsComplete: true, parametersComplete: true };

    it('unlocks Results when one model has results, and keeps Runs pending', () => {
      const s = deriveStepStates(thread, {
        ...base,
        runsComplete: false,
        resultsAvailable: true,
        finishedModels: { finished: 2, total: 3 },
      });
      expect(s.results.locked).toBe(false);
      expect(s.runs.status).not.toBe('done');
      expect(s.runs.summary).toBe('2 of 3 complete');
    });

    it('keeps Results locked while nothing has results', () => {
      const s = deriveStepStates(thread, { ...base, finishedModels: { finished: 0, total: 3 } });
      expect(s.results.locked).toBe(true);
      expect(s.runs.summary).toBe('Pending');
    });
  });
});
