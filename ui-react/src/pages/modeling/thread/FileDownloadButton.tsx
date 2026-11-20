/**
 * FileDownloadButton — save one Tapis result file through the Ensemble Manager.
 *
 * A browser cannot open a `tapis://` URI. The Ensemble Manager streams the file
 * from Tapis with the user's own token, and this button saves it from a blob URL.
 */
import { Download } from 'lucide-react';
import { useState } from 'react';

import { downloadExecutionFile, parseTapisUri, saveBlob } from '@/lib/ensemble-manager';

export interface FileDownloadButtonProps {
  ensembleManagerApi: string;
  executionId: string;
  /** The `tapis://` URI of the file. */
  url: string;
  testId?: string;
}

export function FileDownloadButton({
  ensembleManagerApi,
  executionId,
  url,
  testId = 'download-file',
}: FileDownloadButtonProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const location = parseTapisUri(url);
  if (!location) return null;

  const handleClick = async () => {
    setBusy(true);
    setError('');
    try {
      const { blob, filename } = await downloadExecutionFile(
        ensembleManagerApi,
        executionId,
        location,
      );
      saveBlob(blob, filename);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not download the file');
    } finally {
      setBusy(false);
    }
  };

  return (
    <span className="inline-flex flex-col">
      <button
        type="button"
        data-testid={testId}
        onClick={() => void handleClick()}
        disabled={busy}
        className="inline-flex items-center gap-1 rounded border px-1.5 py-0.5 hover:bg-gray-50 disabled:opacity-40"
      >
        {busy ? (
          <span
            data-testid={`${testId}-spinner`}
            className="h-3 w-3 animate-spin rounded-full border-2 border-blue-600 border-t-transparent"
          />
        ) : (
          <Download className="h-3 w-3" />
        )}
        Download
      </button>
      {error && (
        <span role="alert" data-testid={`${testId}-error`} className="text-xs text-red-600">
          {error}
        </span>
      )}
    </span>
  );
}
