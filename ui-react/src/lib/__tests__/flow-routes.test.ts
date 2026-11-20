import { describe, expect, it } from 'vitest';

import { emptyDraft } from '../flow-authoring';
import {
  applyRoute,
  datasetName,
  formatName,
  needName,
  groupRoutes,
  readableName,
  uniqueDatasets,
  type RouteEntry,
} from '../flow-routes';

const SV = 'https://w3id.org/okn/i/mint/spring__volume_flow_rate';
const BUDGET = 'https://w3id.org/okn/i/mint/drain__budget';

const need = (over: Partial<RouteEntry['inputs'][number]> = {}): RouteEntry['inputs'][number] => ({
  input: 1,
  met: false,
  direct: [],
  chains: [],
  variable: BUDGET,
  variable_label: 'Drain budget',
  format: 'csv',
  providers: { models: [], datasets: [] },
  ...over,
});

const entry = (piece: string, over: Partial<RouteEntry> = {}): RouteEntry => ({
  piece,
  label: piece,
  output: 1,
  complete: false,
  output_variable: SV,
  output_label: 'Spring volume flow rate',
  output_format: 'csv',
  converter: false,
  inputs: [need()],
  ...over,
});

const model = {
  configuration_id: 'https://w3id.org/okn/i/mint/modflow6',
  label: 'MODFLOW 6',
  output: 1,
  format: 'csv',
  variable: BUDGET,
  output_label: 'Drain budget',
};

describe('groupRoutes', () => {
  it('puts model routes, data routes, converters and no-route pieces in their own groups', () => {
    const extractor = entry('extract', {
      inputs: [need({ providers: { models: [model], datasets: [] } })],
    });
    const fromData = entry('cfs-to-m3s', {
      converter: true,
      inputs: [
        need({
          variable: SV,
          providers: { models: [], datasets: [{ data_object_id: 'd1', name: 'Flow' }] },
        }),
      ],
    });
    const idle = entry('m3s-to-cfs', { converter: true, inputs: [need({ variable: SV })] });
    const none = entry('usg');
    const ready = entry('done', { complete: true, inputs: [need({ met: true })] });
    const groups = groupRoutes([none, idle, fromData, extractor, ready]);
    expect(groups.ready).toEqual([ready]);
    expect(groups.model).toEqual([extractor]);
    expect(groups.data).toEqual([fromData]);
    expect(groups.converter).toEqual([idle]);
    expect(groups.none).toEqual([none]);
  });

  it('treats a piece with the same variable in and out as a converter without the flag', () => {
    const old = entry('conv', {
      converter: undefined,
      inputs: [need({ variable: SV, providers: { models: [model], datasets: [] } })],
    });
    expect(groupRoutes([old]).converter).toEqual([old]);
  });
});

describe('names', () => {
  it('does not use a variable URI as a dataset name, and lists a dataset once', () => {
    expect(datasetName({ data_object_id: 'ckan-1', label: SV })).toBe('ckan-1');
    expect(datasetName({ data_object_id: 'ckan-1', label: SV, name: 'Barton Springs flow' })).toBe(
      'Barton Springs flow',
    );
    expect(
      uniqueDatasets([
        { data_object_id: 'a', label: 'x' },
        { data_object_id: 'a', label: 'x' },
        { data_object_id: 'b', label: 'y' },
      ]),
    ).toHaveLength(2);
  });

  it('reads a slug label as words', () => {
    expect(readableName('flow-cfs-to-m3s')).toBe('Flow cfs to m3s');
    expect(readableName('Score')).toBe('Score');
  });
});

describe('applyRoute', () => {
  it('a model route adds a flow input named for the model output, then the wired extractor', () => {
    const extractor = entry('extract', {
      inputs: [need({ providers: { models: [model], datasets: [] } })],
    });
    const draft = applyRoute(emptyDraft(), extractor, { input: 1, kind: 'model', model });
    expect(draft.inputs).toHaveLength(1);
    expect(draft.inputs[0]).toMatchObject({
      key: 'Drain_budget',
      label: 'Drain budget',
      standardVariable: BUDGET,
      format: 'csv',
    });
    expect(draft.steps.map((s) => s.pieceId)).toEqual(['extract']);
    expect(draft.steps[0]?.wires).toEqual([
      { to: { input: 1 }, from: { flow_input: 'Drain_budget' } },
    ]);
  });

  it('a chain route adds every piece in order, wired, before the producer', () => {
    const chain = {
      from: { kind: 'flow_input' as const, id: 'src' },
      pieces: [
        { piece: 'c1', position: 1, output: 1 },
        { piece: 'c2', position: 1, output: 2 },
        { piece: 'c3', position: 1, output: 1 },
      ],
    };
    const producer = entry('make', {
      complete: true,
      inputs: [need({ met: true, chains: [chain] })],
    });
    const draft = applyRoute(emptyDraft(), producer);
    expect(draft.steps.map((s) => s.pieceId)).toEqual(['c1', 'c2', 'c3', 'make']);
    expect(draft.steps[0]?.wires).toEqual([{ to: { input: 1 }, from: { flow_input: 'src' } }]);
    expect(draft.steps[1]?.wires).toEqual([{ to: { input: 1 }, from: { step: 1, output: 1 } }]);
    expect(draft.steps[2]?.wires).toEqual([{ to: { input: 1 }, from: { step: 2, output: 2 } }]);
    expect(draft.steps[3]?.wires).toEqual([{ to: { input: 1 }, from: { step: 3, output: 1 } }]);
  });

  it('a dataset route binds an input named for the dataset', () => {
    const dataset = { data_object_id: 'd1', name: 'Barton flow', format: 'parquet' };
    const conv = entry('cfs', { converter: true, inputs: [need({ variable: SV })] });
    const draft = applyRoute(emptyDraft(), conv, { input: 1, kind: 'dataset', dataset });
    expect(draft.inputs[0]).toMatchObject({ label: 'Barton flow', format: 'parquet' });
    expect(draft.steps[0]?.wires[0]?.from).toEqual({ flow_input: 'Barton_flow' });
  });
});

describe('format-only inputs', () => {
  const formatOnly = need({
    variable: null,
    variable_label: null,
    format: 'cbc-mf6',
    providers: { models: [{ ...model, variable: null, output_label: null }], datasets: [] },
  });

  it('names an input by its model output label, else the format, never "input 0"', () => {
    expect(needName(formatOnly)).toBe('MODFLOW 6 cell-by-cell budget (cbc-mf6)');
    const labelled = need({
      ...formatOnly,
      providers: {
        models: [{ ...model, variable: null, output_label: 'Cell-by-cell budget' }],
        datasets: [],
      },
    });
    expect(needName(labelled)).toBe('Cell-by-cell budget (cbc-mf6)');
    expect(needName(need({ variable: null, variable_label: null, format: 'weird' }))).toBe(
      'a weird file',
    );
    expect(formatName('gma-scalar')).toBe('GMA summary value');
  });

  it('adds a flow input bound by format alone, wired to the extractor', () => {
    const extractor = entry('extract', { inputs: [formatOnly] });
    const mf6 = { ...model, format: 'cbc-mf6', variable: null, output_label: null };
    const draft = applyRoute(emptyDraft(), extractor, { input: 1, kind: 'model', model: mf6 });
    expect(draft.inputs[0]).toMatchObject({
      label: 'MODFLOW 6 cell-by-cell budget',
      standardVariable: '',
      format: 'cbc-mf6',
    });
    expect(draft.steps[0]?.wires[0]?.from).toEqual({
      flow_input: draft.inputs[0]?.key,
    });
  });
});
