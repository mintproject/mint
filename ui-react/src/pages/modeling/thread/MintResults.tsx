/**
 * MintResults — Browse and download execution results.
 *
 * 1:1 port of the legacy LitElement MintResults component.
 * Shows a paginated table of completed execution outputs, supports CSV download,
 * and triggers ingestion/publishing workflows.
 *
 * Legacy: ui/src/screens/modeling/thread/mint-results.ts
 */
import { secretErrorMessage, userParameters } from '@/lib/secret-parameters';
import { Download, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import {
  Execution,
  ExecutionResult,
  ModelExecutionsMap,
  ModelOutputFile,
  ThreadExecutionData,
} from '@/graphql/generated/execution';
import { CollapsibleCard } from '@/components/common/CollapsibleCard';
import { RunAnswerCard } from '@/components/modeling/runs/RunAnswerCard';
import { RunFailureNotice } from '@/components/modeling/runs/RunFailureNotice';
import { SameForEveryRun } from '@/components/modeling/runs/SameForEveryRun';
import { SettingsUsed } from '@/components/modeling/runs/SettingsUsed';
import { flowErrorMessage } from '@/lib/flow-errors';
import {
  aggregateRunStatus,
  displayStatusLabel,
  statusPillClasses,
} from '@/lib/modeling/run-status';
import { humanizeName, runParamValue, splitRunParams } from '@/lib/modeling/run-settings';
import { EditedInputNote } from './EditedInputNote';
import { ExecutionFilesDialog } from './ExecutionFilesDialog';
import { OutputBlock } from './OutputBlock';
import { TapisResult } from './TapisResult';
import {
  EnsembleManagerError,
  NO_OUTPUTS_DECLARED,
  type UnifiedRunSnapshot,
} from '@/lib/ensemble-manager';

// ─── Helpers ──────────────────────────────────────────────────────────────────

type BoundFile = { url?: string; name?: string };

function FileLink({ file }: { file: BoundFile }) {
  if (!file.url) return <span>{file.name ?? '—'}</span>;
  return (
    <a
      href={file.url}
      target="_blank"
      rel="noopener noreferrer"
      className="text-blue-600 hover:underline"
    >
      {file.name ?? file.url}
    </a>
  );
}

/**
 * What a run read for one input: a link for one file, or "N files" that opens to
 * the list for an input that took a collection. "—" when nothing was recorded.
 */
function InputBinding({ binding }: { binding: unknown }) {
  const files = (Array.isArray(binding) ? binding : binding ? [binding] : []).filter(
    (file): file is BoundFile => !!file && typeof file === 'object',
  );
  const [first] = files;
  if (!first) return <>—</>;
  if (!Array.isArray(binding) || files.length === 1) {
    return first.url ? <FileLink file={first} /> : <>—</>;
  }
  return (
    <details data-testid="collection-binding">
      <summary className="cursor-pointer text-blue-600">{files.length} files</summary>
      <ul className="mt-1 space-y-0.5">
        {files.map((file, i) => (
          <li key={file.url ?? i}>
            <FileLink file={file} />
          </li>
        ))}
      </ul>
    </details>
  );
}

function matchVariables(
  responseVars: string[] | undefined,
  outputVars: string[] | undefined,
): boolean {
  if (!responseVars?.length || !outputVars?.length) return false;
  return responseVars.some((rv) => outputVars.some((ov) => ov.includes(rv) || rv.includes(ov)));
}

function getResultUrl(
  result: ExecutionResult,
  engine: string | null | undefined,
  mintConfig?: {
    localex?: { datadir?: string; dataurl?: string };
    wings?: { datadir?: string; dataurl?: string };
  },
): string {
  if (result.url) return result.url;
  if (result.location) {
    if (!mintConfig) return result.location;
    const cfg = engine === 'localex' ? mintConfig.localex : mintConfig.wings;
    if (cfg?.datadir && cfg?.dataurl) {
      return result.location.replace(cfg.datadir, cfg.dataurl);
    }
  }
  return '';
}

/** `tapis` locations are opened through the Ensemble Manager; only http(s) is a link. */
function resultScheme(url: string): 'tapis' | 'web' | 'text' {
  if (/^tapis:\/\//i.test(url)) return 'tapis';
  if (/^https?:\/\//i.test(url)) return 'web';
  return 'text';
}

function getResultName(result: ExecutionResult): string {
  if (result.name) return result.name;
  if (result.location) return result.location.replace(/.+\//, '');
  return 'Download';
}

// ─── Props ────────────────────────────────────────────────────────────────────

interface MintResultsProps {
  threadData: ThreadExecutionData;
  executions: ModelExecutionsMap;
  canWrite: boolean;
  ingestionApiAvailable: boolean;
  mintConfig?: {
    localex?: { datadir?: string; dataurl?: string };
    wings?: { datadir?: string; dataurl?: string };
  };
  onContinue: () => void;
  onFetchRuns: (modelId: string, page: number, pageSize: number) => void;
  onIngestResults?: (modelId: string) => void;
  onPublishResults?: (modelId: string) => Promise<void>;
  unifiedRuns?: Record<string, UnifiedRunSnapshot>;
  /**
   * Take the user to the promote action — the Runs step, where each finished
   * run lists its archived files. Shown instead of the raw 422 text when the
   * model configuration declares no output.
   */
  onPromoteOutputs?: () => void;
  /** Take the user to the Runs step: where a paused run is edited and a failed one restarted. */
  onOpenRuns?: () => void;
  /** Send a model's runs again after they failed. Rejects with the Ensemble Manager's refusal. */
  onRestartRuns?: (modelId: string) => Promise<void>;
}

// ─── Component ────────────────────────────────────────────────────────────────

const PAGE_SIZE = 100;

export function MintResults({
  threadData,
  executions,
  canWrite,
  ingestionApiAvailable,
  mintConfig,
  onContinue,
  onFetchRuns,
  onIngestResults,
  onPublishResults,
  onPromoteOutputs,
  onOpenRuns,
  onRestartRuns,
  unifiedRuns,
}: MintResultsProps) {
  const modelIds = Object.keys(threadData.execution_summary ?? {});

  // One submitted model is enough to browse: the others show as not run yet.
  const paramsDone =
    modelIds.length > 0 &&
    modelIds.some((mid) => {
      const s = threadData.execution_summary[mid];
      return s && (s.submitted_for_execution || s.submission_time);
    });

  const ensembleManagerApi = window.__MINT_CONFIG__?.ENSEMBLE_MANAGER_API ?? '';
  // The run whose result folder is open in the files dialog.
  const [filesFor, setFilesFor] = useState<{ executionId: string; modelId: string } | null>(null);
  const [pages, setPages] = useState<Record<string, number>>({});
  const [showAllOutputs, setShowAllOutputs] = useState(true);
  // A card the user closed (or opened) keeps that choice; the rest start open.
  const [cardOpen, setCardOpen] = useState<Record<string, boolean>>({});
  const [restarting, setRestarting] = useState<Record<string, boolean>>({});
  const [restartError, setRestartError] = useState<Record<string, string>>({});
  const [publishWaiting, setPublishWaiting] = useState<Record<string, boolean>>({});
  const [publishError, setPublishError] = useState<Record<string, string>>({});
  // The server's own error code, kept beside the message. NO_OUTPUTS_DECLARED
  // is not an error to read and dismiss: it names a missing declaration the
  // user repairs by promoting a file (#267).
  const [publishErrorCode, setPublishErrorCode] = useState<Record<string, string>>({});

  useEffect(() => {
    for (const mid of modelIds) {
      const page = pages[mid] ?? 1;
      onFetchRuns(mid, page, PAGE_SIZE);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelIds.join(',')]);

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

  const handlePublish = useCallback(
    async (mid: string) => {
      if (!onPublishResults) return;
      setPublishWaiting((w) => ({ ...w, [mid]: true }));
      setPublishError((e) => ({ ...e, [mid]: '' }));
      setPublishErrorCode((c) => ({ ...c, [mid]: '' }));
      try {
        await onPublishResults(mid);
        // Registration writes the execution_result rows server-side, and this
        // table renders the executions held in the parent's state — which
        // `onPublishResults` does not reload. Without this the rows only appear
        // on a later Reload, so a successful fetch still reads
        // "No results available" (#110).
        onFetchRuns(mid, pages[mid] ?? 1, PAGE_SIZE);
      } catch (err) {
        // Registration reaches Tapis and CKAN, so it fails for reasons the user
        // cannot guess at — an expired data-catalog credential reads as a bare
        // 403. Show the server's own message instead of dropping it (#110).
        setPublishError((e) => ({
          ...e,
          [mid]: err instanceof Error ? err.message : 'Could not fetch results',
        }));
        setPublishErrorCode((c) => ({
          ...c,
          [mid]: err instanceof EnsembleManagerError ? (err.code ?? '') : '',
        }));
      } finally {
        setPublishWaiting((w) => ({ ...w, [mid]: false }));
      }
    },
    [onPublishResults, onFetchRuns, pages],
  );

  const handleRestart = useCallback(
    async (mid: string) => {
      if (!onRestartRuns) return;
      setRestarting((r) => ({ ...r, [mid]: true }));
      setRestartError((e) => ({ ...e, [mid]: '' }));
      try {
        await onRestartRuns(mid);
        // The new run is followed in the Runs step.
        onOpenRuns?.();
      } catch (err) {
        const refusal = flowErrorMessage(err);
        setRestartError((e) => ({
          ...e,
          [mid]: refusal
            ? [refusal.title, ...refusal.lines].join(' ')
            : (secretErrorMessage(err) ?? (err instanceof Error ? err.message : String(err))),
        }));
      } finally {
        setRestarting((r) => ({ ...r, [mid]: false }));
      }
    },
    [onRestartRuns, onOpenRuns],
  );

  // ─ CSV download ─────────────────────────────────────────────────────────
  function handleDownloadCsv(
    groupedExecutions: Record<string, Execution>,
    outputs: ModelOutputFile[],
    inputs: Array<{ id: string; name: string }>,
    params: Array<{ id: string; name: string; default?: string | null }>,
    engine: string | null | undefined,
  ) {
    const headers = [
      ...outputs.map((o) => o.name.replace(/[-_]/g, ' ')),
      ...inputs.map((i) => i.name.replace(/[-_]/g, ' ')),
      ...params.map((p) => p.name.replace(/[-_]/g, ' ')),
    ].join(',');

    const rows = Object.values(groupedExecutions).map((exec) => {
      const paramDefaults: Record<string, string | null | undefined> = {};
      params.forEach((p) => (paramDefaults[p.id] = p.default ?? null));

      const outVals = outputs.map((out) => {
        const result = exec.results[out.id];
        if (!result) return '';
        return getResultUrl(result, engine, mintConfig) || '';
      });
      const inVals = inputs.map((inp) => {
        const res = exec.bindings[inp.id] as { url?: string; location?: string } | null;
        return res?.url ?? res?.location ?? '';
      });
      const paramVals = params.map((p) => {
        let v = exec.bindings[p.id] as string | null;
        if (!v) v = paramDefaults[p.id] ?? null;
        if (v?.startsWith('__region_geojson')) v = 'Region GeoJSON';
        return v ?? '';
      });
      return [...outVals, ...inVals, ...paramVals].join(',');
    });

    const csv = [headers, ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'results.csv';
    a.click();
    URL.revokeObjectURL(url);
  }

  // ─ Guard ────────────────────────────────────────────────────────────────
  if (!paramsDone) {
    return (
      <div data-testid="mint-results">
        <p className="mb-2 text-sm text-gray-600">This step is for monitoring model results.</p>
        <p className="text-sm text-gray-500">Please setup and run some models first.</p>
      </div>
    );
  }

  return (
    <div data-testid="mint-results">
      <ul className="space-y-3">
        {modelIds.map((mid) => {
          const summary = threadData.execution_summary[mid]!;
          const model = threadData.models[mid];
          if (!model) return null;

          const grouped = executions[mid] ?? { executions: [], loading: false };
          const currentPage = pages[mid] ?? 1;
          const totalPages = Math.ceil((summary.total_runs || 1) / PAGE_SIZE);

          const successfulRuns = summary.successful_runs ?? 0;
          const failedRuns = summary.failed_runs ?? 0;
          const submittedRuns = summary.submitted_runs ?? 0;
          const finishedRuns = successfulRuns + failedRuns;
          const submitted = summary.submitted_for_execution || summary.submission_time;
          const finished = finishedRuns >= summary.total_runs && summary.total_runs > 0;
          const submittedPublishing = !!summary.submitted_for_publishing;
          const submittedIngestion = !!summary.submitted_for_ingestion;
          const finishedIngestion = (summary.ingested_runs ?? 0) >= summary.total_runs;
          const run = unifiedRuns?.[mid];

          if (!submitted) {
            return (
              <li key={mid} className="rounded-md border px-4 py-3">
                <h4 className="mb-1 text-sm font-medium">{model.name}</h4>
                <p className="text-sm text-gray-500">
                  Not run yet. Send this model's runs from the Runs step.
                </p>
              </li>
            );
          }

          const status = aggregateRunStatus({
            totalRuns: summary.total_runs,
            submittedRuns,
            successfulRuns,
            failedRuns,
            fallbackStatus: run?.status ?? grouped.executions[0]?.status?.toLowerCase(),
          });
          const isSingleRun = summary.total_runs <= 1;
          const open = cardOpen[mid] ?? true;

          // Determine which outputs to show
          const allOutputs = model.output_files;
          const matching = allOutputs.filter((o) =>
            matchVariables(threadData.response_variables, o.variables),
          );
          const shownOutputs = showAllOutputs ? allOutputs : matching;
          const hasExtraOutputs = matching.length > 0 && matching.length < allOutputs.length;

          // Filter executions with results
          const executionsWithResults = grouped.executions.filter(
            (e) => Object.keys(e.results).length > 0,
          );
          const groupedByKey: Record<string, Execution> = {};
          executionsWithResults.forEach((e) => {
            groupedByKey[e.id] = e;
          });

          const adjustableInputs = model.input_files.filter((f) => !f.value);
          const settableParams = userParameters(model).filter((p) => !p.value);
          const { varying: varyingParams, common: sameParams } = splitRunParams(
            settableParams,
            executionsWithResults,
          );
          const resultExecution = executionsWithResults[0];

          const refresh =
            finished && onPublishResults
              ? () => void handlePublish(mid)
              : () => onFetchRuns(mid, currentPage, PAGE_SIZE);

          return (
            <li key={mid}>
              <CollapsibleCard
                testId={`result-card-${mid}`}
                open={open}
                onOpenChange={(next) => setCardOpen((current) => ({ ...current, [mid]: next }))}
                title={model.name}
                summary={
                  <span className={`rounded px-2 py-0.5 ${statusPillClasses(status)}`}>
                    {displayStatusLabel(status)}
                  </span>
                }
              >
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    data-testid={`refresh-results-${mid}`}
                    onClick={refresh}
                    disabled={publishWaiting[mid]}
                    className="flex items-center gap-1 rounded border px-2 py-1 text-xs hover:bg-gray-50 disabled:opacity-50"
                  >
                    <RefreshCw className={`h-3 w-3 ${publishWaiting[mid] ? 'animate-spin' : ''}`} />
                    Refresh
                  </button>
                  {!isSingleRun && !grouped.loading && Object.keys(groupedByKey).length > 0 && (
                    <button
                      type="button"
                      data-testid={`download-csv-${mid}`}
                      onClick={() =>
                        handleDownloadCsv(
                          groupedByKey,
                          shownOutputs,
                          adjustableInputs.map((f) => ({ id: f.id, name: f.name ?? '' })),
                          settableParams.map((p) => ({
                            id: p.id ?? '',
                            name: p.name ?? '',
                            default: p.default,
                          })),
                          grouped.executions[0]?.execution_engine,
                        )
                      }
                      className="flex items-center gap-1 rounded border px-2 py-1 text-xs hover:bg-gray-50"
                    >
                      <Download className="h-3 w-3" />
                      CSV
                    </button>
                  )}
                  {!isSingleRun && hasExtraOutputs && (
                    <button
                      type="button"
                      onClick={() => setShowAllOutputs((v) => !v)}
                      className="text-xs text-blue-600 hover:underline"
                    >
                      {showAllOutputs ? 'Hide extra outputs' : 'Show all outputs'}
                    </button>
                  )}
                  {submittedPublishing && !finished && (
                    <span className="text-xs text-gray-500">
                      Publishing… {summary.published_runs ?? 0}/{summary.total_runs} runs.
                    </span>
                  )}
                  {ingestionApiAvailable && finished && !submittedIngestion && canWrite && (
                    <button
                      type="button"
                      data-testid={`ingest-results-${mid}`}
                      onClick={() => onIngestResults?.(mid)}
                      className="rounded bg-green-600 px-2 py-1 text-xs text-white hover:bg-green-700"
                    >
                      Save all results
                    </button>
                  )}
                  {submittedIngestion && !finishedIngestion && (
                    <span className="text-xs text-gray-500">
                      Saving… fetched {summary.fetched_run_outputs ?? 0}/{summary.total_runs},
                      ingested {summary.ingested_runs ?? 0}/{summary.total_runs}.
                    </span>
                  )}
                </div>

                {publishErrorCode[mid] === NO_OUTPUTS_DECLARED ? (
                  <div
                    role="alert"
                    data-testid={`publish-error-${mid}`}
                    className="space-y-1 rounded border border-orange-200 bg-orange-50 px-2 py-1.5"
                  >
                    <p className="text-xs text-orange-800">
                      This model configuration declares no output, so there is nothing to publish. A
                      Tapis application does not declare its output files. Open a finished run and
                      promote the files that are results.
                    </p>
                    {onPromoteOutputs && (
                      <button
                        type="button"
                        data-testid={`promote-outputs-${mid}`}
                        onClick={onPromoteOutputs}
                        className="rounded bg-orange-600 px-2 py-0.5 text-xs text-white hover:bg-orange-700"
                      >
                        Choose output files
                      </button>
                    )}
                  </div>
                ) : (
                  publishError[mid] && (
                    <p
                      role="alert"
                      data-testid={`publish-error-${mid}`}
                      className="text-xs text-red-600"
                    >
                      {publishError[mid]}
                    </p>
                  )
                )}

                {/* A run that has not finished says where it is, and what to do. */}
                {status === 'paused' && (
                  <div
                    className="flex flex-wrap items-center gap-2 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-950"
                    data-testid={`result-paused-${mid}`}
                  >
                    <span className="font-medium">Waiting for your edit</span>
                    {onOpenRuns && (
                      <button
                        type="button"
                        data-testid={`open-runs-${mid}`}
                        onClick={onOpenRuns}
                        className="rounded border border-amber-400 bg-white px-2 py-1 font-medium hover:bg-amber-100"
                      >
                        Go to Runs to edit and resume
                      </button>
                    )}
                  </div>
                )}
                {(status === 'running' || status === 'completing' || status === 'waiting') && (
                  <p
                    className="flex items-center gap-2 text-xs text-gray-700"
                    data-testid={`result-running-${mid}`}
                  >
                    <span className="h-3 w-3 animate-spin rounded-full border-2 border-blue-600 border-t-transparent" />
                    {status === 'waiting' ? 'Waiting to start' : 'Running'}
                    {!isSingleRun && ` — ${finishedRuns} of ${summary.total_runs} finished`}
                  </p>
                )}
                {(status === 'failed' || status === 'cancelled') && (
                  <RunFailureNotice
                    run={run}
                    cancelled={status === 'cancelled'}
                    stepErrors={
                      !isSingleRun && failedRuns > 0
                        ? [`${failedRuns} of ${summary.total_runs} runs failed.`]
                        : []
                    }
                    onRestart={onRestartRuns ? () => void handleRestart(mid) : undefined}
                    restarting={restarting[mid]}
                    problem={
                      restartError[mid] ? (
                        <p className="text-red-700" data-testid={`restart-error-${mid}`}>
                          {restartError[mid]}
                        </p>
                      ) : undefined
                    }
                    testId={`result-failure-${mid}`}
                  />
                )}

                <RunAnswerCard result={run?.output_handoff?.result} label="Modeled spring flow" />
                {run?.replacement && <EditedInputNote replacement={run.replacement} />}

                {isSingleRun ? (
                  <>
                    {resultExecution ? (
                      <ul className="space-y-2" data-testid={`outputs-${mid}`}>
                        {shownOutputs.map((out) => {
                          const result = resultExecution.results[out.id];
                          if (!result) return null;
                          const url = getResultUrl(
                            result,
                            resultExecution.execution_engine,
                            mintConfig,
                          );
                          return (
                            <OutputBlock
                              key={out.id}
                              ensembleManagerApi={ensembleManagerApi}
                              executionId={resultExecution.id}
                              label={humanizeName(out.name)}
                              format={out.format}
                              name={getResultName(result)}
                              url={url}
                              scheme={resultScheme(url)}
                              onOpenFolder={(executionId) =>
                                setFilesFor({ executionId, modelId: mid })
                              }
                            />
                          );
                        })}
                      </ul>
                    ) : grouped.loading ? (
                      <div className="flex items-center justify-center py-4">
                        <span className="h-6 w-6 animate-spin rounded-full border-2 border-blue-600 border-t-transparent" />
                      </div>
                    ) : (
                      status === 'completed' && (
                        <p className="text-xs text-gray-500" data-testid={`no-results-${mid}`}>
                          No results yet. Use Refresh to fetch them.
                        </p>
                      )
                    )}
                    {resultExecution && (
                      <details className="text-xs text-gray-700" data-testid={`how-made-${mid}`}>
                        <summary className="cursor-pointer font-medium text-gray-800">
                          How this was made
                        </summary>
                        <div className="mt-2 space-y-2">
                          {adjustableInputs.length > 0 && (
                            <dl className="grid gap-x-4 gap-y-1 sm:grid-cols-[max-content_1fr]">
                              {adjustableInputs.map((inp) => (
                                <div key={inp.id} className="contents">
                                  <dt className="text-gray-500">{humanizeName(inp.name)}</dt>
                                  <dd>
                                    <InputBinding binding={resultExecution.bindings[inp.id]} />
                                  </dd>
                                </div>
                              ))}
                            </dl>
                          )}
                          <SettingsUsed
                            params={settableParams}
                            execution={resultExecution}
                            testId={`results-settings-${mid}`}
                          />
                        </div>
                      </details>
                    )}
                  </>
                ) : (
                  <div className="space-y-2">
                    {totalPages > 1 && !grouped.loading && (
                      <div className="flex items-center gap-2 text-xs">
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
                      </div>
                    )}
                    <SameForEveryRun items={sameParams} testId={`results-same-${mid}`} />
                    <ResultsTable
                      modelId={mid}
                      loading={grouped.loading}
                      outputs={shownOutputs}
                      inputs={adjustableInputs}
                      params={varyingParams}
                      executions={Object.values(groupedByKey)}
                      mintConfig={mintConfig}
                      ensembleManagerApi={ensembleManagerApi}
                      onOpenFolder={(executionId) => setFilesFor({ executionId, modelId: mid })}
                    />
                  </div>
                )}
              </CollapsibleCard>
            </li>
          );
        })}
      </ul>

      {filesFor && (
        <ExecutionFilesDialog
          open
          executionId={filesFor.executionId}
          configurationId={filesFor.modelId}
          declaredOutputLabels={(threadData.models[filesFor.modelId]?.output_files ?? []).map(
            (o) => o.name,
          )}
          ensembleManagerApi={ensembleManagerApi}
          canWrite={false}
          onClose={() => setFilesFor(null)}
        />
      )}

      {/* Footer continue button */}
      <div className="mt-4 flex justify-end">
        <button
          type="button"
          data-testid="results-continue-btn"
          onClick={onContinue}
          className="rounded bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700"
        >
          Continue
        </button>
      </div>
    </div>
  );
}

/** The runs of a model that ran more than once, one row each: its outputs, then what differs. */
function ResultsTable({
  modelId,
  loading,
  outputs,
  inputs,
  params,
  executions,
  mintConfig,
  ensembleManagerApi,
  onOpenFolder,
}: {
  modelId: string;
  loading: boolean;
  outputs: ModelOutputFile[];
  inputs: Array<{ id: string; name?: string | null }>;
  params: Array<{ id?: string | null; name?: string | null; default?: string | null }>;
  executions: Execution[];
  mintConfig: MintResultsProps['mintConfig'];
  ensembleManagerApi: string;
  onOpenFolder: (executionId: string) => void;
}) {
  return (
    <div className="max-h-96 overflow-auto border border-gray-200">
      {loading ? (
        <div className="flex items-center justify-center py-8">
          <span className="h-6 w-6 animate-spin rounded-full border-2 border-blue-600 border-t-transparent" />
        </div>
      ) : (
        <table className="w-full border-collapse text-xs" data-testid={`results-table-${modelId}`}>
          <thead className="sticky top-0 bg-gray-100">
            <tr>
              {outputs.length > 0 && (
                <th colSpan={outputs.length} className="px-2 py-1 text-left font-semibold" id="out">
                  Outputs
                </th>
              )}
              {inputs.length > 0 && (
                <th colSpan={inputs.length} className="px-2 py-1 text-left font-semibold" id="in">
                  Inputs
                </th>
              )}
              {params.length > 0 && (
                <th
                  colSpan={params.length}
                  className="px-2 py-1 text-left font-semibold"
                  id="param"
                >
                  Parameters
                </th>
              )}
            </tr>
            <tr>
              {outputs.map((o) => (
                <th key={o.id} className="px-2 py-1 font-medium">
                  {humanizeName(o.name)}
                </th>
              ))}
              {inputs.map((f) => (
                <th key={f.id} className="px-2 py-1 font-medium">
                  {humanizeName(f.name)}
                </th>
              ))}
              {params.map((p) => (
                <th key={p.id} className="px-2 py-1 font-medium">
                  {humanizeName(p.name)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {executions.length === 0 ? (
              <tr>
                <td
                  colSpan={outputs.length + inputs.length + params.length + 1}
                  className="px-2 py-4 text-center text-gray-400"
                >
                  — No results available —
                </td>
              </tr>
            ) : (
              executions.map((execution) => (
                <tr key={execution.id} className="odd:bg-white even:bg-gray-50">
                  {outputs.map((out) => {
                    const result = execution.results[out.id];
                    if (!result)
                      return (
                        <td key={out.id} className="px-2 py-1">
                          —
                        </td>
                      );
                    const url = getResultUrl(result, execution.execution_engine, mintConfig);
                    const fname = getResultName(result);
                    return (
                      <td key={out.id} className="px-2 py-1">
                        {!url ? (
                          <span className="text-gray-400">{fname || 'No file'}</span>
                        ) : resultScheme(url) === 'tapis' ? (
                          <TapisResult
                            ensembleManagerApi={ensembleManagerApi}
                            executionId={execution.id}
                            name={fname}
                            url={url}
                            onOpenFolder={onOpenFolder}
                          />
                        ) : resultScheme(url) === 'web' ? (
                          <a
                            href={url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-blue-600 hover:underline"
                          >
                            {fname}
                          </a>
                        ) : (
                          <span data-testid="result-text">{fname}</span>
                        )}
                      </td>
                    );
                  })}
                  {inputs.map((inp) => (
                    <td key={inp.id} className="px-2 py-1">
                      <InputBinding binding={execution.bindings[inp.id]} />
                    </td>
                  ))}
                  {params.map((param) => (
                    <td key={param.id} className="px-2 py-1">
                      {runParamValue(param, execution)}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      )}
    </div>
  );
}
