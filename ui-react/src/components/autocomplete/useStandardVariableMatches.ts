/**
 * useStandardVariableMatches
 *
 * The "find" half of find-before-create: the standard variables that resemble a
 * search string. Semantic search ranks them when the service answers; otherwise
 * the local ranker runs over the catalog. Shared by the unit picker's dead-end
 * gate and CreateStandardVariableDialog so both offer creation under one rule.
 */

import * as React from 'react';

import { useSemanticSearch } from '@/hooks/useSemanticSearch';
import { rankStandardVariables } from '@/lib/standard-variable-search';
import type { StandardVariableOption } from '@/components/autocomplete/StandardVariableCombobox';

export interface StandardVariableMatches {
  /** Ranked matches for the search; empty when the search is blank. */
  results: StandardVariableOption[];
  /** True while the semantic service is still answering. */
  loading: boolean;
  /** A non-blank search that found nothing: the point where create is offered. */
  isDeadEnd: boolean;
}

export function useStandardVariableMatches(
  search: string,
  catalog: StandardVariableOption[],
): StandardVariableMatches {
  const localResults = React.useMemo(
    () => (search.trim() === '' ? [] : rankStandardVariables(catalog, search)),
    [catalog, search],
  );
  const semanticSearch = useSemanticSearch(search, { target: 'svo', limit: 50 });
  const semanticResults = React.useMemo<StandardVariableOption[] | null>(
    () =>
      semanticSearch.results?.map((result) => ({
        id: result.id,
        label: result.label ?? '',
        description: result.description ?? null,
      })) ?? null,
    [semanticSearch.results],
  );
  const results = semanticResults ?? localResults;
  const loading = semanticSearch.loading;
  return {
    results,
    loading,
    isDeadEnd: !loading && search.trim() !== '' && results.length === 0,
  };
}
