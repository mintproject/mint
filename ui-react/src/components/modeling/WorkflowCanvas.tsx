import {
  Background,
  BackgroundVariant,
  BaseEdge,
  Controls,
  EdgeLabelRenderer,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  getBezierPath,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeChange,
  type NodeProps,
} from '@xyflow/react';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import '@xyflow/react/dist/style.css';

import {
  autoLayoutWorkflow,
  refreshWorkflowEdgeEndpoints,
  workflowGraphSignature,
  type WorkflowAutoLayoutOptions,
} from './workflowLayout';

export interface WorkflowCanvasPosition<T extends { id: string }> {
  node: T;
  x: number;
  y: number;
  hasInputPort: boolean;
  hasOutputPort: boolean;
  inputPortSide?: 'left' | 'top';
  outputPortSide?: 'right' | 'bottom';
}

export interface WorkflowCanvasEdge {
  id?: string;
  source?: string;
  target?: string;
  from: { x: number; y: number };
  to: { x: number; y: number };
  label?: string | null;
}

export const WORKFLOW_CANVAS_WIDTH = 520;
export const WORKFLOW_NODE_WIDTH = 200;

function workflowEdgeLabel(label: string): string {
  return label.length > 32 ? `${label.slice(0, 31)}…` : label;
}

interface WorkflowNodeData<T extends { id: string }> extends Record<string, unknown> {
  position: WorkflowCanvasPosition<T>;
  renderNode: (node: T, selected: boolean) => ReactNode;
}

type WorkflowFlowNode<T extends { id: string }> = Node<WorkflowNodeData<T>, 'workflow'>;

function WorkflowNode<T extends { id: string }>({
  data,
  selected,
}: NodeProps<WorkflowFlowNode<T>>) {
  return (
    <>
      <Handle
        type="target"
        position={Position.Left}
        className="!h-4 !w-4 !border-gray-700 !bg-white"
        style={{
          display:
            data.position.hasInputPort && data.position.inputPortSide !== 'top'
              ? undefined
              : 'none',
        }}
        isConnectable={false}
      />
      <Handle
        type="target"
        position={Position.Top}
        className="!h-4 !w-4 !border-gray-700 !bg-white"
        style={{
          display:
            data.position.hasInputPort && data.position.inputPortSide === 'top'
              ? undefined
              : 'none',
        }}
        isConnectable={false}
      />
      <Handle
        type="source"
        position={Position.Right}
        className="!h-4 !w-4 !border-gray-700 !bg-white"
        style={{
          display:
            data.position.hasOutputPort && data.position.outputPortSide !== 'bottom'
              ? undefined
              : 'none',
        }}
        isConnectable={false}
      />
      <Handle
        type="source"
        position={Position.Bottom}
        className="!h-4 !w-4 !border-gray-700 !bg-white"
        style={{
          display:
            data.position.hasOutputPort && data.position.outputPortSide === 'bottom'
              ? undefined
              : 'none',
        }}
        isConnectable={false}
      />
      <div
        className={selected ? 'rounded-lg ring-2 ring-blue-500 ring-offset-2' : ''}
        style={{ width: WORKFLOW_NODE_WIDTH }}
      >
        {data.renderNode(data.position.node, selected)}
      </div>
    </>
  );
}

function edgePosition(from: { x: number; y: number }, to: { x: number; y: number }) {
  const horizontal = Math.abs(to.x - from.x) >= Math.abs(to.y - from.y);
  if (horizontal) {
    return {
      sourcePosition: to.x >= from.x ? Position.Right : Position.Left,
      targetPosition: to.x >= from.x ? Position.Left : Position.Right,
    };
  }
  return {
    sourcePosition: to.y >= from.y ? Position.Bottom : Position.Top,
    targetPosition: to.y >= from.y ? Position.Top : Position.Bottom,
  };
}

interface WorkflowEdgeData extends Record<string, unknown> {
  label?: string | null;
}

type WorkflowFlowEdge = Edge<WorkflowEdgeData, 'workflow'>;

function WorkflowEdge({
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerEnd,
  data,
}: EdgeProps<WorkflowFlowEdge>) {
  const [path, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    curvature: 0.25,
  });
  const label = data?.label;

  return (
    <>
      <BaseEdge path={path} markerEnd={markerEnd} style={{ stroke: '#64748b', strokeWidth: 2 }} />
      {label && (
        <EdgeLabelRenderer>
          <div
            className="pointer-events-none absolute z-10 max-w-[180px] -translate-x-1/2 -translate-y-1/2 truncate rounded border border-slate-200 bg-white/95 px-1.5 py-0.5 text-[10px] font-medium leading-tight text-slate-600 shadow-sm"
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)` }}
            title={label}
            aria-label={`SVO: ${label}`}
          >
            {workflowEdgeLabel(label)}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

export function WorkflowCanvas<T extends { id: string }>({
  positions,
  edges,
  selectedId,
  renderNode,
  height,
  testId,
  autoLayout = true,
  layoutOptions,
}: {
  positions: WorkflowCanvasPosition<T>[];
  edges: WorkflowCanvasEdge[];
  selectedId?: string;
  renderNode: (node: T, selected: boolean) => ReactNode;
  height: number;
  markerId: string;
  testId?: string;
  autoLayout?: boolean;
  layoutOptions?: WorkflowAutoLayoutOptions;
}) {
  const graphRef = useRef({ positions, edges });
  graphRef.current = { positions, edges };
  const graphKey = workflowGraphSignature(positions, edges);
  const [positionOverrides, setPositionOverrides] = useState<
    Record<string, { x: number; y: number }>
  >({});
  const [layoutRevision, setLayoutRevision] = useState(0);
  const [layout, setLayout] = useState(() => ({
    positions,
    edges,
    width: WORKFLOW_CANVAS_WIDTH,
    height,
  }));

  useEffect(() => {
    let cancelled = false;
    const graph = graphRef.current;
    setPositionOverrides({});

    if (!autoLayout) {
      setLayout({
        positions: graph.positions,
        edges: graph.edges,
        width: WORKFLOW_CANVAS_WIDTH,
        height,
      });
      setLayoutRevision((revision) => revision + 1);
      return () => {
        cancelled = true;
      };
    }

    void autoLayoutWorkflow(graph.positions, graph.edges, {
      minWidth: WORKFLOW_CANVAS_WIDTH,
      minHeight: height,
      ...layoutOptions,
    }).then((nextLayout) => {
      if (!cancelled) {
        setLayout(nextLayout);
        setLayoutRevision((revision) => revision + 1);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [autoLayout, graphKey, height, layoutOptions]);

  // The layout is a snapshot taken when the graph's shape last changed, so its
  // node objects go stale as a node's data does (a step's state, say). Take the
  // geometry from the layout and the node itself from the current props.
  const currentNodes = new Map(positions.map((position) => [position.node.id, position.node]));
  const displayedPositions = layout.positions.map((position) => ({
    ...position,
    node: currentNodes.get(position.node.id) ?? position.node,
    ...(positionOverrides[position.node.id] ?? {}),
  }));
  const displayedEdges = refreshWorkflowEdgeEndpoints(
    displayedPositions,
    layout.edges,
    layoutOptions?.nodeHeight,
  );
  const interactive = import.meta.env.MODE !== 'test';
  const nodesDraggable = interactive;
  const handleNodesChange = useCallback(
    (changes: NodeChange[]) => {
      const visibleNodeIds = new Set(layout.positions.map((position) => position.node.id));
      const positionChanges = changes.filter(
        (change): change is NodeChange & { type: 'position'; position: { x: number; y: number } } =>
          change.type === 'position' && Boolean(change.position) && visibleNodeIds.has(change.id),
      );
      if (positionChanges.length === 0) return;
      setPositionOverrides((current) => {
        const next = { ...current };
        positionChanges.forEach((change) => {
          next[change.id] = change.position;
        });
        return next;
      });
    },
    [layout.positions],
  );

  const nodeTypes = { workflow: WorkflowNode };
  const edgeTypes = { workflow: WorkflowEdge };
  const visibleNodes: WorkflowFlowNode<T>[] = displayedPositions.map((position) => ({
    id: position.node.id,
    type: 'workflow',
    position: { x: position.x, y: position.y },
    data: {
      position,
      renderNode,
    },
    selected: position.node.id === selectedId,
    draggable: nodesDraggable,
    selectable: true,
    connectable: false,
    style: { width: WORKFLOW_NODE_WIDTH, height: 128 },
  }));

  const anchorNodes: Node[] = displayedEdges.flatMap((edge, index) => [
    {
      id: `workflow-edge-source-${index}`,
      position: edge.from,
      data: {},
      width: 2,
      height: 2,
      initialWidth: 2,
      initialHeight: 2,
      style: { width: 2, height: 2, opacity: 0, pointerEvents: 'none' },
      draggable: false,
      selectable: false,
      connectable: false,
    },
    {
      id: `workflow-edge-target-${index}`,
      position: edge.to,
      data: {},
      width: 2,
      height: 2,
      initialWidth: 2,
      initialHeight: 2,
      style: { width: 2, height: 2, opacity: 0, pointerEvents: 'none' },
      draggable: false,
      selectable: false,
      connectable: false,
    },
  ]);

  const flowEdges: WorkflowFlowEdge[] = displayedEdges.map((edge, index) => {
    const { sourcePosition, targetPosition } = edgePosition(edge.from, edge.to);
    return {
      id: edge.id ?? `workflow-edge-${index}`,
      type: 'workflow',
      source: `workflow-edge-source-${index}`,
      target: `workflow-edge-target-${index}`,
      sourcePosition,
      targetPosition,
      data: { label: edge.label },
      markerEnd: { type: MarkerType.ArrowClosed, color: '#64748b', width: 16, height: 16 },
      focusable: Boolean(edge.label),
    };
  });

  return (
    <div
      className="min-w-0 overflow-x-auto rounded-lg border border-gray-300 bg-white p-2"
      data-testid={testId ?? 'workflow-canvas'}
    >
      <div
        className="relative min-w-[520px] rounded-md"
        style={{ width: '100%', height: layout.height }}
      >
        <div className="sr-only" aria-label="SVO contracts">
          {displayedEdges
            .filter((edge): edge is WorkflowCanvasEdge & { label: string } => Boolean(edge.label))
            .map((edge, index) => (
              <span key={`workflow-svo-label-${index}`} aria-label={`SVO: ${edge.label}`}>
                {edge.label}
              </span>
            ))}
        </div>
        <ReactFlow
          key={`${testId ?? 'workflow-canvas'}-${layoutRevision}`}
          nodes={[...visibleNodes, ...anchorNodes]}
          edges={flowEdges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          fitView
          fitViewOptions={{ padding: 0.18, minZoom: 0.35, maxZoom: 1.2 }}
          nodesDraggable={nodesDraggable}
          nodesConnectable={false}
          elementsSelectable
          onNodesChange={handleNodesChange}
          panOnDrag={interactive}
          zoomOnScroll
          zoomOnPinch
          zoomOnDoubleClick={false}
          proOptions={{ hideAttribution: true }}
          aria-label="Workflow graph"
        >
          <Background variant={BackgroundVariant.Dots} gap={16} size={1.2} color="#cbd5e1" />
          <Controls showInteractive={false} position="bottom-left" />
        </ReactFlow>
      </div>
    </div>
  );
}
