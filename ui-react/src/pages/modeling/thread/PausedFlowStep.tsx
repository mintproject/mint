/**
 * PausedFlowStep — a flow run that stopped for its user's edit.
 *
 * The run shows the file to edit, with a download; the user edits it offline and
 * uploads the copy to the data catalog (a private dataset in an organisation they
 * choose, by the same upload an input uses); and "Resume" sends that file's catalog
 * address on. Only the user who started the run sees Resume. If the run after the
 * edit failed, the reason is shown and another edit can be sent. There is no editor
 * here: the file is downloaded, changed elsewhere, and uploaded.
 */
import { useState } from 'react';

import { EnsembleManagerError, type UnifiedRunSnapshot } from '@/lib/ensemble-manager';
import { flowErrorMessage } from '@/lib/flow-errors';
import type { UploadedDataset } from '@/lib/ckan-upload';
import { FileDownloadButton } from './FileDownloadButton';
import { UploadFiles } from './wizard/UploadFiles';

export interface PausedEdit {
  url: string;
  dataset_id: string;
  resource_id: string;
}

export interface PausedFlowStepProps {
  run: UnifiedRunSnapshot;
  ensembleManagerApi: string;
  /** The signed-in user. */
  username: string;
  /** Sends the edit on. It rejects with the Ensemble Manager's refusal. */
  onResume?: (edit: PausedEdit) => Promise<void>;
  /** The step the run stopped after, for the sentence. */
  stepName?: string;
}

export function PausedFlowStep({
  run,
  ensembleManagerApi,
  username,
  onResume,
  stepName,
}: PausedFlowStepProps) {
  const pause = run.pause;
  const [edit, setEdit] = useState<(PausedEdit & { name: string }) | null>(null);
  const [resuming, setResuming] = useState(false);
  const [problem, setProblem] = useState<{ title: string; lines: string[] } | null>(null);
  if (!pause) return null;

  const mine = Boolean(username) && run.started_by === username;
  const file = pause.file ?? 'the file';

  function uploaded(dataset: UploadedDataset) {
    const resource = dataset.resources[0];
    if (!resource) return;
    setProblem(null);
    setEdit({
      url: resource.url,
      dataset_id: dataset.datasetId,
      resource_id: resource.id,
      name: resource.name,
    });
  }

  async function resume() {
    if (!edit || !onResume) return;
    setResuming(true);
    setProblem(null);
    try {
      await onResume({ url: edit.url, dataset_id: edit.dataset_id, resource_id: edit.resource_id });
      setEdit(null);
    } catch (error) {
      const known = flowErrorMessage(error);
      setProblem(
        known ?? {
          title: 'The run could not be continued',
          lines: [error instanceof Error ? error.message : String(error)],
        },
      );
      if (error instanceof EnsembleManagerError && error.status === 409) setEdit(null);
    } finally {
      setResuming(false);
    }
  }

  return (
    <div
      className="space-y-2 rounded border border-amber-300 bg-amber-50 px-3 py-3 text-xs text-amber-950"
      data-testid="flow-paused"
    >
      <div className="font-semibold">
        {stepName ? `Paused after “${stepName}”` : 'Paused'}: review and edit {file}
      </div>
      <p>
        The run is waiting for you. Download the file, change it, then upload your copy and
        continue; the rest of the flow will use your copy. The original is kept.
      </p>

      {pause.error && (
        <p role="alert" className="rounded border border-red-200 bg-red-50 px-2 py-1 text-red-800">
          The last edit could not be used: {pause.error}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2" data-testid="flow-paused-file">
        <code>{pause.file ?? pause.file_location ?? 'file'}</code>
        {pause.file_location && run.model_child_id ? (
          <FileDownloadButton
            ensembleManagerApi={ensembleManagerApi}
            executionId={run.model_child_id}
            url={pause.file_location}
            testId="download-paused-file"
          />
        ) : (
          <span className="text-amber-800">Its location is not available yet.</span>
        )}
      </div>

      {mine ? (
        <>
          <UploadFiles
            flowName="Edited flow output"
            inputName={file}
            variables={[]}
            variableOptional
            forcePrivate
            multiple={false}
            username={username}
            buttonLabel="Upload the edited file"
            hint={`One file: your edited copy of ${file}.`}
            datasetNotes={`The user's edited copy of ${file}, uploaded through DYNAMO to continue a flow run.`}
            disabled={resuming}
            onUploaded={uploaded}
          />
          {edit && (
            <p data-testid="flow-paused-edit">
              Ready: <code>{edit.name}</code> in catalog dataset <code>{edit.dataset_id}</code>.
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void resume()}
              disabled={!edit || resuming || !onResume}
              className="rounded border border-amber-400 bg-amber-600 px-2.5 py-1.5 font-medium text-white hover:bg-amber-700 disabled:cursor-not-allowed disabled:opacity-50"
              data-testid="resume-flow"
            >
              {resuming ? 'Continuing…' : 'Resume with this edit'}
            </button>
            {!edit && <span className="text-amber-800">Upload your edited file first.</span>}
          </div>
        </>
      ) : (
        <p data-testid="flow-paused-not-yours">
          {run.started_by
            ? `Only ${run.started_by}, who started this run, can upload the edit and continue it.`
            : 'Only the user who started this run can upload the edit and continue it.'}
        </p>
      )}

      {problem && (
        <div
          role="alert"
          className="rounded border border-red-200 bg-red-50 px-2 py-2 text-red-800"
          data-testid="flow-paused-problem"
        >
          <div className="font-medium">{problem.title}</div>
          {problem.lines.map((line, index) => (
            <div key={index}>{line}</div>
          ))}
        </div>
      )}
      <p className="text-amber-800">
        A run left waiting for 14 days is cancelled. You can also cancel it below.
      </p>
    </div>
  );
}
