/**
 * Starting layout for a flow's graph on the `WorkflowCanvas`.
 *
 * Shared by the run panel (a run's stages) and the model page (a flow's steps):
 * both hand over nodes and "A feeds B" links and get back positions and edges.
 */
import {
  WORKFLOW_NODE_WIDTH,
  type WorkflowCanvasEdge,
  type WorkflowCanvasPosition,
} from '@/components/modeling/WorkflowCanvas';

export const FLOW_NODE_HEIGHT = 128;
export const FLOW_CANVAS_MIN_HEIGHT = 240;
export const FLOW_LAYOUT_OPTIONS = { nodeHeight: FLOW_NODE_HEIGHT };

const LAYER_GAP = 100;
const ROW_GAP = 24;

/** `from` comes before `to`: an edge is drawn from one node to the other. */
export interface FlowGraphLink {
  from: string;
  to: string;
  label?: string | null;
}

export interface FlowGraphLayout<T extends { id: string }> {
  positions: WorkflowCanvasPosition<T>[];
  edges: WorkflowCanvasEdge[];
}

/**
 * Positions and edges for `nodes` joined by `links`.
 *
 * A node sits one layer right of the deepest node it depends on (the longest path
 * from a root), so nodes with the same dependencies share a layer and sit side by
 * side, and a node with several dependencies has one edge from each. A link to or
 * from an unknown node is ignored. The canvas's own auto layout refines these
 * starting positions.
 */
export function layoutFlowGraph<T extends { id: string }>(
  nodes: readonly T[],
  links: readonly FlowGraphLink[],
): FlowGraphLayout<T> {
  const known = new Set(nodes.map((node) => node.id));
  const usable = links.filter((link) => known.has(link.from) && known.has(link.to));
  const dependsOn = new Map<string, string[]>();
  for (const link of usable) dependsOn.set(link.to, [...(dependsOn.get(link.to) ?? []), link.from]);
  const hasDependents = new Set(usable.map((link) => link.from));

  const layerOf = new Map<string, number>();
  const layer = (id: string, trail: Set<string>): number => {
    const cached = layerOf.get(id);
    if (cached !== undefined) return cached;
    if (trail.has(id)) return 0; // a cycle: do not recurse forever
    trail.add(id);
    const deps = dependsOn.get(id) ?? [];
    const value = deps.length === 0 ? 0 : Math.max(...deps.map((dep) => layer(dep, trail))) + 1;
    trail.delete(id);
    layerOf.set(id, value);
    return value;
  };

  const rowsUsed = new Map<number, number>();
  const positions: WorkflowCanvasPosition<T>[] = nodes.map((node) => {
    const column = layer(node.id, new Set());
    const row = rowsUsed.get(column) ?? 0;
    rowsUsed.set(column, row + 1);
    return {
      node,
      x: 24 + column * (WORKFLOW_NODE_WIDTH + LAYER_GAP),
      y: 24 + row * (FLOW_NODE_HEIGHT + ROW_GAP),
      hasInputPort: (dependsOn.get(node.id) ?? []).length > 0,
      hasOutputPort: hasDependents.has(node.id),
      inputPortSide: 'left' as const,
      outputPortSide: 'right' as const,
    };
  });
  const at = new Map(positions.map((position) => [position.node.id, position]));
  const edges: WorkflowCanvasEdge[] = usable.map((link) => {
    const from = at.get(link.from)!;
    const to = at.get(link.to)!;
    return {
      id: `${link.from}-to-${link.to}`,
      source: link.from,
      target: link.to,
      from: { x: from.x + WORKFLOW_NODE_WIDTH, y: from.y + FLOW_NODE_HEIGHT / 2 },
      to: { x: to.x, y: to.y + FLOW_NODE_HEIGHT / 2 },
      ...(link.label ? { label: link.label } : {}),
    };
  });
  return { positions, edges };
}

/** Canvas height that fits every positioned node. */
export function flowCanvasHeight(positions: readonly { y: number }[]): number {
  return Math.max(FLOW_CANVAS_MIN_HEIGHT, ...positions.map((p) => p.y + FLOW_NODE_HEIGHT + 24));
}
