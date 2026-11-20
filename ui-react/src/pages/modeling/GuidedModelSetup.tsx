import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from 'react';
import { useQuery } from '@apollo/client';
import { ArrowLeft, Check, Loader2, Sparkles } from 'lucide-react';
import { useNavigate, useSearchParams } from 'react-router-dom';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { LIST_TOP_REGIONS } from '@/graphql/queries/regions';
import {
  generateModelingId,
  useInsertProblemStatementMutation,
  useInsertProblemStatementProvenanceMutation,
  useInsertTaskMutation,
  useInsertTaskProvenanceMutation,
  useInsertThreadMutation,
  useInsertThreadProvenanceMutation,
  useListProblemStatementsQuery,
  useSetThreadModelsMutation,
  useUpdateThreadMutation,
  type ProblemStatement,
} from '@/graphql/generated/modeling';
import { provisionTask } from '@/lib/modeling/provisionTask';
import {
  recommendProblemStatement,
  type ModelConfigurationRecommendation,
  type StandardVariableRecommendation,
} from '@/lib/modeling/problemStatementRecommendations';
import { findDatasetsByVariables, type DataCatalogDataset } from '@/lib/data-catalog';
import { fetchDatasetDetail } from '@/lib/datasets/data-catalog-api';
import { spatialCoverageBoundingBox } from '@/lib/datasets/spatial';
import type { Dataset } from '@/lib/datasets/types';
import { boundingBoxesOverlap, unionBoundingBox, type BoundingBox } from '@/lib/geo/bbox';
import { useAuth } from '@/lib/auth/useAuth';

interface Region {
  id: string;
  name: string;
  geometries: Array<{ geometry?: unknown }>;
}

interface RegionData {
  region: Region[];
}

interface GuidedModelSetupProps {
  /** Optional route context used by tests and embedded callers. */
  initialModelId?: string | null;
  initialDatasetId?: string | null;
}

function evidenceText(item: {
  evidence?: Array<{ source?: string; label?: string; relation?: string }>;
}) {
  const evidence = item.evidence?.find((entry) => entry.label || entry.relation);
  if (!evidence) return null;
  if (evidence.label) return `Related to ${evidence.label}`;
  if (evidence.relation) return evidence.relation.replace(/_/g, ' ');
  return null;
}

function displayLabel(id: string, label?: string | null) {
  return label?.trim() || id.split('/').pop() || id;
}

function initialIds(value: string | null, searchValue: string | null): string[] {
  const values = [value, ...(searchValue?.split(',') ?? [])].filter((item): item is string =>
    Boolean(item),
  );
  return [...new Set(values)];
}

function modelNamesParam(value: string | null): Record<string, string> {
  if (!value) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function dateInputValue(value: Date | null | undefined): string {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10);
}

function combinedDatasetCoverage(datasets: Dataset[]): BoundingBox | null {
  const boxes = datasets
    .map((dataset) => spatialCoverageBoundingBox(dataset.spatial_coverage))
    .filter((box): box is BoundingBox => Boolean(box));
  if (!boxes.length) return null;
  return boxes.reduce((combined, box) => ({
    xmin: Math.min(combined.xmin, box.xmin),
    xmax: Math.max(combined.xmax, box.xmax),
    ymin: Math.min(combined.ymin, box.ymin),
    ymax: Math.max(combined.ymax, box.ymax),
  }));
}

function regionForDatasetCoverage(datasets: Dataset[], regions: Region[]): string | null {
  const datasetBox = combinedDatasetCoverage(datasets);
  if (!datasetBox) return null;
  return (
    regions.find((region) => {
      const regionBox = unionBoundingBox(region.geometries.map((geometry) => geometry.geometry));
      return regionBox ? boundingBoxesOverlap(datasetBox, regionBox) : false;
    })?.id ?? null
  );
}

export function GuidedModelSetup({
  initialModelId = null,
  initialDatasetId = null,
}: GuidedModelSetupProps) {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { user, isAuthenticated, isLoading: authLoading } = useAuth();
  const modelId = initialModelId ?? searchParams.get('modelId');
  const datasetId = initialDatasetId ?? searchParams.get('datasetId');
  const startingModelIds = useMemo(
    () => initialIds(modelId, searchParams.get('modelIds')),
    [modelId, searchParams],
  );
  const startingDatasetIds = useMemo(
    () => initialIds(datasetId, searchParams.get('datasetIds')),
    [datasetId, searchParams],
  );

  const { data: regionData } = useQuery<RegionData>(LIST_TOP_REGIONS);
  const regions = useMemo(() => regionData?.region ?? [], [regionData]);
  const { data: statementsData, loading: statementsLoading } = useListProblemStatementsQuery({
    variables: { where: {} },
    // This selection includes the private permissions relationship. Wait for
    // AuthProvider to restore the bearer token instead of querying as guest.
    skip: authLoading || !isAuthenticated,
    fetchPolicy: 'cache-and-network',
  });

  const [insertProblemStatement] = useInsertProblemStatementMutation();
  const [insertProblemStatementProvenance] = useInsertProblemStatementProvenanceMutation();
  const [insertTask] = useInsertTaskMutation();
  const [insertTaskProvenance] = useInsertTaskProvenanceMutation();
  const [insertThread] = useInsertThreadMutation();
  const [insertThreadProvenance] = useInsertThreadProvenanceMutation();
  const [setThreadModels] = useSetThreadModelsMutation();
  const [updateThread] = useUpdateThreadMutation();

  // An upload hands over what it already knows. These only seed the fields;
  // the user still edits them and confirms.
  const uploadedVariable = searchParams.get('variable');
  const closeModelIds = useMemo(
    () => initialIds(null, searchParams.get('closeModelIds')),
    [searchParams],
  );
  const modelNames = useMemo(() => modelNamesParam(searchParams.get('modelNames')), [searchParams]);
  const recommendedForData = uploadedVariable
    ? startingModelIds.filter((id) => !closeModelIds.includes(id))
    : [];
  const contextModelIds = startingModelIds.filter(
    (id) => !recommendedForData.includes(id) && !closeModelIds.includes(id),
  );
  const nameOf = (id: string) => displayLabel(id, modelNames[id]);

  const [goal, setGoal] = useState(() => searchParams.get('goal') ?? '');
  const [outcome, setOutcome] = useState('');
  const [regionId, setRegionId] = useState(() => searchParams.get('regionId') ?? '');
  const [startDate, setStartDate] = useState(() => searchParams.get('startDate') || '2000-01-01');
  const [endDate, setEndDate] = useState(
    () => searchParams.get('endDate') || new Date().toISOString().slice(0, 10),
  );
  const [selectedDatasetMetadata, setSelectedDatasetMetadata] = useState<Dataset[]>([]);
  const [destination, setDestination] = useState<'new' | 'existing'>('new');
  const [existingProblemStatementId, setExistingProblemStatementId] = useState('');
  const [problemStatementName, setProblemStatementName] = useState('');
  const [recommendations, setRecommendations] = useState<{
    svo: StandardVariableRecommendation[];
    models: ModelConfigurationRecommendation[];
  } | null>(null);
  const [recommendedDatasets, setRecommendedDatasets] = useState<DataCatalogDataset[]>([]);
  const [selectedSvoId, setSelectedSvoId] = useState<string | null>(null);
  const [selectedModelIds, setSelectedModelIds] = useState<Set<string>>(
    () => new Set(startingModelIds),
  );
  const [selectedDatasetIds, setSelectedDatasetIds] = useState<Set<string>>(
    () => new Set(startingDatasetIds),
  );
  const [loadingRecommendations, setLoadingRecommendations] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const framingEdits = useRef({ region: false, startDate: false, endDate: false });

  useEffect(() => {
    if (!startingDatasetIds.length) {
      setSelectedDatasetMetadata([]);
      return;
    }

    let active = true;
    void Promise.all(
      startingDatasetIds.map(async (id) => {
        try {
          return await fetchDatasetDetail(id);
        } catch {
          // A selected dataset should not prevent framing the problem if its
          // catalog detail is temporarily unavailable.
          return null;
        }
      }),
    ).then((datasets) => {
      if (active)
        setSelectedDatasetMetadata(datasets.filter((dataset): dataset is Dataset => !!dataset));
    });

    return () => {
      active = false;
    };
  }, [startingDatasetIds]);

  useEffect(() => {
    if (!selectedDatasetMetadata.length) return;

    const periods = selectedDatasetMetadata
      .map((dataset) => dataset.time_period)
      .filter((period): period is NonNullable<Dataset['time_period']> => Boolean(period));
    const starts = periods
      .map((period) => period.start_date)
      .filter((date): date is Date => Boolean(date));
    const ends = periods
      .map((period) => period.end_date)
      .filter((date): date is Date => Boolean(date));
    const derivedStart = starts.length
      ? dateInputValue(new Date(Math.max(...starts.map((date) => date.getTime()))))
      : '';
    const derivedEnd = ends.length
      ? dateInputValue(new Date(Math.min(...ends.map((date) => date.getTime()))))
      : '';

    // Use the common period for multiple selected datasets. If the metadata
    // has no common interval, leave the editable defaults in place rather than
    // creating an invalid start/end pair.
    if (derivedStart && derivedEnd && derivedStart < derivedEnd) {
      if (!framingEdits.current.startDate && startDate === '2000-01-01') {
        setStartDate(derivedStart);
      }
      if (!framingEdits.current.endDate && endDate === new Date().toISOString().slice(0, 10)) {
        setEndDate(derivedEnd);
      }
    }

    if (!framingEdits.current.region && !regionId) {
      const derivedRegionId = regionForDatasetCoverage(selectedDatasetMetadata, regions);
      if (derivedRegionId) setRegionId(derivedRegionId);
    }
  }, [endDate, regionId, regions, selectedDatasetMetadata, startDate]);

  useEffect(() => {
    if (!problemStatementName && goal.trim()) setProblemStatementName(goal.trim());
  }, [goal, problemStatementName]);

  const selectedRegion = regions.find((region) => region.id === regionId);
  const problemStatements = (statementsData?.problem_statement ?? []) as ProblemStatement[];
  const visibleModelRecommendations = useMemo(() => {
    if (!recommendations || !selectedSvoId) return recommendations?.models ?? [];

    // Keep models with incomplete output metadata visible. A missing catalog
    // relationship is unknown, not proof that the model cannot produce the
    // selected outcome.
    const modelsWithOutputMetadata = recommendations.models.filter((model) =>
      (model.standard_variables ?? []).some((variable) => variable.role === 'output'),
    );
    if (modelsWithOutputMetadata.length === 0) return recommendations.models;

    return recommendations.models.filter((model) => {
      const outputs = (model.standard_variables ?? []).filter(
        (variable) => variable.role === 'output',
      );
      return outputs.length === 0 || outputs.some((variable) => variable.id === selectedSvoId);
    });
  }, [recommendations, selectedSvoId]);
  const datesValid = Boolean(startDate && endDate && startDate < endDate);
  const framingValid = Boolean(goal.trim() && regionId && datesValid);
  const canConfirm = Boolean(
    recommendations && framingValid && selectedModelIds.size > 0 && !saving,
  );

  function toggle(setter: Dispatch<SetStateAction<Set<string>>>, id: string) {
    setter((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function loadRecommendations() {
    if (!framingValid) {
      setError('Add a goal, region, and valid time period before finding recommendations.');
      return;
    }
    setLoadingRecommendations(true);
    setError(null);
    try {
      const response = await recommendProblemStatement({
        title: goal.trim(),
        description: outcome.trim() || goal.trim(),
        goals: outcome.trim() ? [outcome.trim()] : [],
        region_id: regionId,
        region_name: selectedRegion?.name ?? null,
        selected_model_configuration_ids: startingModelIds,
        start_date: startDate,
        end_date: endDate,
        spatial_conditions: {
          spatial_scope_type: 'custom',
          spatial_scope_id: regionId,
          ...(selectedRegion?.name ? { spatial_scope_name: selectedRegion.name } : {}),
          spatial_resolution: 'region',
        },
        limit: 10,
      });
      setRecommendations({
        svo: response.results.svo,
        models: response.results.model_configuration,
      });
      setSelectedModelIds((previous) => {
        const next = new Set(previous);
        startingModelIds.forEach((id) => next.add(id));
        return next;
      });

      const variableLabels = [
        ...response.results.svo.map((item) => item.label ?? item.id),
        ...response.results.model_configuration.flatMap((item) =>
          (item.standard_variables ?? [])
            .filter((variable) => variable.role === 'input')
            .map((variable) => variable.label ?? variable.id),
        ),
      ];
      if (variableLabels.length > 0) {
        try {
          const datasets = await findDatasetsByVariables({
            variableNames: [...new Set(variableLabels)],
            regionGeometry: selectedRegion?.geometries.map((geometry) => geometry.geometry),
            startDate: new Date(startDate),
            endDate: new Date(endDate),
          });
          setRecommendedDatasets(datasets.slice(0, 12));
        } catch (reason) {
          // Dataset retrieval is a useful enrichment, not a prerequisite for
          // reviewing the SVO/model recommendations. Keep the successful
          // recommendation response visible and let the wizard recover later.
          setRecommendedDatasets([]);
          setError(
            `Models were found, but dataset suggestions are unavailable: ${
              reason instanceof Error ? reason.message : String(reason)
            }`,
          );
        }
      } else {
        setRecommendedDatasets([]);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setRecommendations(null);
    } finally {
      setLoadingRecommendations(false);
    }
  }

  async function confirmSetup() {
    if (!canConfirm || !user?.username) return;
    setSaving(true);
    setError(null);
    try {
      let problemStatementId = existingProblemStatementId;
      if (destination === 'new') {
        problemStatementId = generateModelingId('problem_statement');
        await insertProblemStatement({
          variables: {
            id: problemStatementId,
            name: problemStatementName.trim() || goal.trim(),
            regionId,
            startDate,
            endDate,
          },
        });
        await insertProblemStatementProvenance({
          variables: {
            problemStatementId,
            event: 'CREATE',
            userid: user.username,
            notes: outcome.trim() || null,
          },
        });
      }
      if (!problemStatementId) throw new Error('Choose an existing problem statement.');

      const { threadId } = await provisionTask(
        { insertTask, insertTaskProvenance, insertThread, insertThreadProvenance },
        {
          problemStatementId,
          taskName: goal.trim(),
          startDate,
          endDate,
          regionId,
          userId: user.username,
        },
      );

      await updateThread({
        variables: {
          id: threadId,
          name: goal.trim(),
          startDate,
          endDate,
          regionId,
          responseVariableId: selectedSvoId,
          drivingVariableId: null,
        },
      });
      await setThreadModels({
        variables: {
          threadId,
          removedIds: [],
          models: [...selectedModelIds].map((id) => ({
            thread_id: threadId,
            modelcatalog_configuration_id: id,
          })),
          userid: user.username,
          notes: 'Confirmed from guided model setup',
        },
      });

      const params = new URLSearchParams({ threadId });
      const datasetIds = [...selectedDatasetIds];
      if (datasetIds.length) params.set('datasetIds', datasetIds.join(','));
      navigate(`/modeling/problem-statement/${problemStatementId}?${params.toString()}`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6 pb-10">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" onClick={() => navigate(-1)}>
          <ArrowLeft className="mr-1.5 h-4 w-4" /> Back
        </Button>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Start model setup</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Tell us what you want to understand, then review the suggested data and models.
          </p>
        </div>
      </div>

      {(startingModelIds.length > 0 || startingDatasetIds.length > 0) && (
        <section className="rounded-lg border bg-muted/30 p-4" aria-label="Starting context">
          <div className="mb-2 text-sm font-semibold">Starting context</div>
          <div className="flex flex-wrap gap-2 text-sm">
            {contextModelIds.map((id) => (
              <button
                key={`model-${id}`}
                type="button"
                className={`rounded-full border px-3 py-1 ${selectedModelIds.has(id) ? 'border-blue-500 bg-blue-50' : 'bg-background'}`}
                onClick={() => toggle(setSelectedModelIds, id)}
              >
                Model: {displayLabel(id)} {selectedModelIds.has(id) ? '✓' : '＋'}
              </button>
            ))}
            {startingDatasetIds.map((id) => (
              <button
                key={`dataset-${id}`}
                type="button"
                className={`rounded-full border px-3 py-1 ${selectedDatasetIds.has(id) ? 'border-blue-500 bg-blue-50' : 'bg-background'}`}
                onClick={() => toggle(setSelectedDatasetIds, id)}
              >
                Dataset: {displayLabel(id)} {selectedDatasetIds.has(id) ? '✓' : '＋'}
              </button>
            ))}
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            Confirm or remove these starting items below before continuing.
          </p>
        </section>
      )}

      {uploadedVariable && (recommendedForData.length > 0 || closeModelIds.length > 0) && (
        <section className="rounded-lg border p-5" aria-label="Models for your uploaded data">
          <h2 className="mb-1 font-semibold">Models that can use your data</h2>
          <p className="mb-4 text-sm text-muted-foreground">
            Pick the ones to carry into setup. Nothing is saved until you confirm.
          </p>
          <div className="grid gap-5 md:grid-cols-2">
            <RecommendationGroup title="Recommended" empty="No model takes this variable exactly.">
              {recommendedForData.map((id) => (
                <RecommendationCard
                  key={id}
                  title={nameOf(id)}
                  evidence={`Takes ${uploadedVariable}, the variable of your uploaded data`}
                  checked={selectedModelIds.has(id)}
                  onToggle={() => toggle(setSelectedModelIds, id)}
                />
              ))}
            </RecommendationGroup>
            {closeModelIds.length > 0 && (
              <RecommendationGroup title="Close matches" empty="">
                {closeModelIds.map((id) => (
                  <RecommendationCard
                    key={id}
                    title={nameOf(id)}
                    evidence="Close match, not an exact fit"
                    checked={selectedModelIds.has(id)}
                    onToggle={() => toggle(setSelectedModelIds, id)}
                  />
                ))}
              </RecommendationGroup>
            )}
          </div>
        </section>
      )}

      <section className="rounded-lg border p-5">
        <div className="mb-4 flex items-center gap-2">
          <Sparkles className="h-5 w-5 text-blue-600" />
          <h2 className="font-semibold">1. Frame the problem</h2>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-1.5 md:col-span-2">
            <Label htmlFor="guided-goal">
              What are you trying to understand, predict, or decide? *
            </Label>
            <Input
              id="guided-goal"
              value={goal}
              onChange={(event) => setGoal(event.target.value)}
              placeholder="For example: understand seasonal groundwater availability"
            />
          </div>
          <div className="space-y-1.5 md:col-span-2">
            <Label htmlFor="guided-outcome">What should the model produce? (optional)</Label>
            <Input
              id="guided-outcome"
              value={outcome}
              onChange={(event) => setOutcome(event.target.value)}
              placeholder="For example: groundwater hydraulic head or flood extent"
            />
            <p className="text-xs text-muted-foreground">
              This helps identify the response variable and models that can produce it.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="guided-region">Region *</Label>
            <Select
              value={regionId}
              onValueChange={(value) => {
                framingEdits.current.region = true;
                setRegionId(value);
              }}
            >
              <SelectTrigger id="guided-region" aria-label="Region">
                <SelectValue placeholder="Choose a region" />
              </SelectTrigger>
              <SelectContent>
                {regions.map((region) => (
                  <SelectItem key={region.id} value={region.id}>
                    {region.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="guided-start">Start date *</Label>
              <Input
                id="guided-start"
                type="date"
                value={startDate}
                onChange={(e) => {
                  framingEdits.current.startDate = true;
                  setStartDate(e.target.value);
                }}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="guided-end">End date *</Label>
              <Input
                id="guided-end"
                type="date"
                value={endDate}
                onChange={(e) => {
                  framingEdits.current.endDate = true;
                  setEndDate(e.target.value);
                }}
              />
            </div>
          </div>
        </div>
        {selectedDatasetMetadata.length > 0 && (
          <p className="mt-3 text-xs text-muted-foreground">
            Region and dates were prefilled from the selected dataset metadata. Review them before
            continuing.
          </p>
        )}
        {!datesValid && (
          <p className="mt-3 text-sm text-destructive">End date must be after start date.</p>
        )}
        <Button
          className="mt-5"
          onClick={loadRecommendations}
          disabled={!framingValid || loadingRecommendations}
        >
          {loadingRecommendations ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <Sparkles className="mr-2 h-4 w-4" />
          )}
          {loadingRecommendations ? 'Finding recommendations…' : 'Find recommendations'}
        </Button>
      </section>

      {recommendations && (
        <section className="rounded-lg border p-5">
          <div className="mb-4 flex items-center gap-2">
            <Check className="h-5 w-5 text-emerald-600" />
            <h2 className="font-semibold">2. Review suggestions</h2>
          </div>
          <p className="mb-4 text-sm text-muted-foreground">
            Choose the items you want to carry into model setup. Nothing is saved until you confirm
            below.
          </p>
          <div className="grid gap-5 lg:grid-cols-3">
            <RecommendationGroup
              title="Response variables"
              empty="No standard variables suggested."
            >
              {recommendations.svo.map((item) => (
                <RecommendationCard
                  key={item.id}
                  title={displayLabel(item.id, item.label)}
                  description={item.description}
                  evidence={evidenceText(item)}
                  checked={selectedSvoId === item.id}
                  onToggle={() =>
                    setSelectedSvoId((previous) => (previous === item.id ? null : item.id))
                  }
                />
              ))}
            </RecommendationGroup>
            <RecommendationGroup
              title="Models that can help"
              empty={
                selectedSvoId
                  ? 'No returned model declares this response variable as an output.'
                  : 'No models suggested.'
              }
            >
              {visibleModelRecommendations.map((item) => (
                <RecommendationCard
                  key={item.id}
                  title={displayLabel(item.id, item.label)}
                  description={item.description}
                  evidence={evidenceText(item)}
                  checked={selectedModelIds.has(item.id)}
                  onToggle={() => toggle(setSelectedModelIds, item.id)}
                />
              ))}
            </RecommendationGroup>
            <RecommendationGroup title="Datasets" empty="No datasets matched the selected context.">
              {recommendedDatasets.map((item) => (
                <RecommendationCard
                  key={item.id}
                  title={item.name}
                  description={item.description}
                  evidence={
                    item.region_match === 'inside'
                      ? 'Coverage overlaps your region'
                      : 'Coverage needs review'
                  }
                  checked={selectedDatasetIds.has(item.id)}
                  onToggle={() => toggle(setSelectedDatasetIds, item.id)}
                />
              ))}
            </RecommendationGroup>
          </div>
        </section>
      )}

      {recommendations && (
        <section className="rounded-lg border p-5">
          <h2 className="mb-4 font-semibold">3. Choose where to save this setup</h2>
          <div className="grid gap-3 md:grid-cols-2">
            <label
              className={`cursor-pointer rounded border p-3 ${destination === 'new' ? 'border-blue-500 bg-blue-50' : ''}`}
            >
              <input
                type="radio"
                name="destination"
                checked={destination === 'new'}
                onChange={() => setDestination('new')}
                className="mr-2"
              />
              Create a new problem statement
            </label>
            <label
              className={`cursor-pointer rounded border p-3 ${destination === 'existing' ? 'border-blue-500 bg-blue-50' : ''}`}
            >
              <input
                type="radio"
                name="destination"
                checked={destination === 'existing'}
                onChange={() => setDestination('existing')}
                className="mr-2"
              />
              Add a task to an existing problem statement
            </label>
          </div>
          {destination === 'new' ? (
            <div className="mt-4 max-w-xl space-y-1.5">
              <Label htmlFor="guided-name">Problem statement name</Label>
              <Input
                id="guided-name"
                value={problemStatementName}
                onChange={(event) => setProblemStatementName(event.target.value)}
              />
            </div>
          ) : (
            <div className="mt-4 max-w-xl space-y-1.5">
              <Label htmlFor="guided-existing">Existing problem statement</Label>
              <Select
                value={existingProblemStatementId}
                onValueChange={setExistingProblemStatementId}
              >
                <SelectTrigger id="guided-existing" aria-label="Existing problem statement">
                  <SelectValue
                    placeholder={statementsLoading ? 'Loading…' : 'Choose a problem statement'}
                  />
                </SelectTrigger>
                <SelectContent>
                  {problemStatements.map((statement) => (
                    <SelectItem key={statement.id} value={statement.id}>
                      {statement.name ?? statement.id}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          {error && (
            <p className="mt-4 text-sm text-destructive" role="alert">
              {error}
            </p>
          )}
          <Button
            className="mt-5"
            onClick={confirmSetup}
            disabled={!canConfirm || (destination === 'existing' && !existingProblemStatementId)}
          >
            {saving ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Check className="mr-2 h-4 w-4" />
            )}
            {saving ? 'Starting setup…' : 'Confirm and start setup'}
          </Button>
          {selectedModelIds.size === 0 && (
            <p className="mt-2 text-xs text-amber-700">Select at least one model to continue.</p>
          )}
        </section>
      )}
    </div>
  );
}

function RecommendationGroup({
  title,
  empty,
  children,
}: {
  title: string;
  empty: string;
  children: ReactNode;
}) {
  const hasChildren = Array.isArray(children) ? children.length > 0 : Boolean(children);
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-semibold">{title}</h3>
      {hasChildren ? children : <p className="text-sm text-muted-foreground">{empty}</p>}
    </div>
  );
}

function RecommendationCard({
  title,
  description,
  evidence,
  checked,
  onToggle,
}: {
  title: string;
  description?: string | null;
  evidence: string | null;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className={`w-full rounded border p-3 text-left transition-colors ${checked ? 'border-blue-500 bg-blue-50' : 'hover:bg-muted/40'}`}
      aria-pressed={checked}
    >
      <div className="flex items-start gap-2">
        <span
          className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border ${checked ? 'border-blue-600 bg-blue-600 text-white' : 'border-muted-foreground'}`}
        >
          {checked && <Check className="h-3 w-3" />}
        </span>
        <span className="min-w-0">
          <span className="block text-sm font-medium">{title}</span>
          {description && (
            <span className="mt-1 line-clamp-2 block text-xs text-muted-foreground">
              {description}
            </span>
          )}
          {evidence && <span className="mt-1 block text-xs text-blue-700">{evidence}</span>}
        </span>
      </div>
    </button>
  );
}
