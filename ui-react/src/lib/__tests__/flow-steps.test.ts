import { describe, expect, it } from 'vitest';

import type { FlowStepRow } from '@/graphql/queries/flows';
import { layoutFlowGraph } from '@/lib/flow-graph-layout';
import {
  describeWire,
  flowStepsGraph,
  parseSettings,
  parseWires,
  threadBindingLines,
  type FlowLabels,
} from '@/lib/flow-steps';

const labels: FlowLabels = {
  inputs: new Map([
    ['in:corpus', 'Corpus'],
    ['in:aoi', 'Area'],
  ]),
  parameters: new Map([['p:year', 'Year']]),
};

const piece = (id: string, label: string) => ({ id, label });

// Step 3 reads from two different steps and from a flow input.
const steps: FlowStepRow[] = [
  {
    position: 1,
    etl_process_id: 'p1',
    etl_process: piece('p1', 'Ingest'),
    wires_json: [{ to: { input: 0 }, from: { flow_input: 'in:corpus' } }],
  },
  {
    position: 2,
    etl_process_id: 'p2',
    etl_process: piece('p2', 'Score'),
    wires_json: [{ to: { input: 0 }, from: { step: 1, output: 0 } }],
  },
  {
    position: 3,
    etl_process_id: 'p3',
    etl_process: piece('p3', 'Report'),
    wires_json: [
      { to: { input: 0 }, from: { step: 2, output: 1 } },
      { to: { input: 1 }, from: { step: 1, output: 0 } },
      { to: { input: 2 }, from: { flow_input: 'in:corpus' } },
      { to: { setting: 'top_n' }, from: { step: 2, value: 'job_uuid' } },
    ],
  },
];

describe('describeWire', () => {
  it('reads each kind of wire as a sentence', () => {
    const d = (json: unknown) => describeWire(parseWires([json])[0]!, labels);
    expect(d({ to: { input: 0 }, from: { step: 2, output: 1 } })).toBe(
      'input 0 ← step 2, output 1',
    );
    expect(d({ to: { input: 0 }, from: { flow_input: 'in:corpus' } })).toBe(
      'input 0 ← flow input Corpus',
    );
    expect(d({ to: { setting: 'top_n' }, from: { step: 1, value: 'job_uuid' } })).toBe(
      'setting top_n ← step 1, value job_uuid',
    );
    expect(d({ to: {}, from: { step: 3 } })).toBe('runs after step 3');
    expect(d({ to: { setting: 'year' }, from: { flow_parameter: 'p:year' } })).toBe(
      'setting year ← flow parameter Year',
    );
  });

  it('skips malformed wires and settings rather than throwing', () => {
    expect(parseWires([null, 'x', { to: 1 }, { to: {}, from: { step: 'a' } }])).toEqual([
      { to: {}, from: {} },
    ]);
    expect(parseWires('nope')).toEqual([]);
    expect(parseSettings(null)).toEqual([]);
    expect(parseSettings({ a: 'x', b: 2 })).toEqual([
      ['a', 'x'],
      ['b', '2'],
    ]);
  });
});

describe('threadBindingLines', () => {
  it('names the input the thread fills and the inputs that take a collection', () => {
    expect(
      threadBindingLines(
        {
          region: { input: 'in:aoi' },
          start_date: { parameter: 'p:year' },
          collections: ['in:corpus'],
        },
        labels,
      ),
    ).toEqual([
      "The thread's region fills: Area",
      "The thread's start date fills: Year",
      'Takes a collection of files: Corpus',
    ]);
    expect(threadBindingLines(null, labels)).toEqual([]);
  });
});

describe('flowStepsGraph', () => {
  const graph = flowStepsGraph(steps, labels);
  const edge = (source: string, target: string) =>
    graph.edges.find((e) => e.source === source && e.target === target);

  it('has the flow input as a source node and one node per step', () => {
    expect(graph.nodes.map((n) => [n.id, n.kind])).toEqual([
      ['input-in:corpus', 'input'],
      ['step-1', 'step'],
      ['step-2', 'step'],
      ['step-3', 'step'],
    ]);
  });

  it('draws an edge for every wire, merging wires between the same two nodes', () => {
    expect(graph.edges).toHaveLength(5);
    expect(edge('input-in:corpus', 'step-1')?.label).toBe('input 0');
    expect(edge('step-1', 'step-2')?.label).toBe('output 0 → input 0');
    expect(edge('step-1', 'step-3')?.label).toBe('output 0 → input 1');
    expect(edge('input-in:corpus', 'step-3')).toBeDefined();
    // Step 3 reads from two different steps, and from a setting value of one of them.
    expect(edge('step-2', 'step-3')?.label).toBe(
      'output 1 → input 0, value job_uuid → setting top_n',
    );
  });

  it('puts a step one layer right of the deepest step it reads from', () => {
    const x = (id: string) => graph.positions.find((p) => p.node.id === id)!.x;
    expect(x('input-in:corpus')).toBeLessThan(x('step-1'));
    expect(x('step-1')).toBeLessThan(x('step-2'));
    expect(x('step-2')).toBeLessThan(x('step-3'));
  });

  it('draws an order-only wire as an edge, and marks a missing piece', () => {
    const g = flowStepsGraph(
      [
        { position: 1, etl_process_id: 'p1', etl_process: piece('p1', 'A'), wires_json: [] },
        {
          position: 2,
          etl_process_id: 'gone',
          etl_process: null,
          wires_json: [{ to: {}, from: { step: 1 } }],
        },
      ],
      labels,
    );
    expect(g.edges.map((e) => [e.source, e.target, e.label])).toEqual([
      ['step-1', 'step-2', 'runs after'],
    ]);
    expect(g.nodes.find((n) => n.id === 'step-2')?.missing).toBe(true);
  });
});

describe('layoutFlowGraph', () => {
  it('ignores links to unknown nodes and survives a cycle', () => {
    const nodes = [{ id: 'a' }, { id: 'b' }];
    const { edges, positions } = layoutFlowGraph(nodes, [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'a' },
      { from: 'zzz', to: 'a' },
    ]);
    expect(edges).toHaveLength(2);
    expect(positions).toHaveLength(2);
  });
});
