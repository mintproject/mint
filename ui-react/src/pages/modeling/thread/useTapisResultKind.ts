/**
 * useTapisResultKind — whether Tapis says a result location is a file or a folder.
 *
 * The Ensemble Manager lists a run with each result marked by Tapis; the name of
 * the location is never used to guess.
 */
import { useEffect, useState } from 'react';

import { fetchExecutionListing, type ExecutionResultLocation } from '@/lib/ensemble-manager';

// Cells of one run ask for the same listing; share the request while it is in flight.
const inFlight = new Map<string, Promise<ExecutionResultLocation[]>>();

function loadResultKinds(api: string, executionId: string): Promise<ExecutionResultLocation[]> {
  const key = `${api}|${executionId}`;
  let pending = inFlight.get(key);
  if (!pending) {
    pending = fetchExecutionListing(api, executionId)
      .then((listing) => listing.results)
      .finally(() => inFlight.delete(key));
    inFlight.set(key, pending);
  }
  return pending;
}

export type TapisResultKind = 'file' | 'folder' | 'unknown' | 'error';

/** Whether Tapis says a result location is a file or a folder (the name is never used to guess). */
export function useTapisResultKind(
  ensembleManagerApi: string,
  executionId: string,
  url: string,
  enabled = true,
): TapisResultKind {
  const [kind, setKind] = useState<TapisResultKind>('unknown');

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    setKind('unknown');
    loadResultKinds(ensembleManagerApi, executionId)
      .then((results) => {
        if (cancelled) return;
        const match = results.find((result) => result.url === url);
        setKind(match ? match.kind : 'error');
      })
      .catch(() => !cancelled && setKind('error'));
    return () => {
      cancelled = true;
    };
  }, [ensembleManagerApi, executionId, url, enabled]);

  return kind;
}
