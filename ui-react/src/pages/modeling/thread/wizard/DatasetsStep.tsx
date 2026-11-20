import { useCallback, useEffect, useMemo, useState } from 'react';
import { Search } from 'lucide-react';

import {
  Thread,
  getUserPermission,
  useInsertThreadProvenanceMutation,
  useUpdateThreadMutation,
  useUpdateThreadDataMutation,
} from '@/graphql/generated/modeling';
import type {
  ModelEnsembleMap,
  ThreadExecutionData,
  ThreadModel,
} from '@/graphql/generated/execution';
import { useDataCatalogDatasets } from '@/hooks/useDataCatalog';
import type {
  DataCatalogDataset,
  DataCatalogResource,
  DataCatalogTimePeriod,
} from '@/lib/data-catalog';
import { loadDatasetResources } from '@/lib/data-catalog';
import {
  buildThreadDataInsert,
  collectionDefaultSelection,
  newDatasliceId,
  type ThreadDataInsert,
} from '@/lib/thread-datasets';
import { useAuth } from '@/lib/auth/useAuth';
import { useToast } from '@/components/ui/use-toast';
import { DatasetSpatialMap } from '@/components/datasets/DatasetSpatialMap';
import { boundingBoxesOverlap, type BoundingBox } from '@/lib/geo/bbox';
import { spatialCoverageBoundingBox } from '@/lib/datasets/spatial';
import { cn } from '@/lib/utils';
import { StepShell } from './StepShell';
import { COLLECTION_EXPLANATION, CollectionFiles } from './CollectionFiles';
import { FilteredByBanner } from './FilteredByBanner';

interface RequestedRange {
  start: Date;
  end: Date;
}

export type DateCoverage = 'none' | 'full' | 'partial' | 'outside' | 'unknown';
type CoverageFilter = Exclude<DateCoverage, 'none'> | 'all';

/**
 * A dataset bound to one model input.
 *
 * `resources` is present when the binding was read back from Hasura — the
 * dataslice already holds the exact files that were bound, so re-saving it does
 * not have to ask the catalog again. A freshly picked dataset leaves it unset
 * and the files are fetched at save time.
 */
interface Assignment {
  datasetId: string;
  datasetName: string;
  timePeriod?: DataCatalogTimePeriod | null;
  spatialCoverage?: DataCatalogDataset['spatial_coverage'];
  resources?: DataCatalogResource[];
}

/** Metadata from a selected dataset used to constrain the other inputs. */
export type DatasetCompatibilityContext = Pick<
  Assignment,
  'datasetId' | 'datasetName' | 'timePeriod' | 'spatialCoverage'
>;

/** Classify a dataset's temporal coverage against the requested window. */
export function dateCoverage(
  requested: RequestedRange | null,
  period: { start: Date | null; end: Date | null } | null,
): DateCoverage {
  if (!requested) return 'none';
  const start = validDate(period?.start);
  const end = validDate(period?.end);
  if (!start && !end) return 'unknown';

  // Bounds are inclusive: a dataset ending on the model start date overlaps it.
  if (end && end < requested.start) return 'outside';
  if (start && start > requested.end) return 'outside';
  if (!start || !end) return 'unknown';

  const covered = start <= requested.start && end >= requested.end;
  return covered ? 'full' : 'partial';
}

function validDate(value: Date | null | undefined): Date | null {
  return value && !Number.isNaN(value.getTime()) ? value : null;
}

/**
 * Find the date window shared by every selected archive. A range is only
 * returned when each archive declares both bounds, because an open-ended or
 * missing bound cannot safely constrain a model run.
 */
export function archiveDateRange(
  periods: Array<DataCatalogTimePeriod | null | undefined>,
): RequestedRange | null {
  const bounds = periods.map((period) => ({
    start: validDate(period?.start_date),
    end: validDate(period?.end_date),
  }));
  if (bounds.length === 0 || bounds.some(({ start, end }) => !start || !end)) return null;

  const start = new Date(Math.max(...bounds.map(({ start }) => start!.getTime())));
  const end = new Date(Math.min(...bounds.map(({ end }) => end!.getTime())));
  return start < end ? { start, end } : null;
}

/** Map a Data Catalog time period onto the {start,end} shape dateCoverage expects. */
function toPeriod(
  tp: DataCatalogTimePeriod | null | undefined,
): { start: Date | null; end: Date | null } | null {
  if (!tp) return null;
  return { start: tp.start_date, end: tp.end_date };
}

function coverageForDataset(
  ds: Pick<DataCatalogDataset, 'time_period'>,
  requested: RequestedRange | null,
): DateCoverage {
  return dateCoverage(requested, toPeriod(ds.time_period));
}

function coverageLabel(coverage: DateCoverage): string {
  switch (coverage) {
    case 'full':
      return 'Full coverage';
    case 'partial':
      return 'Partial overlap';
    case 'outside':
      return 'Outside model window';
    case 'unknown':
      return 'No declared dates';
    default:
      return 'Target dates unavailable';
  }
}

function periodLabel(period: DataCatalogTimePeriod | null | undefined): string {
  const start = validDate(period?.start_date);
  const end = validDate(period?.end_date);
  if (!start && !end) return 'No declared dates';
  return `${start ? start.getUTCFullYear() : 'Open'} – ${end ? end.getUTCFullYear() : 'Open'}`;
}

function datasetMatchesSearch(dataset: DataCatalogDataset, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  const haystack = [
    dataset.name,
    dataset.description,
    dataset.version,
    dataset.source.name,
    dataset.datatype,
    ...dataset.variables,
    ...(dataset.categories ?? []),
  ]
    .join(' ')
    .toLowerCase();
  return haystack.includes(needle);
}

function coverageMatchesFilter(coverage: DateCoverage, filter: CoverageFilter): boolean {
  return filter === 'all' || coverage === filter;
}

function timelineDomain(
  datasets: DataCatalogDataset[],
  requested: RequestedRange | null,
): { start: number; end: number } {
  const dates = datasets.flatMap((dataset) => {
    const start = validDate(dataset.time_period?.start_date)?.getTime();
    const end = validDate(dataset.time_period?.end_date)?.getTime();
    return [start, end].filter((value): value is number => value !== undefined);
  });
  if (requested) dates.push(requested.start.getTime(), requested.end.getTime());

  const start = Math.min(...dates);
  const end = Math.max(...dates);
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    const year = new Date().getUTCFullYear();
    return { start: Date.UTC(year, 0, 1), end: Date.UTC(year + 1, 0, 1) };
  }
  if (start === end) return { start, end: end + 24 * 60 * 60 * 1000 };
  return { start, end };
}

function timelinePercent(value: number, domain: { start: number; end: number }): number {
  return Math.max(0, Math.min(100, ((value - domain.start) / (domain.end - domain.start)) * 100));
}

const MAX_TIMELINE_TICKS = 16;

function timelineTickStep(span: number): number {
  const rawStep = Math.max(1, span / (MAX_TIMELINE_TICKS - 1));
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const normalized = rawStep / magnitude;
  const niceNormalized = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return Math.max(1, niceNormalized * magnitude);
}

function nextTimelineTickStep(step: number): number {
  const magnitude = 10 ** Math.floor(Math.log10(step));
  const normalized = step / magnitude;
  const nextNormalized = normalized <= 1 ? 2 : normalized <= 2 ? 5 : 10;
  return nextNormalized * magnitude;
}

function timelineTickYears(startYear: number, endYear: number, step: number): number[] {
  const years = new Set<number>([startYear]);
  const firstAlignedYear = Math.ceil(startYear / step) * step;
  for (let year = firstAlignedYear; year <= endYear; year += step) {
    years.add(year);
  }
  years.add(endYear);
  return [...years].sort((a, b) => a - b);
}

export function timelineTicks(domain: { start: number; end: number }): number[] {
  const startYear = new Date(domain.start).getUTCFullYear();
  const endYear = new Date(domain.end).getUTCFullYear();
  const span = Math.max(1, endYear - startYear);
  let step = timelineTickStep(span);
  let years = timelineTickYears(startYear, endYear, step);
  while (years.length > MAX_TIMELINE_TICKS) {
    step = nextTimelineTickStep(step);
    years = timelineTickYears(startYear, endYear, step);
  }
  return years.map((year) => Date.UTC(year, 0, 1));
}

/**
 * Bindings already written for this thread, as the assignment map the step
 * renders: model id -> input id -> the dataset behind the bound dataslice.
 */
export function assignmentsFromBindings(
  ensembles: ModelEnsembleMap,
  data: ThreadExecutionData['data'],
): Record<string, Record<string, Assignment>> {
  const out: Record<string, Record<string, Assignment>> = {};
  for (const [modelId, ensemble] of Object.entries(ensembles ?? {})) {
    for (const [inputId, sliceIds] of Object.entries(ensemble.bindings ?? {})) {
      const slice = data?.[sliceIds[0] ?? ''];
      // A parameter binding shares this map and has no dataslice behind it.
      if (!slice) continue;
      const dataset = slice['dataset'] as { id: string; name: string } | undefined;
      if (!dataset) continue;
      (out[modelId] ??= {})[inputId] = {
        datasetId: dataset.id,
        datasetName: dataset.name,
        resources: (slice['resources'] as DataCatalogResource[] | undefined) ?? [],
      };
    }
  }
  return out;
}

interface DatasetsStepProps {
  thread: Thread;
  /** Selected models, keyed by configuration id (from the thread execution query). */
  models: Record<string, ThreadModel>;
  /** Existing bindings, keyed the same way — supplies each model's thread_model id. */
  ensembles: ModelEnsembleMap;
  /** Dataslices already persisted for this thread, keyed by dataslice id. */
  persistedData: ThreadExecutionData['data'];
  regionGeometry?: unknown;
  spatialScopeName?: string | null;
  /** Dataset ids confirmed by guided setup and offered as initial choices. */
  initialDatasetIds?: string[];
  onUpdated: () => void | Promise<void>;
  onContinue: () => void;
  onBack?: () => void;
}

/**
 * How a dataset reads in the picker: its name, plus what is *missing* from it.
 *
 * Missing metadata is stated rather than hidden. A dataset with no declared
 * extent is a candidate — it makes no claim to be elsewhere — but the person
 * choosing it should know the region and date filters could not speak for it.
 */
export function datasetOptionLabel(
  ds: Pick<DataCatalogDataset, 'name' | 'region_match' | 'time_period'>,
  requested: RequestedRange | null,
): string {
  const notes: string[] = [];
  if (ds.region_match === 'unknown') notes.push('! no location');
  if (!ds.time_period) notes.push('! no dates');
  else {
    const cov = dateCoverage(requested, toPeriod(ds.time_period));
    if (cov === 'full') notes.push('dates full');
    else if (cov === 'partial') notes.push('dates partial');
    else if (cov === 'outside') notes.push('dates outside');
    else if (cov === 'unknown') notes.push('dates unknown');
  }
  return notes.length ? `${ds.name} · ${notes.join(' · ')}` : ds.name;
}

/**
 * Split the candidates by what the region filter can say about them.
 *
 * Three buckets, because there are three answers. `outside` is a positive claim
 * — the dataset declares a location and it is not here — and is the only one
 * worth hiding. `unknown` declares nothing, so hiding it would be an assertion
 * the data does not support.
 */
export function splitByRegion(datasets: DataCatalogDataset[]): {
  inRegion: DataCatalogDataset[];
  noLocation: DataCatalogDataset[];
  outside: DataCatalogDataset[];
} {
  return {
    inRegion: datasets.filter((d) => d.region_match === 'inside'),
    noLocation: datasets.filter((d) => d.region_match === 'unknown'),
    outside: datasets.filter((d) => d.region_match === 'outside'),
  };
}

/** Keep datasets with no declared extent visible, but hide known non-overlaps. */
export function matchesSpatialBox(
  dataset: Pick<DataCatalogDataset, 'spatial_coverage'>,
  box: BoundingBox | null,
): boolean {
  if (!box) return true;
  const datasetBox = spatialCoverageBoundingBox(dataset.spatial_coverage);
  return !datasetBox || boundingBoxesOverlap(datasetBox, box);
}

/**
 * A temporal overlap check that treats missing or open-ended bounds as
 * unknown. Unknown metadata stays available because it cannot prove that a
 * candidate is incompatible with the selected dataset.
 */
function temporalCoverageCompatible(
  candidate: DataCatalogTimePeriod | null | undefined,
  selected: DataCatalogTimePeriod | null | undefined,
): boolean {
  const candidateStart = validDate(candidate?.start_date);
  const candidateEnd = validDate(candidate?.end_date);
  const selectedStart = validDate(selected?.start_date);
  const selectedEnd = validDate(selected?.end_date);

  if (candidateEnd && selectedStart && candidateEnd < selectedStart) return false;
  if (selectedEnd && candidateStart && selectedEnd < candidateStart) return false;
  return true;
}

/**
 * Keep a candidate when every selected dataset is spatially and temporally
 * compatible with it. A missing spatial extent or date bound is unknown, not a
 * contradiction, so it remains visible for the user to evaluate.
 */
export function matchesSelectedDatasetContext(
  candidate: Pick<DataCatalogDataset, 'spatial_coverage' | 'time_period'>,
  selectedDatasets: DatasetCompatibilityContext[],
): boolean {
  const candidateBox = spatialCoverageBoundingBox(candidate.spatial_coverage);
  return selectedDatasets.every((selected) => {
    const selectedBox = spatialCoverageBoundingBox(selected.spatialCoverage);
    const spatiallyCompatible =
      !candidateBox || !selectedBox || boundingBoxesOverlap(candidateBox, selectedBox);
    return (
      spatiallyCompatible && temporalCoverageCompatible(candidate.time_period, selected.timePeriod)
    );
  });
}

function coverageBarClass(coverage: DateCoverage, selected: boolean): string {
  const selectedRing = selected ? 'ring-2 ring-blue-500 ring-offset-1' : '';
  switch (coverage) {
    case 'full':
      return `bg-emerald-500 ${selectedRing}`;
    case 'partial':
      return `bg-amber-400 ${selectedRing}`;
    case 'outside':
      return `bg-slate-300 ${selectedRing}`;
    default:
      return selectedRing;
  }
}

/** Required inputs come first, then optional inputs, alphabetically by name. */
export function sortModelInputs(inputs: ThreadModel['input_files']): ThreadModel['input_files'] {
  return [...inputs].sort((a, b) => {
    const optionalOrder = Number(Boolean(a.isOptional)) - Number(Boolean(b.isOptional));
    if (optionalOrder !== 0) return optionalOrder;

    const aName = a.name?.trim() || a.id;
    const bName = b.name?.trim() || b.id;
    const nameOrder = aName.localeCompare(bName, undefined, { sensitivity: 'base' });
    if (nameOrder !== 0) return nameOrder;

    const exactNameOrder = aName.localeCompare(bName);
    return exactNameOrder !== 0 ? exactNameOrder : a.id.localeCompare(b.id);
  });
}

function inputCardKey(modelId: string, inputId: string): string {
  return `${modelId}:${inputId}`;
}

function inputCardPanelId(modelId: string, inputId: string): string {
  return `dataset-input-panel-${encodeURIComponent(inputCardKey(modelId, inputId))}`;
}

function DatasetCoverageTimeline({
  datasets,
  allCandidates,
  requested,
  assignedId,
  onAssign,
}: {
  datasets: DataCatalogDataset[];
  allCandidates: DataCatalogDataset[];
  requested: RequestedRange | null;
  assignedId: string | null;
  onAssign: (datasetId: string, dataset: DataCatalogDataset) => void;
}) {
  const domain = timelineDomain(allCandidates, requested);
  const ticks = timelineTicks(domain);
  const counts = allCandidates.reduce<Record<string, number>>((acc, dataset) => {
    const coverage = coverageForDataset(dataset, requested);
    acc[coverage] = (acc[coverage] ?? 0) + 1;
    return acc;
  }, {});
  const targetLeft = requested ? timelinePercent(requested.start.getTime(), domain) : null;
  const targetRight = requested ? timelinePercent(requested.end.getTime(), domain) : null;

  return (
    <div className="space-y-3 rounded-md border bg-slate-50 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h4 className="font-medium text-slate-900">Temporal coverage</h4>
          <p className="text-xs text-slate-500">
            {requested
              ? `Target model window: ${requested.start.toISOString().slice(0, 10)} – ${requested.end.toISOString().slice(0, 10)}`
              : 'Target model dates are not available.'}
          </p>
        </div>
        <div
          className="flex flex-wrap gap-1.5 text-[11px] text-slate-600"
          aria-label="Coverage summary"
        >
          <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-emerald-800 ring-1 ring-emerald-200">
            {counts.full ?? 0} full
          </span>
          <span className="rounded bg-amber-50 px-1.5 py-0.5 text-amber-800 ring-1 ring-amber-200">
            {counts.partial ?? 0} partial
          </span>
          <span className="rounded bg-white px-1.5 py-0.5 ring-1 ring-slate-200">
            {counts.unknown ?? 0} no dates
          </span>
        </div>
      </div>

      <div className="min-w-[42rem]">
        <div className="relative ml-48 h-8 border-b border-slate-300 text-[11px] text-slate-500">
          {targetLeft !== null && targetRight !== null && (
            <span
              className="absolute inset-y-0 bg-blue-100/80"
              style={{ left: `${targetLeft}%`, width: `${Math.max(1, targetRight - targetLeft)}%` }}
              aria-hidden
            />
          )}
          {ticks.map((tick, index) => (
            <span
              key={tick}
              className={cn(
                'absolute bottom-1 whitespace-nowrap',
                index === 0
                  ? 'translate-x-0'
                  : index === ticks.length - 1
                    ? '-translate-x-full'
                    : '-translate-x-1/2',
              )}
              style={{ left: `${timelinePercent(tick, domain)}%` }}
            >
              {new Date(tick).getUTCFullYear()}
            </span>
          ))}
        </div>

        <div role="radiogroup" aria-label="Choose dataset" className="space-y-1.5 pt-2">
          <p className="text-xs text-slate-500">Choose · {allCandidates.length} options</p>
          {datasets.map((dataset) => {
            const coverage = coverageForDataset(dataset, requested);
            const start = validDate(dataset.time_period?.start_date)?.getTime();
            const end = validDate(dataset.time_period?.end_date)?.getTime();
            const left = start === undefined ? 0 : timelinePercent(start, domain);
            const right = end === undefined ? 100 : timelinePercent(end, domain);
            const selected = dataset.id === assignedId;
            const hasBar = start !== undefined || end !== undefined;

            return (
              <button
                key={dataset.id}
                type="button"
                role="radio"
                aria-checked={selected}
                aria-label={`${dataset.name}: ${coverageLabel(coverage)}; ${periodLabel(dataset.time_period)}`}
                onClick={() => onAssign(dataset.id, dataset)}
                className={cn(
                  'grid w-full grid-cols-[12rem_minmax(28rem,1fr)_9rem] items-center gap-2 rounded px-1.5 py-1 text-left transition-colors hover:bg-white',
                  selected && 'bg-white ring-1 ring-blue-400',
                )}
              >
                <span className="min-w-0 truncate text-xs font-medium text-slate-800">
                  <span className="mr-1 text-slate-400" aria-hidden>
                    {selected ? '●' : '○'}
                  </span>
                  {dataset.name}
                  {dataset.region_match === 'unknown' && (
                    <span className="font-normal text-slate-500"> · ! no location</span>
                  )}
                  {dataset.region_match === 'outside' && (
                    <span className="font-normal text-slate-500"> · ! outside region</span>
                  )}
                </span>
                <span className="relative h-6 rounded bg-slate-200/70">
                  {hasBar && (
                    <span
                      className={cn(
                        'absolute top-1 h-4 min-w-[0.35rem] rounded-full',
                        coverageBarClass(coverage, selected),
                        (start === undefined || end === undefined) &&
                          'border border-dashed border-slate-500',
                      )}
                      style={{ left: `${left}%`, width: `${Math.max(0.75, right - left)}%` }}
                      aria-hidden
                    />
                  )}
                  {requested && (
                    <span
                      className="pointer-events-none absolute inset-y-0 border-x border-blue-500/80"
                      style={{
                        left: `${targetLeft}%`,
                        width: `${Math.max(1, (targetRight ?? 0) - (targetLeft ?? 0))}%`,
                      }}
                      aria-hidden
                    />
                  )}
                  {!hasBar && (
                    <span className="absolute inset-y-0 left-2 flex items-center text-[11px] text-slate-500">
                      No temporal extent declared
                    </span>
                  )}
                </span>
                <span className="text-[11px] text-slate-600">
                  <span className="block font-medium">{coverageLabel(coverage)}</span>
                  <span className="block text-slate-500">{periodLabel(dataset.time_period)}</span>
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/** Per-input dataset picker — lists candidates and assigns one dataset id. Isolated per model. */
function InputPicker({
  thread,
  variables,
  regionGeometry,
  spatialBox,
  requested,
  assignedId,
  suggestedDatasetIds,
  selectedDatasets = [],
  onDatasetMetadata,
  onAssign,
}: {
  thread: Thread;
  variables: string[];
  regionGeometry?: unknown;
  spatialBox: BoundingBox | null;
  requested: RequestedRange | null;
  assignedId: string | null;
  suggestedDatasetIds?: string[];
  selectedDatasets?: DatasetCompatibilityContext[];
  onDatasetMetadata?: (dataset: DataCatalogDataset) => void;
  onAssign: (datasetId: string | null, dataset?: DataCatalogDataset) => void;
}) {
  const [showOutside, setShowOutside] = useState(false);
  const [query, setQuery] = useState('');
  const [coverageFilter, setCoverageFilter] = useState<CoverageFilter>('all');
  const { datasets, loading } = useDataCatalogDatasets({
    variableNames: variables,
    regionGeometry,
    startDate: thread.start_date ? new Date(thread.start_date) : null,
    endDate: thread.end_date ? new Date(thread.end_date) : null,
    includeOutsideDateRange: true,
    skip: false,
  });

  const spatialCandidates = useMemo(
    () => datasets.filter((dataset) => matchesSpatialBox(dataset, spatialBox)),
    [datasets, spatialBox],
  );
  const spatiallyExcludedCount = datasets.length - spatialCandidates.length;
  const compatibleCandidates = useMemo(
    () =>
      spatialCandidates.filter((dataset) =>
        matchesSelectedDatasetContext(dataset, selectedDatasets),
      ),
    [selectedDatasets, spatialCandidates],
  );
  const consistencyExcludedCount = spatialCandidates.length - compatibleCandidates.length;
  const { inRegion, noLocation, outside } = useMemo(
    () => splitByRegion(compatibleCandidates),
    [compatibleCandidates],
  );

  useEffect(() => {
    if (assignedId || !suggestedDatasetIds?.length) return;
    const suggestion = compatibleCandidates.find((dataset) =>
      suggestedDatasetIds.includes(dataset.id),
    );
    if (suggestion) onAssign(suggestion.id, suggestion);
  }, [assignedId, compatibleCandidates, onAssign, suggestedDatasetIds]);

  const assignedDataset = assignedId ? datasets.find((dataset) => dataset.id === assignedId) : null;

  useEffect(() => {
    if (assignedDataset) onDatasetMetadata?.(assignedDataset);
  }, [assignedDataset, onDatasetMetadata]);

  const offered = showOutside ? compatibleCandidates : [...inRegion, ...noLocation];
  const candidates =
    assignedDataset && !offered.some((dataset) => dataset.id === assignedDataset.id)
      ? [assignedDataset, ...offered]
      : offered;
  const filteredCandidates = candidates.filter(
    (dataset) =>
      datasetMatchesSearch(dataset, query) &&
      coverageMatchesFilter(coverageForDataset(dataset, requested), coverageFilter),
  );
  const visibleDatasets =
    assignedDataset && !filteredCandidates.some((dataset) => dataset.id === assignedDataset.id)
      ? [assignedDataset, ...filteredCandidates]
      : filteredCandidates;
  const assignedIsPinned = Boolean(
    assignedDataset && !filteredCandidates.includes(assignedDataset),
  );

  const outsideToggle = outside.length > 0 && (
    <button
      type="button"
      onClick={() => setShowOutside((v) => !v)}
      className="text-xs text-blue-600 hover:underline"
    >
      {showOutside ? 'Hide' : 'Show'} {outside.length} dataset{outside.length !== 1 ? 's' : ''}{' '}
      outside this region
    </button>
  );
  const spatialFilterNotice = spatiallyExcludedCount > 0 && (
    <p className="rounded bg-slate-50 px-2 py-1 text-xs text-slate-600">
      {spatiallyExcludedCount} dataset{spatiallyExcludedCount !== 1 ? 's' : ''} outside the drawn
      box {spatiallyExcludedCount !== 1 ? 'are' : 'is'} hidden. Datasets without a declared location
      remain available.
    </p>
  );
  const consistencyFilterNotice = consistencyExcludedCount > 0 && selectedDatasets.length > 0 && (
    <p className="rounded bg-blue-50 px-2 py-1 text-xs text-blue-800">
      {consistencyExcludedCount} dataset{consistencyExcludedCount !== 1 ? 's' : ''} with declared
      coverage {consistencyExcludedCount !== 1 ? 'are' : 'is'} hidden because their spatial or
      temporal coverage is incompatible with a dataset already selected for this model. Datasets
      without comparable coverage remain available.
    </p>
  );

  if (loading) {
    return <span className="text-xs text-gray-400">Loading datasets…</span>;
  }
  if (candidates.length === 0) {
    return (
      <div className="space-y-2">
        <span className="flex flex-wrap items-center gap-2 text-xs text-gray-400">
          No matching datasets in this region.
          {outsideToggle}
        </span>
        {spatialFilterNotice}
        {consistencyFilterNotice}
      </div>
    );
  }

  return (
    <div className="mt-3 w-full space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <label className="relative min-w-[16rem] flex-1">
          <Search
            className="pointer-events-none absolute left-2 top-2 h-4 w-4 text-slate-400"
            aria-hidden
          />
          <input
            type="search"
            aria-label="Search datasets"
            placeholder="Search datasets by name, source, or variable…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="h-8 w-full rounded border border-slate-300 bg-white pl-8 pr-2 text-xs outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
          />
        </label>
        <label className="flex items-center gap-1.5 text-xs text-slate-600">
          <span>Coverage</span>
          <select
            aria-label="Filter by date coverage"
            value={coverageFilter}
            onChange={(event) => setCoverageFilter(event.target.value as CoverageFilter)}
            className="h-8 rounded border border-slate-300 bg-white px-2 text-xs"
          >
            <option value="all">All candidates</option>
            <option value="full">Full coverage</option>
            <option value="partial">Partial overlap</option>
            <option value="unknown">No declared dates</option>
            <option value="outside">Outside model window</option>
          </select>
        </label>
        {outsideToggle}
      </div>

      {assignedIsPinned && (
        <p className="rounded bg-blue-50 px-2 py-1 text-xs text-blue-800">
          The selected dataset remains visible even though it does not match the current search,
          coverage, or spatial filter.
        </p>
      )}

      {spatialFilterNotice}
      {consistencyFilterNotice}

      {visibleDatasets.length > 0 ? (
        <DatasetCoverageTimeline
          datasets={visibleDatasets}
          allCandidates={candidates}
          requested={requested}
          assignedId={assignedId}
          onAssign={(datasetId, dataset) => onAssign(datasetId, dataset)}
        />
      ) : (
        <p className="rounded border border-dashed px-3 py-4 text-center text-xs text-slate-500">
          No candidates match this search and coverage filter.
        </p>
      )}
    </div>
  );
}

export function DatasetsStep({
  thread,
  models,
  ensembles,
  persistedData,
  regionGeometry,
  spatialScopeName,
  initialDatasetIds = [],
  onUpdated,
  onContinue,
  onBack,
}: DatasetsStepProps) {
  const { user } = useAuth();
  const { toast } = useToast();
  const perm = getUserPermission(thread.permissions, thread.events, user?.username ?? null);
  const [saving, setSaving] = useState(false);
  const [spatialBox, setSpatialBox] = useState<BoundingBox | null>(null);
  const [collapsedInputs, setCollapsedInputs] = useState<Record<string, boolean>>({});

  // What the database already holds. Recomputed whenever the thread execution
  // query refetches, so a save is reflected without remounting the step.
  const persisted = useMemo(
    () => assignmentsFromBindings(ensembles, persistedData),
    [ensembles, persistedData],
  );

  // Edits made in this session. `null` is a deliberate clear, which is why the
  // lookup below tests for `undefined` rather than falsiness.
  const [overrides, setOverrides] = useState<Record<string, Record<string, Assignment | null>>>({});
  // Existing bindings only store a dataset id and name. InputPicker reports
  // the catalog metadata when it sees such a binding, allowing persisted
  // selections to constrain the other inputs without adding a new API call.
  const [knownDatasetMetadata, setKnownDatasetMetadata] = useState<
    Record<string, DataCatalogDataset>
  >({});

  // Files chosen for each collection input, keyed like the input cards. An input
  // that is not a collection never appears here: all its files are bound.
  const [collectionPicks, setCollectionPicks] = useState<Record<string, DataCatalogResource[]>>({});
  const reportCollectionPick = useCallback((key: string, chosen: DataCatalogResource[]) => {
    setCollectionPicks((prev) => ({ ...prev, [key]: chosen }));
  }, []);

  const [savingArchiveDates, setSavingArchiveDates] = useState(false);
  const [updateThread] = useUpdateThreadMutation();
  const [insertThreadProvenance] = useInsertThreadProvenanceMutation();
  const [updateThreadData] = useUpdateThreadDataMutation();

  const modelIds = Object.keys(models);

  const assignmentFor = useCallback(
    (modelId: string, inputId: string): Assignment | null => {
      const override = overrides[modelId]?.[inputId];
      if (override !== undefined) return override;
      return persisted[modelId]?.[inputId] ?? null;
    },
    [overrides, persisted],
  );

  const reportKnownDatasetMetadata = useCallback((dataset: DataCatalogDataset) => {
    setKnownDatasetMetadata((previous) =>
      previous[dataset.id] === dataset ? previous : { ...previous, [dataset.id]: dataset },
    );
  }, []);

  const selectedDatasetContextsByModel: Record<string, DatasetCompatibilityContext[]> = {};
  for (const [modelId, model] of Object.entries(models)) {
    const contexts: DatasetCompatibilityContext[] = [];
    for (const input of model.input_files) {
      const assignment = assignmentFor(modelId, input.id);
      if (!assignment) continue;
      const metadata = knownDatasetMetadata[assignment.datasetId];
      contexts.push({
        datasetId: assignment.datasetId,
        datasetName: assignment.datasetName,
        timePeriod: assignment.timePeriod ?? metadata?.time_period ?? null,
        spatialCoverage: assignment.spatialCoverage ?? metadata?.spatial_coverage,
      });
    }
    selectedDatasetContextsByModel[modelId] = contexts;
  }

  const requested: RequestedRange | null = useMemo(() => {
    if (!thread.start_date || !thread.end_date) return null;
    const start = new Date(thread.start_date);
    const end = new Date(thread.end_date);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) return null;
    return { start, end };
  }, [thread.start_date, thread.end_date]);

  const requiredInputCount = useMemo(
    () =>
      modelIds.reduce(
        (acc, mid) => acc + (models[mid]?.input_files.filter((i) => !i.isOptional).length ?? 0),
        0,
      ),
    [modelIds, models],
  );

  const assignedCount = modelIds.reduce((acc, mid) => {
    const reqInputs = models[mid]?.input_files.filter((i) => !i.isOptional) ?? [];
    return acc + reqInputs.filter((i) => assignmentFor(mid, i.id)).length;
  }, 0);

  const allAssigned = requiredInputCount > 0 && assignedCount === requiredInputCount;

  const selectedArchivePeriods = useMemo(() => {
    const periods: Array<DataCatalogTimePeriod | null> = [];
    for (const [modelId, model] of Object.entries(models)) {
      for (const input of model.input_files) {
        const assignment = assignmentFor(modelId, input.id);
        if (!assignment) continue;
        periods.push(
          assignment.timePeriod ?? knownDatasetMetadata[assignment.datasetId]?.time_period ?? null,
        );
      }
    }
    return periods;
  }, [assignmentFor, knownDatasetMetadata, models]);

  const selectedArchiveRange = useMemo(
    () => archiveDateRange(selectedArchivePeriods),
    [selectedArchivePeriods],
  );

  async function handleUseArchiveDates() {
    if (!selectedArchiveRange || !perm.write) return;
    const startDate = selectedArchiveRange.start.toISOString().slice(0, 10);
    const endDate = selectedArchiveRange.end.toISOString().slice(0, 10);
    setSavingArchiveDates(true);
    try {
      await updateThread({
        variables: {
          id: thread.id,
          name: thread.name,
          startDate,
          endDate,
          regionId: thread.region_id,
          drivingVariableId: thread.driving_variable_id,
          responseVariableId: thread.response_variable_id,
        },
      });
      if (user?.username) {
        await insertThreadProvenance({
          variables: {
            threadId: thread.id,
            event: 'UPDATE',
            userid: user.username,
            notes: 'Set time period from selected archive coverage',
          },
        });
      }
      await onUpdated();
      toast({
        title: 'Dates set from selected archives',
        description: `${startDate} – ${endDate}`,
      });
    } catch (err) {
      toast({
        title: 'Could not set archive dates',
        description: String(err),
        variant: 'destructive',
      });
    } finally {
      setSavingArchiveDates(false);
    }
  }

  function assign(
    modelId: string,
    inputId: string,
    datasetId: string | null,
    dataset?: DataCatalogDataset,
  ) {
    // The files chosen for the old dataset do not carry over to a new one.
    setCollectionPicks(({ [inputCardKey(modelId, inputId)]: _dropped, ...rest }) => rest);
    setOverrides((prev) => {
      const bucket = { ...(prev[modelId] ?? {}) };
      bucket[inputId] =
        datasetId && dataset
          ? {
              datasetId,
              datasetName: dataset.name,
              timePeriod: dataset.time_period,
              spatialCoverage: dataset.spatial_coverage,
            }
          : null;
      return { ...prev, [modelId]: bucket };
    });
  }

  async function handleContinue() {
    if (!allAssigned) return;
    setSaving(true);
    try {
      const data: ThreadDataInsert[] = [];
      const modelIO: Array<{
        thread_model_id: string;
        model_io_id: string;
        dataslice_id: string;
      }> = [];

      for (const modelId of modelIds) {
        const model = models[modelId];
        // The thread_model row id, not the configuration id — thread_model_io
        // is keyed by the former.
        const threadModelId = ensembles[modelId]?.id;
        if (!model || !threadModelId) continue;

        for (const input of model.input_files) {
          const assignment = assignmentFor(modelId, input.id);
          if (!assignment) continue;

          // The mutation drops every dataslice for the thread before inserting,
          // so a binding that is being carried over has to be rebuilt too. A
          // binding read back from Hasura already carries its files; a freshly
          // picked dataset does not, and the catalog only narrows resources to
          // the input's variables on demand.
          const isCollection = Boolean(model.collectionInputs?.includes(input.id));
          const picked = isCollection
            ? collectionPicks[inputCardKey(modelId, input.id)]
            : undefined;
          const all =
            picked ??
            assignment.resources ??
            (await loadDatasetResources({
              datasetId: assignment.datasetId,
              variableNames: input.variables ?? [],
            }));
          // A collection holds only files the backend can gather, up to its cap.
          const resources = isCollection && !picked ? collectionDefaultSelection(all) : all;

          if (resources.length === 0) {
            toast({
              title: `No matching files in ${assignment.datasetName}`,
              description: `Nothing in this dataset carries ${(input.variables ?? []).join(', ') || 'the input variable'}.`,
              variant: 'destructive',
            });
            setSaving(false);
            return;
          }

          const datasliceId = newDatasliceId();
          data.push(
            buildThreadDataInsert({
              threadId: thread.id,
              threadName: thread.name,
              regionId: thread.region_id,
              startDate: thread.start_date,
              endDate: thread.end_date,
              datasliceId,
              dataset: { id: assignment.datasetId, name: assignment.datasetName },
              resources,
            }),
          );
          modelIO.push({
            thread_model_id: threadModelId,
            model_io_id: input.id,
            dataslice_id: datasliceId,
          });
        }
      }

      await updateThreadData({
        variables: {
          threadId: thread.id,
          event: {
            thread_id: thread.id,
            event: 'SELECT_DATA',
            userid: user?.username ?? 'anonymous',
            notes: null,
          },
          data,
          modelIO,
        },
      });
      setOverrides({});
      await onUpdated();
      onContinue();
    } catch (err) {
      toast({ title: 'Save failed', description: String(err), variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  }

  if (modelIds.length === 0) {
    return (
      <StepShell title="Datasets" description="Assign a dataset to every model input.">
        <p className="text-sm text-orange-600">Please select model(s) first.</p>
      </StepShell>
    );
  }

  // A region with no geometry cannot narrow anything; say so rather than
  // implying a filter that never ran.
  const regionHasExtent = Array.isArray(regionGeometry)
    ? regionGeometry.length > 0
    : Boolean(regionGeometry);
  const chips = [
    { icon: '📦', label: 'Input', value: 'per model input' },
    ...(thread.region_id || spatialScopeName
      ? [
          {
            icon: '⌖',
            label: spatialScopeName ? 'Boundary' : 'Region',
            value:
              spatialScopeName ?? thread.region?.name ?? thread.region_id ?? 'Selected boundary',
            source: regionHasExtent ? 'from Framing' : 'from Framing · no extent, not applied',
          },
        ]
      : []),
    ...(requested
      ? [
          {
            icon: '🗓',
            label: 'Dates',
            value: `${thread.start_date} – ${thread.end_date}`,
            source: 'from Framing',
          },
        ]
      : []),
  ];

  return (
    <StepShell
      title="Datasets"
      description="Assign a dataset to every input, per model. Each model's assignments are independent."
      canContinue={allAssigned && !saving && perm.write}
      continueHint={`${assignedCount} of ${requiredInputCount} inputs assigned`}
      continueLabel={saving ? 'Saving…' : 'Continue'}
      onContinue={handleContinue}
      onBack={onBack}
    >
      <FilteredByBanner chips={chips} />

      {allAssigned && selectedArchiveRange && (
        <div
          className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded border border-blue-200 bg-blue-50 px-3 py-2 text-sm"
          data-testid="archive-date-suggestion"
        >
          <div>
            <p className="font-medium text-blue-900">Selected archive coverage</p>
            <p className="text-xs text-blue-800">
              {selectedArchiveRange.start.toISOString().slice(0, 10)} –{' '}
              {selectedArchiveRange.end.toISOString().slice(0, 10)}
            </p>
          </div>
          <button
            type="button"
            className="rounded border border-blue-300 bg-white px-2.5 py-1.5 text-xs font-medium text-blue-800 hover:bg-blue-100 disabled:cursor-not-allowed disabled:opacity-50"
            onClick={() => void handleUseArchiveDates()}
            disabled={savingArchiveDates || !perm.write}
          >
            {savingArchiveDates ? 'Setting dates…' : 'Use archive dates'}
          </button>
        </div>
      )}

      <DatasetSpatialMap value={spatialBox} onChange={setSpatialBox} />

      <div className="space-y-4">
        {modelIds.map((modelId) => {
          const model = models[modelId]!;
          const sortedInputs = sortModelInputs(model.input_files);
          const reqInputs = model.input_files.filter((i) => !i.isOptional);
          const doneForModel = reqInputs.filter((i) => assignmentFor(modelId, i.id)).length;
          return (
            <div key={modelId} className="rounded border p-3 text-sm">
              <div className="mb-2 flex items-center justify-between">
                <span className="font-medium">
                  <span className="text-xs font-normal text-gray-400">MODEL · </span>
                  {model.name}
                </span>
                <span className="text-xs text-gray-500">
                  {doneForModel} / {reqInputs.length} inputs
                </span>
              </div>
              <ul className="space-y-2">
                {sortedInputs.map((input) => {
                  const current = assignmentFor(modelId, input.id);
                  const cov = dateCoverage(requested, toPeriod(current?.timePeriod));
                  const key = inputCardKey(modelId, input.id);
                  const collapsed = collapsedInputs[key] ?? false;
                  const panelId = inputCardPanelId(modelId, input.id);
                  const isCollection = Boolean(model.collectionInputs?.includes(input.id));
                  return (
                    <li key={input.id} className="rounded border bg-white p-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="font-medium text-gray-700">
                          {input.name}
                          {input.isOptional && (
                            <span className="ml-1 text-xs font-normal text-gray-400">
                              (optional)
                            </span>
                          )}
                        </span>
                        <span className="flex flex-wrap items-center gap-2 text-xs">
                          {!current && !input.isOptional && (
                            <span className="text-amber-600">⚠ no dataset assigned</span>
                          )}
                          {current && cov !== 'none' && (
                            <span
                              className={cn(
                                'rounded px-1.5 py-0.5',
                                cov === 'full'
                                  ? 'bg-green-100 text-green-800'
                                  : cov === 'partial'
                                    ? 'bg-amber-100 text-amber-800'
                                    : 'bg-slate-100 text-slate-700',
                              )}
                            >
                              🗓 {coverageLabel(cov)}
                            </span>
                          )}
                          <button
                            type="button"
                            className="rounded px-1.5 py-0.5 text-blue-600 hover:bg-blue-50 hover:underline"
                            aria-expanded={!collapsed}
                            aria-controls={panelId}
                            aria-label={`${collapsed ? 'Expand' : 'Minimize'} dataset card for ${input.name}`}
                            onClick={() =>
                              setCollapsedInputs((previous) => ({
                                ...previous,
                                [key]: !collapsed,
                              }))
                            }
                          >
                            {collapsed ? 'Expand' : 'Minimize'}
                          </button>
                        </span>
                      </div>
                      {isCollection && (
                        <div className="mt-1 text-xs text-purple-900">
                          <span className="rounded bg-purple-100 px-1.5 py-0.5 font-medium">
                            Takes a collection
                          </span>{' '}
                          {COLLECTION_EXPLANATION}
                        </div>
                      )}
                      <div id={panelId} hidden={collapsed}>
                        <InputPicker
                          thread={thread}
                          variables={input.variables ?? []}
                          regionGeometry={regionGeometry}
                          spatialBox={spatialBox}
                          requested={requested}
                          assignedId={current?.datasetId ?? null}
                          suggestedDatasetIds={initialDatasetIds}
                          selectedDatasets={selectedDatasetContextsByModel[modelId]}
                          onDatasetMetadata={reportKnownDatasetMetadata}
                          onAssign={(dsId, ds) => assign(modelId, input.id, dsId, ds)}
                        />
                        {isCollection && current && (
                          <CollectionFiles
                            key={current.datasetId}
                            datasetId={current.datasetId}
                            variables={input.variables ?? []}
                            initial={current.resources}
                            onChange={(chosen) => reportCollectionPick(key, chosen)}
                          />
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </div>
    </StepShell>
  );
}
