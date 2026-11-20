/**
 * ModelsBrowsePage — the model find/configure experience.
 *
 * Left column: semantic text search + facet filters (Region / Category / Output
 * variable) over a server-side-filtered, client-grouped Model -> Config -> Setup
 * list. Right column: detail for the config/setup in the URL. The URL is the
 * source of truth for facet filters and selection; text search never touches it.
 *
 * Mounted at two routes that share the same left panel:
 *   - /models + /modelconfigurations/:slugid — read-only browse.
 *   - /models/configure/:slugid (editable)   — same panel, but the detail pane
 *     exposes an Edit button that opens the inline ConfigurationForm.
 */
import { useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Search } from 'lucide-react';
import { useApolloClient, useMutation, useQuery } from '@apollo/client';

import {
  useSearchModelConfigurationsQuery,
  type SearchModelConfigurationsQuery,
} from '@/graphql/generated/graphql';
import { groupConfigurations, rankModelGroups } from '@/lib/groupConfigurations';
import {
  buildConfigurationWhere,
  filterRowsByKind,
  filtersToParams,
  hasActiveFilters,
  parseFilters,
  type ModelBrowseFilters,
  type ModelKind,
} from '@/lib/modelBrowseFilters';
import { slugMatchPattern } from '@/lib/uri';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { useSemanticSearch } from '@/hooks/useSemanticSearch';
import { useFlowConfigurationIds } from '@/hooks/useFlowConfigurationIds';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { ConfigurationDetail } from '@/components/configuration/ConfigurationDetail';
import { ConfigurationForm } from '@/components/configuration/ConfigurationForm';
import { FacetSelect } from './FacetSelect';
import { ModelGroupList } from './ModelGroupList';
import { useFacetOptions } from './useFacetOptions';
import { useGetConfigurationBySlugQuery } from '@/graphql/generated/graphql';
import {
  DELETE_MODEL_CONFIGURATION,
  GET_OWNED_MODEL_CONFIGURATIONS,
  type OwnedModelConfigurationsData,
} from '@/graphql/owned-model-configurations';
import { useAuth } from '@/lib/auth/useAuth';
import { useToast } from '@/components/ui/use-toast';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { Switch } from '@/components/ui/switch';

type ModelConfigurationRow = SearchModelConfigurationsQuery['modelcatalog_configuration'][number];

export interface ModelsBrowsePageProps {
  /** When true, the detail pane allows editing the selected configuration. */
  editable?: boolean;
  /** Route prefix for left-panel row links (the slug is appended). */
  basePath?: string;
}

export function ModelsBrowsePage({
  editable = false,
  basePath = '/modelconfigurations',
}: ModelsBrowsePageProps = {}) {
  const navigate = useNavigate();
  const apolloClient = useApolloClient();
  const { toast } = useToast();
  const { user } = useAuth();
  const { slugid } = useParams<{ slugid: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  // Drop any `q` from the URL — text search is intentionally not URL-driven.
  const facetFilters = useMemo(() => ({ ...parseFilters(searchParams), q: '' }), [searchParams]);

  // Text search is not URL-driven. Facets remain URL-backed hard filters.
  const [text, setText] = useState('');
  const debouncedText = useDebouncedValue(text, 300);

  const filters = useMemo(
    () => ({ ...facetFilters, q: debouncedText }),
    [facetFilters, debouncedText],
  );

  const semanticQuery = debouncedText.trim();
  const semanticQueryActive = semanticQuery.length >= 2;
  const semanticFilters = useMemo(
    () => ({
      regionIds: facetFilters.regionIds,
      categoryIds: facetFilters.categoryIds,
      outputVariableIds: facetFilters.variableIds,
    }),
    [facetFilters],
  );
  const semanticSearch = useSemanticSearch(semanticQuery, {
    target: 'model_configuration',
    limit: 100,
    filters: semanticFilters,
  });

  const updateFacet = (partial: Partial<ModelBrowseFilters>) => {
    setSearchParams(filtersToParams({ ...facetFilters, ...partial }));
  };

  const facetOptions = useFacetOptions();
  const flows = useFlowConfigurationIds();
  const hasuraFilters = useMemo(
    () => (semanticQueryActive && !semanticSearch.error ? { ...facetFilters, q: '' } : filters),
    [facetFilters, filters, semanticQueryActive, semanticSearch.error],
  );
  const where = useMemo(() => buildConfigurationWhere(hasuraFilters), [hasuraFilters]);
  const { data, loading, error, refetch } = useSearchModelConfigurationsQuery({
    variables: { where },
  });
  const {
    data: ownedData,
    loading: ownedLoading,
    refetch: refetchOwned,
  } = useQuery<OwnedModelConfigurationsData>(GET_OWNED_MODEL_CONFIGURATIONS, {
    variables: { ownerUsername: user?.username ?? '' },
    skip: !user?.username,
  });
  const [deleteConfiguration] = useMutation(DELETE_MODEL_CONFIGURATION);
  const [showOwnedOnly, setShowOwnedOnly] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; label: string } | null>(null);

  const ownedIds = useMemo(
    () => new Set<string>((ownedData?.modelcatalog_configuration ?? []).map((row) => row.id)),
    [ownedData],
  );
  const deletableIds = useMemo(
    () =>
      new Set<string>(
        (ownedData?.modelcatalog_configuration ?? [])
          .filter((row) => row.child_configurations.length === 0)
          .map((row) => row.id),
      ),
    [ownedData],
  );

  const semanticRows = useMemo(() => {
    if (!semanticQueryActive || !semanticSearch.results) return null;
    const rankById = new Map(semanticSearch.results.map((result, index) => [result.id, index]));
    const rows = (data?.modelcatalog_configuration ?? [])
      .map((row) => {
        const rank =
          rankById.get(row.id) ??
          (row.model_configuration_id ? rankById.get(row.model_configuration_id) : undefined) ??
          (row.parent_configuration ? rankById.get(row.parent_configuration.id) : undefined);
        return rank === undefined ? null : { row, rank };
      })
      .filter((item): item is { row: ModelConfigurationRow; rank: number } => item !== null)
      .sort((a, b) => a.rank - b.rank)
      .map((item) => item.row);
    return { rows, rankById };
  }, [data, semanticQueryActive, semanticSearch.results]);

  const groups = useMemo(() => {
    const rows = semanticRows?.rows ?? data?.modelcatalog_configuration ?? [];
    // Without the flow ids the kind cannot be told apart, so it is not applied.
    const grouped = groupConfigurations(
      flows.known ? filterRowsByKind(rows, facetFilters.kind, flows.ids) : rows,
    );
    return semanticRows ? rankModelGroups(grouped, semanticRows.rankById) : grouped;
  }, [data, semanticRows, flows, facetFilters.kind]);
  const visibleGroups = useMemo(
    () =>
      showOwnedOnly
        ? groups
            .map((group) => ({
              ...group,
              configs: group.configs.filter((config) => ownedIds.has(config.id)),
            }))
            .filter((group) => group.configs.length > 0)
        : groups,
    [groups, ownedIds, showOwnedOnly],
  );
  const active = hasActiveFilters(filters);
  const listLoading =
    loading || (semanticQueryActive && semanticSearch.loading) || (showOwnedOnly && ownedLoading);

  const handleDelete = async () => {
    if (!deleteTarget) return;
    const target = deleteTarget;
    try {
      const result = await deleteConfiguration({ variables: { id: target.id } });
      if (!result.data?.delete_modelcatalog_configuration_by_pk) {
        throw new Error('The model configuration was not deleted. You may no longer own it.');
      }
      await Promise.all([refetch(), refetchOwned()]);
      apolloClient.cache.evict({
        id: apolloClient.cache.identify({
          __typename: 'modelcatalog_configuration',
          id: target.id,
        }),
      });
      apolloClient.cache.gc();
      setDeleteTarget(null);
      navigate('/models');
      toast({
        title: 'Model configuration deleted',
        description: `${target.label} was deleted successfully.`,
      });
    } catch (err) {
      toast({
        title: 'Could not delete model configuration',
        description: err instanceof Error ? err.message : 'Deletion failed.',
        variant: 'destructive',
      });
    }
  };

  return (
    <div className="flex h-full overflow-hidden">
      <aside className="flex w-96 shrink-0 flex-col border-r">
        <div className="flex flex-col gap-2 border-b p-3">
          <h2 className="text-base font-semibold">Models</h2>
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Filter by model name…"
              className="h-9 pl-8"
            />
          </div>
          <div className="flex flex-wrap gap-1.5">
            <FacetSelect
              label="Region"
              options={facetOptions.regions}
              selectedIds={filters.regionIds}
              onChange={(ids) => updateFacet({ regionIds: ids })}
              loading={facetOptions.loading}
            />
            <FacetSelect
              label="Category"
              options={facetOptions.categories}
              selectedIds={filters.categoryIds}
              onChange={(ids) => updateFacet({ categoryIds: ids })}
              loading={facetOptions.loading}
            />
            <FacetSelect
              label="Output variable"
              options={facetOptions.variables}
              selectedIds={filters.variableIds}
              onChange={(ids) => updateFacet({ variableIds: ids })}
              loading={facetOptions.loading}
            />
            {flows.known && (
              <KindFacet value={facetFilters.kind} onChange={(kind) => updateFacet({ kind })} />
            )}
            {user?.username && (
              <label className="flex items-center gap-2 rounded-md border px-2 py-1 text-xs">
                <Switch
                  checked={showOwnedOnly}
                  onCheckedChange={setShowOwnedOnly}
                  aria-label="Show my models only"
                />
                My models
              </label>
            )}
          </div>
        </div>
        <div className="flex-1 overflow-auto p-2">
          {listLoading ? (
            <ListSkeleton />
          ) : error ? (
            <p className="px-1 py-8 text-center text-sm text-destructive">{error.message}</p>
          ) : (
            <ModelGroupList
              groups={visibleGroups}
              selectedSlug={slugid ?? null}
              expandAll={active}
              basePath={basePath}
              ownedIds={ownedIds}
              flowIds={flows.ids}
              emptyMessage={
                showOwnedOnly ? 'You have not registered any model configurations.' : undefined
              }
            />
          )}
        </div>
      </aside>

      <main className="flex-1 overflow-auto p-6">
        <DetailPane
          slug={slugid}
          editable={editable}
          deletableIds={deletableIds}
          onRequestDelete={(target) => setDeleteTarget(target)}
        />
      </main>
      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title="Delete model configuration?"
        description={
          deleteTarget
            ? `Delete ${deleteTarget.label}? This removes its catalog metadata. Existing execution records are preserved, but their configuration link may be cleared.`
            : ''
        }
        onConfirm={handleDelete}
        confirmLabel="Delete configuration"
        variant="destructive"
      />
    </div>
  );
}

const KIND_OPTIONS: { value: ModelKind; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'models', label: 'Models' },
  { value: 'flows', label: 'Flows' },
];

/** All / Models / Flows: a flow is a model configuration made of ETL pieces. */
function KindFacet({ value, onChange }: { value: ModelKind; onChange: (kind: ModelKind) => void }) {
  return (
    <div role="group" aria-label="Kind" className="flex overflow-hidden rounded-md border text-xs">
      {KIND_OPTIONS.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
          className={
            value === option.value
              ? 'bg-accent px-2 py-1 font-medium'
              : 'px-2 py-1 text-muted-foreground hover:bg-accent'
          }
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function DetailPane({
  slug,
  editable,
  deletableIds,
  onRequestDelete,
}: {
  slug?: string;
  editable: boolean;
  deletableIds: ReadonlySet<string>;
  onRequestDelete: (target: { id: string; label: string }) => void;
}) {
  const { data, loading } = useGetConfigurationBySlugQuery({
    variables: { pattern: slug ? slugMatchPattern(slug) : '' },
    skip: !slug,
  });

  if (!slug) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Select a configuration or setup on the left.
      </div>
    );
  }
  if (loading) {
    return <ListSkeleton />;
  }
  const id = data?.modelcatalog_configuration?.[0]?.id;
  if (!id) {
    return <p className="text-sm text-destructive">Configuration not found.</p>;
  }
  return editable ? (
    <EditableDetail
      key={id}
      configurationId={id}
      onRequestDelete={deletableIds.has(id) ? (label) => onRequestDelete({ id, label }) : undefined}
    />
  ) : (
    <ConfigurationDetail
      configurationId={id}
      onDelete={deletableIds.has(id) ? (label) => onRequestDelete({ id, label }) : undefined}
    />
  );
}

/**
 * Read-only detail first, with an Edit button that opens the inline form.
 * Keyed by configurationId so switching selection resets edit state.
 */
function EditableDetail({
  configurationId,
  onRequestDelete,
}: {
  configurationId: string;
  onRequestDelete?: (label: string) => void;
}) {
  const [isEditing, setIsEditing] = useState(false);

  if (isEditing) {
    return (
      <ConfigurationForm
        configurationId={configurationId}
        onSaved={() => setIsEditing(false)}
        onCancel={() => setIsEditing(false)}
      />
    );
  }
  return (
    <ConfigurationDetail
      configurationId={configurationId}
      onEdit={() => setIsEditing(true)}
      onDelete={onRequestDelete}
    />
  );
}

function ListSkeleton() {
  return (
    <div className="space-y-2 p-1">
      {Array.from({ length: 6 }).map((_, i) => (
        <Skeleton key={i} className="h-6 w-full" />
      ))}
    </div>
  );
}
