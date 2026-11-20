/**
 * ResultPreview — the start of one result file, shown inline.
 *
 * Read only when the block is open (it mounts then): a Markdown report rendered,
 * the first rows of a CSV as a small table, JSON indented. A Tapis file is read
 * through the same Ensemble Manager route, with the same token, as its Download
 * button, and only its first 200 KB is pulled (the body is cancelled at the cap).
 * A web address is never read from here. If the file cannot be read, the preview says so quietly and
 * offers the Download instead.
 */
import { useEffect, useState, type ReactNode } from 'react';

import { MarkdownLite } from '@/components/common/MarkdownLite';
import { parseTapisUri, readExecutionFilePrefix } from '@/lib/ensemble-manager';
import {
  PREVIEW_CSV_ROWS,
  PREVIEW_MAX_BYTES,
  decodePreviewText,
  parseCsvRows,
  prettyJson,
  type PreviewKind,
} from '@/lib/result-preview';

type State =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; text: string; truncated: boolean };

export interface ResultPreviewProps {
  kind: PreviewKind;
  ensembleManagerApi: string;
  executionId: string;
  /** The `tapis://` location of the file. Only Tapis files are previewed. */
  url: string;
  /** The Download control, repeated beside the fallback message. */
  download?: ReactNode;
}

export function ResultPreview({
  kind,
  ensembleManagerApi,
  executionId,
  url,
  download,
}: ResultPreviewProps) {
  const [state, setState] = useState<State>({ status: 'loading' });

  useEffect(() => {
    const controller = new AbortController();
    setState({ status: 'loading' });
    const location = parseTapisUri(url);
    if (!location) {
      setState({ status: 'error' });
      return;
    }
    readExecutionFilePrefix(
      ensembleManagerApi,
      executionId,
      location,
      PREVIEW_MAX_BYTES,
      controller.signal,
    )
      .then(
        ({ bytes, truncated }) =>
          !controller.signal.aborted &&
          setState({ status: 'ready', text: decodePreviewText(bytes), truncated }),
      )
      .catch(() => !controller.signal.aborted && setState({ status: 'error' }));
    return () => controller.abort();
  }, [ensembleManagerApi, executionId, url]);

  if (state.status === 'loading') {
    return (
      <div
        className="flex items-center gap-2 py-2 text-xs text-gray-500"
        data-testid="preview-loading"
      >
        <span className="h-3 w-3 animate-spin rounded-full border-2 border-blue-600 border-t-transparent" />
        Loading preview…
      </div>
    );
  }
  if (state.status === 'error') {
    return (
      <p className="py-2 text-xs text-gray-500" data-testid="preview-unavailable">
        Preview unavailable — {download ?? 'use Download'}
      </p>
    );
  }

  let body: ReactNode;
  let truncatedRows = false;
  let jsonNote: string | undefined;
  if (kind === 'markdown') {
    body = <MarkdownLite source={state.text} testId="preview-markdown" />;
  } else if (kind === 'csv') {
    const parsed = parseCsvRows(state.text, PREVIEW_CSV_ROWS);
    truncatedRows = parsed.truncated;
    const [head, ...rows] = parsed.rows;
    body = head ? (
      <div className="overflow-x-auto">
        <table className="border-collapse text-xs" data-testid="preview-csv">
          <thead className="bg-gray-100">
            <tr>
              {head.map((cell, n) => (
                <th key={n} className="border border-gray-200 px-2 py-1 text-left font-medium">
                  {cell}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, r) => (
              <tr key={r}>
                {row.map((cell, n) => (
                  <td key={n} className="border border-gray-200 px-2 py-1">
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    ) : (
      <p className="text-xs text-gray-500">The file is empty.</p>
    );
  } else {
    const json = prettyJson(state.text, { truncated: state.truncated });
    jsonNote = json.note;
    body = (
      <pre
        className="max-h-80 overflow-auto rounded bg-gray-50 p-2 text-xs"
        data-testid="preview-json"
      >
        {json.text}
      </pre>
    );
  }

  return (
    <div className="space-y-1">
      {body}
      {(state.truncated || truncatedRows || jsonNote) && (
        <p className="text-[11px] text-gray-500" data-testid="preview-note">
          {jsonNote ? `${jsonNote} ` : ''}
          {truncatedRows ? `Only the first ${PREVIEW_CSV_ROWS - 1} rows are shown. ` : ''}
          {state.truncated && kind !== 'json' ? 'Only the start of the file is shown. ' : ''}
          Download for the whole file.
        </p>
      )}
    </div>
  );
}
