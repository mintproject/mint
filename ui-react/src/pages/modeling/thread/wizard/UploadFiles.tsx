import { useEffect, useState } from 'react';

import {
  UPLOAD_FILE_CAP,
  UploadError,
  listUploadOrganizations,
  uploadFilesToCatalog,
  type UploadOrganization,
  type UploadProgress,
  type UploadedDataset,
} from '@/lib/ckan-upload';

interface UploadFilesProps {
  /** The flow and the input the files are for (named in the new dataset's notes). */
  flowName: string;
  inputName: string;
  /** The input's standard variable name(s): how the data step finds the dataset. */
  variables: string[];
  /** The input's declared file format. */
  format?: string | null;
  /** An input that takes a collection takes many files; any other takes one. */
  multiple: boolean;
  startDate?: string | null;
  endDate?: string | null;
  regionGeometry?: unknown;
  username: string;
  /** A model (not a flow) reads its files itself, with no token, so they must be public. */
  forcePublic?: boolean;
  disabled?: boolean;
  onUploaded: (dataset: UploadedDataset) => void;
}

export const UPLOAD_CATALOG_NOTICE =
  'Your files go into the catalog dataset you choose. Private files can be read only by members of that organisation, and by your own runs.';
export const UPLOAD_MODEL_PUBLIC_NOTE =
  'A model reads its files directly, so uploads for a model must be public. Private uploads are for flows.';
export const UPLOAD_NO_ORGANIZATION_MESSAGE =
  'You cannot create datasets in any catalog organisation. Ask a CKAN admin to add you to one.';

/**
 * "Upload files" beside the catalog search, for an input of a flow that takes a
 * collection. The files become one new catalog dataset (private unless the user
 * ticks the box) in an organisation the user may create datasets in, and the
 * input is then bound to it like any catalog dataset.
 */
export function UploadFiles({
  flowName,
  inputName,
  variables,
  format,
  multiple,
  startDate,
  endDate,
  regionGeometry,
  username,
  forcePublic = false,
  disabled,
  onUploaded,
}: UploadFilesProps) {
  const [open, setOpen] = useState(false);
  const [orgs, setOrgs] = useState<UploadOrganization[] | null>(null);
  const [orgId, setOrgId] = useState('');
  const [isPublic, setIsPublic] = useState(false);
  const [chosen, setChosen] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<UploadProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState<string[]>([]);

  useEffect(() => {
    if (!open || orgs) return;
    let live = true;
    listUploadOrganizations()
      .then((list) => {
        if (!live) return;
        setOrgs(list);
        if (list.length === 1) setOrgId(list[0]!.id);
      })
      .catch((err) => live && setError(err instanceof UploadError ? err.message : String(err)));
    return () => {
      live = false;
    };
  }, [open, orgs]);

  async function handleUpload() {
    setBusy(true);
    setError(null);
    setProgress(null);
    try {
      const dataset = await uploadFilesToCatalog({
        files: chosen,
        organizationId: orgId,
        isPublic: forcePublic || isPublic,
        flowName,
        inputName,
        variables,
        format,
        multiple,
        startDate,
        endDate,
        regionGeometry,
        username,
        onProgress: setProgress,
      });
      setChosen([]);
      setOpen(false);
      setNotes(dataset.notes);
      onUploaded(dataset);
    } catch (err) {
      setError(err instanceof UploadError ? err.message : `Upload failed: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  }

  const percent =
    progress && progress.total > 0 ? Math.round((progress.sent / progress.total) * 100) : 0;

  return (
    <div className="mt-2 space-y-1 text-xs" data-testid="upload-files">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="rounded border border-blue-300 bg-white px-2.5 py-1.5 font-medium text-blue-800 hover:bg-blue-50 disabled:cursor-not-allowed disabled:opacity-50"
          disabled={disabled || busy}
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          Upload files
        </button>
        <span className="text-slate-500">
          {multiple
            ? `Up to ${UPLOAD_FILE_CAP} files, 2 GB in all, read together.`
            : 'This input takes one file.'}
        </span>
      </div>
      {open && (
        <div className="space-y-2 rounded border border-blue-200 bg-blue-50 p-2">
          {orgs && orgs.length === 0 ? (
            <p role="alert" className="text-amber-800">
              {UPLOAD_NO_ORGANIZATION_MESSAGE}
            </p>
          ) : (
            <>
              <label className="flex flex-wrap items-center gap-2">
                <span>Organisation</span>
                <select
                  aria-label="Organisation"
                  value={orgId}
                  disabled={!orgs || busy}
                  onChange={(e) => setOrgId(e.target.value)}
                  className="h-8 rounded border border-slate-300 bg-white px-2"
                >
                  <option value="">{orgs ? 'Choose an organisation' : 'Loading…'}</option>
                  {(orgs ?? []).map((org) => (
                    <option key={org.id} value={org.id}>
                      {org.title}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={forcePublic || isPublic}
                  disabled={busy || forcePublic}
                  onChange={(e) => setIsPublic(e.target.checked)}
                />
                <span>Make these files public</span>
              </label>
              {forcePublic && (
                <p className="text-slate-600" data-testid="upload-public-only">
                  {UPLOAD_MODEL_PUBLIC_NOTE}
                </p>
              )}
              <input
                type="file"
                multiple={multiple}
                disabled={busy}
                aria-label="Choose files to upload"
                data-testid="upload-file-input"
                onChange={(e) => setChosen(Array.from(e.target.files ?? []))}
              />
              <button
                type="button"
                className="rounded border border-blue-300 bg-white px-2.5 py-1.5 font-medium text-blue-800 hover:bg-blue-100 disabled:cursor-not-allowed disabled:opacity-50"
                disabled={busy || !orgId || chosen.length === 0}
                onClick={() => void handleUpload()}
              >
                {busy
                  ? 'Uploading…'
                  : `Upload ${chosen.length} ${chosen.length === 1 ? 'file' : 'files'}`}
              </button>
            </>
          )}
        </div>
      )}
      {busy && progress && (
        <div role="status" className="space-y-0.5" data-testid="upload-progress">
          <progress className="h-2 w-full max-w-sm" max={100} value={percent} />
          <p className="text-slate-600">
            {percent}% · file {Math.min(progress.index + 1, progress.count)} of {progress.count}
          </p>
        </div>
      )}
      {notes.map((note) => (
        <p key={note} className="text-slate-600" data-testid="upload-note">
          {note}
        </p>
      ))}
      {error && (
        <p role="alert" className="text-red-700">
          {error}
        </p>
      )}
      <p className="text-slate-500" data-testid="upload-catalog-notice">
        {UPLOAD_CATALOG_NOTICE}
      </p>
    </div>
  );
}
