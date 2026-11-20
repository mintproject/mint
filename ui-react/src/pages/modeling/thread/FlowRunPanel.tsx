/**
 * FlowRunPanel — how a flow's run is shown in the thread's Runs step.
 *
 * A flow runs as a graph of steps, not as one model job, so the model-shaped
 * "prepare inputs / run model / hand off" rows do not describe it. This panel
 * draws the run's own `workflow_stages`: one node per step, joined by
 * `depends_on`, with a plain list of the same steps underneath.
 */
import { RefreshCw } from 'lucide-react';
import { useState } from 'react';

import {
  WORKFLOW_NODE_WIDTH,
  WorkflowCanvas,
  type WorkflowCanvasEdge,
  type WorkflowCanvasPosition,
} from '@/components/modeling/WorkflowCanvas';
import { EnsembleManagerError, type UnifiedRunSnapshot } from '@/lib/ensemble-manager';
import { flowErrorMessage } from '@/lib/flow-errors';

type FlowStage = NonNullable<UnifiedRunSnapshot['workflow_stages']>[number];

type FlowStepState = 'waiting' | 'running' | 'completed' | 'failed' | 'skipped' | 'cancelled';

const STEP_LABEL: Record<FlowStepState, string> = {
  waiting: 'Waiting',
  running: 'Running',
  completed: 'Completed',
  failed: 'Failed',
  skipped: 'Skipped',
  cancelled: 'Cancelled',
};

// The same colours the model-shaped workflow rows use for each state.
const STEP_NODE_CLASS: Record<FlowStepState, string> = {
  waiting: 'border-gray-200 bg-white text-gray-600',
  running: 'border-blue-200 bg-blue-50 text-blue-800',
  completed: 'border-green-200 bg-green-50 text-green-800',
  failed: 'border-red-200 bg-red-50 text-red-800',
  cancelled: 'border-red-200 bg-red-50 text-red-800',
  skipped: 'border-gray-200 bg-gray-50 text-gray-500',
};

const STEP_PILL_CLASS: Record<FlowStepState, string> = {
  waiting: 'bg-gray-100 text-gray-700',
  running: 'bg-blue-100 text-blue-800',
  completed: 'bg-green-100 text-green-800',
  failed: 'bg-red-100 text-red-800',
  cancelled: 'bg-red-100 text-red-800',
  skipped: 'bg-gray-100 text-gray-500',
};

const NODE_HEIGHT = 128;
const LAYER_GAP = 100;
const ROW_GAP = 24;
const CANVAS_MIN_HEIGHT = 240;
const LAYOUT_OPTIONS = { nodeHeight: NODE_HEIGHT };
const TERMINAL_RUN_STATUSES = ['completed', 'failed', 'cancelled'];

/** A step's state from the word the Ensemble Manager reports for it. */
export function flowStepState(status?: string | null): FlowStepState {
  const word = String(status ?? '').toLowerCase();
  if (['running', 'adapter_running', 'submitting'].includes(word)) return 'running';
  if (['completed', 'succeeded', 'success'].includes(word)) return 'completed';
  if (['failed', 'failure', 'error'].includes(word)) return 'failed';
  if (['cancelled', 'canceled'].includes(word)) return 'cancelled';
  if (word === 'skipped') return 'skipped';
  return 'waiting';
}

/** What a step is called: its name, `stage_id` when it has none. */
export function flowStepLabel(stage: Pick<FlowStage, 'stage_id' | 'name'>): string {
  // Before the first poll the steps are unknown and the run is one stage.
  if (stage.stage_id === 'flow' && !stage.name) return 'Starting the flow';
  return stage.name?.trim() || stage.stage_id;
}

export interface FlowGraphNode {
  id: string;
  label: string;
  state: FlowStepState;
}

export interface FlowStageGraph {
  nodes: FlowGraphNode[];
  positions: WorkflowCanvasPosition<FlowGraphNode>[];
  edges: WorkflowCanvasEdge[];
}

/**
 * Nodes, positions and edges for a flow's stages.
 *
 * A step sits one layer right of the deepest step it depends on (the longest
 * path from a root), so steps with the same dependencies share a layer and run
 * side by side, and a step with several dependencies has one edge from each.
 * The canvas's own auto layout refines these starting positions.
 */
export function flowStageGraph(stages: readonly FlowStage[]): FlowStageGraph {
  const byId = new Map(stages.map((stage) => [stage.stage_id, stage]));
  const layerOf = new Map<string, number>();
  const layer = (id: string, trail: Set<string>): number => {
    const known = layerOf.get(id);
    if (known !== undefined) return known;
    if (trail.has(id)) return 0; // a cycle: do not recurse forever
    trail.add(id);
    const deps = (byId.get(id)?.depends_on ?? []).filter((dep) => byId.has(dep));
    const value = deps.length === 0 ? 0 : Math.max(...deps.map((dep) => layer(dep, trail))) + 1;
    trail.delete(id);
    layerOf.set(id, value);
    return value;
  };

  const nodes: FlowGraphNode[] = stages.map((stage) => ({
    id: stage.stage_id,
    label: flowStepLabel(stage),
    state: flowStepState(stage.status),
  }));
  const rowsUsed = new Map<number, number>();
  const hasDependents = new Set(stages.flatMap((stage) => stage.depends_on ?? []));
  const positions = nodes.map((node) => {
    const column = layer(node.id, new Set());
    const row = rowsUsed.get(column) ?? 0;
    rowsUsed.set(column, row + 1);
    const deps = (byId.get(node.id)?.depends_on ?? []).filter((dep) => byId.has(dep));
    return {
      node,
      x: 24 + column * (WORKFLOW_NODE_WIDTH + LAYER_GAP),
      y: 24 + row * (NODE_HEIGHT + ROW_GAP),
      hasInputPort: deps.length > 0,
      hasOutputPort: hasDependents.has(node.id),
      inputPortSide: 'left' as const,
      outputPortSide: 'right' as const,
    };
  });
  const at = new Map(positions.map((position) => [position.node.id, position]));
  const edges: WorkflowCanvasEdge[] = stages.flatMap((stage) =>
    (stage.depends_on ?? [])
      .filter((dep) => at.has(dep))
      .map((dep) => {
        const from = at.get(dep)!;
        const to = at.get(stage.stage_id)!;
        return {
          id: `${dep}-to-${stage.stage_id}`,
          source: dep,
          target: stage.stage_id,
          from: { x: from.x + WORKFLOW_NODE_WIDTH, y: from.y + NODE_HEIGHT / 2 },
          to: { x: to.x, y: to.y + NODE_HEIGHT / 2 },
        };
      }),
  );
  return { nodes, positions, edges };
}

function FlowStepNode({ node }: { node: FlowGraphNode }) {
  return (
    <div
      className={`h-[128px] w-full min-w-0 overflow-hidden rounded-lg border px-3 py-2 text-left shadow-sm ${STEP_NODE_CLASS[node.state]} ${
        node.state === 'running' ? 'ring-2 ring-blue-300 ring-offset-1' : ''
      }`}
      data-testid={`flow-node-${node.id}`}
      aria-current={node.state === 'running' ? 'step' : undefined}
      aria-label={`${node.label}: ${STEP_LABEL[node.state]}`}
    >
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide opacity-70">
        {STEP_LABEL[node.state]}
      </div>
      <div className="break-words font-semibold">{node.label}</div>
    </div>
  );
}

/** The run-level refusal text for a failed flow, once. */
function RunFailure({ run }: { run: UnifiedRunSnapshot }) {
  if (!run.failure_code && !run.error_message) return null;
  const known = run.failure_code
    ? flowErrorMessage(new EnsembleManagerError(0, run.error_message ?? '', run.failure_code))
    : null;
  return (
    <div
      className="rounded border border-red-200 bg-red-50 px-2 py-2 text-red-800"
      data-testid="flow-run-failure"
    >
      {known ? (
        <>
          <div className="font-medium">{known.title}</div>
          {known.lines.map((line, index) => (
            <div key={index}>{line}</div>
          ))}
        </>
      ) : (
        <>
          {run.failure_code && <div className="font-medium">Failure: {run.failure_code}</div>}
          {run.error_message && <div>{run.error_message}</div>}
        </>
      )}
    </div>
  );
}

export interface FlowRunPanelProps {
  run: UnifiedRunSnapshot;
  onRefresh?: () => Promise<void>;
  refreshing?: boolean;
  refreshError?: string;
  onCancel?: () => Promise<void>;
  cancelling?: boolean;
}

export function FlowRunPanel({
  run,
  onRefresh,
  refreshing = false,
  refreshError,
  onCancel,
  cancelling = false,
}: FlowRunPanelProps) {
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const stages: FlowStage[] = run.workflow_stages?.length
    ? run.workflow_stages
    : [
        {
          stage_id: 'flow',
          type: 'flow_step',
          depends_on: [],
          status: run.status ?? 'pending',
          provider: 'tapis-workflows',
          provider_ids: {},
        },
      ];
  const graph = flowStageGraph(stages);
  const tapisWorkflow = run.tapis_workflow;
  const active = !TERMINAL_RUN_STATUSES.includes(String(run.status ?? ''));
  const canvasHeight = Math.max(
    CANVAS_MIN_HEIGHT,
    ...graph.positions.map((position) => position.y + NODE_HEIGHT + 24),
  );

  return (
    <div
      className="space-y-3 rounded border border-blue-200 bg-blue-50 px-3 py-3 text-xs"
      data-testid="flow-run-panel"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-semibold text-blue-900">Flow steps</span>
        {onRefresh && (
          <button
            type="button"
            onClick={() => void onRefresh()}
            disabled={refreshing}
            className="flex items-center gap-1 rounded border border-blue-300 bg-white px-2 py-1 text-blue-800 hover:bg-blue-100 disabled:opacity-50"
            data-testid="refresh-workflow"
          >
            <RefreshCw className={`h-3 w-3 ${refreshing ? 'animate-spin' : ''}`} />
            {refreshing ? 'Refreshing…' : 'Refresh workflow'}
          </button>
        )}
      </div>

      <WorkflowCanvas
        positions={graph.positions}
        edges={graph.edges}
        renderNode={(node) => <FlowStepNode node={node} />}
        height={canvasHeight}
        layoutOptions={LAYOUT_OPTIONS}
        markerId={`flow-graph-arrow-${run.run_id ?? 'current'}`}
        testId="flow-graph-canvas"
      />

      <ol className="space-y-1" data-testid="flow-step-list">
        {stages.map((stage) => {
          const state = flowStepState(stage.status);
          const taskId = stage.provider_ids?.task_id;
          return (
            <li
              key={stage.stage_id}
              className="rounded border border-gray-200 bg-white px-2 py-2"
              data-testid={`flow-step-${stage.stage_id}`}
            >
              <div className="flex items-start justify-between gap-2">
                <span className="font-medium text-gray-900">{flowStepLabel(stage)}</span>
                <span className={`rounded px-2 py-0.5 text-[11px] ${STEP_PILL_CLASS[state]}`}>
                  {STEP_LABEL[state]}
                </span>
              </div>
              {stage.error_message && <p className="mt-1 text-red-800">{stage.error_message}</p>}
              {taskId && (
                <p className="mt-1 text-gray-500">
                  Task <code>{taskId}</code>
                </p>
              )}
            </li>
          );
        })}
      </ol>

      {active && onCancel && (
        <div className="flex flex-wrap items-center gap-2">
          {confirmingCancel ? (
            <>
              <span>Cancel this run in Tapis? This cannot be undone.</span>
              <button
                type="button"
                onClick={() => {
                  setConfirmingCancel(false);
                  void onCancel();
                }}
                disabled={cancelling}
                className="rounded border border-red-400 bg-red-600 px-2 py-1 text-white hover:bg-red-700 disabled:opacity-50"
                data-testid="confirm-cancel-workflow"
              >
                {cancelling ? 'Cancelling…' : 'Yes, cancel run'}
              </button>
              <button
                type="button"
                onClick={() => setConfirmingCancel(false)}
                className="rounded border border-gray-300 bg-white px-2 py-1 text-gray-800 hover:bg-gray-100"
              >
                Keep waiting
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmingCancel(true)}
              disabled={cancelling}
              className="rounded border border-red-300 bg-white px-2 py-1 text-red-800 hover:bg-red-100 disabled:opacity-50"
              data-testid="cancel-workflow"
            >
              Cancel run
            </button>
          )}
        </div>
      )}

      <RunFailure run={run} />

      <details className="rounded border border-blue-200 bg-white px-2 py-2 text-blue-800">
        <summary className="cursor-pointer font-medium">Technical identifiers</summary>
        <div className="mt-2 space-y-1">
          <div>
            Tapis workflow run ID: <code>{tapisWorkflow?.run_id ?? 'not submitted yet'}</code>
          </div>
          {tapisWorkflow?.workflow_id && (
            <div>
              Tapis pipeline ID: <code>{tapisWorkflow.workflow_id}</code>
            </div>
          )}
          {run.run_id && (
            <div>
              Execution ID: <code>{run.run_id}</code>
            </div>
          )}
        </div>
      </details>

      {refreshError && (
        <div className="rounded border border-amber-200 bg-amber-50 px-2 py-2 text-amber-800">
          Showing the last saved workflow state. Refresh failed: {refreshError}
        </div>
      )}
      <p className="text-[11px] text-blue-700">
        Application logs and files remain available from the run records below.
      </p>
    </div>
  );
}
