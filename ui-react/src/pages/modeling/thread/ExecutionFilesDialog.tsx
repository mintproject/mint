/**
 * ExecutionFilesDialog — the archived files of one run, and what to do with them.
 *
 * A Tapis application declares no output file type, so a model configuration
 * registered from one reaches its first successful run with zero declared
 * outputs, and publication answers 422 `NO_OUTPUTS_DECLARED`. This dialog is
 * the repair: it lists what the job archived, and the user promotes the files
 * that are results (#261, #267).
 *
 * The list is read live from Tapis — MINT stores none of these files. A file
 * the user promotes becomes an output dataset specification on the model
 * configuration, which the publication matcher then binds back to that file.
 *
 * Nothing republishes by itself, so the dialog also carries the Publish button
 * for this one run.
 */
import { AlertCircle, FileText, Upload } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useAddConfigurationOutputMutation } from '@/graphql/generated/graphql';
import {
  EnsembleManagerError,
  NO_OUTPUTS_DECLARED,
  fetchExecutionListing,
  isResultDownload,
  type ExecutionFile,
  type ExecutionResultLocation,
} from '@/lib/ensemble-manager';
import { FileDownloadButton } from './FileDownloadButton';
import { buildAddOutputVariables } from '@/lib/mutation-builder';
import {
  formatFileSize,
  isFileDeclared,
  nextOutputPosition,
  outputRowFromFile,
} from '@/lib/promote-output';

export interface ExecutionFilesDialogProps {
  open: boolean;
  /** The execution whose archive is listed. */
  executionId: string;
  /** The model configuration a promoted file is written onto. */
  configurationId: string;
  /** Labels of the outputs the configuration already declares. */
  declaredOutputLabels: string[];
  ensembleManagerApi: string;
  /** When false, the dialog lists the files and offers no write action. */
  canWrite: boolean;
  onClose: () => void;
  /** Called after a successful promotion, so the caller re-reads the configuration. */
  onPromoted?: () => void | Promise<void>;
  /** Publish this one execution. Absent means publishing is not available. */
  onPublish?: (executionId: string) => Promise<void>;
}

export function ExecutionFilesDialog({
  open,
  executionId,
  configurationId,
  declaredOutputLabels,
  ensembleManagerApi,
  canWrite,
  onClose,
  onPromoted,
  onPublish,
}: ExecutionFilesDialogProps) {
  const [files, setFiles] = useState<ExecutionFile[] | null>(null);
  // The run's results, which decide which listed files can be downloaded.
  const [results, setResults] = useState<ExecutionResultLocation[]>([]);
  const [loadError, setLoadError] = useState('');
  const [promoting, setPromoting] = useState<Record<string, boolean>>({});
  const [promoted, setPromoted] = useState<string[]>([]);
  const [promoteError, setPromoteError] = useState('');
  const [publishWaiting, setPublishWaiting] = useState(false);
  const [publishError, setPublishError] = useState('');
  const [publishErrorCode, setPublishErrorCode] = useState('');
  const [published, setPublished] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const [addOutput] = useAddConfigurationOutputMutation();

  // Read the archive each time the dialog opens: a run that archived nothing a
  // minute ago may have archived everything by now.
  useEffect(() => {
    if (!open) return;
    setFiles(null);
    setResults([]);
    setLoadError('');
    setPromoted([]);
    setPromoteError('');
    setPublishError('');
    setPublishErrorCode('');
    setPublished(false);

    const ctrl = new AbortController();
    abortRef.current?.abort();
    abortRef.current = ctrl;
    fetchExecutionListing(ensembleManagerApi, executionId, ctrl.signal)
      .then((listing) => {
        setFiles(listing.files);
        setResults(listing.results);
      })
      .catch((err: unknown) => {
        if (err instanceof Error && err.name === 'AbortError') return;
        setFiles([]);
        setLoadError(err instanceof Error ? err.message : 'Could not list the archived files');
      });
    return () => ctrl.abort();
  }, [open, executionId, ensembleManagerApi]);

  const handlePromote = useCallback(
    async (file: ExecutionFile) => {
      setPromoting((p) => ({ ...p, [file.path]: true }));
      setPromoteError('');
      try {
        const position = nextOutputPosition(declaredOutputLabels.length + promoted.length);
        await addOutput({
          variables: buildAddOutputVariables(configurationId, outputRowFromFile(file, position)),
        });
        // Hold the promoted path locally as well as re-reading the thread: the
        // re-read is a round trip, and the row must stop offering a second
        // promotion at once. Two outputs with one label compete for one file.
        setPromoted((list) => [...list, file.path]);
        // A promoted output is a declared output, so the 422 no longer holds.
        setPublishErrorCode('');
        await onPromoted?.();
      } catch (err) {
        // Hasura decides who may write. A refusal reads as a GraphQL error, and
        // the user must see it rather than a row that silently does nothing.
        setPromoteError(err instanceof Error ? err.message : 'Could not promote the file');
      } finally {
        setPromoting((p) => ({ ...p, [file.path]: false }));
      }
    },
    [addOutput, configurationId, declaredOutputLabels.length, promoted.length, onPromoted],
  );

  const handlePublish = useCallback(async () => {
    if (!onPublish) return;
    setPublishWaiting(true);
    setPublishError('');
    setPublishErrorCode('');
    setPublished(false);
    try {
      await onPublish(executionId);
      setPublished(true);
    } catch (err) {
      setPublishError(err instanceof Error ? err.message : 'Could not publish this execution');
      if (err instanceof EnsembleManagerError && err.code) setPublishErrorCode(err.code);
    } finally {
      setPublishWaiting(false);
    }
  }, [onPublish, executionId]);

  const declaredCount = declaredOutputLabels.length + promoted.length;

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-w-2xl" data-testid="execution-files-dialog">
        <DialogHeader>
          <DialogTitle>Archived files</DialogTitle>
          <DialogDescription>
            These files stay in the Tapis archive. Promote a file to declare it as an output of the
            model configuration, then publish the run.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-80 overflow-auto border border-gray-200">
          {files === null ? (
            <div className="flex items-center justify-center py-8">
              <span
                data-testid="execution-files-loading"
                className="h-6 w-6 animate-spin rounded-full border-2 border-blue-600 border-t-transparent"
              />
            </div>
          ) : files.length === 0 ? (
            <p className="px-3 py-6 text-center text-xs text-gray-500">
              {loadError || 'This run archived no file.'}
            </p>
          ) : (
            <table className="w-full border-collapse text-xs" data-testid="execution-files-table">
              <thead className="sticky top-0 bg-gray-100">
                <tr>
                  <th className="px-2 py-1 text-left font-medium">File</th>
                  <th className="px-2 py-1 text-left font-medium">Size</th>
                  <th className="px-2 py-1 text-left font-medium">Download</th>
                  <th className="px-2 py-1 text-left font-medium">Output</th>
                </tr>
              </thead>
              <tbody>
                {files.map((file) => {
                  const declared =
                    isFileDeclared(file, declaredOutputLabels) || promoted.includes(file.path);
                  return (
                    <tr key={file.path} className="odd:bg-white even:bg-gray-50">
                      <td className="px-2 py-1">
                        <span className="flex items-center gap-1" title={file.path}>
                          <FileText className="h-3 w-3 text-gray-400" />
                          {file.name}
                        </span>
                      </td>
                      <td className="px-2 py-1 text-gray-500">{formatFileSize(file.size)}</td>
                      <td className="px-2 py-1">
                        {isResultDownload(file.url, results) ? (
                          <FileDownloadButton
                            ensembleManagerApi={ensembleManagerApi}
                            executionId={executionId}
                            url={file.url}
                            testId={`download-${file.path}`}
                          />
                        ) : (
                          <span className="text-gray-400">—</span>
                        )}
                      </td>
                      <td className="px-2 py-1">
                        {declared ? (
                          <span className="text-green-700">Declared</span>
                        ) : canWrite ? (
                          <button
                            type="button"
                            data-testid={`promote-${file.path}`}
                            onClick={() => void handlePromote(file)}
                            disabled={promoting[file.path]}
                            className="flex items-center gap-1 rounded border px-1.5 py-0.5 hover:bg-gray-50 disabled:opacity-40"
                          >
                            <Upload className="h-3 w-3" />
                            {promoting[file.path] ? 'Promoting…' : 'Promote'}
                          </button>
                        ) : (
                          <span className="text-gray-400">Raw artifact</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        {loadError && files !== null && files.length > 0 && (
          <p role="alert" className="text-xs text-red-600">
            {loadError}
          </p>
        )}

        {promoteError && (
          <p role="alert" data-testid="promote-error" className="text-xs text-red-600">
            {promoteError}
          </p>
        )}

        <p className="text-xs text-gray-500">
          A promoted output carries a name only. It reaches the data catalog, but it cannot match a
          modeling task until you give it a standard variable on the model configuration form.
        </p>

        {publishErrorCode === NO_OUTPUTS_DECLARED ? (
          <p role="alert" data-testid="publish-execution-error" className="text-xs text-orange-600">
            This model configuration declares no output. Promote a file above, then publish again.
          </p>
        ) : (
          publishError && (
            <p role="alert" data-testid="publish-execution-error" className="text-xs text-red-600">
              <AlertCircle className="mr-1 inline h-3 w-3" />
              {publishError}
            </p>
          )
        )}

        {published && (
          <p data-testid="publish-execution-done" className="text-xs text-green-700">
            This execution is published. Its results are on the Results step.
          </p>
        )}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Close
          </Button>
          {onPublish && canWrite && (
            <Button
              type="button"
              data-testid="publish-execution"
              onClick={() => void handlePublish()}
              disabled={publishWaiting || declaredCount === 0}
              title={
                declaredCount === 0 ? 'Promote a file first — nothing is declared as an output' : ''
              }
            >
              {publishWaiting ? 'Publishing…' : 'Publish this execution now'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
