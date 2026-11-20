/**
 * Reading a stored flow for the model page: its steps as a graph, and its wires
 * as sentences.
 *
 * A wire is `{"to": {...}, "from": {...}}`:
 *
 *   to    {"input": k} | {"setting": name} | {}
 *   from  {"flow_input": id} | {"flow_parameter": id} | {"step": n, "output": k}
 *         | {"step": n, "value": name} | {"step": n}
 *
 * The stored JSON is read defensively: a malformed entry is skipped, never thrown.
 */
import type { FlowStepRow } from '@/graphql/queries/flows';
import { layoutFlowGraph, type FlowGraphLayout, type FlowGraphLink } from './flow-graph-layout';

export interface FlowWire {
  to: { input?: number; setting?: string };
  from: {
    flow_input?: string;
    flow_parameter?: string;
    step?: number;
    output?: number;
    value?: string;
  };
}

/** Display names for the ids a flow's wires and bindings refer to. */
export interface FlowLabels {
  inputs: ReadonlyMap<string, string>;
  parameters: ReadonlyMap<string, string>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isInt = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value);

export function parseWires(json: unknown): FlowWire[] {
  if (!Array.isArray(json)) return [];
  const wires: FlowWire[] = [];
  for (const raw of json) {
    if (!isRecord(raw) || !isRecord(raw.from)) continue;
    const to = isRecord(raw.to) ? raw.to : {};
    const from = raw.from;
    wires.push({
      to: {
        ...(isInt(to.input) ? { input: to.input } : {}),
        ...(typeof to.setting === 'string' ? { setting: to.setting } : {}),
      },
      from: {
        ...(typeof from.flow_input === 'string' ? { flow_input: from.flow_input } : {}),
        ...(typeof from.flow_parameter === 'string' ? { flow_parameter: from.flow_parameter } : {}),
        ...(isInt(from.step) ? { step: from.step } : {}),
        ...(isInt(from.output) ? { output: from.output } : {}),
        ...(typeof from.value === 'string' ? { value: from.value } : {}),
      },
    });
  }
  return wires;
}

/** The settings a flow gives a step, as name and display value. */
export function parseSettings(json: unknown): [string, string][] {
  if (!isRecord(json)) return [];
  return Object.entries(json).map(([name, value]) => [
    name,
    typeof value === 'string' ? value : JSON.stringify(value),
  ]);
}

function wireTarget(wire: FlowWire): string | null {
  if (wire.to.input !== undefined) return `input ${wire.to.input}`;
  if (wire.to.setting !== undefined) return `setting ${wire.to.setting}`;
  return null;
}

function wireSource(wire: FlowWire, labels: FlowLabels): string {
  const { from } = wire;
  if (from.flow_input !== undefined) {
    return `flow input ${labels.inputs.get(from.flow_input) ?? from.flow_input}`;
  }
  if (from.flow_parameter !== undefined) {
    return `flow parameter ${labels.parameters.get(from.flow_parameter) ?? from.flow_parameter}`;
  }
  const detail =
    from.output !== undefined
      ? `, output ${from.output}`
      : from.value !== undefined
        ? `, value ${from.value}`
        : '';
  return `step ${from.step}${detail}`;
}

/** One wire as a sentence: "input 0 ← step 2, output 1" or "runs after step 3". */
export function describeWire(wire: FlowWire, labels: FlowLabels): string {
  const target = wireTarget(wire);
  if (target === null) {
    return wire.from.step !== undefined
      ? `runs after step ${wire.from.step}`
      : `reads ${wireSource(wire, labels)}`;
  }
  return `${target} ← ${wireSource(wire, labels)}`;
}

const THREAD_ROLE_SENTENCE: Record<string, string> = {
  region: "The thread's region fills",
  start_date: "The thread's start date fills",
  end_date: "The thread's end date fills",
};

/** Lines for what the thread fills in and which inputs take a collection of files. */
export function threadBindingLines(bindingsJson: unknown, labels: FlowLabels): string[] {
  if (!isRecord(bindingsJson)) return [];
  const lines: string[] = [];
  for (const [role, sentence] of Object.entries(THREAD_ROLE_SENTENCE)) {
    const target = bindingsJson[role];
    if (!isRecord(target)) continue;
    if (typeof target.input === 'string') {
      lines.push(`${sentence}: ${labels.inputs.get(target.input) ?? target.input}`);
    } else if (typeof target.parameter === 'string') {
      lines.push(`${sentence}: ${labels.parameters.get(target.parameter) ?? target.parameter}`);
    }
  }
  const collections = bindingsJson.collections;
  if (Array.isArray(collections)) {
    for (const entry of collections) {
      const id = typeof entry === 'string' ? entry : isRecord(entry) ? entry.input : undefined;
      if (typeof id === 'string') {
        lines.push(`Takes a collection of files: ${labels.inputs.get(id) ?? id}`);
      }
    }
  }
  return lines;
}

/** Whether the caller may run a step, as the adapter reports it (see flow-availability). */
export type StepRunnable = { runnable: boolean; reason: string | null };

export interface FlowStepsNode {
  id: string;
  kind: 'input' | 'parameter' | 'step';
  label: string;
  /** A step whose piece is deleted or hidden. */
  missing?: boolean;
  /** The adapter's answer for a step, when it gave one. */
  availability?: StepRunnable;
}

export interface FlowStepsGraph extends FlowGraphLayout<FlowStepsNode> {
  nodes: FlowStepsNode[];
}

export const stepNodeId = (position: number) => `step-${position}`;

/** The text a step shows for its piece. */
export function stepPieceLabel(step: FlowStepRow): string {
  return step.etl_process?.label?.trim() || step.etl_process?.id || 'Missing piece';
}

/**
 * Nodes and edges for a flow: the flow inputs its wires read, then its steps. An
 * edge for every wire that carries data, a value or just an order; wires between
 * the same two nodes share one edge and one label.
 */
export function flowStepsGraph(
  steps: readonly FlowStepRow[],
  labels: FlowLabels,
  availability: ReadonlyMap<number, StepRunnable> = new Map(),
): FlowStepsGraph {
  const stepNodes: FlowStepsNode[] = steps.map((step) => ({
    id: stepNodeId(step.position),
    kind: 'step',
    label: `${step.position}. ${stepPieceLabel(step)}`,
    missing: !step.etl_process,
    availability: availability.get(step.position),
  }));
  const stepIds = new Set(stepNodes.map((node) => node.id));

  const sourceNodes = new Map<string, FlowStepsNode>();
  const edgeLabels = new Map<string, { link: FlowGraphLink; parts: string[] }>();
  for (const step of steps) {
    const to = stepNodeId(step.position);
    for (const wire of parseWires(step.wires_json)) {
      let from: string;
      if (wire.from.flow_input !== undefined) {
        from = `input-${wire.from.flow_input}`;
        if (!sourceNodes.has(from)) {
          sourceNodes.set(from, {
            id: from,
            kind: 'input',
            label: labels.inputs.get(wire.from.flow_input) ?? wire.from.flow_input,
          });
        }
      } else if (wire.from.flow_parameter !== undefined) {
        from = `parameter-${wire.from.flow_parameter}`;
        if (!sourceNodes.has(from)) {
          sourceNodes.set(from, {
            id: from,
            kind: 'parameter',
            label: labels.parameters.get(wire.from.flow_parameter) ?? wire.from.flow_parameter,
          });
        }
      } else if (wire.from.step !== undefined && stepIds.has(stepNodeId(wire.from.step))) {
        from = stepNodeId(wire.from.step);
      } else {
        continue;
      }
      const part = [
        wire.from.output !== undefined ? `output ${wire.from.output}` : null,
        wire.from.value !== undefined ? `value ${wire.from.value}` : null,
      ]
        .filter(Boolean)
        .join('');
      const target = wireTarget(wire);
      const text = target ? (part ? `${part} → ${target}` : target) : 'runs after';
      const key = `${from}>${to}`;
      const found = edgeLabels.get(key);
      if (found) found.parts.push(text);
      else edgeLabels.set(key, { link: { from, to }, parts: [text] });
    }
  }

  const nodes = [...sourceNodes.values(), ...stepNodes];
  const links = [...edgeLabels.values()].map(({ link, parts }) => ({
    ...link,
    label: parts.join(', '),
  }));
  return { nodes, ...layoutFlowGraph(nodes, links) };
}
