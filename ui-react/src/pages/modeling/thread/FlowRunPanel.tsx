/**
 * FlowRunPanel — how a flow's run is shown in the thread's Runs step.
 *
 * A flow runs as a graph of steps, not as one model job, so the model-shaped
 * "prepare inputs / run model / hand off" rows do not describe it. This panel
 * draws the run's own `workflow_stages`: one node per step, joined by
 * `depends_on`, once. A run stopped for an edit puts its controls first; a run
 * that failed says why and offers Restart; step task ids sit under a collapsed
 * "Technical details".
 */
import { RefreshCw } from 'lucide-react';
import { useState, type ReactNode } from 'react';

import {
  WorkflowCanvas,
  type WorkflowCanvasEdge,
  type WorkflowCanvasPosition,
} from '@/components/modeling/WorkflowCanvas';
import { FLOW_LAYOUT_OPTIONS, flowCanvasHeight, layoutFlowGraph } from '@/lib/flow-graph-layout';
import { RunFailureNotice } from '@/components/modeling/runs/RunFailureNotice';
import type { UnifiedRunSnapshot } from '@/lib/ensemble-manager';
import { stepErrorText } from '@/lib/flow-errors';
import { normalizeRunStatus } from '@/lib/modeling/run-status';
import { EditedInputNote } from './EditedInputNote';
import { PausedFlowStep, type PausedEdit } from './PausedFlowStep';

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
 * Nodes, positions and edges for a flow's stages: one node per stage, one edge
 * per `depends_on` entry, laid out by `layoutFlowGraph`.
 */
export function flowStageGraph(stages: readonly FlowStage[]): FlowStageGraph {
  const nodes: FlowGraphNode[] = stages.map((stage) => ({
    id: stage.stage_id,
    label: flowStepLabel(stage),
    state: flowStepState(stage.status),
  }));
  const links = stages.flatMap((stage) =>
    (stage.depends_on ?? []).map((dep) => ({ from: dep, to: stage.stage_id })),
  );
  return { nodes, ...layoutFlowGraph(nodes, links) };
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

export interface FlowRunPanelProps {
  run: UnifiedRunSnapshot;
  onRefresh?: () => Promise<void>;
  refreshing?: boolean;
  refreshError?: string;
  onCancel?: () => Promise<void>;
  cancelling?: boolean;
  /** Where the run's files are served from, and who is looking: for a run stopped for an edit. */
  ensembleManagerApi?: string;
  username?: string;
  /** Sends the user's edited file on and continues the run. */
  onResume?: (edit: PausedEdit) => Promise<void>;
  /** The control that sends the flow again, once it failed or was cancelled. */
  restartControl?: ReactNode;
}

export function FlowRunPanel({
  run,
  onRefresh,
  refreshing = false,
  refreshError,
  onCancel,
  cancelling = false,
  ensembleManagerApi = '',
  username = '',
  onResume,
  restartControl,
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
  const canvasHeight = flowCanvasHeight(graph.positions);
  const outcome = normalizeRunStatus(run.status);
  const ended = outcome === 'failed' || outcome === 'cancelled';
  const stepErrors = stages.flatMap((stage) =>
    stage.error_message ? [`${flowStepLabel(stage)}: ${stepErrorText(stage.error_message)}`] : [],
  );
  const tasks = stages.filter((stage) => stage.provider_ids?.task_id);

  return (
    <div className="space-y-3 text-xs" data-testid="flow-run-panel">
      {run.status === 'awaiting_edit' && run.pause && (
        <PausedFlowStep
          run={run}
          ensembleManagerApi={ensembleManagerApi}
          username={username}
          onResume={onResume}
          stepName={
            stages.find((stage) => stage.stage_id === `step-${run.pause?.paused_after_step}`)?.name
          }
        />
      )}
      {run.replacement && <EditedInputNote replacement={run.replacement} />}

      {(ended || run.failure_code || run.error_message || restartControl) && (
        <RunFailureNotice
          run={run}
          stepErrors={stepErrors}
          cancelled={outcome === 'cancelled'}
          actions={restartControl}
        />
      )}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-semibold text-gray-900">Steps</span>
        {onRefresh && (
          <button
            type="button"
            onClick={() => void onRefresh()}
            disabled={refreshing}
            className="flex items-center gap-1 rounded border border-gray-300 bg-white px-2 py-1 text-gray-800 hover:bg-gray-100 disabled:opacity-50"
            data-testid="refresh-workflow"
          >
            <RefreshCw className={`h-3 w-3 ${refreshing ? 'animate-spin' : ''}`} />
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
        )}
      </div>

      <WorkflowCanvas
        positions={graph.positions}
        edges={graph.edges}
        renderNode={(node) => <FlowStepNode node={node} />}
        height={canvasHeight}
        layoutOptions={FLOW_LAYOUT_OPTIONS}
        markerId={`flow-graph-arrow-${run.run_id ?? 'current'}`}
        testId="flow-graph-canvas"
      />

      {active && onCancel && (
        <div className="flex flex-wrap items-center gap-2">
          {confirmingCancel ? (
            <>
              <span>
                {run.status === 'awaiting_edit'
                  ? 'Cancel this run? It stops here and cannot be continued.'
                  : 'Cancel this run in Tapis? This cannot be undone.'}
              </span>
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

      <details className="text-gray-700" data-testid="flow-technical-details">
        <summary className="cursor-pointer font-medium text-gray-800">Technical details</summary>
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
          {tasks.length > 0 && (
            <ul className="space-y-0.5" data-testid="flow-step-list">
              {tasks.map((stage) => (
                <li key={stage.stage_id} data-testid={`flow-step-${stage.stage_id}`}>
                  {flowStepLabel(stage)}: task <code>{stage.provider_ids?.task_id}</code>
                </li>
              ))}
            </ul>
          )}
        </div>
      </details>

      {refreshError && (
        <div className="rounded border border-amber-200 bg-amber-50 px-2 py-2 text-amber-800">
          Showing the last saved workflow state. Refresh failed: {refreshError}
        </div>
      )}
    </div>
  );
}
