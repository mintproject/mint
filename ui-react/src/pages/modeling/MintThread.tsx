/**
 * MintThread — Step workflow container for a modeling sub-task.
 *
 * Provides a left wizard rail (Framing → Variables → Models → Datasets →
 * Parameters → Runs → Results → Summary) and renders the appropriate atomic
 * step component based on the active section.
 *
 * Two queries feed it. GetThread holds the thread's metadata and permissions;
 * GetThreadExecution holds the execution pipeline — the selected models with
 * their catalog I/O, the data and parameter bindings, and the run summaries.
 * Everything downstream of the Models step reads the second one, so a step is
 * only ever as complete as what the database actually holds.
 */
import { Maximize2, Minimize2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useApolloClient } from '@apollo/client';
import { useParams } from 'react-router-dom';

import { Skeleton } from '@/components/ui/skeleton';
import { getUserPermission, useGetThreadQuery } from '@/graphql/generated/modeling';
import {
  ExecutionSummaryMap,
  ModelEnsembleMap,
  ModelExecutionsMap,
  ThreadExecutionData,
} from '@/graphql/generated/execution';
import {
  GetThreadModelExecutionsDocument,
  useGetThreadExecutionQuery,
  useUpdateThreadParametersMutation,
  type GetThreadModelExecutionsQuery,
  type GetThreadModelExecutionsQueryVariables,
  type ThreadModelParameterInsert,
  type ThreadModelSummaryInsert,
} from '@/graphql/generated/thread-execution';
import {
  datasetsComplete,
  executionFromGQL,
  hasUnfinishedRuns,
  parametersComplete,
  runsComplete,
  threadExecutionFromGQL,
} from '@/lib/thread-execution';
import {
  createExecutionPlan,
  EnsembleManagerError,
  cancelUnifiedRun,
  fetchUnifiedRun,
  isUnifiedRunTerminal,
  publishExecution,
  publishResults,
  submitExecutionPlan,
  type UnifiedRunSnapshot,
} from '@/lib/ensemble-manager';
import {
  clearUnifiedRunSnapshots,
  loadUnifiedRunSnapshot,
  saveUnifiedRunSnapshot,
} from '@/lib/unified-run-storage';
import {
  adapterParameterDefaults,
  adapterParameterValuesForSubmission,
  adapterPlansByModel,
  adapterPlansSourceFingerprint,
  fetchThreadAdapterPlans,
  replaceThreadAdapterPlans,
  type ThreadAdapterPlan,
} from '@/lib/adapter-execution';
import { useAuth } from '@/lib/auth/useAuth';
import { cn } from '@/lib/utils';

import { MintSummary } from './thread/MintSummary';
import { MintParameters } from './thread/MintParameters';
import type { SpatialSelection } from './thread/SpatialScopeMap';
import { MintRuns } from './thread/MintRuns';
import { MintResults } from './thread/MintResults';
import { WizardRail } from './thread/wizard/WizardRail';
import { deriveStepStates } from './thread/wizard/deriveStepStates';
import { WIZARD_STEPS, type WizardStepId } from './thread/wizard/types';
import { FramingStep } from './thread/wizard/FramingStep';
import { VariablesStep } from './thread/wizard/VariablesStep';
import { ModelsStep } from './thread/wizard/ModelsStep';
import { DatasetsStep } from './thread/wizard/DatasetsStep';

// ─── Step order (module scope so nav helpers have a stable reference) ───────────

const stepOrder = WIZARD_STEPS.map((s) => s.id);

/** How often to re-read the execution summary while runs are still in flight. */
const RUN_POLL_MS = 10_000;

// ─── MintThread ────────────────────────────────────────────────────────────────

interface MintThreadProps {
  /**
   * Thread to render. When provided, the component runs embedded (e.g. inside
   * the problem-statement detail panel) instead of reading the id from the
   * route. Falls back to the `:id` route param when omitted.
   */
  threadId?: string;
  /** Parent task name, available when the wizard is embedded in a problem statement. */
  taskName?: string | null;
  /** Dataset suggestions confirmed by guided setup and carried into the picker. */
  initialDatasetIds?: string[];
  /** Compatibility fallback for threads created before region propagation was fixed. */
  fallbackSpatialScopeId?: string | null;
}

export function MintThread({
  threadId: threadIdProp,
  taskName,
  initialDatasetIds = [],
  fallbackSpatialScopeId,
}: MintThreadProps = {}) {
  const { id: routeThreadId } = useParams<{ id: string }>();
  const threadId = threadIdProp ?? routeThreadId;
  const { user } = useAuth();
  const apollo = useApolloClient();
  const [maximized, setMaximized] = useState(false);
  const [currentSection, setCurrentSection] = useState<WizardStepId>('framing');

  const goNext = useCallback(() => {
    setCurrentSection(
      (cur) => stepOrder[Math.min(stepOrder.indexOf(cur) + 1, stepOrder.length - 1)]!,
    );
  }, []);
  const goBack = useCallback(() => {
    setCurrentSection((cur) => stepOrder[Math.max(stepOrder.indexOf(cur) - 1, 0)]!);
  }, []);

  const [modelExecutions, setModelExecutions] = useState<ModelExecutionsMap>({});
  const [unifiedRuns, setUnifiedRuns] = useState<Record<string, UnifiedRunSnapshot>>({});
  const [unifiedRunErrors, setUnifiedRunErrors] = useState<Record<string, string>>({});
  const [unifiedRunRefreshing, setUnifiedRunRefreshing] = useState<Record<string, boolean>>({});
  const [unifiedRunCancelling, setUnifiedRunCancelling] = useState<Record<string, boolean>>({});
  // Per-model backoff for the periodic workflow refresh: after a failed fetch
  // (expired token, adapter down) wait 2, 4, 8… minutes before retrying.
  const refreshBackoff = useRef<Record<string, { failures: number; nextAt: number }>>({});
  const [adapterPlanRows, setAdapterPlanRows] = useState<ThreadAdapterPlan[]>([]);
  const [adapterPlansLoaded, setAdapterPlansLoaded] = useState(false);
  const [adapterPlanError, setAdapterPlanError] = useState<string | null>(null);
  const [adapterPlansLoading, setAdapterPlansLoading] = useState(false);
  const [spatialSelection, setSpatialSelection] = useState<SpatialSelection | null>(null);
  const discoveredAdapterSources = useRef<string | null>(null);
  const hydratedWorkflowIdentity = useRef<string | null>(null);

  // Workflow metadata is not an application log and is safe to cache as a
  // small, user-scoped browser snapshot. The server remains authoritative for
  // refreshes; this cache only lets the details survive a page remount.
  const workflowUserKey = user?.sub || user?.username || 'anonymous';
  const workflowIdentity = threadId ? `${workflowUserKey}:${threadId}` : null;

  const adapterPlanningEnabled =
    window.__MINT_CONFIG__?.SVO_ADAPTER_ENABLED === 'true' ||
    window.__MINT_CONFIG__?.SVO_ADAPTER_ENABLED === '1';

  const { data, loading, error, refetch } = useGetThreadQuery({
    variables: { id: threadId! },
    skip: !threadId,
    fetchPolicy: 'cache-and-network',
  });

  const thread = data?.thread_by_pk ?? null;
  const spatialScopeId = thread?.region_id ?? fallbackSpatialScopeId ?? null;

  const savedAdapterSpatialContext = useMemo(() => {
    const values = adapterPlanRows.flatMap((plan) => Object.entries(plan.parameter_values ?? []));
    const value = (name: string): string | null => {
      const entry = values.find(([key]) => key === name)?.[1];
      return entry === undefined || entry === null || String(entry).trim() === ''
        ? null
        : String(entry);
    };
    return {
      geometry_source_uri: value('geometry_source_uri'),
      geometry_source_type: value('geometry_source_type'),
      geometry_filter_field: value('geometry_filter_field'),
      geometry_filter_value: value('geometry_filter_value'),
      geometry_crs: value('geometry_crs'),
      geometry_format: value('geometry_format'),
      spatial_scope_id: value('spatial_scope_id'),
      spatial_scope_name: value('spatial_scope_name'),
      spatial_scope_type: value('spatial_scope_type'),
      spatial_resolution: value('spatial_resolution'),
    };
  }, [adapterPlanRows]);

  const adapterSpatialContext = useMemo(
    () => ({
      geometry_source_uri:
        spatialSelection?.layer?.source_uri ??
        spatialSelection?.layer?.uri ??
        savedAdapterSpatialContext.geometry_source_uri,
      geometry_source_type:
        spatialSelection?.layer?.geometry_type ?? savedAdapterSpatialContext.geometry_source_type,
      geometry_filter_field:
        spatialSelection?.feature?.filterField ??
        spatialSelection?.layer?.default_filter_field ??
        savedAdapterSpatialContext.geometry_filter_field,
      geometry_filter_value:
        spatialSelection?.feature?.filterValue ?? savedAdapterSpatialContext.geometry_filter_value,
      geometry_crs: spatialSelection?.layer?.crs ?? savedAdapterSpatialContext.geometry_crs,
      geometry_format:
        spatialSelection?.layer?.format ?? savedAdapterSpatialContext.geometry_format,
      spatial_scope_id:
        spatialSelection?.feature?.filterValue ??
        savedAdapterSpatialContext.spatial_scope_id ??
        spatialScopeId,
      spatial_scope_name:
        spatialSelection?.feature?.label ??
        savedAdapterSpatialContext.spatial_scope_name ??
        thread?.region?.name,
      spatial_scope_type: spatialSelection?.layer?.tags?.includes('gma')
        ? 'gma'
        : savedAdapterSpatialContext.spatial_scope_type
          ? savedAdapterSpatialContext.spatial_scope_type
          : spatialScopeId
            ? 'custom'
            : null,
      spatial_resolution:
        spatialSelection?.layer?.geometry_type === 'polygon'
          ? 'polygon'
          : savedAdapterSpatialContext.spatial_resolution
            ? savedAdapterSpatialContext.spatial_resolution
            : spatialScopeId
              ? 'region'
              : null,
    }),
    [savedAdapterSpatialContext, spatialScopeId, spatialSelection, thread?.region?.name],
  );

  const {
    data: execRaw,
    refetch: refetchExecution,
    startPolling,
    stopPolling,
  } = useGetThreadExecutionQuery({
    variables: { id: threadId! },
    skip: !threadId,
    fetchPolicy: 'cache-and-network',
  });

  const rememberUnifiedRun = useCallback(
    (modelId: string, snapshot: UnifiedRunSnapshot) => {
      setUnifiedRuns((current) => ({ ...current, [modelId]: snapshot }));
      if (threadId) saveUnifiedRunSnapshot(workflowUserKey, threadId, modelId, snapshot);
      setUnifiedRunErrors((current) => {
        if (!current[modelId]) return current;
        const next = { ...current };
        delete next[modelId];
        return next;
      });
    },
    [threadId, workflowUserKey],
  );

  const refreshUnifiedRun = useCallback(
    async (modelId: string, cachedSnapshot: UnifiedRunSnapshot) => {
      const runId = cachedSnapshot.run_id;
      const ensembleManagerApi = window.__MINT_CONFIG__?.ENSEMBLE_MANAGER_API ?? '';
      if (!threadId || !runId?.startsWith('ue_') || !ensembleManagerApi) return;

      setUnifiedRunRefreshing((current) => ({ ...current, [modelId]: true }));
      try {
        const refreshed = await fetchUnifiedRun(ensembleManagerApi, runId);
        rememberUnifiedRun(modelId, refreshed);
      } catch (error) {
        // Keep the cached workflow visible when the service is temporarily
        // unavailable; the error tells the user the displayed state is stale.
        setUnifiedRunErrors((current) => ({
          ...current,
          [modelId]: error instanceof Error ? error.message : 'Could not refresh workflow status',
        }));
        throw error;
      } finally {
        setUnifiedRunRefreshing((current) => ({ ...current, [modelId]: false }));
      }
    },
    [rememberUnifiedRun, threadId],
  );

  const baseThreadExecutionData = useMemo(
    () => threadExecutionFromGQL(execRaw?.thread_by_pk),
    [execRaw],
  );

  // Restore the latest pipeline snapshot for this sub-task/model after a
  // problem-statement navigation remount, then reconcile it with the server.
  useEffect(() => {
    if (
      !workflowIdentity ||
      !threadId ||
      !baseThreadExecutionData ||
      baseThreadExecutionData.id !== threadId ||
      hydratedWorkflowIdentity.current === workflowIdentity
    ) {
      return;
    }
    hydratedWorkflowIdentity.current = workflowIdentity;

    const restored = Object.fromEntries(
      Object.keys(baseThreadExecutionData.models)
        .map((modelId) => [modelId, loadUnifiedRunSnapshot(workflowUserKey, threadId, modelId)])
        .filter((entry): entry is [string, UnifiedRunSnapshot] => entry[1] !== null),
    );
    setUnifiedRuns(restored);
    setUnifiedRunErrors({});
    for (const [modelId, snapshot] of Object.entries(restored)) {
      void refreshUnifiedRun(modelId, snapshot).catch(() => undefined);
    }
  }, [baseThreadExecutionData, refreshUnifiedRun, threadId, workflowIdentity, workflowUserKey]);

  // Existing executions already retain the Ensemble Manager parent id in
  // Hasura. Recover the workflow snapshot from that durable id when the Runs
  // table is loaded, even if the browser cache was cleared or the page was
  // opened on a different route first.
  useEffect(() => {
    const ensembleManagerApi = window.__MINT_CONFIG__?.ENSEMBLE_MANAGER_API ?? '';
    if (!ensembleManagerApi) return;

    for (const [modelId, group] of Object.entries(modelExecutions)) {
      const runId = group.executions.find((execution) =>
        execution.run_id?.startsWith('ue_'),
      )?.run_id;
      if (!runId || unifiedRuns[modelId]?.run_id === runId) continue;

      void fetchUnifiedRun(ensembleManagerApi, runId)
        .then((snapshot) => rememberUnifiedRun(modelId, snapshot))
        .catch((error) => {
          setUnifiedRunErrors((current) => ({
            ...current,
            [modelId]: error instanceof Error ? error.message : 'Could not load workflow status',
          }));
        });
    }
  }, [modelExecutions, rememberUnifiedRun, unifiedRuns]);

  // Keep an open Runs step honest. Ensemble Manager reconciles a unified run
  // against Tapis with this user's token every time it is fetched, so while
  // any run is still moving, fetch it every 60 s; this is also what settles a
  // run that finished while nobody was looking.
  useEffect(() => {
    if (currentSection !== 'runs') return;
    const active = Object.entries(unifiedRuns).filter(([, run]) => !isUnifiedRunTerminal(run));
    if (active.length === 0) return;
    const timer = window.setInterval(() => {
      const now = Date.now();
      for (const [modelId, snapshot] of active) {
        const backoff = refreshBackoff.current[modelId];
        if (backoff && backoff.nextAt > now) continue;
        void refreshUnifiedRun(modelId, snapshot)
          .then(() => {
            delete refreshBackoff.current[modelId];
          })
          .catch(() => {
            const failures = (refreshBackoff.current[modelId]?.failures ?? 0) + 1;
            refreshBackoff.current[modelId] = {
              failures,
              nextAt: now + Math.min(2 ** failures, 16) * 60_000,
            };
          });
      }
    }, 60_000);
    return () => window.clearInterval(timer);
  }, [currentSection, refreshUnifiedRun, unifiedRuns]);

  const threadExecutionData = useMemo(() => {
    if (!baseThreadExecutionData) return null;
    const contextualPlans = adapterPlanRows.map((plan) => ({
      ...plan,
      parameter_values: {
        ...adapterParameterDefaults(plan.plan_json?.parameters ?? [], adapterSpatialContext),
        ...plan.parameter_values,
      },
    }));
    const plansByThreadModelId = adapterPlansByModel(contextualPlans);
    return {
      ...baseThreadExecutionData,
      adapter_plans: Object.fromEntries(
        Object.entries(baseThreadExecutionData.model_ensembles).map(([modelId, ensemble]) => [
          modelId,
          plansByThreadModelId[ensemble.id] ?? [],
        ]),
      ),
    };
  }, [adapterPlanRows, adapterSpatialContext, baseThreadExecutionData]);

  const loadAdapterPlans = useCallback(async () => {
    if (!threadId || !adapterPlanningEnabled) {
      setAdapterPlansLoaded(false);
      return;
    }
    setAdapterPlansLoaded(false);
    try {
      const rows = await fetchThreadAdapterPlans(apollo, threadId);
      setAdapterPlanRows(rows);
    } finally {
      setAdapterPlansLoaded(true);
    }
  }, [adapterPlanningEnabled, apollo, threadId]);

  useEffect(() => {
    if (!adapterPlanningEnabled || !threadId) {
      setAdapterPlanRows([]);
      setAdapterPlansLoaded(false);
      return;
    }
    void loadAdapterPlans().catch((err: unknown) => {
      setAdapterPlanError(err instanceof Error ? err.message : String(err));
    });
  }, [adapterPlanningEnabled, loadAdapterPlans, threadId]);

  // The geometry the Datasets step narrows on. A selected catalog boundary is
  // the active extent; otherwise retain the thread's stored region geometry.
  const regionGeometry = useMemo(
    () =>
      spatialSelection?.feature?.geometry
        ? [spatialSelection.feature.geometry]
        : (thread?.region?.geometries ?? []).map((g) => g.geometry).filter(Boolean),
    [spatialSelection, thread?.region],
  );

  // The execution engine writes the run counters; nothing pushes them back, so
  // poll while a submitted run is still unfinished and stop as soon as it is.
  const runsInFlight = hasUnfinishedRuns(threadExecutionData?.execution_summary ?? {});
  useEffect(() => {
    if (runsInFlight) startPolling(RUN_POLL_MS);
    else stopPolling();
    return () => stopPolling();
  }, [runsInFlight, startPolling, stopPolling]);

  const handleThreadUpdated = useCallback(async () => {
    await Promise.all([refetch(), refetchExecution(), loadAdapterPlans()]);
  }, [loadAdapterPlans, refetch, refetchExecution]);

  const [updateThreadParameters] = useUpdateThreadParametersMutation();

  // ── Execution handlers ──────────────────────────────────────────────────

  const handleSaveParameters = useCallback(
    async (
      ensembles: ModelEnsembleMap,
      summary: ExecutionSummaryMap,
      notes: string,
      adapterPlans: ThreadAdapterPlan[],
    ) => {
      if (!threadId || !threadExecutionData) return;
      const modelParams: ThreadModelParameterInsert[] = [];
      const summaries: ThreadModelSummaryInsert[] = [];

      for (const [modelId, ensemble] of Object.entries(ensembles)) {
        const model = threadExecutionData.models[modelId];
        // `bindings` holds data and parameter bindings side by side; only the
        // adjustable parameters belong in thread_model_parameter.
        if (!model || !ensemble.id) continue;
        for (const param of model.input_parameters.filter((p) => !p.value)) {
          for (const value of ensemble.bindings[param.id] ?? []) {
            modelParams.push({
              thread_model_id: ensemble.id,
              model_parameter_id: param.id,
              parameter_value: value,
            });
          }
        }
        const counters = summary[modelId];
        summaries.push({
          thread_model_id: ensemble.id,
          total_runs: counters?.total_runs ?? 0,
          submitted_runs: 0,
          successful_runs: 0,
          failed_runs: 0,
        });
      }

      await updateThreadParameters({
        variables: {
          threadId,
          event: {
            thread_id: threadId,
            event: 'SELECT_PARAMETERS',
            userid: user?.username ?? 'anonymous',
            notes: notes || null,
          },
          summaries,
          modelParams,
        },
      });
      if (adapterPlanningEnabled) {
        const savedPlans = await replaceThreadAdapterPlans(apollo, threadId, adapterPlans);
        setAdapterPlanRows(savedPlans);
      }
      await handleThreadUpdated();
    },
    [
      adapterPlanningEnabled,
      apollo,
      handleThreadUpdated,
      threadExecutionData,
      threadId,
      updateThreadParameters,
      user,
    ],
  );

  const adapterSourceFingerprint = useMemo(() => {
    if (!baseThreadExecutionData) return '';
    const inputSources = Object.entries(baseThreadExecutionData.models).flatMap(
      ([modelId, model]) =>
        model.input_files.flatMap((input) => {
          const slices = baseThreadExecutionData.model_ensembles[modelId]?.bindings[input.id] ?? [];
          return slices.flatMap((sliceId) => {
            const resources = baseThreadExecutionData.data[sliceId]?.resources as
              | Array<{ id: string; selected?: boolean }>
              | undefined;
            return (resources ?? [])
              .filter((resource) => resource.selected !== false)
              .map((resource) => {
                const threadModelId =
                  baseThreadExecutionData.model_ensembles[modelId]?.id ?? modelId;
                return `${threadModelId}:${input.id}:${resource.id}`;
              });
          });
        }),
    );
    const target = baseThreadExecutionData.response_variables?.[0] ?? '';
    const outputSources = Object.entries(baseThreadExecutionData.models).flatMap(
      ([modelId, model]) => {
        const threadModelId = baseThreadExecutionData.model_ensembles[modelId]?.id ?? modelId;
        return model.output_files
          .filter((output) => !output.variables?.length || !output.variables.includes(target))
          .map((output) => `${threadModelId}:post_model:${output.id}:${target}`);
      },
    );
    return [...inputSources, ...outputSources].sort().join('|');
  }, [baseThreadExecutionData]);

  const savedAdapterPlansMatchSources = useMemo(
    () =>
      adapterPlansLoaded &&
      Boolean(adapterSourceFingerprint) &&
      adapterPlansSourceFingerprint(adapterPlanRows) === adapterSourceFingerprint,
    [adapterPlanRows, adapterPlansLoaded, adapterSourceFingerprint],
  );

  const discoverAdapterPlans = useCallback(async () => {
    if (!threadId || !baseThreadExecutionData || !adapterSourceFingerprint) return;
    setAdapterPlansLoading(true);
    try {
      const ensembleManagerApi = window.__MINT_CONFIG__?.ENSEMBLE_MANAGER_API ?? '';
      const discovered: ThreadAdapterPlan[] = [];
      const seen = new Set<string>();
      const savedByKey = new Map(
        adapterPlanRows.map((saved) => {
          const key =
            saved.stage === 'post_model' || saved.source_kind === 'model_output'
              ? `${saved.thread_model_id}:post_model:${saved.model_io_id}`
              : `${saved.thread_model_id}:${saved.model_io_id}:${saved.source_resource_id ?? ''}`;
          return [key, saved] as const;
        }),
      );

      for (const [modelId, model] of Object.entries(baseThreadExecutionData.models)) {
        const threadModelId = baseThreadExecutionData.model_ensembles[modelId]?.id;
        if (!threadModelId) continue;
        for (const input of model.input_files) {
          const slices = baseThreadExecutionData.model_ensembles[modelId]?.bindings[input.id] ?? [];
          for (const sliceId of slices) {
            const resources = baseThreadExecutionData.data[sliceId]?.resources as
              | Array<{ id: string; name?: string; url?: string; selected?: boolean }>
              | undefined;
            for (const resource of (resources ?? []).filter((item) => item.selected !== false)) {
              const key = `${threadModelId}:${input.id}:${resource.id}`;
              if (seen.has(key)) continue;
              seen.add(key);
              const plan = await createExecutionPlan(ensembleManagerApi, {
                executor: 'svo_adapter',
                thread_id: threadId,
                model_id: modelId,
                adapter_request: {
                  data_object_id: resource.id.startsWith('ckan-')
                    ? resource.id
                    : `ckan-${resource.id}`,
                  data_object: {
                    id: resource.id.startsWith('ckan-') ? resource.id : `ckan-${resource.id}`,
                    label: resource.name || resource.id,
                    resource_uri: resource.url,
                    format: input.format ?? undefined,
                    variables: (input.variableIds ?? []).map((standardVariableUri) => ({
                      standard_variable_uri: standardVariableUri,
                    })),
                  },
                  target_dataset_specification_id: input.id,
                },
              });
              const saved = savedByKey.get(`${threadModelId}:${input.id}:${resource.id}`);
              discovered.push({
                thread_model_id: threadModelId,
                model_io_id: input.id,
                source_resource_id: resource.id,
                executor: 'svo_adapter',
                adapter_plan_id: plan.plan_id?.replace(/^svo_/, '') ?? null,
                status: plan.plan_id ? 'transform_required' : plan.status || 'ready',
                plan_json: plan,
                parameter_values: {
                  ...(saved?.parameter_values ?? {}),
                  ...adapterParameterDefaults(plan.parameters ?? [], adapterSpatialContext),
                },
              });
            }
          }
        }

        const targetVariable = baseThreadExecutionData.response_variables?.[0];
        const postModelCandidates: Array<{
          output: (typeof model.output_files)[number];
          plan: Awaited<ReturnType<typeof createExecutionPlan>>;
        }> = [];
        if (targetVariable) {
          for (const output of model.output_files) {
            if (output.variables?.includes(targetVariable)) continue;
            const key = `${threadModelId}:post_model:${output.id}:${targetVariable}`;
            if (seen.has(key)) continue;
            seen.add(key);
            try {
              const saved = savedByKey.get(`${threadModelId}:post_model:${output.id}`);
              const savedTargetContract = (
                saved?.plan_json?.post_model_adapter as
                  | { target_contract?: Record<string, unknown> }
                  | undefined
              )?.target_contract;
              const plan = await createExecutionPlan(ensembleManagerApi, {
                executor: 'ensemble_manager',
                thread_id: threadId,
                model_id: modelId,
                execution_engine: window.__MINT_CONFIG__?.EXECUTION_ENGINE ?? 'localex',
                post_model_adapter: {
                  model_io_id: output.id,
                  model_output_key: output.id,
                  source_contract: {
                    standard_variable_uri: output.variables?.[0] ?? output.id,
                    format: output.format ?? undefined,
                  },
                  target_contract: {
                    standard_variable_uri: targetVariable,
                    ...(savedTargetContract?.unit ? { unit: savedTargetContract.unit } : {}),
                  },
                },
              });
              postModelCandidates.push({ output, plan });
            } catch (error) {
              // A model can declare several outputs. Only the output that has
              // a valid path to the selected response variable belongs in the
              // deferred plan; unrelated outputs are not discovery failures.
              if (
                error instanceof EnsembleManagerError &&
                error.code === 'NO_DEFERRED_TRANSFORM_PATH'
              ) {
                continue;
              }
              throw error;
            }
          }
        }
        if (postModelCandidates.length > 1) {
          throw new Error(
            `Multiple model outputs can produce ${targetVariable}; select a model with one unambiguous output path.`,
          );
        }
        for (const { output, plan } of postModelCandidates) {
          const postModel = plan.post_model_adapter as
            | { adapter_plan_id?: string; plan_hash?: string }
            | undefined;
          discovered.push({
            thread_model_id: threadModelId,
            model_io_id: output.id,
            source_resource_id: null,
            stage: 'post_model',
            source_kind: 'model_output',
            executor: 'svo_adapter',
            adapter_plan_id: postModel?.adapter_plan_id ?? null,
            status: postModel?.adapter_plan_id ? 'transform_required' : plan.status || 'ready',
            plan_json: plan,
            parameter_values: {
              ...(savedByKey.get(`${threadModelId}:post_model:${output.id}`)?.parameter_values ??
                {}),
              ...adapterParameterDefaults(plan.parameters ?? [], adapterSpatialContext),
            },
          });
        }
      }

      const savedPlans = await replaceThreadAdapterPlans(apollo, threadId, discovered);
      setAdapterPlanRows(savedPlans);
      setAdapterPlanError(null);
      discoveredAdapterSources.current = adapterSourceFingerprint;
    } finally {
      setAdapterPlansLoading(false);
    }
  }, [
    adapterPlanRows,
    adapterSourceFingerprint,
    adapterSpatialContext,
    apollo,
    baseThreadExecutionData,
    threadId,
  ]);

  useEffect(() => {
    if (
      currentSection !== 'parameters' ||
      !adapterPlanningEnabled ||
      !adapterPlansLoaded ||
      !baseThreadExecutionData ||
      !datasetsComplete(baseThreadExecutionData) ||
      !adapterSourceFingerprint ||
      savedAdapterPlansMatchSources ||
      discoveredAdapterSources.current === adapterSourceFingerprint
    ) {
      return;
    }
    discoveredAdapterSources.current = adapterSourceFingerprint;
    void discoverAdapterPlans().catch((err: unknown) => {
      discoveredAdapterSources.current = null;
      setAdapterPlanError(err instanceof Error ? err.message : String(err));
    });
  }, [
    adapterPlanningEnabled,
    adapterPlansLoaded,
    adapterSourceFingerprint,
    baseThreadExecutionData,
    currentSection,
    discoverAdapterPlans,
    savedAdapterPlansMatchSources,
  ]);

  const handleFetchRuns = useCallback(
    (modelId: string, page: number, pageSize: number) => {
      const threadModelId = threadExecutionData?.model_ensembles[modelId]?.id;
      if (!threadModelId) return;
      setModelExecutions((prev) => ({
        ...prev,
        [modelId]: { executions: prev[modelId]?.executions ?? [], loading: true },
      }));
      apollo
        .query<GetThreadModelExecutionsQuery, GetThreadModelExecutionsQueryVariables>({
          query: GetThreadModelExecutionsDocument,
          variables: { threadModelId, offset: (page - 1) * pageSize, limit: pageSize },
          fetchPolicy: 'network-only',
        })
        .then((res) => {
          setModelExecutions((prev) => ({
            ...prev,
            [modelId]: {
              executions: (res.data?.execution ?? []).map(executionFromGQL),
              loading: false,
            },
          }));
        })
        .catch(() => {
          setModelExecutions((prev) => ({
            ...prev,
            [modelId]: { executions: prev[modelId]?.executions ?? [], loading: false },
          }));
        });
    },
    [apollo, threadExecutionData],
  );

  const handleSubmitRuns = useCallback(
    async (modelId: string, maxMinutes: number) => {
      if (adapterPlansLoading || adapterPlanError) {
        throw new Error('SVO adapter plan discovery must complete before workflow submission.');
      }
      const adapterPlans = threadExecutionData?.adapter_plans?.[modelId] ?? [];
      // POST to the ensemble manager REST API
      const ensembleManagerApi = window.__MINT_CONFIG__?.ENSEMBLE_MANAGER_API ?? '';
      // Which backend this deployment's Ensemble Manager runs. Read at call
      // time, like the API base above. The fallback matches the one in
      // scripts/generate-env-config.mjs, and only fires against an env-config.js
      // generated before this key existed.
      const executionEngine = window.__MINT_CONFIG__?.EXECUTION_ENGINE ?? 'localex';
      const adapterSteps = adapterPlans
        .filter(
          (plan) =>
            plan.stage !== 'post_model' &&
            plan.adapter_plan_id &&
            plan.status === 'transform_required',
        )
        .map((plan) => ({
          adapter_plan_id: plan.adapter_plan_id!,
          model_io_id: plan.model_io_id,
          source_resource_id: plan.source_resource_id!,
        }));
      const postModelPlan = adapterPlans.find((item) => item.stage === 'post_model');
      const postModelSpec = postModelPlan?.plan_json?.post_model_adapter as
        | {
            model_io_id: string;
            model_output_key: string;
            source_contract: Record<string, unknown>;
            target_contract: Record<string, unknown>;
            target_dataset_specification_id?: string;
          }
        | undefined;
      if (postModelPlan && !postModelSpec) {
        throw new Error('Deferred SVO adapter plan is missing its source contract.');
      }
      if (postModelPlan && adapterSteps.length) {
        throw new Error('A model cannot submit both pre-model and post-model adapters yet.');
      }
      if (postModelPlan && (!thread?.start_date || !thread?.end_date)) {
        throw new Error(
          'Set both a start date and an end date from the selected archive before sending runs.',
        );
      }
      const plan = await createExecutionPlan(ensembleManagerApi, {
        executor: 'ensemble_manager',
        execution_engine: executionEngine,
        thread_id: threadId,
        model_id: modelId,
        adapter_steps: adapterSteps,
        ...(postModelSpec ? { post_model_adapter: postModelSpec } : {}),
      });
      if (!plan.plan_id) throw new Error('Ensemble Manager did not return an execution plan.');
      const defaultBoundaryUri = adapterPlans
        .flatMap((adapterPlan) => adapterPlan.plan_json?.parameters ?? [])
        .map((parameter) =>
          parameter.name === 'geometry_source_uri' ? parameter.default : undefined,
        )
        .find((value): value is string => typeof value === 'string' && value.trim().length > 0);
      const selectedBoundaryUri =
        adapterPlans
          .map((adapterPlan) => adapterPlan.parameter_values?.geometry_source_uri)
          .find((value): value is string => typeof value === 'string' && value.trim().length > 0) ??
        spatialSelection?.layer?.source_uri ??
        spatialSelection?.layer?.uri ??
        defaultBoundaryUri;
      const adapterParameterValues = adapterParameterValuesForSubmission(adapterPlans, plan, {
        start_date: thread?.start_date?.split('T')[0],
        end_date: thread?.end_date?.split('T')[0],
        // The DFC budget workflow consumes geometry_source_uri. Older generated
        // workflow definitions also retain the SUBSIDE-compatible AOI argument;
        // provide the selected boundary URI so validation does not reject a
        // valid DFC run before its actual boundary argument is read.
        aoi_geojson_uri: selectedBoundaryUri,
      });
      const submitted = await submitExecutionPlan(ensembleManagerApi, {
        plan_id: plan.plan_id,
        max_minutes: maxMinutes,
        adapter_parameter_values: adapterParameterValues,
      });
      if (submitted.run_id?.startsWith('ue_')) {
        rememberUnifiedRun(modelId, submitted);
      } else {
        // A normal model job has no workflow parent. Do not leave an older
        // pipeline snapshot attached to this new submission.
        setUnifiedRuns((current) => {
          const next = { ...current };
          delete next[modelId];
          return next;
        });
        if (threadId) clearUnifiedRunSnapshots(workflowUserKey, threadId, modelId);
      }
      const parentRunId = typeof submitted.run_id === 'string' ? submitted.run_id : null;
      if (parentRunId?.startsWith('ue_')) {
        // Reconciliation is server-owned, but it needs a status read to drive
        // the child -> output -> model state machine when no worker is enabled.
        void (async () => {
          for (let attempt = 0; attempt < 120; attempt += 1) {
            await new Promise((resolve) => window.setTimeout(resolve, 5000));
            const state = await fetchUnifiedRun(ensembleManagerApi, parentRunId);
            rememberUnifiedRun(modelId, state);
            if (
              ['completed', 'failed', 'unknown', 'cancelled', 'model_submitted'].includes(
                String(state.status),
              )
            ) {
              await refetchExecution();
              return;
            }
          }
        })().catch(() => undefined);
      }
      // The engine writes the counters itself; read them back rather than
      // guessing at them locally.
      await refetchExecution();
    },
    [
      adapterPlanError,
      adapterPlansLoading,
      refetchExecution,
      rememberUnifiedRun,
      thread?.end_date,
      threadExecutionData,
      threadId,
      thread?.start_date,
      workflowUserKey,
    ],
  );

  const handleRefreshWorkflow = useCallback(
    async (modelId: string) => {
      const persistedRunId = modelExecutions[modelId]?.executions
        .map((execution) => execution.run_id)
        .find((runId): runId is string => typeof runId === 'string' && runId.startsWith('ue_'));
      const snapshot =
        unifiedRuns[modelId] ??
        (persistedRunId
          ? { run_id: persistedRunId, execution_mode: 'workflow_pipeline' as const }
          : undefined);
      if (!snapshot) return;
      await refreshUnifiedRun(modelId, snapshot);
    },
    [modelExecutions, refreshUnifiedRun, unifiedRuns],
  );

  const handleCancelWorkflow = useCallback(
    async (modelId: string) => {
      const runId = unifiedRuns[modelId]?.run_id;
      const ensembleManagerApi = window.__MINT_CONFIG__?.ENSEMBLE_MANAGER_API ?? '';
      if (!runId?.startsWith('ue_') || !ensembleManagerApi) return;
      setUnifiedRunCancelling((current) => ({ ...current, [modelId]: true }));
      try {
        const cancelled = await cancelUnifiedRun(ensembleManagerApi, runId);
        rememberUnifiedRun(modelId, cancelled);
        setUnifiedRunErrors((current) => {
          const next = { ...current };
          delete next[modelId];
          return next;
        });
      } catch (error) {
        setUnifiedRunErrors((current) => ({
          ...current,
          [modelId]: error instanceof Error ? error.message : 'Could not cancel the run',
        }));
      } finally {
        setUnifiedRunCancelling((current) => ({ ...current, [modelId]: false }));
      }
    },
    [rememberUnifiedRun, unifiedRuns],
  );

  /**
   * Register this thread's run outputs, then read the counters back.
   *
   * `MintResults` treats the absence of this prop as "publishing is not
   * available" and returns before making any request, so leaving it unpassed
   * makes the Fetch results button silently dead — which is what #110 was.
   */
  const handlePublishResults = useCallback(async () => {
    const ensembleManagerApi = window.__MINT_CONFIG__?.ENSEMBLE_MANAGER_API ?? '';
    const problemStatementId = thread?.task?.problem_statement_id;
    const taskId = thread?.task_id;
    if (!ensembleManagerApi || !problemStatementId || !taskId || !threadId) return;
    await publishResults(ensembleManagerApi, { problemStatementId, taskId, threadId });
    // The server writes published_runs and the execution_result rows; read them
    // back rather than guessing at them locally.
    await refetchExecution();
  }, [thread, threadId, refetchExecution]);

  /**
   * Register the outputs of one execution, then read the counters back.
   *
   * The Runs step offers this beside the archived files of a single run:
   * nothing republishes by itself, so a user who has just promoted a file
   * presses Publish for that run alone (#261).
   */
  const handlePublishExecution = useCallback(
    async (executionId: string) => {
      const ensembleManagerApi = window.__MINT_CONFIG__?.ENSEMBLE_MANAGER_API ?? '';
      const problemStatementId = thread?.task?.problem_statement_id;
      const taskId = thread?.task_id;
      if (!ensembleManagerApi || !problemStatementId || !taskId || !threadId) {
        // Saying nothing here would read as a successful publication.
        throw new Error('This deployment has no Ensemble Manager configured.');
      }
      await publishExecution(
        ensembleManagerApi,
        { problemStatementId, taskId, threadId },
        executionId,
      );
      await refetchExecution();
    },
    [thread, threadId, refetchExecution],
  );

  /**
   * Re-read the thread after the user promotes a file.
   *
   * The declared outputs of a model configuration reach the steps through the
   * execution query, so a promotion is invisible until that query runs again.
   */
  const handleOutputsChanged = useCallback(async () => {
    await refetchExecution();
  }, [refetchExecution]);

  // ── render ─────────────────────────────────────────────────────────────────

  if (loading && !data) {
    return (
      <div className="space-y-3 p-4">
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (error) {
    return (
      <p className="p-4 text-sm text-destructive" role="alert">
        Failed to load thread: {error.message}
      </p>
    );
  }

  if (!thread) {
    return (
      <p className="p-4 text-sm text-muted-foreground">No sub-task selected or thread not found.</p>
    );
  }

  const perm = getUserPermission(thread.permissions, thread.events, user?.username ?? null);

  // Until the execution query resolves, the pipeline is empty rather than
  // wrong: the steps that read it show their "nothing selected yet" state.
  const execData: ThreadExecutionData = threadExecutionData ?? {
    id: thread.id,
    models: {},
    model_ensembles: {},
    execution_summary: {},
    data: {},
    response_variables: thread.response_variable_id ? [thread.response_variable_id] : [],
    adapter_plans: {},
  };

  const stepStates = deriveStepStates(thread, {
    datasetsComplete: datasetsComplete(threadExecutionData),
    parametersComplete:
      !adapterPlansLoading && !adapterPlanError && parametersComplete(threadExecutionData),
    runsComplete: runsComplete(threadExecutionData),
  });

  function renderStep() {
    switch (currentSection) {
      case 'framing':
        return (
          <FramingStep
            thread={thread!}
            onUpdated={() => void handleThreadUpdated()}
            onContinue={goNext}
            spatialSelection={spatialSelection}
            onSpatialSelectionChange={setSpatialSelection}
          />
        );
      case 'variables':
        return (
          <VariablesStep
            thread={thread!}
            taskName={taskName}
            onUpdated={() => void handleThreadUpdated()}
            onContinue={goNext}
            onBack={goBack}
          />
        );
      case 'models':
        return (
          <ModelsStep
            thread={thread!}
            onUpdated={() => void handleThreadUpdated()}
            onContinue={goNext}
            onBack={goBack}
            onEditIndicator={() => setCurrentSection('variables')}
            regionGeometry={regionGeometry}
          />
        );
      case 'datasets':
        return (
          <DatasetsStep
            thread={thread!}
            models={execData.models}
            ensembles={execData.model_ensembles}
            persistedData={execData.data}
            regionGeometry={regionGeometry}
            spatialScopeName={spatialSelection?.feature?.label ?? thread?.region?.name ?? null}
            initialDatasetIds={initialDatasetIds}
            onUpdated={handleThreadUpdated}
            onContinue={goNext}
            onBack={goBack}
          />
        );
      case 'parameters':
        return (
          <MintParameters
            threadData={execData}
            canWrite={perm.write}
            canExecute={perm.write}
            onSave={handleSaveParameters}
            onContinue={goNext}
            adapterPlanError={adapterPlanError}
            adapterPlanLoading={adapterPlansLoading}
            spatialScopeName={thread?.region?.name ?? spatialScopeId}
            spatialScopeId={spatialScopeId}
            spatialSelection={spatialSelection}
          />
        );
      case 'runs':
        return (
          <MintRuns
            threadId={threadId}
            threadData={execData}
            executions={modelExecutions}
            canWrite={perm.write}
            canExecute={perm.write}
            ensembleManagerApi={window.__MINT_CONFIG__?.ENSEMBLE_MANAGER_API ?? ''}
            unifiedRuns={unifiedRuns}
            onContinue={goNext}
            onFetchRuns={handleFetchRuns}
            onSubmitRuns={handleSubmitRuns}
            onRefreshWorkflow={handleRefreshWorkflow}
            workflowRefreshErrors={unifiedRunErrors}
            workflowRefreshing={unifiedRunRefreshing}
            onCancelWorkflow={handleCancelWorkflow}
            workflowCancelling={unifiedRunCancelling}
            onPublishExecution={handlePublishExecution}
            onOutputsChanged={handleOutputsChanged}
            adapterPlansLoading={adapterPlansLoading}
            adapterPlanError={adapterPlanError}
          />
        );
      case 'results':
        return (
          <MintResults
            threadData={execData}
            executions={modelExecutions}
            unifiedRuns={unifiedRuns}
            canWrite={perm.write}
            ingestionApiAvailable={false}
            onContinue={goNext}
            onFetchRuns={handleFetchRuns}
            onPublishResults={handlePublishResults}
            onPromoteOutputs={() => setCurrentSection('runs')}
          />
        );
      case 'summary':
        return <MintSummary thread={thread!} />;
    }
  }

  const stepNavigation = (
    <WizardRail states={stepStates} currentStep={currentSection} onSelect={setCurrentSection} />
  );

  return (
    <div
      data-testid="mint-thread"
      className={cn(
        'flex flex-col overflow-hidden',
        maximized ? 'fixed inset-0 z-50 bg-white p-4' : 'h-full',
      )}
    >
      <div className="mb-2 flex items-center justify-end">
        <button
          type="button"
          aria-label={maximized ? 'Restore size' : 'Maximize'}
          onClick={() => setMaximized((m) => !m)}
          className="rounded p-1.5 text-gray-500 hover:bg-gray-100"
        >
          {maximized ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
        </button>
      </div>
      <div className="flex min-h-0 flex-1 gap-3 overflow-hidden">
        <aside
          className="w-56 shrink-0 overflow-y-auto border-r border-gray-200 pr-3"
          aria-label="Sub-task step navigation"
        >
          {stepNavigation}
        </aside>
        <main className="min-w-0 flex-1 overflow-y-auto pr-1">{renderStep()}</main>
      </div>
    </div>
  );
}
