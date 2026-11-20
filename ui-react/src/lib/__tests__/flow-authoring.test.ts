import { describe, expect, it } from 'vitest';

import {
  addStep,
  applyChain,
  applyDirect,
  buildCheckBody,
  buildSaveBody,
  draftFromStoredFlow,
  emptyDraft,
  insertSteps,
  removeInput,
  removeStep,
  setInputWire,
  sortProblems,
  type FlowDraft,
  type StoredFlowSource,
} from '../flow-authoring';

const wire = (input: number, from: Record<string, unknown>) => ({ to: { input }, from });

function twoSteps(): FlowDraft {
  let draft: FlowDraft = {
    ...emptyDraft(),
    inputs: [
      {
        key: 'corpus',
        label: 'Corpus',
        standardVariable: 'sv:corpus',
        standardVariableLabel: 'Corpus',
        format: 'csv',
        optional: false,
      },
    ],
  };
  draft = addStep(draft, 'piece-a', [wire(1, { flow_input: 'corpus' })]);
  return addStep(draft, 'piece-b', [wire(1, { step: 1, output: 1 })]);
}

describe('flow draft edits', () => {
  it('numbers steps from 1 in list order', () => {
    expect(buildCheckBody(twoSteps()).steps.map((s) => s.position)).toEqual([1, 2]);
  });

  it('inserting steps renumbers the wires and outputs that read from later steps', () => {
    const draft = {
      ...twoSteps(),
      outputs: [{ step: 2, kind: 'output' as const, ref: '1', label: 'R', format: '' }],
    };
    const inserted = insertSteps(draft, 1, [
      { pieceId: 'conv', settings: {}, wires: [], pauseAfter: false },
    ]);
    expect(inserted.steps.map((s) => s.pieceId)).toEqual(['piece-a', 'conv', 'piece-b']);
    expect(inserted.steps[2]?.wires[0]?.from).toEqual({ step: 1, output: 1 });
    expect(inserted.outputs[0]?.step).toBe(3);
    const later = insertSteps(draft, 0, [
      { pieceId: 'x', settings: {}, wires: [], pauseAfter: false },
    ]);
    expect(later.steps[2]?.wires[0]?.from).toEqual({ step: 2, output: 1 });
  });

  it('removing a step drops what read from it and renumbers the rest', () => {
    const removed = removeStep(twoSteps(), 0);
    expect(removed.steps).toHaveLength(1);
    expect(removed.steps[0]?.wires).toEqual([]);
  });

  it('removing a flow input unlinks it and clears its bindings', () => {
    const draft = twoSteps();
    draft.bindings = {
      region: 'input:corpus',
      start_date: '',
      end_date: '',
      collections: ['corpus'],
    };
    const removed = removeInput(draft, 'corpus');
    expect(removed.steps[0]?.wires).toEqual([]);
    expect(removed.bindings).toEqual({ region: '', start_date: '', end_date: '', collections: [] });
  });

  it('feeding an input replaces its link, and null clears it', () => {
    const draft = setInputWire(twoSteps(), 1, 1, { flow_input: 'corpus' });
    expect(draft.steps[1]?.wires).toEqual([wire(1, { flow_input: 'corpus' })]);
    expect(setInputWire(draft, 1, 1, null).steps[1]?.wires).toEqual([]);
  });

  it('accepts a direct source as a link', () => {
    const draft = applyDirect(addStep(twoSteps(), 'piece-c'), 2, 1, {
      kind: 'step_output',
      step: 2,
      output: 1,
    });
    expect(draft.steps[2]?.wires).toEqual([wire(1, { step: 2, output: 1 })]);
  });

  it('accepts a converter chain: its pieces go before the step, which then reads the last', () => {
    const draft = applyChain(twoSteps(), 1, 1, {
      from: { kind: 'step_output', step: 1, output: 1 },
      pieces: [
        { piece: 'c1', position: 1, output: 1 },
        { piece: 'c2', position: 1, output: 2 },
      ],
    });
    expect(draft.steps.map((s) => s.pieceId)).toEqual(['piece-a', 'c1', 'c2', 'piece-b']);
    expect(draft.steps[1]?.wires).toEqual([wire(1, { step: 1, output: 1 })]);
    expect(draft.steps[2]?.wires).toEqual([wire(1, { step: 2, output: 1 })]);
    expect(draft.steps[3]?.wires).toEqual([wire(1, { step: 3, output: 2 })]);
  });
});

describe('request bodies', () => {
  it('the check body uses input keys, skips blank settings and keeps wires as written', () => {
    const draft = twoSteps();
    draft.steps[0]!.settings = { top_n: '5', title: '' };
    const body = buildCheckBody(draft);
    expect(body.inputs).toEqual([
      { id: 'corpus', contract: { standard_variable_uri: 'sv:corpus', format: 'csv' } },
    ]);
    expect(body.steps[0]).toMatchObject({
      position: 1,
      etl_process_id: 'piece-a',
      settings: { top_n: '5' },
      wires: [wire(1, { flow_input: 'corpus' })],
    });
  });

  it('thread bindings: region and dates name an input or a setting, collections name inputs', () => {
    const draft = twoSteps();
    draft.bindings = {
      region: 'input:corpus',
      start_date: 'setting:begin',
      end_date: '',
      collections: ['corpus'],
    };
    expect(buildSaveBody(draft).thread_bindings).toEqual({
      region: { input: 'corpus' },
      start_date: { setting: 'begin' },
      collections: ['corpus'],
    });
    // The adapter's check knows flow inputs only, not a piece's setting.
    expect(buildCheckBody(draft).thread_bindings).toEqual({
      region: { input: 'corpus' },
      collections: ['corpus'],
    });
  });

  it('the save body carries labels for dataset outputs only', () => {
    const draft = twoSteps();
    draft.configuration = { label: 'My flow', description: '' };
    draft.software.label = 'Sensemaking';
    draft.version.label = '1';
    draft.outputs = [
      { step: 2, kind: 'output', ref: '1', label: 'Report', format: 'html' },
      { step: 2, kind: 'value', ref: 'manifest', label: '', format: '' },
    ];
    const body = buildSaveBody(draft);
    expect(body.outputs).toEqual([
      { step: 2, output: 1, label: 'Report', format: 'html' },
      { step: 2, value: 'manifest' },
    ]);
    expect(body.software).toEqual({ label: 'Sensemaking' });
    expect(body.inputs[0]).toMatchObject({
      key: 'corpus',
      standard_variable: 'sv:corpus',
      format: 'csv',
    });
  });
});

describe('problems', () => {
  it('are sorted onto the step they are on, flow-wide ones apart', () => {
    const sorted = sortProblems([
      { code: 'A', message: 'a', step: 2, wire: 0 },
      { code: 'B', message: 'b' },
      { code: 'C', message: 'c', step: 2 },
    ]);
    expect(sorted.flow.map((p) => p.code)).toEqual(['B']);
    expect(sorted.steps.get(2)?.map((p) => p.code)).toEqual(['A', 'C']);
  });
});

describe('editing as a copy', () => {
  const stored: StoredFlowSource = {
    configuration: {
      label: 'Dictionary',
      description: 'd',
      software_version: {
        id: 'ver-1',
        version_id: '1.0',
        software: { id: 'sw-1', label: 'Sense' },
      },
      inputs: [
        {
          is_optional: false,
          input: {
            id: 'cfg_input_1',
            label: 'Text corpus',
            has_format: 'csv',
            position: 1,
            presentations: [
              { presentation: { standard_variable: { id: 'sv:corpus', label: 'Corpus' } } },
            ],
          },
        },
      ],
      outputs: [{ output: { id: 'cfg_output_1', label: 'Report', has_format: 'html' } }],
      parameters: [{ parameter: { id: 'cfg_setting_begin', label: 'begin' } }],
    },
    flow: {
      thread_bindings_json: {
        region: { input: 'cfg_input_1' },
        start_date: { parameter: 'cfg_setting_begin' },
        collections: ['cfg_input_1'],
      },
      outputs_json: [
        { step: 1, output: 1, output_id: 'cfg_output_1', editable: { file: 'lexicon.csv' } },
        { step: 1, value: 'm' },
      ],
      steps: [
        {
          position: 1,
          etl_process_id: 'piece-a',
          settings_json: { top_n: '25' },
          wires_json: [{ to: { input: 1 }, from: { flow_input: 'cfg_input_1' } }],
          pause_after: true,
        },
      ],
    },
  };

  it('prefills the form with plain keys and the same version, under a new name', () => {
    const draft = draftFromStoredFlow(stored);
    expect(draft.configuration.label).toBe('Dictionary (copy)');
    expect(draft.software).toEqual({ id: 'sw-1', label: 'Sense' });
    expect(draft.version.id).toBe('ver-1');
    expect(draft.inputs[0]).toMatchObject({
      key: 'Text_corpus',
      standardVariable: 'sv:corpus',
      format: 'csv',
    });
    expect(draft.steps[0]).toMatchObject({
      pieceId: 'piece-a',
      settings: { top_n: '25' },
      pauseAfter: true,
      wires: [{ to: { input: 1 }, from: { flow_input: 'Text_corpus' } }],
    });
    expect(draft.outputs).toEqual([
      {
        step: 1,
        kind: 'output',
        ref: '1',
        label: 'Report',
        format: 'html',
        editable: { file: 'lexicon.csv' },
      },
      { step: 1, kind: 'value', ref: 'm', label: '', format: '' },
    ]);
    expect(draft.bindings).toEqual({
      region: 'input:Text_corpus',
      start_date: 'setting:begin',
      end_date: '',
      collections: ['Text_corpus'],
    });
  });

  it('keeps the editable file of a paused flow through a copy, in the check and the save', () => {
    const draft = draftFromStoredFlow(stored);
    expect(buildSaveBody(draft).outputs[0]).toMatchObject({ editable: { file: 'lexicon.csv' } });
    expect(buildCheckBody(draft).outputs[0]).toMatchObject({ editable: { file: 'lexicon.csv' } });
  });

  it('saves under the existing version by id, with no new model or version labels', () => {
    const body = buildSaveBody(draftFromStoredFlow(stored));
    expect(body.software).toEqual({ id: 'sw-1', label: 'Sense' });
    expect(body.version).toEqual({ id: 'ver-1', label: '1.0' });
    expect(body.configuration.label).toBe('Dictionary (copy)');
  });

  it('reads a malformed stored flow without throwing', () => {
    const draft = draftFromStoredFlow({
      ...stored,
      flow: { steps: [], outputs_json: 'x', thread_bindings_json: [1] },
    });
    expect(draft.outputs).toEqual([]);
    expect(draft.bindings.collections).toEqual([]);
  });
});
