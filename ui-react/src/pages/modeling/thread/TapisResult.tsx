/**
 * TapisResult — one result whose URL is a `tapis://` storage location.
 *
 * A browser cannot open `tapis://`, so the result is not a link. Tapis says (via
 * the Ensemble Manager's listing of the run) whether the location is a file or a
 * folder; the name of the location is never used to guess. A file offers a
 * download through the Ensemble Manager, a folder opens the files dialog.
 */
import { Copy, FolderOpen } from 'lucide-react';

import { FileDownloadButton } from './FileDownloadButton';
import { useTapisResultKind } from './useTapisResultKind';

export interface TapisResultProps {
  ensembleManagerApi: string;
  executionId: string;
  name: string;
  url: string;
  onOpenFolder: (executionId: string) => void;
}

export function TapisResult({
  ensembleManagerApi,
  executionId,
  name,
  url,
  onOpenFolder,
}: TapisResultProps) {
  const kind = useTapisResultKind(ensembleManagerApi, executionId, url);

  return (
    <span className="inline-flex flex-wrap items-center gap-1" data-testid="tapis-result">
      <span>{name}</span>
      {kind === 'file' && (
        <FileDownloadButton
          ensembleManagerApi={ensembleManagerApi}
          executionId={executionId}
          url={url}
        />
      )}
      {kind === 'folder' && (
        <button
          type="button"
          data-testid="open-folder"
          onClick={() => onOpenFolder(executionId)}
          className="inline-flex items-center gap-1 rounded border px-1.5 py-0.5 hover:bg-gray-50"
        >
          <FolderOpen className="h-3 w-3" />
          Open folder
        </button>
      )}
      {kind === 'unknown' && <span className="text-gray-400">…</span>}
      {kind === 'error' && (
        <span
          className="text-gray-400"
          title="Tapis could not say whether this is a file or a folder"
        >
          (location not readable)
        </span>
      )}
      <button
        type="button"
        data-testid="copy-location"
        title={url}
        onClick={() => void navigator.clipboard?.writeText(url)}
        className="inline-flex items-center gap-1 rounded px-1 py-0.5 text-gray-500 hover:bg-gray-100"
      >
        <Copy className="h-3 w-3" />
        Copy location
      </button>
    </span>
  );
}
