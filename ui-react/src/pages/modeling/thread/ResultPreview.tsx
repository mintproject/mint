/**
 * ResultPreview — the start of one result file, shown inline.
 *
 * Read only when the block is open (it mounts then): a Markdown report rendered,
 * the first rows of a CSV as a small table, JSON indented. A Tapis file is read
 * through the same Ensemble Manager route, with the same token, as its Download
 * button; a web address is fetched as the link would be. At most the first
 * 200 KB is read. If the file cannot be read, the preview says so quietly and
 * offers the Download instead.
 */
import { useEffect, useState, type ReactNode } from 'react';

import { MarkdownLite } from '@/components/common/MarkdownLite';
import { downloadExecutionFile, parseTapisUri } from '@/lib/ensemble-manager';
import {
  PREVIEW_CSV_ROWS,
  PREVIEW_MAX_BYTES,
  parseCsvRows,
  prettyJson,
  readBlobText,
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
  /** A `tapis://` location, or a web address. */
  url: string;
  /** The Download control, repeated beside the fallback message. */
  download?: ReactNode;
}

async function readResult(
  props: Pick<ResultPreviewProps, 'ensembleManagerApi' | 'executionId' | 'url'>,
  signal: AbortSignal,
): Promise<Blob> {
  const location = parseTapisUri(props.url);
  if (location) {
    return (
      await downloadExecutionFile(props.ensembleManagerApi, props.executionId, location, signal)
    ).blob;
  }
  const response = await fetch(props.url, { signal });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.blob();
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
    readResult({ ensembleManagerApi, executionId, url }, controller.signal)
      .then((blob) => readBlobText(blob, PREVIEW_MAX_BYTES))
      .then((read) => !controller.signal.aborted && setState({ status: 'ready', ...read }))
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
  if (kind === 'markdown') {
    body = <MarkdownLite source={state.text} testId="preview-markdown" />;
  } else if (kind === 'csv') {
    const [head, ...rows] = parseCsvRows(state.text, PREVIEW_CSV_ROWS);
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
    body = (
      <pre
        className="max-h-80 overflow-auto rounded bg-gray-50 p-2 text-xs"
        data-testid="preview-json"
      >
        {prettyJson(state.text)}
      </pre>
    );
  }

  return (
    <div className="space-y-1">
      {body}
      {(state.truncated || kind === 'csv') && (
        <p className="text-[11px] text-gray-500">
          {kind === 'csv' ? `First ${PREVIEW_CSV_ROWS - 1} rows. ` : ''}
          {state.truncated ? 'Only the start of the file is shown. ' : ''}
          Download for the whole file.
        </p>
      )}
    </div>
  );
}
