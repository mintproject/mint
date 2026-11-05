/**
 * MintRuns — Execution lifecycle: submit, monitor, cancel.
 *
 * 1:1 port of the legacy LitElement MintRuns component.
 * Shows per-model run counts, progress bars, and allows submitting runs to the
 * mint-ensemble-manager REST API. Supports log viewing via a modal dialog.
 *
 * Legacy: ui/src/screens/modeling/thread/mint-runs.ts
 */
import { ExternalLink, FolderOpen, RefreshCw, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';

import {
  Execution,
  ExecutionSummaryMap,
  ModelExecutionsMap,
  ThreadExecutionData,
} from '@/graphql/generated/execution';
import {
  WORKFLOW_NODE_WIDTH,
  WorkflowCanvas,
  type WorkflowCanvasEdge,
  type WorkflowCanvasPosition,
} from '@/components/modeling/WorkflowCanvas';
import { RunConfigurationSummary } from '@/components/modeling/runs/RunConfigurationSummary';
import { RunAnswerCard } from '@/components/modeling/runs/RunAnswerCard';
import { RunStageTimeline } from '@/components/modeling/runs/RunStageTimeline';
import { RunStatusSummary } from '@/components/modeling/runs/RunStatusSummary';
import {
  fetchExecutionLog,
  fetchPlanPublishers,
  type PlanPublisher,
  type UnifiedPublication,
  type UnifiedRunSnapshot,
} from '@/lib/ensemble-manager';
import { adapterParametersComplete, type ThreadAdapterPlan } from '@/lib/adapter-execution';
import { aggregateRunStatus, stageStatusFromLegacyState } from '@/lib/modeling/run-status';
import { inputResourceCount } from '@/lib/thread-execution';
import { secretErrorMessage, userParameters } from '@/lib/secret-parameters';
import { ExecutionFilesDialog } from './ExecutionFilesDialog';
import { PublishOutputsControl } from './PublishOutputsControl';
import {
  publishRequestFor,
  type PublishRequest,
  type PublishSelection,
} from '@/lib/publish-outputs';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function toDateTimeString(ts: string | null | undefined): string {
  if (!ts) return '—';
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return ts;
  }
}

function getResourceUrl(res: {
  url?: string | null;
  location?: string | null;
  name?: string | null;
}): string {
  return res.url ?? res.location ?? res.name ?? '';
}

// ─── Status progress bar ─────────────────────────────────────────────────────

const STATUS_BAR_CLASSES: Record<string, string> = {
  SUCCESS: 'bg-green-500',
  FAILURE: 'bg-red-500',
  RUNNING: 'bg-blue-400',
  WAITING: 'bg-gray-300',
};

interface StatusBarProps {
  status: string;
  progress?: number | null;
}

function StatusBar({ status, progress }: StatusBarProps) {
  // `execution.run_progress` is a fraction, not a percentage — a finished run
  // stores 1. Read live from TACC, where every completed run reads 1. Treating
  // it as a percentage drew every running job as a 1%-wide sliver.
  const pct = status === 'FAILURE' ? 100 : Math.min(100, Math.max(0, (progress ?? 0) * 100));
  const color = STATUS_BAR_CLASSES[status] ?? 'bg-gray-300';
  return (
    <div
      className="h-4 w-24 overflow-hidden rounded bg-gray-200"
      title={status}
      aria-label={`Run status: ${status}`}
    >
      <div className={`h-full transition-all ${color}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

// ─── Log dialog ───────────────────────────────────────────────────────────────

interface LogDialogProps {
  open: boolean;
  log: string | null;
  onClose: () => void;
}

function LogDialog({ open, log, onClose }: LogDialogProps) {
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      role="dialog"
      aria-modal="true"
      aria-label="Run log"
    >
      <div className="mx-4 flex max-h-[80vh] w-full max-w-3xl flex-col rounded-lg bg-white shadow-xl">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <h3 className="text-sm font-semibold">Run log</h3>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 hover:bg-gray-100"
            aria-label="Close log dialog"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex-1 overflow-auto p-4">
          {log == null ? (
            <div className="flex items-center justify-center py-8">
              <span className="h-6 w-6 animate-spin rounded-full border-2 border-blue-600 border-t-transparent" />
            </div>
          ) : (
            <pre className="whitespace-pre-wrap font-mono text-xs">{log}</pre>
          )}
        </div>
        <div className="flex justify-end border-t px-4 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

function displayStatus(status?: string | null): string {
  if (!status) return 'pending';
  return status.replace(/_/g, ' ');
}

type WorkflowStageState = 'success' | 'failure' | 'running' | 'pending' | 'not-required';

function workflowStageClass(state: WorkflowStageState): string {
  if (state === 'success') return 'border-green-200 bg-green-50 text-green-800';
  if (state === 'failure') return 'border-red-200 bg-red-50 text-red-800';
  if (state === 'running') return 'border-blue-200 bg-blue-50 text-blue-800';
  if (state === 'not-required') return 'border-gray-200 bg-gray-50 text-gray-500';
  return 'border-gray-200 bg-white text-gray-600';
}

function workflowStageLabel(state: WorkflowStageState): string {
  if (state === 'success') return 'Completed';
  if (state === 'failure') return 'Failed';
  if (state === 'running') return 'Running';
  if (state === 'not-required') return 'Not required';
  return 'Waiting';
}

function isWorkflowFailure(status?: string | null): boolean {
  const normalized = String(status ?? '').toLowerCase();
  return (
    normalized.includes('fail') ||
    normalized.includes('unknown') ||
    normalized.includes('cancel') ||
    normalized === 'error'
  );
}

function isWorkflowSuccess(status?: string | null): boolean {
  return ['completed', 'success', 'model_succeeded'].includes(String(status ?? '').toLowerCase());
}

function workflowStageState(status?: string | null): WorkflowStageState {
  const normalized = String(status ?? '').toLowerCase();
  if (isWorkflowFailure(normalized)) return 'failure';
  if (['succeeded', 'completed', 'success', 'model_succeeded'].includes(normalized))
    return 'success';
  if (['running', 'submitting'].includes(normalized)) return 'running';
  return 'pending';
}

export function modelProviderState(run: UnifiedRunSnapshot): WorkflowStageState | null {
  const status = String(run.model_result?.status ?? '').toLowerCase();
  if (['success', 'succeeded', 'completed'].includes(status)) return 'success';
  if (['failure', 'failed', 'error', 'cancelled'].includes(status)) return 'failure';
  return null;
}

function modelProviderStatus(run: UnifiedRunSnapshot): string | null {
  const status = run.model_result?.status;
  return typeof status === 'string' && status ? status : null;
}

function contractValue(contract: unknown, ...keys: string[]): string | null {
  if (!contract || typeof contract !== 'object') return null;
  const record = contract as Record<string, unknown>;
  for (const key of keys) {
    if (typeof record[key] === 'string' && record[key]) return record[key] as string;
  }
  return null;
}

function shortContractValue(value: string | null): string {
  if (!value) return 'SVO contract';
  const parts = value.split(/[/:#]/).filter(Boolean);
  return parts.at(-1) ?? value;
}

function adapterPlanTargetContract(plan: ThreadAdapterPlan): unknown {
  const planJson = plan.plan_json as Record<string, unknown> | undefined;
  const deferred = planJson?.post_model_adapter;
  if (deferred && typeof deferred === 'object') {
    return (deferred as Record<string, unknown>).target_contract;
  }
  return planJson?.target_contract;
}

function adapterPlanSourceContract(plan: ThreadAdapterPlan): unknown {
  if (plan.source_contract) return plan.source_contract;
  const planJson = plan.plan_json as Record<string, unknown> | undefined;
  const deferred = planJson?.post_model_adapter;
  if (deferred && typeof deferred === 'object') {
    return (deferred as Record<string, unknown>).source_contract;
  }
  return planJson?.source_contract;
}

/** The step a plan marks `publishes: true`, wherever the plan nests its steps. */
function publishingStep(plan: ThreadAdapterPlan): Record<string, unknown> | null {
  const planJson = plan.plan_json as Record<string, unknown> | undefined;
  const deferred = planJson?.post_model_adapter as Record<string, unknown> | undefined;
  for (const holder of [deferred, planJson]) {
    const steps = holder?.steps;
    if (!Array.isArray(steps)) continue;
    const found = steps.find(
      (step) =>
        step && typeof step === 'object' && (step as { publishes?: unknown }).publishes === true,
    );
    if (found) return found as Record<string, unknown>;
  }
  return null;
}

function publicationState(publication?: UnifiedPublication | null): WorkflowStageState {
  if (!publication) return 'pending';
  if (publication.status === 'published') return 'success';
  if (publication.status === 'failed') return 'failure';
  return 'pending';
}

function PublicationSummary({ publication }: { publication: UnifiedPublication }) {
  if (publication.status === 'published') {
    return (
      <div
        className="rounded border border-green-200 bg-green-50 px-2 py-2 text-green-900"
        data-testid="publication-published"
      >
        <div className="font-medium">Published</div>
        <ul className="mt-1 space-y-1">
          {publication.ckan_dataset && (
            <li>
              <a
                href={publication.ckan_dataset}
                target="_blank"
                rel="noreferrer"
                className="text-blue-700 underline"
              >
                CKAN dataset
              </a>
            </li>
          )}
          {publication.stac_item && (
            <li>
              <a
                href={publication.stac_item}
                target="_blank"
                rel="noreferrer"
                className="text-blue-700 underline"
              >
                STAC item
              </a>
            </li>
          )}
        </ul>
      </div>
    );
  }
  if (publication.status === 'failed') {
    return (
      <div
        className="rounded border border-red-200 bg-red-50 px-2 py-2 text-red-800"
        data-testid="publication-failed"
      >
        <div className="font-medium">Publishing failed</div>
        {publication.error && <div>{publication.error}</div>}
        <div className="mt-1 text-red-700">The model output is still available.</div>
      </div>
    );
  }
  if (publication.status === 'awaiting_owner') {
    return (
      <div
        className="rounded border border-amber-200 bg-amber-50 px-2 py-2 text-amber-800"
        data-testid="publication-awaiting-owner"
      >
        Waiting for the run&apos;s owner to publish
      </div>
    );
  }
  return null;
}

interface WorkflowGraphNode {
  id: string;
  label: string;
  detail: string;
  state: WorkflowStageState;
  kind: 'etl' | 'model' | 'handoff';
  contract?: string | null;
}

function WorkflowGraphNodeView({
  node,
  selected,
  onSelect,
}: {
  node: WorkflowGraphNode;
  selected: boolean;
  onSelect: () => void;
}) {
  const kindLabel = node.kind === 'etl' ? 'SVO ETL' : node.kind === 'handoff' ? 'Handoff' : 'Model';
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={`h-[128px] w-full min-w-0 overflow-hidden rounded-lg border px-3 py-2 text-left shadow-sm ${workflowStageClass(node.state)} ${
        selected ? 'ring-2 ring-blue-300 ring-offset-1' : ''
      } ${node.state === 'running' ? 'ring-2 ring-blue-300 ring-offset-1' : ''}`}
      data-testid={`workflow-node-${node.id}`}
      aria-current={node.state === 'running' ? 'step' : undefined}
      aria-label={`${kindLabel}: ${node.label}`}
    >
      <div className="mb-1 flex flex-wrap items-center justify-between gap-x-2 gap-y-1 text-[10px] font-semibold uppercase tracking-wide opacity-70">
        <span>{kindLabel}</span>
        <span>{workflowStageLabel(node.state)}</span>
      </div>
      <div className="break-words font-semibold">{node.label}</div>
      <div className="mt-1 break-words text-[11px] opacity-80">{node.detail}</div>
    </button>
  );
}

function WorkflowGraphDetails({ node }: { node: WorkflowGraphNode }) {
  const kindLabel = node.kind === 'etl' ? 'SVO ETL' : node.kind === 'handoff' ? 'Handoff' : 'Model';
  return (
    <aside
      className="min-w-0 rounded border border-blue-200 bg-blue-50/50 p-3 text-xs text-blue-950"
      data-testid="workflow-graph-details"
    >
      <div className="break-words font-semibold">{node.label}</div>
      <div className="mt-1 text-blue-800">
        {kindLabel} · {workflowStageLabel(node.state)}
      </div>
      <details className="mt-3" open>
        <summary className="cursor-pointer font-medium text-blue-900">Stage details</summary>
        <div className="mt-2 space-y-2 text-gray-700">
          <p>{node.detail}</p>
          {node.contract && (
            <div>
              <div className="font-medium">SVO contract</div>
              <code className="break-all text-[11px]">{node.contract}</code>
            </div>
          )}
        </div>
      </details>
    </aside>
  );
}

function WorkflowGraph({
  run,
  modelName,
  adapterPlans,
}: {
  run: UnifiedRunSnapshot;
  modelName?: string | null;
  adapterPlans: ThreadAdapterPlan[];
}) {
  const stages = run.workflow_stages ?? [];
  const stageFor = (id: string, fallback?: string): WorkflowStageState => {
    if (id === 'model') {
      const providerState = modelProviderState(run);
      if (providerState) return providerState;
    }
    return workflowStageState(stages.find((stage) => stage.stage_id === id)?.status ?? fallback);
  };
  const prePlans = adapterPlans.filter(
    (plan) =>
      plan.stage !== 'post_model' &&
      Boolean(plan.adapter_plan_id) &&
      plan.status === 'transform_required',
  );
  const postPlans = adapterPlans.filter((plan) => plan.stage === 'post_model');
  const modelStage = stageFor('model', run.status);
  const handoffStage = stageFor('output-handoff');

  const preNodes: WorkflowGraphNode[] = prePlans.map((plan, index) => {
    const source = contractValue(
      adapterPlanSourceContract(plan),
      'standard_variable_uri',
      'variable_uri',
      'name',
    );
    return {
      id: `adapter-input-${index + 1}`,
      label: `Input ETL ${index + 1}`,
      detail: plan.adapter_plan_id ? 'Adapter plan selected' : 'Source already compatible',
      state: stageFor(`adapter-input-${index + 1}`, plan.status),
      kind: 'etl',
      contract: source,
    };
  });

  const postNodes: WorkflowGraphNode[] = postPlans.map((plan, index) => {
    const target = contractValue(
      adapterPlanTargetContract(plan),
      'standard_variable_uri',
      'variable_uri',
      'name',
    );
    return {
      id: `adapter-output-${index + 1}`,
      label: `Output ETL ${index + 1}`,
      detail: plan.adapter_plan_id ? 'SVO transformation' : 'Output mapping',
      state:
        modelStage === 'failure'
          ? 'failure'
          : modelStage !== 'success'
            ? 'pending'
            : stageFor(`adapter-output-${index + 1}`, run.status),
      kind: 'etl',
      contract: target,
    };
  });

  const publication = run.output_handoff?.publication;
  const planPublishStep = postPlans.map(publishingStep).find(Boolean) ?? null;
  const publishCatalog =
    (typeof planPublishStep?.catalog === 'string' ? planPublishStep.catalog : null) ??
    contractValue(postPlans[0] ? adapterPlanTargetContract(postPlans[0]) : undefined, 'catalog');
  const publishNodes: WorkflowGraphNode[] =
    planPublishStep || publication
      ? [
          {
            id: 'publish',
            label: 'publish',
            detail: publishCatalog ? `Publish to ${publishCatalog}` : 'Publish model output',
            state: modelStage === 'failure' ? 'failure' : publicationState(publication),
            kind: 'etl',
            contract: publishCatalog,
          },
        ]
      : [];

  const modelNode: WorkflowGraphNode = {
    id: 'model',
    label: modelName || 'Model application',
    detail: 'Provider job inside this workflow',
    state: modelStage,
    kind: 'model',
  };
  const handoffNode: WorkflowGraphNode = {
    id: 'output-handoff',
    label: 'Output handoff',
    detail: 'Register model output for the next stage',
    state: handoffStage,
    kind: 'handoff',
  };
  const showHandoff =
    postNodes.length > 0 ||
    publishNodes.length > 0 ||
    stages.some((stage) => stage.type === 'output_handoff');
  const currentNode = [
    ...preNodes,
    modelNode,
    ...(showHandoff ? [handoffNode] : []),
    ...postNodes,
    ...publishNodes,
  ].find((node) => node.state === 'running');
  const sourceContract = postPlans[0]
    ? contractValue(
        adapterPlanSourceContract(postPlans[0]),
        'standard_variable_uri',
        'variable_uri',
        'name',
      )
    : null;
  const targetContract = postPlans[0]
    ? contractValue(
        adapterPlanTargetContract(postPlans[0]),
        'standard_variable_uri',
        'variable_uri',
        'name',
      )
    : null;

  const graphNodes = [
    ...preNodes,
    modelNode,
    ...(showHandoff ? [handoffNode] : []),
    ...postNodes,
    ...publishNodes,
  ];
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const selectedNode =
    graphNodes.find((node) => node.id === selectedNodeId) ?? currentNode ?? modelNode;
  const workflowLayoutOptions = useMemo(() => ({ nodeHeight: 128 }), []);
  const flowX = preNodes.length > 0 ? 260 : 24;
  const flowStartY = Math.max(24, 24 + Math.max(0, preNodes.length - 1) * 48);
  const flowNodes = [
    modelNode,
    ...(showHandoff ? [handoffNode] : []),
    ...postNodes,
    ...publishNodes,
  ];
  const prePositions: WorkflowCanvasPosition<WorkflowGraphNode>[] = preNodes.map((node, index) => ({
    node,
    x: 24,
    y: 24 + index * 96,
    hasInputPort: false,
    hasOutputPort: true,
    outputPortSide: 'right',
  }));
  const flowPositions: WorkflowCanvasPosition<WorkflowGraphNode>[] = flowNodes.map(
    (node, index) => ({
      node,
      x: flowX,
      y: flowStartY + index * 148,
      hasInputPort: index > 0 || preNodes.length > 0,
      hasOutputPort: index < flowNodes.length - 1,
      inputPortSide: index === 0 ? 'left' : 'top',
      outputPortSide: index < flowNodes.length - 1 ? 'bottom' : 'right',
    }),
  );
  const canvasPositions = [...prePositions, ...flowPositions];
  const canvasEdges: WorkflowCanvasEdge[] = [
    ...prePositions.map((position) => ({
      id: `${position.node.id}-to-model`,
      source: position.node.id,
      target: modelNode.id,
      from: { x: position.x + WORKFLOW_NODE_WIDTH, y: position.y + 56 },
      to: { x: flowX, y: flowStartY + 64 },
      label: position.node.contract,
    })),
    ...flowPositions.slice(0, -1).flatMap((position, index) => {
      const next = flowPositions[index + 1];
      if (!next) return [];
      return {
        id: `${position.node.id}-to-${next.node.id}`,
        source: position.node.id,
        target: next.node.id,
        from: { x: position.x + WORKFLOW_NODE_WIDTH / 2, y: position.y + 128 },
        to: { x: next.x + WORKFLOW_NODE_WIDTH / 2, y: next.y },
        label:
          position.node.kind === 'model'
            ? sourceContract
            : (position.node.contract ?? next.node.contract),
      };
    }),
  ];
  const canvasHeight = Math.max(380, ...canvasPositions.map((position) => position.y + 150));

  return (
    <div className="rounded border border-blue-200 bg-white px-3 py-3" data-testid="workflow-graph">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <div className="font-semibold text-blue-950">Execution graph</div>
          <div className="text-[11px] text-blue-700">
            SVO contracts label the arrows between the model, handoff, and ETL stages.
          </div>
        </div>
        <div className="text-[11px] text-blue-800">
          Current step:{' '}
          <span className="font-semibold">
            {currentNode
              ? `${currentNode.label} · ${workflowStageLabel(currentNode.state)}`
              : 'Waiting'}
          </span>
        </div>
      </div>
      <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_280px]">
        <WorkflowCanvas
          positions={canvasPositions}
          edges={canvasEdges}
          selectedId={selectedNode?.id}
          renderNode={(node, selected) => (
            <WorkflowGraphNodeView
              node={node}
              selected={selected}
              onSelect={() => setSelectedNodeId(node.id)}
            />
          )}
          height={canvasHeight}
          layoutOptions={workflowLayoutOptions}
          markerId={`workflow-graph-arrow-${run.run_id ?? 'current'}`}
          testId="workflow-graph-canvas"
        />
        {selectedNode && <WorkflowGraphDetails node={selectedNode} />}
      </div>
      {sourceContract || targetContract ? (
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-dashed border-blue-200 pt-2 text-[11px] text-blue-800">
          <span className="font-semibold">SVO contract path</span>
          {sourceContract && (
            <code className="rounded bg-blue-50 px-1.5 py-1">
              {shortContractValue(sourceContract)}
            </code>
          )}
          {sourceContract && targetContract && <span aria-hidden="true">→</span>}
          {targetContract && (
            <code className="rounded bg-blue-50 px-1.5 py-1">
              {shortContractValue(targetContract)}
            </code>
          )}
        </div>
      ) : null}
    </div>
  );
}

interface UnifiedExecutionPanelProps {
  run: UnifiedRunSnapshot;
  modelName?: string | null;
  adapterPlans?: ThreadAdapterPlan[];
  onRefresh?: () => Promise<void>;
  refreshing?: boolean;
  refreshError?: string;
  onCancel?: () => Promise<void>;
  cancelling?: boolean;
}

/**
 * The adapter's liveness verdict for the run, independent of lifecycle status.
 * `stalled`: the model task never reported in after dispatch. `reported_failed`:
 * the task said it failed and Tapis has not confirmed yet.
 */
function runHealth(run: UnifiedRunSnapshot): {
  state: 'stalled' | 'reported_failed' | null;
  message: string | null;
} {
  const child = (run.adapter_runs ?? []).find(
    (candidate) => candidate.health === 'stalled' || candidate.health === 'reported_failed',
  );
  if (run.failure_code === 'COMPOSITE_WORKFLOW_STALLED' || child?.health === 'stalled') {
    return { state: 'stalled', message: child?.error_message ?? run.error_message ?? null };
  }
  if (run.failure_code === 'MODEL_FAILURE_REPORTED' || child?.health === 'reported_failed') {
    return { state: 'reported_failed', message: child?.error_message ?? run.error_message ?? null };
  }
  return { state: null, message: null };
}

function elapsedSince(iso: string | null | undefined, now = Date.now()): string | null {
  if (!iso) return null;
  const started = Date.parse(iso);
  if (Number.isNaN(started)) return null;
  const minutes = Math.max(0, Math.floor((now - started) / 60000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return `${hours} h ${String(minutes % 60).padStart(2, '0')} min`;
}

function UnifiedExecutionPanel({
  run,
  modelName,
  adapterPlans = [],
  onRefresh,
  refreshing = false,
  refreshError,
  onCancel,
  cancelling = false,
}: UnifiedExecutionPanelProps) {
  const adapterRuns = run.adapter_runs ?? [];
  const health = runHealth(run);
  const compositeChild = adapterRuns.find((child) => child.model_job_id || child.started_at);
  const runIsTerminal = ['completed', 'failed', 'cancelled'].includes(String(run.status ?? ''));
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const isPostModelAdapter = run.adapter_stage === 'post_model';
  const isPipeline =
    run.execution_mode === 'workflow_pipeline' || isPostModelAdapter || adapterRuns.length > 0;
  const tapisWorkflow = run.tapis_workflow;
  const modelProviderJobId = run.model_job_id;
  const modelExecutionId = isPostModelAdapter ? run.model_child_id : null;
  const modelJobId = modelProviderJobId ?? (!isPostModelAdapter ? run.model_child_id : null);
  const status = String(run.status ?? '');
  const persistedModelStage = run.workflow_stages?.find((stage) => stage.type === 'model');
  const adapterStage: WorkflowStageState = !isPipeline
    ? 'not-required'
    : adapterRuns.some((child) => isWorkflowFailure(child.status))
      ? 'failure'
      : adapterRuns.length > 0 && adapterRuns.every((child) => isWorkflowSuccess(child.status))
        ? 'success'
        : isPostModelAdapter &&
            ['model_dispatching', 'model_submitted', 'model_running', 'model_succeeded'].includes(
              status,
            )
          ? 'pending'
          : 'running';
  const persistedHandoffStage = run.workflow_stages?.find(
    (stage) => stage.type === 'output_handoff',
  );
  const handoffStage: WorkflowStageState = !isPipeline
    ? 'not-required'
    : persistedHandoffStage
      ? workflowStageState(persistedHandoffStage.status)
      : isWorkflowFailure(run.status) || run.error_message
        ? 'failure'
        : isPostModelAdapter
          ? ['adapter_running', 'completed'].includes(status)
            ? 'success'
            : ['output_registering', 'output_verifying', 'adapter_dispatching'].includes(status)
              ? 'running'
              : 'pending'
          : ['model_dispatching', 'model_submitted', 'model_running', 'model_succeeded'].includes(
                status,
              )
            ? 'success'
            : 'pending';
  const modelStage: WorkflowStageState =
    modelProviderState(run) ??
    (persistedModelStage
      ? workflowStageState(persistedModelStage.status)
      : !modelJobId
        ? isPipeline
          ? 'pending'
          : 'not-required'
        : isWorkflowFailure(run.status)
          ? 'failure'
          : run.status === 'model_running'
            ? 'running'
            : isWorkflowSuccess(run.status)
              ? 'success'
              : 'pending');
  const modelStatus = modelProviderStatus(run) ?? run.status;

  const stageRows: Array<{ label: string; state: WorkflowStageState; detail: string }> = [
    {
      label: 'SVO adapter workflow',
      state: adapterStage,
      detail:
        adapterRuns.length > 0
          ? `${adapterRuns.length} workflow${adapterRuns.length === 1 ? '' : 's'}`
          : isPostModelAdapter
            ? 'Legacy/recovery run — composite workflow unavailable'
            : 'No adapter step',
    },
    {
      label: 'Output handoff',
      state: handoffStage,
      detail: isPostModelAdapter
        ? handoffStage === 'success'
          ? 'Output handed to adapter'
          : handoffStage === 'running'
            ? 'Registering model output'
            : 'Waiting for model stage'
        : isPipeline
          ? displayStatus(run.status)
          : 'No adapter output handoff',
    },
    {
      label: 'Model application',
      state: modelStage,
      detail: modelJobId
        ? displayStatus(modelStatus)
        : isPipeline
          ? 'Waiting for adapter output'
          : 'Not submitted yet',
    },
  ];
  const timelineRows = !isPipeline
    ? [stageRows[2]!]
    : isPostModelAdapter
      ? [stageRows[2]!, stageRows[1]!, stageRows[0]!]
      : [stageRows[0]!, stageRows[2]!, stageRows[1]!];

  return (
    <div
      className="space-y-3 rounded border border-blue-200 bg-blue-50 px-3 py-3 text-xs"
      data-testid="unified-execution-panel"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="font-semibold text-blue-900">Workflow details</span>
          <span className="font-medium text-blue-900">
            {isPipeline
              ? 'Workflow pipeline'
              : run.execution_mode === 'workflow'
                ? 'SVO workflow'
                : 'Model job'}
          </span>
        </div>
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
      <RunStageTimeline
        stages={timelineRows.map((stage, index) => ({
          id: `${stage.label}-${index}`,
          label:
            stage.label === 'SVO adapter workflow'
              ? isPostModelAdapter
                ? 'Transform results'
                : 'Prepare inputs'
              : stage.label === 'Output handoff'
                ? isPostModelAdapter
                  ? 'Register outputs'
                  : 'Pass inputs to model'
                : 'Run model',
          detail: stage.detail,
          status: stageStatusFromLegacyState(stage.state),
        }))}
      />
      {health.state && !runIsTerminal && (
        <div
          role="alert"
          className={`space-y-2 rounded border px-3 py-2 ${
            health.state === 'stalled'
              ? 'border-red-200 bg-red-50 text-red-900'
              : 'border-amber-200 bg-amber-50 text-amber-900'
          }`}
          data-testid="workflow-health"
        >
          <p className="font-semibold">
            {health.state === 'stalled'
              ? 'This run appears to be stuck.'
              : 'The model task reported a failure; waiting for Tapis to confirm.'}
          </p>
          {health.message && <p>{health.message}</p>}
          {onCancel &&
            (confirmingCancel ? (
              <div className="flex flex-wrap items-center gap-2">
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
              </div>
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
            ))}
        </div>
      )}
      {!health.state && compositeChild?.model_job_id && !runIsTerminal && (
        <p className="text-blue-900" data-testid="workflow-queue-status">
          Model job <code>{compositeChild.model_job_id}</code>
          {compositeChild.started_at
            ? ` submitted ${elapsedSince(compositeChild.started_at)} ago; `
            : ' submitted; '}
          queue waits on ls6 have ranged from 20 minutes to 18 hours.
        </p>
      )}
      {run.output_handoff?.publication && (
        <PublicationSummary publication={run.output_handoff.publication} />
      )}
      <RunAnswerCard
        result={(run.output_handoff as { result?: unknown } | null | undefined)?.result}
        label="Modeled spring flow"
      />
      <details className="rounded border border-blue-200 bg-white px-2 py-2 text-blue-800">
        <summary className="cursor-pointer font-medium">Technical identifiers</summary>
        <div className="mt-2 space-y-1">
          {isPipeline ? (
            <>
              <div>
                Tapis workflow run ID: <code>{tapisWorkflow?.run_id ?? 'not submitted yet'}</code>
              </div>
              {tapisWorkflow?.workflow_id && (
                <div>
                  Tapis pipeline ID: <code>{tapisWorkflow.workflow_id}</code>
                </div>
              )}
              <div>
                Tapis Workflows tracking: pipeline{' '}
                <code>{tapisWorkflow?.workflow_id ?? 'not registered yet'}</code> · run{' '}
                <code>{tapisWorkflow?.run_id ?? 'not started'}</code>
              </div>
            </>
          ) : (
            run.run_id && (
              <div>
                Execution ID: <code>{run.run_id}</code>
              </div>
            )
          )}
          {modelJobId && (
            <div>
              <span className="font-medium">Tapis model job ID:</span> <code>{modelJobId}</code>
            </div>
          )}
          {modelExecutionId && !modelProviderJobId && (
            <div>
              <span className="font-medium">Model execution ID:</span>{' '}
              <code>{modelExecutionId}</code>
            </div>
          )}
          {adapterRuns.map((child, index) => (
            <div key={child.run_id ?? `${child.adapter_plan_id ?? 'workflow'}-${index}`}>
              <span className="font-medium">SVO workflow:</span>{' '}
              <code>{child.tapis_workflow_id ?? 'not registered yet'}</code>{' '}
              <span className="text-blue-700">
                run {child.tapis_run_id ?? 'not submitted'} · {displayStatus(child.status)}
              </span>
            </div>
          ))}
          {!isPipeline && (
            <p className="text-gray-600">This legacy model job has no recorded workflow stages.</p>
          )}
          {isPostModelAdapter && !tapisWorkflow?.workflow_id && (
            <p className="text-gray-600">
              provider workflow reference unavailable — this legacy/recovery run was not upgraded.
            </p>
          )}
        </div>
      </details>
      <details className="rounded border border-blue-200 bg-white px-2 py-2">
        <summary className="cursor-pointer font-medium text-blue-900">
          Technical workflow graph
        </summary>
        <div className="mt-3">
          <WorkflowGraph run={run} modelName={modelName} adapterPlans={adapterPlans} />
        </div>
      </details>
      {(run.failure_code || run.error_message) && (
        <div className="rounded border border-red-200 bg-red-50 px-2 py-2 text-red-800">
          {run.failure_code && <div className="font-medium">Failure: {run.failure_code}</div>}
          {run.error_message && <div>{run.error_message}</div>}
        </div>
      )}
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

// ─── Props ────────────────────────────────────────────────────────────────────

interface MintRunsProps {
  threadId?: string;
  threadData: ThreadExecutionData;
  executions: ModelExecutionsMap;
  canWrite: boolean;
  canExecute: boolean;
  ensembleManagerApi: string;
  unifiedRuns?: Record<string, UnifiedRunSnapshot>;
  onRefreshWorkflow?: (modelId: string) => Promise<void>;
  workflowRefreshErrors?: Record<string, string>;
  workflowRefreshing?: Record<string, boolean>;
  onCancelWorkflow?: (modelId: string) => Promise<void>;
  workflowCancelling?: Record<string, boolean>;
  onContinue: () => void;
  onFetchRuns: (modelId: string, page: number, pageSize: number) => void;
  onSubmitRuns: (modelId: string, maxMinutes: number, publish?: PublishRequest) => Promise<void>;
  onExecutionSummaryChanged?: (summary: ExecutionSummaryMap) => void;
  /**
   * Publish one execution. Absent means publishing is not available, and the
   * files dialog then only lists and promotes.
   */
  onPublishExecution?: (executionId: string) => Promise<void>;
  /** Called after the user promotes a file, so the caller re-reads the thread. */
  onOutputsChanged?: () => void | Promise<void>;
  /** Adapter plan discovery must finish before a run can be submitted. */
  adapterPlansLoading?: boolean;
  adapterPlanError?: string | null;
}

// ─── Component ───────────────────────────────────────────────────────────────

const PAGE_SIZE = 100;

export function MintRuns({
  threadId,
  threadData,
  executions,
  canWrite,
  canExecute,
  ensembleManagerApi,
  unifiedRuns,
  onRefreshWorkflow,
  workflowRefreshErrors,
  workflowRefreshing,
  onCancelWorkflow,
  workflowCancelling,
  onContinue,
  onFetchRuns,
  onSubmitRuns,
  onPublishExecution,
  onOutputsChanged,
  adapterPlansLoading = false,
  adapterPlanError,
}: MintRunsProps) {
  const modelIds = Object.keys(threadData.execution_summary ?? {});

  // Determine if params are done: every model has at least one ensemble binding
  const paramsDone =
    !adapterPlansLoading &&
    !adapterPlanError &&
    modelIds.length > 0 &&
    modelIds.every((mid) => {
      const model = threadData.models[mid];
      if (!model) return true;
      const bindings = threadData.model_ensembles[mid]?.bindings ?? {};
      return userParameters(model)
        .filter((p) => !p.value)
        .every((p) => (bindings[p.id ?? ''] ?? []).length > 0);
    }) &&
    modelIds.every((mid) => adapterParametersComplete(threadData.adapter_plans?.[mid] ?? []));

  // Are all runs finished?
  const allDone =
    modelIds.length > 0 &&
    modelIds.every((mid) => {
      const s = threadData.execution_summary[mid];
      if (!s) return false;
      return s.submitted_runs > 0 && s.successful_runs + s.failed_runs >= s.total_runs;
    });

  const [pages, setPages] = useState<Record<string, number>>({});
  const [waiting, setWaiting] = useState<Record<string, boolean>>({});
  const [maxMinutes, setMaxMinutes] = useState<Record<string, string>>({});
  const [runtimeErrors, setRuntimeErrors] = useState<Record<string, string>>({});
  const [publishers, setPublishers] = useState<Record<string, PlanPublisher[]>>({});
  const [publishSelections, setPublishSelections] = useState<
    Record<string, PublishSelection | null>
  >({});
  const [logDialogOpen, setLogDialogOpen] = useState(false);
  const [logContent, setLogContent] = useState<string | null>(null);
  const logAbortRef = useRef<AbortController | null>(null);
  // Which run's archive the files dialog shows. The model id travels with it
  // because a promoted file is written onto that model's configuration.
  const [filesFor, setFilesFor] = useState<{ executionId: string; modelId: string } | null>(null);

  // Auto-fetch runs when page/model changes
  useEffect(() => {
    for (const mid of modelIds) {
      const page = pages[mid] ?? 1;
      onFetchRuns(mid, page, PAGE_SIZE);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelIds.join(',')]);

  // Which catalogs each model's output can be published to. A failed lookup
  // just hides the control: publishing is optional and must not block a run.
  const canSubmitRuns = canExecute && canWrite;
  const unsubmittedIds = modelIds.filter((mid) => {
    const summary = threadData.execution_summary[mid];
    return !(summary?.submitted_for_execution || summary?.submission_time);
  });
  useEffect(() => {
    if (!canSubmitRuns || !ensembleManagerApi) return;
    const controller = new AbortController();
    for (const mid of unsubmittedIds) {
      fetchPlanPublishers(ensembleManagerApi, mid, controller.signal)
        .then((response) =>
          setPublishers((current) => ({ ...current, [mid]: response.publishers ?? [] })),
        )
        .catch(() => undefined);
    }
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unsubmittedIds.join(','), ensembleManagerApi, canSubmitRuns]);

  const handleSubmit = useCallback(
    async (mid: string) => {
      const minutes = Number(maxMinutes[mid] ?? '60');
      if (!Number.isInteger(minutes) || minutes < 1) {
        setRuntimeErrors((errors) => ({
          ...errors,
          [mid]: 'Enter a positive whole number of minutes.',
        }));
        return;
      }
      setRuntimeErrors((errors) => {
        const next = { ...errors };
        delete next[mid];
        return next;
      });
      setWaiting((w) => ({ ...w, [mid]: true }));
      try {
        const publish = publishRequestFor(publishers[mid] ?? [], publishSelections[mid]);
        if (publish) await onSubmitRuns(mid, minutes, publish);
        else await onSubmitRuns(mid, minutes);
      } catch (error) {
        setRuntimeErrors((errors) => ({
          ...errors,
          [mid]:
            secretErrorMessage(error) ?? (error instanceof Error ? error.message : String(error)),
        }));
      } finally {
        setWaiting((w) => ({ ...w, [mid]: false }));
      }
    },
    [maxMinutes, onSubmitRuns, publishers, publishSelections],
  );

  const handleNextPage = useCallback(
    (mid: string, delta: number) => {
      setPages((p) => {
        const next = Math.max(1, (p[mid] ?? 1) + delta);
        onFetchRuns(mid, next, PAGE_SIZE);
        return { ...p, [mid]: next };
      });
    },
    [onFetchRuns],
  );

  const handleViewLog = useCallback(
    async (executionId: string) => {
      setLogContent(null);
      setLogDialogOpen(true);
      if (logAbortRef.current) logAbortRef.current.abort();
      const ctrl = new AbortController();
      logAbortRef.current = ctrl;
      try {
        let text = await fetchExecutionLog(ensembleManagerApi, executionId, ctrl.signal);
        // Clean ANSI / escape sequences
        text = text.replace(/\\n/g, '\n').replace(/\\r/g, '').replace(/\\t/g, '\t');
        text = text.replace(/\\u001b.+?m/g, '').replace(/^"|"$/g, '');
        setLogContent(text);
      } catch (err) {
        if ((err as Error).name !== 'AbortError') {
          setLogContent(`Error loading log: ${(err as Error).message}`);
        }
      }
    },
    [ensembleManagerApi],
  );

  const handleCloseLog = useCallback(() => {
    setLogDialogOpen(false);
    logAbortRef.current?.abort();
  }, []);

  const handleCloseFiles = useCallback(() => setFilesFor(null), []);

  // ─ Guard: params not configured ─────────────────────────────────────────
  if (!paramsDone) {
    return (
      <div data-testid="mint-runs">
        <p className="mb-2 text-sm text-gray-600">This step is for monitoring model runs.</p>
        <p className="text-sm text-gray-500">Please setup some models first.</p>
      </div>
    );
  }

  return (
    <div data-testid="mint-runs">
      <div className="mb-4 flex items-center justify-between gap-3">
        <p className="text-sm text-gray-600">This step is for monitoring model runs.</p>
        {threadId && (
          <Link
            to={`/modeling/thread/${encodeURIComponent(threadId)}/runs`}
            className="rounded border border-blue-200 px-3 py-1.5 text-sm text-blue-700 hover:bg-blue-50"
          >
            Previous runs &amp; provenance
          </Link>
        )}
      </div>
      <h3 className="mb-3 text-sm font-semibold">Runs</h3>

      <ul className="space-y-4">
        {modelIds.map((mid) => {
          const summary = threadData.execution_summary[mid]!;
          const model = threadData.models[mid];
          if (!model) return null;

          const grouped = executions[mid] ?? { executions: [], loading: false };
          const currentPage = pages[mid] ?? 1;
          const totalPages = Math.ceil((summary.total_runs || 1) / PAGE_SIZE);

          const submittedRuns = summary.submitted_runs ?? 0;
          const failedRuns = summary.failed_runs ?? 0;
          const successfulRuns = summary.successful_runs ?? 0;
          const finishedRuns = successfulRuns + failedRuns;
          const runningRuns = Math.max(0, submittedRuns - finishedRuns);
          const pendingRuns = Math.max(0, summary.total_runs - submittedRuns);
          const submitted = summary.submitted_for_execution || summary.submission_time;
          const latestExecution = executions[mid]?.executions[0];
          const persistedRunId = latestExecution?.run_id ?? undefined;
          const workflowRun =
            unifiedRuns?.[mid] ??
            (latestExecution
              ? {
                  run_id: persistedRunId,
                  execution_mode: persistedRunId?.startsWith('ue_') ? 'workflow_pipeline' : 'job',
                  status: latestExecution.status.toLowerCase(),
                }
              : undefined);
          const displayStatus = aggregateRunStatus({
            totalRuns: summary.total_runs,
            submittedRuns,
            successfulRuns,
            failedRuns,
            fallbackStatus: workflowRun?.status,
          });
          const nextAction =
            displayStatus === 'failed'
              ? 'Review the failed run and its diagnostics before trying again.'
              : displayStatus === 'completed'
                ? 'The model run is complete. Continue to review or publish its results.'
                : displayStatus === 'completing'
                  ? 'The model finished and its output is being prepared for the next stage.'
                  : displayStatus === 'running'
                    ? 'The model is running. Results will appear when it completes.'
                    : 'The run is waiting to start.';

          // ── count inputs × params for display ──────────────────────────
          const nParameters = userParameters(model)
            .map((p) => (threadData.model_ensembles[mid]?.bindings[p.id ?? ''] ?? [0]).length)
            .reduce((a, b) => a * b, 1);

          const nInputs = inputResourceCount(
            model,
            threadData.model_ensembles[mid]?.bindings ?? {},
          );

          // ── adjustable inputs / params for column headers ─────────────
          const adjustableInputs = model.input_files.filter((f) => !f.value);
          const adjustableParams = userParameters(model).filter((p) => !p.value);

          return (
            <li key={mid}>
              {summary.total_runs > 0 && submitted && (
                <RunStatusSummary
                  modelName={model.name ?? mid}
                  status={displayStatus}
                  totalRuns={summary.total_runs}
                  submittedRuns={submittedRuns}
                  successfulRuns={successfulRuns}
                  failedRuns={failedRuns}
                  runningRuns={runningRuns}
                  pendingRuns={pendingRuns}
                  startedAt={
                    latestExecution?.start_time ??
                    (typeof submitted === 'string' ? submitted : undefined)
                  }
                  nextAction={nextAction}
                  context={
                    <RunConfigurationSummary
                      inputResources={nInputs}
                      parameterCombinations={nParameters}
                      outputsPerRun={model.output_files.length}
                    />
                  }
                />
              )}

              {!summary.total_runs ? (
                <div className="text-sm text-orange-600">
                  🚨 No runs configured. Please go back to the Data and Parameters steps.
                </div>
              ) : !submitted ? (
                <div className="space-y-2">
                  <div className="text-sm font-medium">{model.name ?? mid}</div>
                  <p className="text-sm text-gray-600">
                    The parameter settings require {summary.total_runs} runs ({nInputs} input
                    resources × {nParameters} parameters).{' '}
                    {model.output_files.length * summary.total_runs} output files will be generated.
                  </p>
                  {!paramsDone ? (
                    <p className="text-xs text-orange-600">
                      {adapterPlanError
                        ? 'SVO adapter plan discovery failed; return to Parameters and retry.'
                        : adapterPlansLoading
                          ? 'Waiting for SVO adapter plan discovery to finish.'
                          : 'Complete the required model and SVO adapter parameters before sending runs.'}
                    </p>
                  ) : canExecute && canWrite ? (
                    <div className="space-y-2">
                      <div className="flex flex-wrap items-end gap-3">
                        <label className="flex flex-col gap-1 text-xs text-gray-700">
                          <span>Maximum run time (minutes)</span>
                          <input
                            aria-label={`Maximum run time for ${model.name}`}
                            data-testid={`max-runtime-${mid}`}
                            type="number"
                            min="1"
                            step="1"
                            value={maxMinutes[mid] ?? '60'}
                            onChange={(event) =>
                              setMaxMinutes((values) => ({ ...values, [mid]: event.target.value }))
                            }
                            className="w-32 rounded border border-gray-300 px-2 py-1.5 text-sm"
                          />
                        </label>
                        <button
                          type="button"
                          data-testid={`submit-runs-${mid}`}
                          onClick={() => void handleSubmit(mid)}
                          disabled={waiting[mid]}
                          className="rounded bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
                        >
                          {waiting[mid] ? (
                            <>
                              Submitting…{' '}
                              <span className="inline-block h-3 w-3 animate-spin rounded border-2 border-white border-t-transparent" />
                            </>
                          ) : (
                            'Send Runs'
                          )}
                        </button>
                      </div>
                      <PublishOutputsControl
                        modelId={mid}
                        publishers={publishers[mid] ?? []}
                        outputs={model.output_files}
                        selection={publishSelections[mid] ?? null}
                        disabled={waiting[mid]}
                        onChange={(selection) =>
                          setPublishSelections((current) => ({ ...current, [mid]: selection }))
                        }
                      />
                      {runtimeErrors[mid] && (
                        <p className="text-xs text-red-600">{runtimeErrors[mid]}</p>
                      )}
                    </div>
                  ) : (
                    <p className="text-xs text-gray-500">
                      You don&apos;t have permission to send runs on this sub-task.
                    </p>
                  )}
                </div>
              ) : (
                <div className="space-y-2">
                  {workflowRun ? (
                    <UnifiedExecutionPanel
                      run={workflowRun}
                      modelName={model.name}
                      adapterPlans={threadData.adapter_plans?.[mid] ?? []}
                      onRefresh={
                        onRefreshWorkflow &&
                        (Boolean(unifiedRuns?.[mid]) || workflowRun.run_id?.startsWith('ue_'))
                          ? () => onRefreshWorkflow(mid)
                          : undefined
                      }
                      refreshing={workflowRefreshing?.[mid]}
                      refreshError={workflowRefreshErrors?.[mid]}
                      onCancel={
                        onCancelWorkflow && workflowRun.run_id?.startsWith('ue_')
                          ? () => onCancelWorkflow(mid)
                          : undefined
                      }
                      cancelling={workflowCancelling?.[mid]}
                    />
                  ) : null}

                  {/* Pagination + Reload bar */}
                  <div className="flex items-center gap-2 border border-gray-200 px-2 py-1 text-xs">
                    <button
                      type="button"
                      onClick={() => handleNextPage(mid, -1)}
                      disabled={currentPage <= 1}
                      className="rounded border px-2 py-0.5 hover:bg-gray-50 disabled:opacity-40"
                    >
                      Back
                    </button>
                    <span>
                      Page {currentPage} of {totalPages}
                    </span>
                    <button
                      type="button"
                      onClick={() => handleNextPage(mid, 1)}
                      disabled={currentPage >= totalPages}
                      className="rounded border px-2 py-0.5 hover:bg-gray-50 disabled:opacity-40"
                    >
                      Next
                    </button>
                    <div className="ml-auto flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => onFetchRuns(mid, currentPage, PAGE_SIZE)}
                        className="flex items-center gap-1 rounded border px-2 py-0.5 hover:bg-gray-50"
                        title="Reload"
                      >
                        <RefreshCw className="h-3 w-3" />
                        Reload
                      </button>
                    </div>
                  </div>

                  {/* Runs table */}
                  <div className="max-h-96 overflow-auto border border-gray-200">
                    {grouped.loading ? (
                      <div className="flex items-center justify-center py-8">
                        <span className="h-6 w-6 animate-spin rounded-full border-2 border-blue-600 border-t-transparent" />
                      </div>
                    ) : (
                      <table
                        className="w-full border-collapse text-xs"
                        data-testid={`runs-table-${mid}`}
                      >
                        <thead className="sticky top-0 bg-gray-100">
                          <tr>
                            <th colSpan={5} className="px-2 py-1 text-left font-semibold">
                              Run
                            </th>
                            {adjustableInputs.length > 0 && (
                              <th
                                colSpan={adjustableInputs.length}
                                className="px-2 py-1 text-left font-semibold"
                              >
                                Inputs
                              </th>
                            )}
                            {adjustableParams.length > 0 && (
                              <th
                                colSpan={adjustableParams.length}
                                className="px-2 py-1 text-left font-semibold"
                              >
                                Parameters
                              </th>
                            )}
                          </tr>
                          <tr>
                            <th className="px-2 py-1 font-medium">Status</th>
                            <th className="px-2 py-1 font-medium">Start</th>
                            <th className="px-2 py-1 font-medium">End</th>
                            <th className="px-2 py-1 font-medium">Log</th>
                            <th className="px-2 py-1 font-medium">Files</th>
                            {adjustableInputs.length + adjustableParams.length === 0 && (
                              <th className="px-2 py-1" />
                            )}
                            {adjustableInputs.map((f) => (
                              <th key={f.id} className="px-2 py-1 font-medium">
                                {(f.name ?? '').replace(/[-_]/g, ' ')}
                              </th>
                            ))}
                            {adjustableParams.map((p) => (
                              <th key={p.id} className="px-2 py-1 font-medium">
                                {(p.name ?? '').replace(/[-_]/g, ' ')}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {grouped.executions.length === 0 ? (
                            <tr>
                              <td
                                colSpan={5 + adjustableInputs.length + adjustableParams.length}
                                className="px-2 py-4 text-center text-gray-400"
                              >
                                <div className="flex items-center justify-center gap-2">
                                  <span className="h-4 w-4 animate-spin rounded-full border-2 border-blue-400 border-t-transparent" />
                                  Loading run records…
                                </div>
                              </td>
                            </tr>
                          ) : (
                            grouped.executions.map((execution: Execution) => {
                              const paramDefaults: Record<string, string | null | undefined> = {};
                              userParameters(model).forEach(
                                (p) => (paramDefaults[p.id ?? ''] = p.default ?? null),
                              );
                              return (
                                <tr key={execution.id} className="odd:bg-white even:bg-gray-50">
                                  <td className="px-2 py-1">
                                    <StatusBar
                                      status={execution.status}
                                      progress={execution.run_progress}
                                    />
                                  </td>
                                  <td className="px-2 py-1 text-gray-500">
                                    {toDateTimeString(execution.start_time)}
                                  </td>
                                  <td className="px-2 py-1 text-gray-500">
                                    {toDateTimeString(execution.end_time)}
                                  </td>
                                  <td className="px-2 py-1">
                                    <button
                                      type="button"
                                      onClick={() => void handleViewLog(execution.id)}
                                      className="flex items-center gap-1 rounded border px-1.5 py-0.5 text-xs hover:bg-gray-50"
                                    >
                                      <ExternalLink className="h-3 w-3" />
                                      View Log
                                    </button>
                                  </td>
                                  <td className="px-2 py-1">
                                    <button
                                      type="button"
                                      data-testid={`view-files-${execution.id}`}
                                      onClick={() =>
                                        setFilesFor({ executionId: execution.id, modelId: mid })
                                      }
                                      className="flex items-center gap-1 rounded border px-1.5 py-0.5 text-xs hover:bg-gray-50"
                                    >
                                      <FolderOpen className="h-3 w-3" />
                                      Files
                                    </button>
                                  </td>
                                  {adjustableInputs.length + adjustableParams.length === 0 && (
                                    <td className="px-2 py-1 text-gray-400">
                                      No inputs or parameters
                                    </td>
                                  )}
                                  {adjustableInputs.map((input) => {
                                    const res = execution.bindings[input.id ?? ''] as {
                                      name?: string;
                                      url?: string;
                                      location?: string;
                                    } | null;
                                    const url = res ? getResourceUrl(res) : '';
                                    return (
                                      <td key={input.id} className="px-2 py-1">
                                        {res && url ? (
                                          <a
                                            href={url}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className="text-blue-600 hover:underline"
                                          >
                                            {res.name ?? url}
                                          </a>
                                        ) : (
                                          '—'
                                        )}
                                      </td>
                                    );
                                  })}
                                  {adjustableParams.map((param) => {
                                    let pval = execution.bindings[param.id ?? ''] as
                                      | string
                                      | null
                                      | undefined;
                                    if (pval == null) pval = paramDefaults[param.id ?? ''];
                                    if (
                                      typeof pval === 'string' &&
                                      pval.startsWith('__region_geojson')
                                    ) {
                                      pval = 'Region GeoJSON';
                                    }
                                    return (
                                      <td key={param.id} className="px-2 py-1">
                                        {pval ?? '—'}
                                      </td>
                                    );
                                  })}
                                </tr>
                              );
                            })
                          )}
                        </tbody>
                      </table>
                    )}
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>

      {/* Continue button */}
      {allDone && (
        <div className="mt-4 flex justify-end">
          <button
            type="button"
            data-testid="runs-continue-btn"
            onClick={onContinue}
            className="rounded bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700"
          >
            Continue
          </button>
        </div>
      )}

      {/* Log dialog */}
      <LogDialog open={logDialogOpen} log={logContent} onClose={handleCloseLog} />

      {/* Archived files of one run: promote a file, then publish it */}
      {filesFor && (
        <ExecutionFilesDialog
          open
          executionId={filesFor.executionId}
          configurationId={filesFor.modelId}
          declaredOutputLabels={(threadData.models[filesFor.modelId]?.output_files ?? []).map(
            (o) => o.name,
          )}
          ensembleManagerApi={ensembleManagerApi}
          canWrite={canWrite}
          onClose={handleCloseFiles}
          onPromoted={onOutputsChanged}
          onPublish={onPublishExecution}
        />
      )}
    </div>
  );
}
