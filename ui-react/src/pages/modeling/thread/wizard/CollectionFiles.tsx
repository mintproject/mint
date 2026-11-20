import { useEffect, useMemo, useState } from 'react';

import { loadDatasetResources, type DataCatalogResource } from '@/lib/data-catalog';
import {
  COLLECTION_FILE_CAP,
  collectionDefaultSelection,
  isGatherableUrl,
} from '@/lib/thread-datasets';

export const COLLECTION_EXPLANATION =
  'All the files you select are read together as one input. This is one run.';
export const NOT_GATHERABLE_MESSAGE =
  "This file's location cannot be gathered (only https and Tapis storage locations)";

interface CollectionFilesProps {
  datasetId: string;
  /** Standard-variable names the input reads; narrows the dataset's files. */
  variables: string[];
  /** Files already bound to this input, read back from the database. */
  initial?: DataCatalogResource[];
  /** Called with the files chosen, whenever the choice changes. */
  onChange: (chosen: DataCatalogResource[]) => void;
}

/**
 * The file chooser for an input that takes a collection.
 *
 * Unlike an ordinary input, where every file of the dataset is one run, here the
 * chosen files are one input, so the person can pick which and how many. Files
 * whose location the backend cannot gather are shown but cannot be chosen, and
 * the choice is capped at the backend's limit.
 */
export function CollectionFiles({ datasetId, variables, initial, onChange }: CollectionFilesProps) {
  const [files, setFiles] = useState<DataCatalogResource[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const variableKey = variables.join('|');

  useEffect(() => {
    let live = true;
    setFiles(null);
    setError(null);
    loadDatasetResources({ datasetId, variableNames: variables })
      .then((loaded) => {
        if (!live) return;
        const wanted = (initial ?? []).filter((r) => r.selected !== false).map((r) => r.id);
        const kept = wanted.length
          ? loaded.filter((r) => wanted.includes(r.id) && isGatherableUrl(r.url))
          : collectionDefaultSelection(loaded);
        setFiles(loaded);
        setPicked(new Set(kept.slice(0, COLLECTION_FILE_CAP).map((r) => r.id)));
      })
      .catch((err) => live && setError(String(err)));
    return () => {
      live = false;
    };
    // `initial` is only the starting point for a freshly loaded dataset.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [datasetId, variableKey]);

  useEffect(() => {
    if (files) onChange(files.filter((r) => picked.has(r.id)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files, picked]);

  const gatherable = useMemo(() => (files ?? []).filter((r) => isGatherableUrl(r.url)), [files]);

  if (error) return <p className="mt-2 text-xs text-red-700">Could not list the files: {error}</p>;
  if (!files) return <p className="mt-2 text-xs text-gray-500">Loading files…</p>;

  const atCap = picked.size >= COLLECTION_FILE_CAP;
  const toggle = (id: string, on: boolean) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (on && next.size < COLLECTION_FILE_CAP) next.add(id);
      else if (!on) next.delete(id);
      return next;
    });

  return (
    <div className="mt-2 space-y-2 rounded border border-purple-200 bg-purple-50 p-2 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium text-purple-900" data-testid="collection-count">
          {picked.size} {picked.size === 1 ? 'file' : 'files'}, read together
        </span>
        <span className="flex gap-2">
          <button
            type="button"
            className="rounded border border-purple-300 bg-white px-2 py-1 text-purple-800 hover:bg-purple-100"
            onClick={() => setPicked(new Set(collectionDefaultSelection(files).map((r) => r.id)))}
          >
            Select all {Math.min(gatherable.length, COLLECTION_FILE_CAP)} files
          </button>
          <button
            type="button"
            className="rounded border border-gray-300 bg-white px-2 py-1 text-gray-700 hover:bg-gray-100"
            onClick={() => setPicked(new Set())}
          >
            Clear
          </button>
        </span>
      </div>
      {(gatherable.length > COLLECTION_FILE_CAP || atCap) && (
        <p className="text-amber-800" role="status">
          At most {COLLECTION_FILE_CAP} files can be read as one input.
          {gatherable.length > COLLECTION_FILE_CAP &&
            ` This dataset has ${gatherable.length}; select the ones you need.`}
        </p>
      )}
      <ul className="max-h-48 space-y-1 overflow-y-auto">
        {files.map((file) => {
          const ok = isGatherableUrl(file.url);
          const checked = picked.has(file.id);
          return (
            <li key={file.id}>
              <label
                className={ok ? 'flex items-center gap-2' : 'flex items-center gap-2 opacity-60'}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={!ok || (!checked && atCap)}
                  onChange={(e) => toggle(file.id, e.target.checked)}
                  aria-label={file.name}
                />
                <span className="break-all">{file.name}</span>
              </label>
              {!ok && <p className="ml-6 text-red-700">{NOT_GATHERABLE_MESSAGE}</p>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
