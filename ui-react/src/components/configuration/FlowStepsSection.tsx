/**
 * FlowStepsSection — the "Steps" section of a model configuration that is a flow.
 *
 * A flow is a graph of ETL pieces. This draws the steps and their links on the
 * same canvas the run panel uses, and lists each step with its piece, who owns it,
 * the settings the flow gives it and where each of its wires comes from. The flow
 * is read by a query of its own, so a deployment where it fails (or a
 * configuration that is not a flow) shows nothing here and the page is unharmed.
 *
 * Flow inputs, outputs and settings already appear in the Inputs, Outputs and
 * Parameters sections above and are not repeated.
 */
import { useMemo } from 'react';
import { useQuery } from '@apollo/client';

import { WorkflowCanvas } from '@/components/modeling/WorkflowCanvas';
import { Badge } from '@/components/ui/badge';
import { FlowBadge } from '@/components/common/FlowBadge';
import { useFlowAvailability } from '@/hooks/useFlowAvailability';
import {
  GET_CONFIGURATION_FLOW,
  type FlowStepRow,
  type GetConfigurationFlowData,
} from '@/graphql/queries/flows';
import { FLOW_LAYOUT_OPTIONS, flowCanvasHeight } from '@/lib/flow-graph-layout';
import {
  describeWire,
  flowStepsGraph,
  parseSettings,
  parseWires,
  stepNodeId,
  stepPieceLabel,
  threadBindingLines,
  type FlowLabels,
  type FlowStepsNode,
  type StepRunnable,
} from '@/lib/flow-steps';
import { flowUnavailableMessage, type FlowStepReason } from '@/lib/flow-availability';

export interface FlowStepsSectionProps {
  configurationId: string;
  /** The configuration's declared inputs and parameters, to name what wires refer to. */
  inputs: { id: string; label?: string | null }[];
  parameters: { id: string; label?: string | null }[];
}

const REASON_TEXT: Record<FlowStepReason, string> = {
  piece_missing: "this step's piece was deleted or is not visible to you",
  not_approved: 'the piece is not approved for your account',
  stored_source_disabled: 'this deployment does not run stored code',
};

const heading = 'mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground';

function NodeBox({ node }: { node: FlowStepsNode }) {
  const blocked = node.availability?.runnable === false;
  return (
    <div
      className={`h-[128px] w-full min-w-0 overflow-hidden rounded-lg border px-3 py-2 text-left text-sm shadow-sm ${
        node.kind !== 'step'
          ? 'border-purple-200 bg-purple-50 text-purple-900'
          : node.missing || blocked
            ? 'border-red-200 bg-red-50 text-red-800'
            : 'border-gray-200 bg-white text-gray-800'
      }`}
      data-testid={`flow-steps-node-${node.id}`}
    >
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide opacity-70">
        {node.kind === 'input'
          ? 'Flow input'
          : node.kind === 'parameter'
            ? 'Flow parameter'
            : 'Step'}
      </div>
      <div className="break-words font-semibold">{node.label}</div>
      {node.kind === 'step' && node.missing && <div className="mt-1 text-xs">Piece missing</div>}
      {node.kind === 'step' && !node.missing && blocked && (
        <div className="mt-1 text-xs">Not runnable for you</div>
      )}
    </div>
  );
}

function StepItem({
  step,
  labels,
  availability,
}: {
  step: FlowStepRow;
  labels: FlowLabels;
  availability?: StepRunnable;
}) {
  const piece = step.etl_process;
  const settings = parseSettings(step.settings_json);
  const wires = parseWires(step.wires_json);
  return (
    <li
      className="rounded border px-3 py-2 text-sm"
      data-testid={`flow-steps-step-${step.position}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">
          {step.position}. {stepPieceLabel(step)}
        </span>
        {piece?.visibility && (
          <Badge variant="outline" className="text-[10px]">
            {piece.visibility}
          </Badge>
        )}
        {availability && (
          <Badge
            variant={availability.runnable ? 'secondary' : 'destructive'}
            className="text-[10px]"
          >
            {availability.runnable
              ? 'Runnable'
              : `Not runnable: ${REASON_TEXT[availability.reason as FlowStepReason] ?? 'not available to you'}`}
          </Badge>
        )}
      </div>
      {piece ? (
        <>
          {piece.description && (
            <p className="mt-0.5 text-xs text-muted-foreground">{piece.description}</p>
          )}
          {piece.owner_username && (
            <p className="mt-0.5 text-xs text-muted-foreground">Owner: {piece.owner_username}</p>
          )}
        </>
      ) : (
        <p className="mt-0.5 text-xs text-destructive">
          This step&apos;s piece was deleted or is not visible to you.
        </p>
      )}
      {settings.length > 0 && (
        <dl className="mt-1 text-xs">
          <dt className="font-medium text-muted-foreground">Settings the flow gives it</dt>
          {settings.map(([name, value]) => (
            <dd key={name} className="font-mono">
              {name} = {value}
            </dd>
          ))}
        </dl>
      )}
      {wires.length > 0 && (
        <ul className="mt-1 list-disc pl-4 text-xs text-muted-foreground">
          {wires.map((wire, index) => (
            <li key={index}>{describeWire(wire, labels)}</li>
          ))}
        </ul>
      )}
    </li>
  );
}

export function FlowStepsSection({ configurationId, inputs, parameters }: FlowStepsSectionProps) {
  const { data } = useQuery<GetConfigurationFlowData>(GET_CONFIGURATION_FLOW, {
    variables: { id: configurationId },
    fetchPolicy: 'cache-first',
  });
  const flow = data?.modelcatalog_configuration_flow_by_pk ?? null;
  const availability = useFlowAvailability(flow ? configurationId : null);

  const labels = useMemo<FlowLabels>(
    () => ({
      inputs: new Map(inputs.map((item) => [item.id, item.label ?? item.id])),
      parameters: new Map(parameters.map((item) => [item.id, item.label ?? item.id])),
    }),
    [inputs, parameters],
  );
  const byPosition = useMemo(
    () => new Map(availability?.steps.map((step) => [step.position, step]) ?? []),
    [availability],
  );
  const graph = useMemo(
    () => flowStepsGraph(flow?.steps ?? [], labels, byPosition),
    [flow, labels, byPosition],
  );

  if (!flow) return null;

  const notice = flowUnavailableMessage(availability);
  const bindingLines = threadBindingLines(flow.thread_bindings_json, labels);

  return (
    <section data-testid="flow-steps-section">
      <h3 className={`${heading} flex items-center gap-2`}>
        Steps ({flow.steps.length}) <FlowBadge />
      </h3>
      {notice && (
        <p className="mb-2 rounded border border-amber-200 bg-amber-50 px-2 py-1 text-sm text-amber-800">
          This flow is not available to you: {notice}
        </p>
      )}
      {bindingLines.length > 0 && (
        <ul className="mb-2 list-disc pl-4 text-sm text-muted-foreground">
          {bindingLines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}
      {flow.steps.length === 0 ? (
        <p className="text-sm text-muted-foreground">This flow has no steps.</p>
      ) : (
        <>
          <WorkflowCanvas
            positions={graph.positions}
            edges={graph.edges}
            renderNode={(node) => <NodeBox node={node} />}
            height={flowCanvasHeight(graph.positions)}
            layoutOptions={FLOW_LAYOUT_OPTIONS}
            markerId={`flow-steps-arrow-${configurationId}`}
            testId="flow-steps-canvas"
          />
          <ol className="mt-3 space-y-2" data-testid="flow-steps-list">
            {flow.steps.map((step) => (
              <StepItem
                key={stepNodeId(step.position)}
                step={step}
                labels={labels}
                availability={byPosition.get(step.position)}
              />
            ))}
          </ol>
        </>
      )}
    </section>
  );
}
