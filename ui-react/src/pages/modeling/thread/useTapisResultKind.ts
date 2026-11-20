/**
 * useTapisResultKind — whether Tapis says a result location is a file or a
 * folder, and how big the file is.
 *
 * The Ensemble Manager lists a run with each result marked by Tapis; the name of
 * the location is never used to guess. The size comes from the same listing.
 */
import { useEffect, useState } from 'react';

import {
  fetchExecutionListing,
  type ExecutionFile,
  type ExecutionResultLocation,
} from '@/lib/ensemble-manager';

interface Listing {
  files: ExecutionFile[];
  results: ExecutionResultLocation[];
}

// Cells of one run ask for the same listing; share the request while it is in flight.
const inFlight = new Map<string, Promise<Listing>>();

function loadListing(api: string, executionId: string): Promise<Listing> {
  const key = `${api}|${executionId}`;
  let pending = inFlight.get(key);
  if (!pending) {
    pending = fetchExecutionListing(api, executionId).finally(() => inFlight.delete(key));
    inFlight.set(key, pending);
  }
  return pending;
}

export type TapisResultKind = 'file' | 'folder' | 'unknown' | 'error';

export interface TapisResultInfo {
  kind: TapisResultKind;
  /** The file's size in bytes when the listing gives one, else null. */
  size: number | null;
}

export function useTapisResultInfo(
  ensembleManagerApi: string,
  executionId: string,
  url: string,
  enabled = true,
): TapisResultInfo {
  const [info, setInfo] = useState<TapisResultInfo>({ kind: 'unknown', size: null });

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    setInfo({ kind: 'unknown', size: null });
    loadListing(ensembleManagerApi, executionId)
      .then(({ files, results }) => {
        if (cancelled) return;
        const match = results.find((result) => result.url === url);
        const size = files.find((file) => file.url === url)?.size;
        setInfo(
          match
            ? { kind: match.kind, size: typeof size === 'number' && size > 0 ? size : null }
            : { kind: 'error', size: null },
        );
      })
      .catch(() => !cancelled && setInfo({ kind: 'error', size: null }));
    return () => {
      cancelled = true;
    };
  }, [ensembleManagerApi, executionId, url, enabled]);

  return info;
}

/** Just the kind, for a result that needs no size. */
export function useTapisResultKind(
  ensembleManagerApi: string,
  executionId: string,
  url: string,
  enabled = true,
): TapisResultKind {
  return useTapisResultInfo(ensembleManagerApi, executionId, url, enabled).kind;
}
