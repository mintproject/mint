/**
 * OutputBlock — one declared output of a run: its label, type, Download, Copy
 * location, and a preview that opens in place.
 */
import { ChevronRight, Copy, Download, FolderOpen } from 'lucide-react';
import { useState } from 'react';

import { PREVIEW_AUTO_OPEN_MAX_BYTES, outputPreviewKind } from '@/lib/result-preview';
import { FileDownloadButton } from './FileDownloadButton';
import { ResultPreview } from './ResultPreview';
import { useTapisResultInfo } from './useTapisResultKind';

export interface OutputBlockProps {
  ensembleManagerApi: string;
  executionId: string;
  /** What the output is called, as the model declares it. */
  label: string;
  /** The declared format, when the model says one. */
  format?: string | null;
  /** The file's name. */
  name: string;
  /** Where it is: `tapis://`, a web address, or something that is only text. */
  url: string;
  scheme: 'tapis' | 'web' | 'text';
  /** Open the run's folder: the answer for a result that is a folder. */
  onOpenFolder: (executionId: string) => void;
}

function typeLabel(format: string | null | undefined, name: string, url: string): string {
  if (format) return format;
  // A result is usually named by its label, so the file's own name is the better guide.
  const extension = (text: string) => /\.([a-z0-9]+)(?:[?#].*)?$/i.exec(text)?.[1]?.toUpperCase();
  return extension(url) ?? extension(name) ?? '';
}

export function OutputBlock({
  ensembleManagerApi,
  executionId,
  label,
  format,
  name,
  url,
  scheme,
  onOpenFolder,
}: OutputBlockProps) {
  // Asked of Tapis only for a tapis:// location; the others never use it.
  const { kind: tapisKind, size } = useTapisResultInfo(
    ensembleManagerApi,
    executionId,
    url,
    scheme === 'tapis',
  );
  const kind = outputPreviewKind(url, name, format);
  const previewable = Boolean(kind) && scheme === 'tapis' && tapisKind === 'file';
  const [open, setOpen] = useState<boolean | null>(null);
  // A report is what the run was for, so it opens by itself, but only when the
  // listing says it is small; every other preview waits to be asked for. A web
  // address is never read from here: it only has Download.
  const expanded =
    open ?? (kind === 'markdown' && size !== null && size <= PREVIEW_AUTO_OPEN_MAX_BYTES);

  const download =
    scheme === 'tapis' && tapisKind === 'file' ? (
      <FileDownloadButton
        ensembleManagerApi={ensembleManagerApi}
        executionId={executionId}
        url={url}
      />
    ) : scheme === 'web' ? (
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        data-testid="download-link"
        className="inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-blue-700 hover:bg-gray-50"
      >
        <Download className="h-3 w-3" />
        Download
      </a>
    ) : null;

  return (
    <li
      className="space-y-1 rounded border border-gray-200 px-3 py-2 text-xs"
      data-testid="output-block"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-gray-900">{label}</span>
        {typeLabel(format, name, url) && (
          <span className="rounded bg-gray-100 px-1.5 py-0.5 text-gray-600">
            {typeLabel(format, name, url)}
          </span>
        )}
        <span className="text-gray-500">{name}</span>
        <span className="ml-auto inline-flex flex-wrap items-center gap-1">
          {download}
          {scheme === 'tapis' && tapisKind === 'folder' && (
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
          {scheme === 'tapis' && tapisKind === 'unknown' && (
            <span className="text-gray-400">…</span>
          )}
          {scheme === 'tapis' && tapisKind === 'error' && (
            <span
              className="text-gray-400"
              title="Tapis could not say whether this is a file or a folder"
            >
              (location not readable)
            </span>
          )}
          {url && (
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
          )}
        </span>
      </div>
      {previewable && kind && (
        <div>
          <button
            type="button"
            aria-expanded={expanded}
            onClick={() => setOpen(!expanded)}
            className="group/preview flex items-center gap-1 text-gray-600 hover:text-gray-900"
            data-testid="preview-toggle"
          >
            <ChevronRight
              aria-hidden="true"
              className={`h-3.5 w-3.5 transition-transform duration-200 motion-reduce:transition-none ${
                expanded ? 'rotate-90' : ''
              }`}
            />
            Preview
          </button>
          {expanded && (
            <div className="mt-1 border-l-2 border-gray-200 pl-3">
              <ResultPreview
                kind={kind}
                ensembleManagerApi={ensembleManagerApi}
                executionId={executionId}
                url={url}
                download={download}
              />
            </div>
          )}
        </div>
      )}
    </li>
  );
}
