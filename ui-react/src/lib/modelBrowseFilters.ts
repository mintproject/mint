/**
 * modelBrowseFilters — pure helpers for the /models browse filters.
 *
 * Filters live in the URL (text query + three facet id lists + a models/flows
 * kind) and are compiled into a Hasura `where` for SearchModelConfigurations.
 * Facets are AND-combined across dimensions and OR-combined within a dimension
 * (`_in`).
 *
 * The kind is not part of the `where`: which configurations are flows comes from
 * a separate query (see useFlowConfigurationIds), so it is applied to the rows
 * afterwards by `filterRowsByKind`, and a deployment where that query fails
 * still lists every model.
 */
import type { Modelcatalog_Configuration_Bool_Exp } from '@/graphql/generated/graphql';

export type ModelKind = 'all' | 'models' | 'flows';

export interface ModelBrowseFilters {
  q: string;
  regionIds: string[];
  categoryIds: string[];
  variableIds: string[];
  kind: ModelKind;
}

export const EMPTY_FILTERS: ModelBrowseFilters = {
  q: '',
  regionIds: [],
  categoryIds: [],
  variableIds: [],
  kind: 'all',
};

export function hasActiveFilters(filters: ModelBrowseFilters): boolean {
  return (
    filters.q.trim().length > 0 ||
    filters.regionIds.length > 0 ||
    filters.categoryIds.length > 0 ||
    filters.variableIds.length > 0 ||
    filters.kind !== 'all'
  );
}

export function buildConfigurationWhere(
  filters: ModelBrowseFilters,
): Modelcatalog_Configuration_Bool_Exp {
  const and: Modelcatalog_Configuration_Bool_Exp[] = [];

  const q = filters.q.trim();
  if (q) {
    const pattern = `%${q}%`;
    and.push({
      _or: [
        { label: { _ilike: pattern } },
        { software_version: { software: { label: { _ilike: pattern } } } },
        {
          parent_configuration: { software_version: { software: { label: { _ilike: pattern } } } },
        },
      ],
    });
  }

  if (filters.categoryIds.length > 0) {
    and.push({ categories: { category_id: { _in: filters.categoryIds } } });
  }

  if (filters.regionIds.length > 0) {
    and.push({ regions: { region_id: { _in: filters.regionIds } } });
  }

  if (filters.variableIds.length > 0) {
    and.push({
      outputs: {
        output: {
          presentations: {
            presentation: { standard_variable: { id: { _in: filters.variableIds } } },
          },
        },
      },
    });
  }

  return and.length > 0 ? { _and: and } : {};
}

function parseKind(value: string | null): ModelKind {
  return value === 'models' || value === 'flows' ? value : 'all';
}

/**
 * Keep the rows of the chosen kind. A setup (a row with a parent configuration)
 * takes its parent's kind, since a flow has no setups of its own.
 */
export function filterRowsByKind<T extends { id: string; model_configuration_id?: string | null }>(
  rows: readonly T[],
  kind: ModelKind,
  flowIds: ReadonlySet<string>,
): T[] {
  if (kind === 'all') return [...rows];
  return rows.filter(
    (row) => flowIds.has(row.model_configuration_id ?? row.id) === (kind === 'flows'),
  );
}

export function parseFilters(params: URLSearchParams): ModelBrowseFilters {
  return {
    q: params.get('q') ?? '',
    regionIds: params.getAll('region'),
    categoryIds: params.getAll('category'),
    variableIds: params.getAll('variable'),
    kind: parseKind(params.get('type')),
  };
}

/** Serialize filters into URLSearchParams (repeated params per facet dimension). */
export function filtersToParams(filters: ModelBrowseFilters): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.q.trim()) params.set('q', filters.q);
  filters.regionIds.forEach((id) => params.append('region', id));
  filters.categoryIds.forEach((id) => params.append('category', id));
  filters.variableIds.forEach((id) => params.append('variable', id));
  if (filters.kind !== 'all') params.set('type', filters.kind);
  return params;
}
