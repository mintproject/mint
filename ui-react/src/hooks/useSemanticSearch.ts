import { useEffect, useState } from 'react';

import { getSemanticSearchApiUrl } from '@/lib/config';

export type SemanticSearchTarget = 'svo' | 'model_configuration' | 'etl_piece';

export interface SemanticSearchFilters {
  regionIds?: string[];
  categoryIds?: string[];
  variableIds?: string[];
  outputVariableIds?: string[];
  role?: 'input' | 'output';
}

export interface SemanticSearchResult {
  id: string;
  label?: string | null;
  description?: string | null;
  score?: number;
  ranking_source?: string | null;
  [key: string]: unknown;
}

/** One input or output of an ETL piece, as `target=etl_piece` reports it. */
export interface SemanticPieceSlot {
  position: number;
  standard_variable_uri?: string | null;
  label?: string | null;
  format?: string | null;
}

/** A `target=etl_piece` result: the base fields plus the piece's contract. */
export interface SemanticPieceResult extends SemanticSearchResult {
  visibility?: string | null;
  owner_username?: string | null;
  inputs?: SemanticPieceSlot[];
  outputs?: SemanticPieceSlot[];
}

export interface SemanticSearchOptions {
  target: SemanticSearchTarget;
  limit?: number;
  minLength?: number;
  enabled?: boolean;
  filters?: SemanticSearchFilters;
}

function appendRepeated(params: URLSearchParams, key: string, values: string[] | undefined) {
  values?.forEach((value) => params.append(key, value));
}

export function buildSemanticSearchUrl(
  query: string,
  {
    target,
    limit = 50,
    filters,
    baseUrl = getSemanticSearchApiUrl(),
  }: SemanticSearchOptions & { baseUrl?: string },
): string {
  const params = new URLSearchParams({ q: query.trim(), target, limit: String(limit) });
  appendRepeated(params, 'region_id', filters?.regionIds);
  appendRepeated(params, 'category_id', filters?.categoryIds);
  appendRepeated(params, 'variable_id', filters?.variableIds);
  appendRepeated(params, 'output_variable_id', filters?.outputVariableIds);
  if (filters?.role) params.set('role', filters.role);
  return `${baseUrl.replace(/\/$/, '')}/search?${params.toString()}`;
}

export async function searchSemanticCatalog(
  query: string,
  options: SemanticSearchOptions & { signal?: AbortSignal },
): Promise<SemanticSearchResult[]> {
  const response = await fetch(buildSemanticSearchUrl(query, options), {
    signal: options.signal,
  });
  if (!response.ok) throw new Error(`Semantic search failed (${response.status})`);
  const body: unknown = await response.json();
  if (
    !body ||
    typeof body !== 'object' ||
    !Array.isArray((body as { results?: unknown }).results)
  ) {
    throw new Error('Semantic search returned an invalid response');
  }
  return (body as { results: SemanticSearchResult[] }).results;
}

export function useSemanticSearch(
  query: string,
  { target, limit = 50, minLength = 2, enabled = true, filters }: SemanticSearchOptions,
) {
  const [results, setResults] = useState<SemanticSearchResult[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    const trimmed = query.trim();
    if (!enabled || trimmed.length < minLength) {
      setResults(null);
      setLoading(false);
      setError(null);
      return;
    }

    const controller = new AbortController();
    let active = true;
    setResults(null);
    setLoading(true);
    setError(null);

    searchSemanticCatalog(trimmed, { target, limit, filters, signal: controller.signal })
      .then((nextResults) => {
        if (!active) return;
        setResults(nextResults);
        setLoading(false);
      })
      .catch((reason: unknown) => {
        if (!active || controller.signal.aborted) return;
        setResults(null);
        setLoading(false);
        setError(reason instanceof Error ? reason : new Error(String(reason)));
      });

    return () => {
      active = false;
      controller.abort();
    };
  }, [enabled, filters, limit, minLength, query, target]);

  return { results, loading, error };
}

export interface SimilarVariable {
  id: string;
  label?: string | null;
  description?: string | null;
  score?: number;
}

/**
 * `GET /similar?target=svo&id=&limit=`: the standard variables closest in
 * meaning to one. An empty list (the service also sends a `status` then) is a
 * normal answer, not an error.
 */
export async function fetchSimilarVariables(
  id: string,
  { limit = 5, signal }: { limit?: number; signal?: AbortSignal } = {},
): Promise<SimilarVariable[]> {
  const params = new URLSearchParams({ target: 'svo', id, limit: String(limit) });
  const response = await fetch(`${getSemanticSearchApiUrl()}/similar?${params.toString()}`, {
    signal,
  });
  if (!response.ok) throw new Error(`Similar variables failed (${response.status})`);
  const body: unknown = await response.json();
  const results = (body as { results?: unknown } | null)?.results;
  if (!Array.isArray(results)) return [];
  return (results as SimilarVariable[]).filter((item) => item && typeof item.id === 'string');
}

export function useSimilarVariables(
  id: string | null | undefined,
  { limit = 5, enabled = true }: { limit?: number; enabled?: boolean } = {},
) {
  const [results, setResults] = useState<SimilarVariable[] | null>(null);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    setResults(null);
    setError(null);
    if (!enabled || !id) return;
    const controller = new AbortController();
    fetchSimilarVariables(id, { limit, signal: controller.signal })
      .then((list) => {
        if (!controller.signal.aborted) setResults(list);
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return;
        setError(reason instanceof Error ? reason : new Error(String(reason)));
      });
    return () => controller.abort();
  }, [enabled, id, limit]);

  return { results, error };
}
