/**
 * MintResults — Browse and download execution results.
 *
 * 1:1 port of the legacy LitElement MintResults component.
 * Shows a paginated table of completed execution outputs, supports CSV download,
 * and triggers ingestion/publishing workflows.
 *
 * Legacy: ui/src/screens/modeling/thread/mint-results.ts
 */
import { userParameters } from '@/lib/secret-parameters';
import { Download, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import {
  Execution,
  ExecutionResult,
  ModelExecutionsMap,
  ModelOutputFile,
  ThreadExecutionData,
} from '@/graphql/generated/execution';
import { RunAnswerCard } from '@/components/modeling/runs/RunAnswerCard';
import {
  EnsembleManagerError,
  NO_OUTPUTS_DECLARED,
  type UnifiedRunSnapshot,
} from '@/lib/ensemble-manager';

// ─── Helpers ──────────────────────────────────────────────────────────────────

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
  unifiedRuns,
}: MintResultsProps) {
  const modelIds = Object.keys(threadData.execution_summary ?? {});

  const paramsDone =
    modelIds.length > 0 &&
    modelIds.every((mid) => {
      const s = threadData.execution_summary[mid];
      return s && (s.submitted_for_execution || s.submission_time);
    });

  const [pages, setPages] = useState<Record<string, number>>({});
  const [showAllOutputs, setShowAllOutputs] = useState(true);
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
      <p className="mb-2 text-sm text-gray-600">
        This step is for browsing the results of the models that you ran earlier.
      </p>
      <h3 className="mb-3 text-sm font-semibold">Results</h3>

      <ul className="space-y-4">
        {modelIds.map((mid) => {
          const summary = threadData.execution_summary[mid]!;
          const model = threadData.models[mid];
          if (!model) return null;

          const grouped = executions[mid] ?? { executions: [], loading: false };
          const currentPage = pages[mid] ?? 1;
          const totalPages = Math.ceil((summary.total_runs || 1) / PAGE_SIZE);

          const finishedRuns = (summary.successful_runs ?? 0) + (summary.failed_runs ?? 0);
          const submitted = summary.submitted_for_execution || summary.submission_time;
          const finished = finishedRuns >= summary.total_runs && summary.total_runs > 0;
          const runningRuns = (summary.submitted_runs ?? 0) - finishedRuns;
          const pendingRuns = summary.total_runs - (summary.submitted_runs ?? 0);
          const publishedAll = (summary.published_runs ?? 0) >= (summary.successful_runs ?? 0);
          const submittedPublishing = !!summary.submitted_for_publishing;
          const submittedIngestion = !!summary.submitted_for_ingestion;
          const finishedIngestion = (summary.ingested_runs ?? 0) >= summary.total_runs;

          if (!submitted) {
            return (
              <li key={mid} className="rounded-md border px-4 py-3">
                <h4 className="mb-1 text-sm font-medium">{model.name}</h4>
                <p className="text-sm text-gray-500">Please execute some runs first.</p>
              </li>
            );
          }

          // Determine which outputs to show
          const allOutputs = model.output_files;
          let shownOutputs = allOutputs;
          if (!showAllOutputs) {
            shownOutputs = allOutputs.filter((o) =>
              matchVariables(threadData.response_variables, o.variables),
            );
          }
          const hasExtraOutputs = shownOutputs.length < allOutputs.length;

          // Filter executions with results
          const executionsWithResults = grouped.executions.filter(
            (e) => Object.keys(e.results).length > 0,
          );
          const groupedByKey: Record<string, Execution> = {};
          executionsWithResults.forEach((e) => {
            groupedByKey[e.id] = e;
          });

          const adjustableInputs = model.input_files.filter((f) => !f.value);
          const adjustableParams = userParameters(model).filter((p) => !p.value);

          return (
            <li key={mid} className="overflow-hidden rounded-md border">
              <div className="border-b bg-gray-50 px-4 py-2 text-sm font-medium">{model.name}</div>
              <div className="space-y-2 px-4 py-3">
                <RunAnswerCard
                  result={unifiedRuns?.[mid]?.output_handoff?.result}
                  label="Modeled spring flow"
                />
                {submitted && (
                  <>
                    <p className="text-sm text-gray-600">
                      Below are results of all successfully completed model executions.
                    </p>
                    <p className="text-sm text-gray-600">
                      {summary.total_runs} runs required. {!finished ? 'So far, ' : ''}
                      {summary.submitted_runs} submitted, {summary.successful_runs} succeeded,{' '}
                      <span className={(summary.failed_runs ?? 0) > 0 ? 'text-red-600' : ''}>
                        {summary.failed_runs} failed
                      </span>
                      . {runningRuns > 0 && `${runningRuns} running`}
                      {runningRuns > 0 && pendingRuns > 0 && ', '}
                      {pendingRuns > 0 && `${pendingRuns} waiting`}
                    </p>
                  </>
                )}

                {/* Action buttons */}
                <div className="flex flex-wrap gap-2">
                  {finished && (
                    <button
                      type="button"
                      data-testid={`fetch-results-${mid}`}
                      onClick={() => void handlePublish(mid)}
                      disabled={publishWaiting[mid]}
                      className="rounded bg-blue-600 px-3 py-1.5 text-xs text-white hover:bg-blue-700 disabled:opacity-50"
                    >
                      {publishedAll ? 'Refresh results' : 'Fetch results'}
                    </button>
                  )}
                  {submittedPublishing && !finished && (
                    <p className="text-xs text-gray-500">
                      Publishing… {summary.published_runs ?? 0}/{summary.total_runs} runs.
                    </p>
                  )}
                  {ingestionApiAvailable && finished && !submittedIngestion && canWrite && (
                    <button
                      type="button"
                      data-testid={`ingest-results-${mid}`}
                      onClick={() => onIngestResults?.(mid)}
                      className="rounded bg-green-600 px-3 py-1.5 text-xs text-white hover:bg-green-700"
                    >
                      Save all results
                    </button>
                  )}
                  {submittedIngestion && !finishedIngestion && (
                    <p className="text-xs text-gray-500">
                      Saving… fetched {summary.fetched_run_outputs ?? 0}/{summary.total_runs},
                      ingested {summary.ingested_runs ?? 0}/{summary.total_runs}.
                    </p>
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

                {/* Pagination + controls */}
                <div className="flex flex-wrap items-center gap-2 border border-gray-200 px-2 py-1 text-xs">
                  {!grouped.loading && (
                    <>
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
                    </>
                  )}

                  {(hasExtraOutputs || showAllOutputs) && !grouped.loading && (
                    <button
                      type="button"
                      onClick={() => setShowAllOutputs((s) => !s)}
                      className="text-blue-600 hover:underline"
                    >
                      [{showAllOutputs ? 'Hide extra outputs' : 'Show all outputs'}]
                    </button>
                  )}

                  <div className="ml-auto flex items-center gap-2">
                    {!grouped.loading && Object.keys(groupedByKey).length > 0 && (
                      <button
                        type="button"
                        data-testid={`download-csv-${mid}`}
                        onClick={() =>
                          handleDownloadCsv(
                            groupedByKey,
                            shownOutputs,
                            adjustableInputs.map((f) => ({ id: f.id, name: f.name ?? '' })),
                            adjustableParams.map((p) => ({
                              id: p.id ?? '',
                              name: p.name ?? '',
                              default: p.default,
                            })),
                            grouped.executions[0]?.execution_engine,
                          )
                        }
                        className="flex items-center gap-1 rounded border px-2 py-0.5 hover:bg-gray-50"
                      >
                        <Download className="h-3 w-3" />
                        CSV
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => onFetchRuns(mid, currentPage, PAGE_SIZE)}
                      className="flex items-center gap-1 rounded border px-2 py-0.5 hover:bg-gray-50"
                    >
                      <RefreshCw className="h-3 w-3" />
                      Reload
                    </button>
                  </div>
                </div>

                {/* Results table */}
                <div className="max-h-96 overflow-auto border border-gray-200">
                  {grouped.loading ? (
                    <div className="flex items-center justify-center py-8">
                      <span className="h-6 w-6 animate-spin rounded-full border-2 border-blue-600 border-t-transparent" />
                    </div>
                  ) : (
                    <table
                      className="w-full border-collapse text-xs"
                      data-testid={`results-table-${mid}`}
                    >
                      <thead className="sticky top-0 bg-gray-100">
                        <tr>
                          {shownOutputs.length > 0 && (
                            <th
                              colSpan={shownOutputs.length}
                              className="px-2 py-1 text-left font-semibold"
                              id="out"
                            >
                              Outputs
                            </th>
                          )}
                          {adjustableInputs.length > 0 && (
                            <th
                              colSpan={adjustableInputs.length}
                              className="px-2 py-1 text-left font-semibold"
                              id="in"
                            >
                              Inputs
                            </th>
                          )}
                          {adjustableParams.length > 0 && (
                            <th
                              colSpan={adjustableParams.length}
                              className="px-2 py-1 text-left font-semibold"
                              id="param"
                            >
                              Parameters
                            </th>
                          )}
                        </tr>
                        <tr>
                          {shownOutputs.map((o) => (
                            <th key={o.id} className="px-2 py-1 font-medium">
                              {(o.name ?? '').replace(/[-_]/g, ' ')}
                            </th>
                          ))}
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
                        {Object.keys(groupedByKey).length === 0 ? (
                          <tr>
                            <td
                              colSpan={
                                shownOutputs.length +
                                adjustableInputs.length +
                                adjustableParams.length +
                                1
                              }
                              className="px-2 py-4 text-center text-gray-400"
                            >
                              — No results available —
                            </td>
                          </tr>
                        ) : (
                          Object.values(groupedByKey).map((execution) => {
                            const paramDefaults: Record<string, string | null | undefined> = {};
                            userParameters(model).forEach(
                              (p) => (paramDefaults[p.id ?? ''] = p.default ?? null),
                            );
                            return (
                              <tr key={execution.id} className="odd:bg-white even:bg-gray-50">
                                {shownOutputs.map((out) => {
                                  const result = execution.results[out.id];
                                  if (!result)
                                    return (
                                      <td key={out.id} className="px-2 py-1">
                                        —
                                      </td>
                                    );
                                  const url = getResultUrl(
                                    result,
                                    execution.execution_engine,
                                    mintConfig,
                                  );
                                  const fname = getResultName(result);
                                  return (
                                    <td key={out.id} className="px-2 py-1">
                                      {url ? (
                                        <a
                                          href={url}
                                          target="_blank"
                                          rel="noopener noreferrer"
                                          className="text-blue-600 hover:underline"
                                        >
                                          {fname}
                                        </a>
                                      ) : (
                                        <span className="text-gray-400">{fname || 'No file'}</span>
                                      )}
                                    </td>
                                  );
                                })}
                                {adjustableInputs.map((inp) => {
                                  const res = execution.bindings[inp.id ?? ''] as {
                                    url?: string;
                                    name?: string;
                                  } | null;
                                  return (
                                    <td key={inp.id} className="px-2 py-1">
                                      {res?.url ? (
                                        <a
                                          href={res.url}
                                          target="_blank"
                                          rel="noopener noreferrer"
                                          className="text-blue-600 hover:underline"
                                        >
                                          {res.name ?? res.url}
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
                                  if (!pval) pval = paramDefaults[param.id ?? ''];
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
            </li>
          );
        })}
      </ul>

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
