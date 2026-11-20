import { Search } from 'lucide-react';
import { gql, useQuery } from '@apollo/client';
import { useCallback, useMemo, useState } from 'react';

import { FlowBadge } from '@/components/common/FlowBadge';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import {
  WORKFLOW_CANVAS_WIDTH,
  WORKFLOW_NODE_WIDTH,
  WorkflowCanvas,
  type WorkflowCanvasEdge,
  type WorkflowCanvasPosition,
} from '@/components/modeling/WorkflowCanvas';
import {
  ModelConfigInfo,
  ModelSetupInfo,
  Thread,
  ThreadModel,
  extractModelIO,
  getUserPermission,
  useGetModelTreeWithRegionsQuery,
  useSetThreadModelsMutation,
} from '@/graphql/generated/modeling';
import { useAuth } from '@/lib/auth/useAuth';
import { collectionInputsFromFlow } from '@/lib/thread-execution';
import { diffThreadModels } from '@/lib/thread-models';
import { slugFromUri } from '@/lib/uri';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { useDataCatalogVariableAvailability } from '@/hooks/useDataCatalog';
import { useSemanticSearch } from '@/hooks/useSemanticSearch';
import { useFlowAvailability } from '@/hooks/useFlowAvailability';
import { flowUnavailableMessage } from '@/lib/flow-availability';
import { useToast } from '@/components/ui/use-toast';
import { cn } from '@/lib/utils';
import {
  inferReachableModelConfigurationIds,
  type ContractTransform,
  type InferenceModelOutput,
} from '@/lib/modeling/outcome-driver-inference';
import { StepShell } from './StepShell';
import { FilteredByBanner } from './FilteredByBanner';

interface ModelRow {
  id: string;
  searchIds: string[];
  name: string;
  description?: string | null;
  region: string;
  producesIds: string[];
  producesLabels: string[];
  outputContracts: { id: string; label?: string | null; format?: string | null }[];
  needs: { name: string; varIds: string[]; varLabels: string[]; optional: boolean }[];
  /** The configuration is a flow (a graph of pieces), not a single model. */
  isFlow: boolean;
  /** The flow has an input that takes a set of files as one input. */
  takesCollection: boolean;
}

export const ModelOutcomeAdapterInferenceDocument = gql`
  query GetModelOutcomeAdapterInference {
    adapterTransforms: adapter_transform_spec {
      id
      name
      description
      contracts {
        id
        role
        standard_variable_uri
        format
        unit
      }
    }
  }
`;

interface ModelOutcomeAdapterInferenceData {
  adapterTransforms: Array<{
    id?: string | null;
    name?: string | null;
    description?: string | null;
    contracts: Array<{
      id?: string | null;
      role: string;
      standard_variable_uri?: string | null;
      format?: string | null;
      unit?: string | null;
    }>;
  }>;
}

interface ModelsStepProps {
  thread: Thread;
  onUpdated: () => void;
  onContinue: () => void;
  onBack?: () => void;
  /** Optional: jump back to the Variables step (banner edit link). */
  onEditIndicator?: () => void;
  /** Geometry selected in Problem Framing, used for data-feasibility filtering. */
  regionGeometry?: unknown;
}

function rowFromConfig(cfg: ModelConfigInfo | ModelSetupInfo, parent?: ModelConfigInfo): ModelRow {
  const io = extractModelIO(cfg);
  const regions = cfg.regions.length > 0 ? cfg.regions : (parent?.regions ?? []);
  const flow = ('flow' in cfg ? cfg.flow : null) ?? parent?.flow;
  return {
    id: cfg.id,
    searchIds: parent ? [cfg.id, parent.id] : [cfg.id],
    name: cfg.label ?? cfg.id,
    description: 'description' in cfg ? cfg.description : null,
    region: regions.map((r) => r.region.label ?? r.region.id).join(', '),
    producesIds: io.producesVariableIds,
    producesLabels: io.outputs.flatMap((o) => o.variableLabels),
    outputContracts: io.outputs.flatMap((output) => {
      const ids = output.variableIds.length > 0 ? output.variableIds : [''];
      return ids.map((id, index) => ({
        id,
        label: output.variableLabels[index] ?? output.variableLabels[0] ?? output.name,
        format: output.format,
      }));
    }),
    needs: io.inputs.map((i) => ({
      name: i.name,
      varIds: i.variableIds,
      varLabels: i.variableLabels,
      optional: i.optional,
    })),
    isFlow: Boolean(flow),
    takesCollection: collectionInputsFromFlow(flow).length > 0,
  };
}

type OutcomeMatch = 'produces' | 'transforms';

/** The part of a standard-variable id or label that names it, lower-cased. */
function outcomeName(value: string): string {
  return slugFromUri(value.trim()).toLowerCase();
}

/**
 * True when the row declares the outcome as one of its outputs. The id is
 * compared first; the name (the URI slug or the label) bridges a flow whose
 * output was registered under another namespace for the same variable.
 */
function rowProducesOutcome(
  row: Pick<ModelRow, 'producesIds' | 'producesLabels'>,
  outcome: string,
  outcomeLabel?: string | null,
): boolean {
  if (row.producesIds.includes(outcome)) return true;
  const names = new Set([outcomeName(outcome), outcomeLabel ? outcomeName(outcomeLabel) : '']);
  names.delete('');
  return [...row.producesIds, ...row.producesLabels].some(
    (value) => value && names.has(outcomeName(value)),
  );
}

function flattenToRows(
  data: ReturnType<typeof useGetModelTreeWithRegionsQuery>['data'],
): ModelRow[] {
  if (!data) return [];
  const rows: ModelRow[] = [];
  for (const sw of data.modelcatalog_software) {
    for (const ver of sw.versions) {
      for (const cfg of ver.configurations) {
        if (cfg.child_configurations.length > 0) {
          for (const setup of cfg.child_configurations) rows.push(rowFromConfig(setup, cfg));
        } else {
          rows.push(rowFromConfig(cfg));
        }
      }
    }
  }
  return rows;
}

function ModelCard({
  row,
  checked,
  onToggle,
  outcomeMatch,
  outcomeLabel,
}: {
  row: ModelRow;
  checked: boolean;
  onToggle: (id: string, checked: boolean) => void;
  /** How the row reaches the chosen outcome, when one is chosen. */
  outcomeMatch?: OutcomeMatch | null;
  outcomeLabel?: string | null;
}) {
  // Asked only for a flow, and only once per flow per session. An unanswered or
  // failed check leaves the card pickable: plan and submit still refuse correctly.
  const unavailable = flowUnavailableMessage(useFlowAvailability(row.isFlow ? row.id : null));
  // An already-picked flow can still be unpicked.
  const blocked = unavailable !== null && !checked;
  return (
    <label
      className={cn(
        'flex gap-3 rounded border p-3 text-sm transition-colors',
        unavailable !== null && 'opacity-60',
        blocked ? 'cursor-not-allowed bg-gray-50' : 'cursor-pointer',
        checked ? 'border-blue-400 bg-blue-50' : !blocked && 'hover:bg-gray-50',
      )}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={blocked}
        onChange={(e) => onToggle(row.id, e.target.checked)}
        aria-label={`Select ${row.name}`}
        className="mt-1"
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 font-medium">
          {row.name}
          {row.isFlow && <FlowBadge />}
        </div>
        {outcomeMatch && outcomeLabel && (
          <div
            className={cn(
              'text-xs font-medium',
              outcomeMatch === 'produces' ? 'text-green-800' : 'text-blue-800',
            )}
            data-testid="outcome-reason"
          >
            {outcomeMatch === 'produces'
              ? `Produces ${outcomeLabel}`
              : `Can be transformed into ${outcomeLabel}`}
          </div>
        )}
        {row.takesCollection && (
          <div className="text-xs text-purple-800">Takes a set of files as one input</div>
        )}
        {unavailable && (
          <div className="text-xs text-amber-800" data-testid="flow-unavailable">
            {unavailable}
          </div>
        )}
        {row.region && <div className="text-xs text-gray-500">{row.region}</div>}
        {row.description && (
          <p className="mt-0.5 line-clamp-2 text-xs text-gray-500">{row.description}</p>
        )}
        <div className="mt-1.5 flex flex-wrap gap-1">
          {row.producesLabels.length > 0 ? (
            row.producesLabels.map((p, index) => (
              <span
                key={`${row.id}-produces-${index}`}
                className="rounded bg-green-100 px-1.5 py-0.5 text-xs text-green-800"
              >
                Produces: {p}
              </span>
            ))
          ) : (
            <span className="rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-600">
              Output metadata unavailable
            </span>
          )}
          {row.needs.length > 0 ? (
            <span className="rounded bg-blue-100 px-1.5 py-0.5 text-xs text-blue-800">
              Model inputs ({row.needs.length}):{' '}
              {row.needs.map((n) => n.varLabels[0] ?? n.name).join(', ')}
            </span>
          ) : (
            <span className="rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-600">
              Input metadata unavailable
            </span>
          )}
        </div>
      </div>
    </label>
  );
}

type ModelMapNodeKind = 'model' | 'etl';

interface ModelMapNode {
  id: string;
  kind: ModelMapNodeKind;
  label: string;
  subtitle: string;
  description?: string | null;
  standardVariableUri?: string | null;
  format?: string | null;
  unit?: string | null;
  model?: ModelRow;
  transform?: ModelOutcomeAdapterInferenceData['adapterTransforms'][number];
}

function contractUri(contract: { standard_variable_uri?: string | null }): string {
  return contract.standard_variable_uri?.trim().toLowerCase() ?? '';
}

function contractMatches(
  current: { standard_variable_uri?: string | null; format?: string | null },
  required: { standard_variable_uri?: string | null; format?: string | null },
): boolean {
  const currentUri = contractUri(current);
  const requiredUri = contractUri(required);
  if (currentUri && requiredUri) return currentUri === requiredUri;
  return Boolean(current.format && required.format && current.format === required.format);
}

function displayVariable(
  uri?: string | null,
  label?: string | null,
  format?: string | null,
): string {
  if (format === 'cbc-mf6' && !uri) return 'MODFLOW 6 CBC output';
  if (label) return label;
  if (uri) return slugFromUri(uri);
  if (format) return format;
  return 'Unlabeled SVO';
}

function findAdapterPath(
  row: ModelRow,
  transforms: ModelOutcomeAdapterInferenceData['adapterTransforms'],
  outcome?: string | null,
): Array<ModelOutcomeAdapterInferenceData['adapterTransforms'][number]> {
  if (!outcome) return [];
  const outputs = row.outputContracts.map((output) => ({
    standard_variable_uri: output.id,
    format: output.format,
  }));
  const queue: Array<{
    contract: { standard_variable_uri?: string | null; format?: string | null };
    path: Array<ModelOutcomeAdapterInferenceData['adapterTransforms'][number]>;
  }> = outputs.map((contract) => ({ contract, path: [] }));
  const visited = new Set<string>();
  const target = { standard_variable_uri: outcome };

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (contractMatches(current.contract, target)) return current.path;
    const signature = `${current.contract.standard_variable_uri ?? ''}|${current.contract.format ?? ''}`;
    if (visited.has(signature) || current.path.length >= 6) continue;
    visited.add(signature);

    for (const transform of transforms) {
      if (current.path.some((step) => step.id === transform.id)) continue;
      const inputs = transform.contracts.filter((contract) => contract.role === 'input');
      const outputs = transform.contracts.filter((contract) => contract.role === 'output');
      if (!inputs.some((input) => contractMatches(current.contract, input))) continue;
      for (const output of outputs) {
        queue.push({
          contract: output,
          path: [...current.path, transform],
        });
      }
    }
  }
  return [];
}

function mapNodesForModel(
  row: ModelRow,
  transforms: ModelOutcomeAdapterInferenceData['adapterTransforms'],
  outcome: string | null,
): ModelMapNode[] {
  const nodes: ModelMapNode[] = [
    {
      id: `${row.id}-model`,
      kind: 'model',
      label: 'Model',
      subtitle: `${row.name} · Model application`,
      description: row.description,
      model: row,
    },
  ];
  const path = findAdapterPath(row, transforms, outcome);
  path.forEach((transform, index) => {
    const output = transform.contracts.find((contract) => contract.role === 'output');
    nodes.push({
      id: `${row.id}-etl-${index}`,
      kind: 'etl',
      label: transform.name ?? transform.id ?? `SVO ETL ${index + 1}`,
      subtitle: 'Adapter transform',
      description: transform.description,
      standardVariableUri: output?.standard_variable_uri,
      format: output?.format,
      unit: output?.unit,
      transform,
      model: row,
    });
  });
  return nodes;
}

function ModelMapNodeButton({
  node,
  selected,
  onSelect,
}: {
  node: ModelMapNode;
  selected: boolean;
  onSelect: () => void;
}) {
  const kindLabel = node.kind === 'model' ? 'Model' : 'SVO ETL';
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(
        'h-[104px] w-full min-w-0 overflow-hidden rounded border px-3 py-2 text-left text-xs transition-colors 2xl:flex-1',
        selected
          ? 'border-blue-500 bg-blue-50 ring-2 ring-blue-200'
          : 'border-gray-200 bg-white hover:border-blue-300 hover:bg-blue-50/40',
      )}
      data-testid={`model-map-node-${node.id}`}
    >
      <div className="flex items-center justify-between gap-2 text-[10px] font-semibold uppercase tracking-wide text-gray-500">
        <span>{kindLabel}</span>
        {node.format && <span>{node.format}</span>}
      </div>
      <div className="mt-1 break-words font-medium text-gray-900">{node.label}</div>
      <div className="mt-1 break-words text-[11px] text-gray-500">{node.subtitle}</div>
      {node.unit && <div className="mt-1 text-[11px] text-gray-500">Unit: {node.unit}</div>}
    </button>
  );
}

function ModelMapDetails({ node }: { node: ModelMapNode }) {
  const model = node.model;
  return (
    <aside
      className="rounded border border-blue-200 bg-blue-50/50 p-3 text-xs"
      data-testid="model-map-details"
    >
      <div className="font-semibold text-blue-950">{node.label}</div>
      <div className="mt-1 text-blue-800">{node.subtitle}</div>
      <details className="mt-3" open>
        <summary className="cursor-pointer font-medium text-blue-900">Details</summary>
        <div className="mt-2 space-y-2 text-gray-700">
          {node.description && <p>{node.description}</p>}
          {node.standardVariableUri && (
            <div>
              <div className="font-medium">Standard variable</div>
              <code className="break-all text-[11px]">{node.standardVariableUri}</code>
            </div>
          )}
          {node.format && (
            <div>
              <span className="font-medium">Format:</span> {node.format}
            </div>
          )}
          {node.unit && (
            <div>
              <span className="font-medium">Unit:</span> {node.unit}
            </div>
          )}
        </div>
      </details>
      {node.kind === 'model' && model && (
        <details className="mt-3" open>
          <summary className="cursor-pointer font-medium text-blue-900">Model ports</summary>
          <div className="mt-2 space-y-2">
            <div>
              <div className="font-medium">Inputs</div>
              <div className="mt-1 space-y-1">
                {model.needs.map((input) => (
                  <div key={input.name}>{input.varLabels[0] ?? input.name}</div>
                ))}
              </div>
            </div>
            <div>
              <div className="font-medium">Outputs</div>
              <div className="mt-1 space-y-1">
                {model.outputContracts.map((output, index) => (
                  <div key={`${output.id}-${index}`}>
                    {displayVariable(output.id, output.label, output.format)}
                    {output.format && <span className="text-gray-500"> · {output.format}</span>}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </details>
      )}
      {node.kind === 'etl' && node.transform && (
        <details className="mt-3" open>
          <summary className="cursor-pointer font-medium text-blue-900">ETL contracts</summary>
          <div className="mt-2 space-y-1">
            {node.transform.contracts.map((contract, index) => (
              <div key={`${contract.role}-${contract.id ?? index}`}>
                <span className="font-medium">{contract.role}:</span>{' '}
                {displayVariable(contract.standard_variable_uri, null, contract.format)}
                {contract.format && <span className="text-gray-500"> · {contract.format}</span>}
                {contract.unit && <span className="text-gray-500"> · {contract.unit}</span>}
              </div>
            ))}
          </div>
        </details>
      )}
    </aside>
  );
}

function modelMapCanvasLayout(
  rowNodes: ModelMapNode[],
  outcome: string | null,
  outcomeLabel?: string | null,
): {
  positions: WorkflowCanvasPosition<ModelMapNode>[];
  edges: WorkflowCanvasEdge[];
  height: number;
} {
  const models = rowNodes.filter((node) => node.kind === 'model');
  const branches = models.map((model) => [
    model,
    ...rowNodes.filter((node) => node.kind === 'etl' && node.model?.id === model.model?.id),
  ]);
  const branchPositions = branches.map((branch, branchIndex) =>
    branch.map((node, nodeIndex) => ({
      node,
      x: 190 + nodeIndex * 230,
      y: 56 + branchIndex * 176,
      hasInputPort: nodeIndex > 0 || Boolean(node.model?.needs.length),
      hasOutputPort: true,
      inputPortSide: 'left' as const,
      outputPortSide: 'right' as const,
    })),
  );
  const positions = branchPositions.flat();
  const positionById = new Map(positions.map((position) => [position.node.id, position]));
  const edges: WorkflowCanvasEdge[] = branches.flatMap((branch) => {
    const model = branch[0];
    if (!model) return [];
    const modelPosition = positionById.get(model.id);
    if (!modelPosition) return [];
    const inputLabels = model.model?.needs.map((input) => input.varLabels[0] ?? input.name) ?? [];
    const inputStartY = Math.max(
      28,
      modelPosition.y + 52 - Math.max(0, inputLabels.length - 1) * 38,
    );
    const modelOutput = model.model?.outputContracts[0];
    const modelOutputLabel = modelOutput
      ? `${displayVariable(modelOutput.id, modelOutput.label, modelOutput.format)}${
          modelOutput.format ? ` · ${modelOutput.format}` : ''
        }`
      : null;
    const inputEdges = inputLabels.map((label, index) => ({
      id: `input-${model.id}-${index + 1}`,
      source: `input-${model.id}-${index + 1}`,
      target: model.id,
      from: { x: 8, y: inputStartY + index * 76 },
      to: { x: modelPosition.x, y: modelPosition.y + 52 },
      label,
    }));
    const flowEdges = branch.slice(0, -1).flatMap((node, index) => {
      const next = branch[index + 1];
      const position = positionById.get(node.id);
      const nextPosition = next ? positionById.get(next.id) : undefined;
      if (!next || !position || !nextPosition) return [];
      const output = node.transform?.contracts.find((contract) => contract.role === 'output');
      return {
        id: `${node.id}-to-${next.id}`,
        source: node.id,
        target: next.id,
        from: { x: position.x + WORKFLOW_NODE_WIDTH, y: position.y + 52 },
        to: { x: nextPosition.x, y: nextPosition.y + 52 },
        label:
          index === 0
            ? modelOutputLabel
            : output
              ? `${displayVariable(output.standard_variable_uri, null, output.format)}${
                  output.format ? ` · ${output.format}` : ''
                }`
              : null,
      };
    });
    const last = branch.at(-1);
    const lastPosition = last ? positionById.get(last.id) : undefined;
    if (!last || !lastPosition) return [...inputEdges, ...flowEdges];
    const output = last.transform?.contracts.find((contract) => contract.role === 'output');
    const finalLabel = output
      ? `${displayVariable(output.standard_variable_uri, null, output.format)}${
          output.format ? ` · ${output.format}` : ''
        }`
      : (modelOutputLabel ?? outcomeLabel ?? outcome);
    return [
      ...inputEdges,
      ...flowEdges,
      {
        id: `${last.id}-to-${model.id}-outcome`,
        source: last.id,
        target: `outcome-${model.id}`,
        from: { x: lastPosition.x + WORKFLOW_NODE_WIDTH, y: lastPosition.y + 52 },
        to: { x: WORKFLOW_CANVAS_WIDTH - 16, y: lastPosition.y + 52 },
        label: finalLabel,
      },
    ];
  });
  const height = Math.max(380, ...positions.map((position) => position.y + 150));
  return { positions, edges, height };
}

function ModelMap({
  rows,
  transforms,
  outcome,
  outcomeLabel,
}: {
  rows: ModelRow[];
  transforms: ModelOutcomeAdapterInferenceData['adapterTransforms'];
  outcome: string | null;
  outcomeLabel?: string | null;
}) {
  const mapRows = rows.filter(
    (row) => row.producesIds.length > 0 || row.outputContracts.length > 0,
  );
  const mapNodes = useMemo(
    () => mapRows.flatMap((row) => mapNodesForModel(row, transforms, outcome)),
    [mapRows, outcome, transforms],
  );
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const selectedNode = mapNodes.find((node) => node.id === selectedNodeId) ?? mapNodes[0];

  if (mapRows.length === 0) return null;
  const layout = modelMapCanvasLayout(mapNodes, outcome, outcomeLabel);

  return (
    <section className="mb-4 rounded border border-gray-200 bg-gray-50 p-3" data-testid="model-map">
      <div className="mb-3">
        <h3 className="text-sm font-semibold text-gray-900">Model map</h3>
        <p className="text-xs text-gray-600">
          Select a model or adapter stage to inspect its contract. SVOs are shown on the arrows.
        </p>
      </div>
      <div className="space-y-3 rounded border border-gray-200 bg-white p-2">
        <WorkflowCanvas
          positions={layout.positions}
          edges={layout.edges}
          selectedId={selectedNode?.id}
          renderNode={(node, selected) => (
            <ModelMapNodeButton
              node={node}
              selected={selected}
              onSelect={() => setSelectedNodeId(node.id)}
            />
          )}
          height={layout.height}
          markerId="model-map-arrow-combined"
          testId="model-map-canvas"
        />
        {selectedNode && <ModelMapDetails node={selectedNode} />}
      </div>
    </section>
  );
}

export function ModelsStep({
  thread,
  onUpdated,
  onContinue,
  onBack,
  onEditIndicator,
  regionGeometry,
}: ModelsStepProps) {
  const { user } = useAuth();
  const { toast } = useToast();
  const perm = getUserPermission(thread.permissions, thread.events, user?.username ?? null);

  const [searchText, setSearchText] = useState('');
  const [showAllRegions, setShowAllRegions] = useState(false);
  const [showAllDataModels, setShowAllDataModels] = useState(false);
  const [saving, setSaving] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => {
    const ids = new Set<string>();
    (thread.thread_models ?? []).forEach((tm: ThreadModel) => {
      if (tm.modelcatalog_configuration_id) ids.add(tm.modelcatalog_configuration_id);
    });
    return ids;
  });

  const indicator = thread.response_variable_id ?? null;
  const { data, loading, error } = useGetModelTreeWithRegionsQuery();
  const adapterInferenceQ = useQuery<ModelOutcomeAdapterInferenceData>(
    ModelOutcomeAdapterInferenceDocument,
    { fetchPolicy: 'cache-first', skip: !indicator },
  );
  const [setThreadModels] = useSetThreadModelsMutation();

  const allRows = useMemo(() => flattenToRows(data), [data]);
  const totalCount = allRows.length;
  const candidateVariableNames = useMemo(
    () => [
      ...new Set(
        allRows.flatMap((row) => row.needs.flatMap((need) => [...need.varIds, ...need.varLabels])),
      ),
    ],
    [allRows],
  );
  const hasRegionGeometry = Array.isArray(regionGeometry)
    ? regionGeometry.length > 0
    : Boolean(regionGeometry);
  const {
    availableVariables,
    loading: availabilityLoading,
    error: availabilityError,
  } = useDataCatalogVariableAvailability({
    variableNames: candidateVariableNames,
    regionGeometry,
    skip:
      allRows.length === 0 ||
      (Array.isArray(regionGeometry) ? regionGeometry.length === 0 : !regionGeometry),
  });

  // The stored id is a standard-variable URI (#106), which is unreadable, so
  // prefer the label the relationship carries. A thread whose relationship did
  // not resolve falls back to the URI's trailing slug — never the whole URI.
  const indicatorLabel = thread.response_variable?.label ?? (indicator && slugFromUri(indicator));
  const debouncedSearchText = useDebouncedValue(searchText, 300);
  // Outcome compatibility is evaluated locally from model outputs and the
  // adapter graph. Applying the semantic endpoint's direct-output filter here
  // would hide a model that reaches the outcome through an adapter chain.
  const semanticFilters = useMemo(() => ({ outputVariableIds: undefined }), []);
  const semanticSearch = useSemanticSearch(debouncedSearchText, {
    target: 'model_configuration',
    limit: 100,
    filters: semanticFilters,
  });
  const adapterTransformDetails = adapterInferenceQ.data?.adapterTransforms ?? [];
  const adapterTransforms = useMemo<ContractTransform[]>(
    () =>
      (adapterInferenceQ.data?.adapterTransforms ?? []).map((process) => ({
        kind: 'adapter' as const,
        outputs: process.contracts
          .filter((contract) => contract.role === 'output')
          .map((contract) => ({
            id: contract.standard_variable_uri?.trim() ?? '',
            format: contract.format,
          })),
        inputs: process.contracts
          .filter((contract) => contract.role === 'input')
          .map((contract) => ({
            id: contract.standard_variable_uri?.trim() ?? '',
            format: contract.format,
          })),
      })),
    [adapterInferenceQ.data],
  );
  const inferredModelIds = useMemo(() => {
    if (!indicator || !adapterInferenceQ.data) return new Set<string>();
    const modelOutputs: InferenceModelOutput[] = allRows.flatMap((row) =>
      row.outputContracts.map((output) => ({ configurationId: row.id, output })),
    );
    return inferReachableModelConfigurationIds(
      { id: indicator, label: indicatorLabel },
      modelOutputs,
      adapterTransforms,
    );
  }, [adapterInferenceQ.data, adapterTransforms, allRows, indicator, indicatorLabel]);
  const indicatorRows = useMemo(
    () =>
      indicator
        ? allRows.filter(
            (r) => rowProducesOutcome(r, indicator, indicatorLabel) || inferredModelIds.has(r.id),
          )
        : allRows,
    [allRows, indicator, indicatorLabel, inferredModelIds],
  );
  const dataFeasibleRows = useMemo(() => {
    if (!hasRegionGeometry || availabilityLoading || availabilityError) return indicatorRows;
    return indicatorRows.filter((row) =>
      row.needs
        .filter((need) => !need.optional)
        .every(
          (need) =>
            (need.varIds.length === 0 && need.varLabels.length === 0) ||
            [...need.varIds, ...need.varLabels].some((name) => availableVariables.has(name)),
        ),
    );
  }, [
    availabilityError,
    availabilityLoading,
    availableVariables,
    hasRegionGeometry,
    indicatorRows,
  ]);
  const unavailableModelCount = Math.max(indicatorRows.length - dataFeasibleRows.length, 0);
  const dataFilteredRows = useMemo(() => {
    if (showAllDataModels) return indicatorRows;
    const visible = new Map(dataFeasibleRows.map((row) => [row.id, row]));
    // Keep an already-selected model visible so a scope change never hides the
    // user's selection or makes it impossible to remove before continuing.
    for (const row of indicatorRows) {
      if (selectedIds.has(row.id)) visible.set(row.id, row);
    }
    return [...visible.values()];
  }, [dataFeasibleRows, indicatorRows, selectedIds, showAllDataModels]);

  const localSearchedRows = useMemo(() => {
    if (!searchText.trim()) return dataFilteredRows;
    const q = searchText.toLowerCase();
    return dataFilteredRows.filter(
      (r) =>
        r.name.toLowerCase().includes(q) ||
        (r.description ?? '').toLowerCase().includes(q) ||
        r.region.toLowerCase().includes(q),
    );
  }, [dataFilteredRows, searchText]);

  const matchedRows = useMemo(() => {
    if (!debouncedSearchText.trim() || !semanticSearch.results) return localSearchedRows;
    const rankById = new Map(semanticSearch.results.map((result, index) => [result.id, index]));
    const semanticRank = (row: ModelRow) =>
      Math.min(
        Infinity,
        ...row.searchIds
          .map((id) => rankById.get(id))
          .filter((rank): rank is number => rank !== undefined),
      );
    // The index may not carry a row (a flow's outputs, for one), so a row the
    // plain text filter finds is kept and follows the semantic hits.
    const found = new Set(localSearchedRows.map((row) => row.id));
    return dataFilteredRows
      .map((row) => ({ row, rank: semanticRank(row) }))
      .filter((item) => Number.isFinite(item.rank) || found.has(item.row.id))
      .sort((a, b) => (a.rank === b.rank ? 0 : a.rank < b.rank ? -1 : 1))
      .map((item) => item.row);
  }, [dataFilteredRows, debouncedSearchText, localSearchedRows, semanticSearch.results]);

  // Rows that declare the outcome as an output come first, models and flows
  // alike, whatever the search ranked them; then the rows reachable by a
  // transform. The sort is stable, so each group keeps its own order.
  const outcomeMatchById = useMemo(() => {
    const matches = new Map<string, OutcomeMatch>();
    if (!indicator) return matches;
    for (const row of allRows) {
      if (rowProducesOutcome(row, indicator, indicatorLabel)) matches.set(row.id, 'produces');
      else if (inferredModelIds.has(row.id)) matches.set(row.id, 'transforms');
    }
    return matches;
  }, [allRows, indicator, indicatorLabel, inferredModelIds]);
  const searchedRows = useMemo(() => {
    if (outcomeMatchById.size === 0) return matchedRows;
    const tier = (row: ModelRow) => {
      const match = outcomeMatchById.get(row.id);
      return match === 'produces' ? 0 : match === 'transforms' ? 1 : 2;
    };
    return [...matchedRows].sort((a, b) => tier(a) - tier(b));
  }, [matchedRows, outcomeMatchById]);

  const threadRegionId = thread.region_id ?? null;
  const { regionRows, otherRows } = useMemo(() => {
    if (!threadRegionId) return { regionRows: searchedRows, otherRows: [] as ModelRow[] };
    const matched: ModelRow[] = [];
    const others: ModelRow[] = [];
    for (const r of searchedRows) {
      const hasRegion = r.region.length > 0;
      if (!hasRegion || r.region.includes(threadRegionId)) matched.push(r);
      else others.push(r);
    }
    return { regionRows: matched, otherRows: others };
  }, [searchedRows, threadRegionId]);

  const displayedRows = showAllRegions ? searchedRows : regionRows;
  const incompatibleSelectedRows = useMemo(() => {
    if (!indicator) return [];
    const selected = new Set(selectedIds);
    return allRows.filter(
      (row) =>
        selected.has(row.id) &&
        !rowProducesOutcome(row, indicator, indicatorLabel) &&
        !inferredModelIds.has(row.id),
    );
  }, [allRows, indicator, indicatorLabel, inferredModelIds, selectedIds]);

  const toggleModel = useCallback((id: string, checked: boolean) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  async function handleContinue() {
    if (!user?.username || selectedIds.size === 0) return;

    const changes = diffThreadModels(thread.id, thread.thread_models ?? [], selectedIds);
    // Nothing to write: walking back through the step must not touch the
    // bindings the later steps have already stored against these rows.
    if (changes.unchanged) {
      onContinue();
      return;
    }

    setSaving(true);
    try {
      await setThreadModels({
        variables: {
          threadId: thread.id,
          removedIds: changes.removedIds,
          models: changes.added,
          userid: user.username,
          notes: null,
        },
      });
      onUpdated();
      onContinue();
    } catch (err) {
      toast({ title: 'Save failed', description: String(err), variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  }

  const banner = indicator
    ? {
        chips: [
          {
            icon: '🎯',
            label: 'Desired outcome',
            value:
              dataFilteredRows.length === totalCount
                ? `all ${totalCount} models`
                : `${dataFilteredRows.length} of ${totalCount} models`,
            source: indicatorLabel
              ? `produces or transforms to ${indicatorLabel}`
              : 'compatible with available data',
          },
        ],
      }
    : {
        chips: [
          {
            icon: '🎯',
            label: 'Desired outcome',
            value:
              dataFilteredRows.length === totalCount
                ? `all ${totalCount} models`
                : `${dataFilteredRows.length} of ${totalCount} models`,
            source: 'compatible with available data',
          },
        ],
      };

  const canContinue =
    selectedIds.size >= 1 && incompatibleSelectedRows.length === 0 && !saving && perm.write;

  return (
    <StepShell
      title="Models"
      description="Choose one or more calibrated models. Each card shows what it produces and which inputs can become drivers and datasets."
      canContinue={canContinue}
      continueHint={
        incompatibleSelectedRows.length > 0
          ? `Remove ${incompatibleSelectedRows.length} model${incompatibleSelectedRows.length === 1 ? '' : 's'} that do not produce the desired outcome`
          : selectedIds.size === 0
            ? 'Select at least one model'
            : `${selectedIds.size} selected`
      }
      continueLabel={saving ? 'Saving…' : 'Continue'}
      onContinue={handleContinue}
      onBack={onBack}
    >
      <FilteredByBanner
        chips={banner.chips}
        onEdit={indicator ? onEditIndicator : undefined}
        editLabel="edit outcome"
      />

      <ModelMap
        rows={allRows.filter((row) => selectedIds.has(row.id))}
        transforms={adapterTransformDetails}
        outcome={indicator}
        outcomeLabel={indicatorLabel}
      />

      {!availabilityLoading && !availabilityError && unavailableModelCount > 0 && (
        <div className="mb-3 rounded border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-900">
          {unavailableModelCount} model candidate{unavailableModelCount === 1 ? '' : 's'} have no
          usable input data for this spatial scope.
          <button
            type="button"
            onClick={() => setShowAllDataModels((value) => !value)}
            className="ml-1 underline"
          >
            {showAllDataModels ? 'Show feasible models only' : 'Show all model candidates'}
          </button>
        </div>
      )}
      {availabilityLoading && (
        <p className="mb-3 text-xs text-gray-500">
          Checking data availability for this spatial scope…
        </p>
      )}
      {availabilityError && (
        <p className="mb-3 text-xs text-amber-700">
          Data availability could not be checked; showing all compatible models.
        </p>
      )}

      {indicator && !loading && !error && incompatibleSelectedRows.length > 0 && (
        <div
          className="mb-4 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900"
          role="alert"
        >
          <p className="font-medium">
            {incompatibleSelectedRows.length === 1 ? 'One selected model' : 'Some selected models'}{' '}
            {incompatibleSelectedRows.length === 1 ? 'does' : 'do'} not produce{' '}
            {indicatorLabel ?? 'the desired outcome'}.
          </p>
          <p className="mt-1 text-xs">
            Remove {incompatibleSelectedRows.length === 1 ? 'it' : 'them'} or choose a different
            outcome before continuing.
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            {incompatibleSelectedRows.map((row) => (
              <button
                key={row.id}
                type="button"
                className="rounded border border-amber-400 bg-white px-2 py-1 text-xs text-amber-900 hover:bg-amber-100"
                onClick={() => toggleModel(row.id, false)}
                aria-label={`Remove ${row.name}`}
              >
                Remove {row.name}
              </button>
            ))}
          </div>
        </div>
      )}

      {!indicator && !loading && !error && (
        <p className="mb-4 text-xs text-gray-600" role="status">
          No desired outcome selected — all models are available. Choose an outcome in Outcome &
          drivers to narrow this list to models that produce it.
        </p>
      )}

      <div className="relative mb-3">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
        <input
          type="text"
          placeholder="Filter models by name, region or description…"
          value={searchText}
          onChange={(e) => setSearchText(e.target.value)}
          className="w-full rounded border py-2 pl-9 pr-3 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500"
        />
      </div>

      {loading && (
        <div className="flex justify-center py-8">
          <LoadingSpinner />
        </div>
      )}
      {error && (
        <p className="text-sm text-destructive" role="alert">
          Failed to load models: {error.message}
        </p>
      )}

      {!loading && !error && (
        <div className="space-y-2">
          {displayedRows.length === 0 ? (
            <div className="py-6 text-center text-sm text-gray-400">
              {searchText ? (
                'No models match your search.'
              ) : indicator && indicatorRows.length === 0 ? (
                // The Variables step now offers only producible indicators, so
                // this is reachable for a stored value alone — a thread saved
                // before that rule, or one whose model lost its output. Say
                // which choice empties the list, rather than a bare "none".
                <>
                  <p className="text-gray-600">
                    No model produces or transforms to <strong>{indicatorLabel}</strong>.
                  </p>
                  <p className="mt-1 text-xs">
                    This sub-task stores it as its indicator, but no configuration in the catalog
                    carries it as an output.
                  </p>
                  {onEditIndicator && (
                    <button
                      type="button"
                      onClick={onEditIndicator}
                      className="mt-2 text-xs text-blue-600 underline"
                    >
                      Choose a different indicator
                    </button>
                  )}
                </>
              ) : (
                'No models found.'
              )}
            </div>
          ) : (
            displayedRows.map((row) => (
              <ModelCard
                key={row.id}
                row={row}
                checked={selectedIds.has(row.id)}
                onToggle={toggleModel}
                outcomeMatch={outcomeMatchById.get(row.id) ?? null}
                outcomeLabel={indicatorLabel}
              />
            ))
          )}

          {!searchText && otherRows.length > 0 && (
            <button
              type="button"
              onClick={() => setShowAllRegions((v) => !v)}
              className="text-sm text-blue-600 underline hover:text-blue-800"
            >
              {showAllRegions ? 'Hide' : 'Show'} {otherRows.length} model
              {otherRows.length !== 1 ? 's' : ''} calibrated for other regions
            </button>
          )}
        </div>
      )}
    </StepShell>
  );
}
