import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import {
  StandardVariableCombobox,
  type StandardVariableOption,
} from '@/components/autocomplete/StandardVariableCombobox';
import { StandardVariableDetails } from '@/components/autocomplete/StandardVariableDetails';
import { DatasetSpatialMap } from '@/components/datasets/DatasetSpatialMap';
import { TagInput } from '@/components/datasets/TagInput';
import { UploadSummaryCard } from '@/components/datasets/UploadSummaryCard';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useGetModelTreeWithRegionsQuery } from '@/graphql/generated/modeling';
import {
  useListRegionCategoriesQuery,
  useListRegionsByCategoryQuery,
} from '@/graphql/generated/graphql';
import {
  UPLOAD_FILE_CAP,
  UploadError,
  boundingBoxToSpatial,
  defaultLicenseId,
  formatFromName,
  listLicenses,
  listUploadOrganizations,
  regionToSpatial,
  uploadFilesToCatalog,
  type UploadLicense,
  type UploadOrganization,
  type UploadProgress,
  type UploadedDataset,
} from '@/lib/ckan-upload';
import { consumersOfVariable } from '@/lib/datasets/upload-preview';
import { unionBoundingBox, type BoundingBox } from '@/lib/geo/bbox';
import { standardVariableName } from '@/lib/standard-variable-display';
import { useAuth } from '@/lib/auth/useAuth';

export const UPLOAD_PUBLIC_EXPLANATION =
  'A model run reads its input files directly and can only read public files. A flow can read private files, because it runs with your access.';

type SpatialMode = 'none' | 'region' | 'bbox';
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type BoxText = { xmin: string; ymin: string; xmax: string; ymax: string };

/** The four typed values as a box, or null unless they are a valid one (degrees, west < east). */
function parseBox(box: BoxText): BoundingBox | null {
  const [xmin, ymin, xmax, ymax] = [box.xmin, box.ymin, box.xmax, box.ymax].map((v) =>
    v.trim() === '' ? NaN : Number(v),
  ) as [number, number, number, number];
  const valid =
    [xmin, ymin, xmax, ymax].every(Number.isFinite) &&
    xmin >= -180 &&
    xmax <= 180 &&
    ymin >= -90 &&
    ymax <= 90 &&
    xmin < xmax &&
    ymin < ymax;
  return valid ? { xmin, ymin, xmax, ymax } : null;
}

/** A drawn box as the text the coordinate fields hold (4 decimals is about 10 m). */
function boxToText(box: BoundingBox): BoxText {
  const round = (n: number) => String(Math.round(n * 10000) / 10000);
  return {
    xmin: round(box.xmin),
    ymin: round(box.ymin),
    xmax: round(box.xmax),
    ymax: round(box.ymax),
  };
}

function parseGeometry(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

/** Standalone "Upload a dataset": files into CKAN, annotated so DYNAMO can run them. */
export function DatasetUploadPage() {
  const { user } = useAuth();
  const [orgs, setOrgs] = useState<UploadOrganization[] | null>(null);
  const [orgId, setOrgId] = useState('');
  const [isPublic, setIsPublic] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [licenses, setLicenses] = useState<UploadLicense[] | null>(null);
  const [license, setLicense] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [sourceUrl, setSourceUrl] = useState('');
  const [version, setVersion] = useState('');
  // null until edited, so it follows the signed-in username while untouched.
  const [authorEdit, setAuthorEdit] = useState<string | null>(null);
  const [contactEmail, setContactEmail] = useState('');
  const [fileNotes, setFileNotes] = useState<string[]>([]);
  const [files, setFiles] = useState<File[]>([]);
  const [variable, setVariable] = useState<StandardVariableOption | null>(null);
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [mode, setMode] = useState<SpatialMode>('none');
  const [categoryId, setCategoryId] = useState('');
  const [regionId, setRegionId] = useState('');
  const [box, setBox] = useState<BoxText>({ xmin: '', ymin: '', xmax: '', ymax: '' });
  const [problems, setProblems] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<UploadProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<UploadedDataset | null>(null);

  useEffect(() => {
    let live = true;
    listUploadOrganizations()
      .then((list) => {
        if (!live) return;
        setOrgs(list);
        if (list.length === 1) setOrgId(list[0]!.id);
      })
      .catch((err) => {
        if (!live) return;
        setOrgs([]);
        setError(err instanceof UploadError ? err.message : String(err));
      });
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    let live = true;
    listLicenses()
      .then((list) => {
        if (!live) return;
        setLicenses(list);
        setLicense((chosen) => chosen || defaultLicenseId(list));
      })
      .catch((err) => {
        if (!live) return;
        setLicenses([]);
        setError(err instanceof UploadError ? err.message : String(err));
      });
    return () => {
      live = false;
    };
  }, []);

  const { data: categories } = useListRegionCategoriesQuery({ skip: mode !== 'region' });
  const { data: regionList } = useListRegionsByCategoryQuery({
    variables: { categoryId },
    skip: mode !== 'region' || !categoryId,
  });
  const { data: tree, loading: treeLoading } = useGetModelTreeWithRegionsQuery({
    skip: !variable,
  });

  const formats = useMemo(
    () => [...new Set(files.map((f) => formatFromName(f.name) || 'no extension'))],
    [files],
  );
  const consumers = useMemo(
    () => (variable ? consumersOfVariable(tree, variable, files) : []),
    [tree, variable, files],
  );

  const author = authorEdit ?? user?.username ?? '';
  const region = mode === 'region' ? regionList?.region.find((r) => r.id === regionId) : undefined;
  const regionGeometries = region?.geometries.map((g) => parseGeometry(g.geometry));
  const regionBox = regionGeometries ? unionBoundingBox(regionGeometries) : null;
  const drawnBox = parseBox(box);

  function spatialOrProblem(): { spatial: string | null; problem?: string } {
    if (mode === 'region') {
      if (!region) return { spatial: null, problem: 'Choose a region, or choose no spatial area.' };
      const spatial = regionToSpatial(regionGeometries);
      return spatial
        ? { spatial }
        : { spatial: null, problem: 'That region has no geometry to take a bounding box from.' };
    }
    if (mode === 'bbox') {
      return drawnBox
        ? { spatial: boundingBoxToSpatial(drawnBox) }
        : {
            spatial: null,
            problem:
              'Draw a bounding box on the map, or enter one in degrees: west and south below east and north, longitude -180 to 180, latitude -90 to 90.',
          };
    }
    return { spatial: null };
  }

  function drawBox(next: BoundingBox | null) {
    setBox(next ? boxToText(next) : { xmin: '', ymin: '', xmax: '', ymax: '' });
    setMode(next ? 'bbox' : 'none');
  }

  async function submit() {
    const found: string[] = [];
    if (files.length === 0) found.push('Choose at least one file.');
    if (!orgId) found.push('Choose an organisation.');
    if (!title.trim()) found.push('Enter a title.');
    if (!description.trim()) found.push('Enter a description.');
    if (!license) found.push('Choose a license.');
    if (contactEmail.trim() && !EMAIL.test(contactEmail.trim())) {
      found.push('Enter a valid contact email, or leave it empty.');
    }
    if (!variable) found.push('Choose a standard variable.');
    if (!DATE.test(startDate) || !DATE.test(endDate)) {
      found.push('Enter a start and an end date.');
    } else if (startDate > endDate) {
      found.push('The start date must not be after the end date.');
    }
    const { spatial, problem } = spatialOrProblem();
    if (problem) found.push(problem);
    setProblems(found);
    setError(null);
    if (found.length > 0 || !variable) return;

    setBusy(true);
    setProgress(null);
    try {
      setDone(
        await uploadFilesToCatalog({
          files,
          organizationId: orgId,
          isPublic,
          flowName: 'the upload page',
          inputName: 'dataset',
          variables: [variable.label],
          multiple: true,
          title,
          notes: description.trim(),
          formatOptional: true,
          metadata: { license, tags, sourceUrl, version, author, contactEmail },
          fileDescriptions: fileNotes,
          startDate,
          endDate,
          spatial,
          username: user?.username ?? '',
          onProgress: setProgress,
        }),
      );
    } catch (err) {
      setError(err instanceof UploadError ? err.message : `Upload failed: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    setDone(null);
    setFiles([]);
    setTitle('');
    setDescription('');
    setFileNotes([]);
    setProblems([]);
  }

  if (done) {
    return (
      <div className="max-w-2xl space-y-4" data-testid="upload-success">
        <h2 className="text-2xl font-bold tracking-tight">Dataset uploaded</h2>
        <p>
          <code>{done.datasetId}</code> is in the catalog and was read back to check it.{' '}
          <span data-testid="upload-state">{done.isPrivate ? 'Private' : 'Public'}</span>
        </p>
        <div className="flex flex-wrap gap-3">
          <Button asChild variant="outline">
            <Link to={`/datasets/browse/${encodeURIComponent(done.datasetId)}`}>
              Open the dataset page
            </Link>
          </Button>
          <Button asChild>
            <Link to="/modeling/problem-statements">Use in a thread</Link>
          </Button>
          <Button variant="ghost" onClick={reset}>
            Upload another
          </Button>
        </div>
        {done.notes.map((note) => (
          <p key={note} className="text-sm text-muted-foreground">
            {note}
          </p>
        ))}
      </div>
    );
  }

  const percent =
    progress && progress.total > 0 ? Math.round((progress.sent / progress.total) * 100) : 0;
  const selectClass = 'h-10 w-full rounded-md border border-input bg-background px-3 text-sm';

  return (
    <form
      className="max-w-2xl space-y-6"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div>
        <h2 className="text-2xl font-bold tracking-tight">Upload a dataset</h2>
        <p className="mt-1 text-muted-foreground">
          Put one file, or a collection of files read together, into the catalog, ready for DYNAMO
          to run.
        </p>
      </div>

      <section className="space-y-3">
        <h3 className="font-semibold">Files</h3>
        <Input
          type="file"
          multiple
          aria-label="Choose files to upload"
          disabled={busy}
          onChange={(e) => {
            setFiles(Array.from(e.target.files ?? []));
            setFileNotes([]);
          }}
        />
        <p className="text-sm text-muted-foreground">
          {files.length === 0
            ? `One file, or up to ${UPLOAD_FILE_CAP} files read together as a collection.`
            : `${files.length} ${files.length === 1 ? 'file' : 'files'}; format ${formats.join(', ')}, taken from the extension.`}
        </p>
        {files.length > 0 && (
          <div className="space-y-2">
            {files.map((file, i) => (
              <div key={`${i}-${file.name}`} className="space-y-1">
                <Label htmlFor={`upload-file-note-${i}`}>
                  About {file.name} <span className="text-muted-foreground">(optional)</span>
                </Label>
                <Input
                  id={`upload-file-note-${i}`}
                  value={fileNotes[i] ?? ''}
                  disabled={busy}
                  placeholder="One line: what is in this file"
                  onChange={(e) => {
                    const next = files.map((_, j) => fileNotes[j] ?? '');
                    next[i] = e.target.value;
                    setFileNotes(next);
                  }}
                />
              </div>
            ))}
          </div>
        )}
        {formats.length > 1 && (
          <p role="status" className="text-sm text-amber-800" data-testid="mixed-formats">
            These files have different extensions ({formats.join(', ')}). A collection is normally
            one format; check before you upload.
          </p>
        )}
      </section>

      <section className="space-y-3">
        <h3 className="font-semibold">Catalog dataset</h3>
        <div className="space-y-1">
          <Label htmlFor="upload-org">Organisation</Label>
          <select
            id="upload-org"
            className={selectClass}
            value={orgId}
            disabled={!orgs || busy}
            onChange={(e) => setOrgId(e.target.value)}
          >
            <option value="">{orgs ? 'Choose an organisation' : 'Loading…'}</option>
            {(orgs ?? []).map((org) => (
              <option key={org.id} value={org.id}>
                {org.title}
              </option>
            ))}
          </select>
          {orgs && orgs.length === 0 && (
            <p className="text-sm text-amber-800">
              You cannot create datasets in any catalog organisation. Ask a CKAN admin to add you to
              one.
            </p>
          )}
        </div>
        <div className="space-y-1">
          <Label htmlFor="upload-title">Title</Label>
          <Input
            id="upload-title"
            value={title}
            disabled={busy}
            onChange={(e) => setTitle(e.target.value)}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="upload-description">Description</Label>
          <Textarea
            id="upload-description"
            rows={5}
            value={description}
            disabled={busy}
            placeholder={
              'What the data is.\nHow it was collected or produced.\nKnown limits, gaps or caveats.'
            }
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="upload-license">License</Label>
          <select
            id="upload-license"
            className={selectClass}
            value={license}
            disabled={!licenses || busy}
            onChange={(e) => setLicense(e.target.value)}
          >
            <option value="">{licenses ? 'Choose a license' : 'Loading…'}</option>
            {(licenses ?? []).map((l) => (
              <option key={l.id} value={l.id}>
                {l.title}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="upload-tags">Tags</Label>
          <TagInput id="upload-tags" value={tags} onChange={setTags} disabled={busy} />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="upload-author">Author</Label>
            <Input
              id="upload-author"
              value={author}
              disabled={busy}
              onChange={(e) => setAuthorEdit(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="upload-contact">Contact email (optional)</Label>
            <Input
              id="upload-contact"
              type="email"
              value={contactEmail}
              disabled={busy}
              onChange={(e) => setContactEmail(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="upload-source">Source or citation link (optional)</Label>
            <Input
              id="upload-source"
              type="url"
              value={sourceUrl}
              disabled={busy}
              placeholder="https://"
              onChange={(e) => setSourceUrl(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="upload-version">Version (optional)</Label>
            <Input
              id="upload-version"
              value={version}
              disabled={busy}
              onChange={(e) => setVersion(e.target.value)}
            />
          </div>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={isPublic}
            disabled={busy}
            onChange={(e) => setIsPublic(e.target.checked)}
          />
          <span>Make public</span>
        </label>
        <p className="text-sm text-muted-foreground">
          The dataset is private by default. {UPLOAD_PUBLIC_EXPLANATION}
        </p>
      </section>

      <section className="space-y-3">
        <h3 className="font-semibold">What makes it ready for DYNAMO</h3>
        <div className="space-y-1">
          <Label htmlFor="upload-variable">Standard variable</Label>
          <StandardVariableCombobox
            id="upload-variable"
            value={variable}
            onChange={setVariable}
            disabled={busy}
            requireLabel
            allowCreate
          />
          {variable && <StandardVariableDetails variable={variable} />}
          <p className="text-sm text-muted-foreground">
            One variable applies to every file in the collection.
          </p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="upload-start">Start date</Label>
            <Input
              id="upload-start"
              type="date"
              value={startDate}
              disabled={busy}
              onChange={(e) => setStartDate(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="upload-end">End date</Label>
            <Input
              id="upload-end"
              type="date"
              value={endDate}
              disabled={busy}
              onChange={(e) => setEndDate(e.target.value)}
            />
          </div>
        </div>
        <div className="space-y-1">
          <Label htmlFor="upload-spatial">Spatial coverage</Label>
          <select
            id="upload-spatial"
            className={selectClass}
            value={mode}
            disabled={busy}
            onChange={(e) => setMode(e.target.value as SpatialMode)}
          >
            <option value="none">No spatial area</option>
            <option value="region">A MINT region</option>
            <option value="bbox">A bounding box (draw on the map)</option>
          </select>
        </div>
        {mode === 'region' && (
          <div className="grid gap-3 sm:grid-cols-2">
            <select
              aria-label="Region category"
              className={selectClass}
              value={categoryId}
              onChange={(e) => {
                setCategoryId(e.target.value);
                setRegionId('');
              }}
            >
              <option value="">Choose a category</option>
              {(categories?.region_category ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <select
              aria-label="Region"
              className={selectClass}
              value={regionId}
              disabled={!categoryId}
              onChange={(e) => setRegionId(e.target.value)}
            >
              <option value="">Choose a region</option>
              {(regionList?.region ?? []).map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </div>
        )}
        <div className="relative z-0">
          <DatasetSpatialMap
            value={mode === 'bbox' ? drawnBox : null}
            onChange={drawBox}
            outline={regionBox}
            fitToBox
            title="Where the data is"
            description="Draw a box around the area the data covers."
            emptyHint="Use Draw box to mark the area."
          />
        </div>
        <details className="rounded-md border px-3 py-2">
          <summary className="cursor-pointer text-sm font-medium">Edit coordinates</summary>
          <div className="mt-3 grid gap-3 sm:grid-cols-4">
            {(
              [
                ['xmin', 'West'],
                ['ymin', 'South'],
                ['xmax', 'East'],
                ['ymax', 'North'],
              ] as const
            ).map(([key, label]) => (
              <div key={key} className="space-y-1">
                <Label htmlFor={`upload-${key}`}>{label}</Label>
                <Input
                  id={`upload-${key}`}
                  inputMode="decimal"
                  value={box[key]}
                  onChange={(e) => {
                    setBox({ ...box, [key]: e.target.value });
                    setMode('bbox');
                  }}
                />
              </div>
            ))}
          </div>
        </details>
      </section>

      <section className="space-y-2" data-testid="who-can-use">
        <h3 className="font-semibold">Who can use this</h3>
        {!variable ? (
          <p className="text-sm text-muted-foreground">
            Choose a standard variable to see the flows and models that take it as an input.
          </p>
        ) : treeLoading && !tree ? (
          <p className="text-sm text-muted-foreground">Looking up flows and models…</p>
        ) : consumers.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No registered flow or model has an input for this standard variable yet. You can still
            upload the dataset.
          </p>
        ) : (
          <ul className="space-y-1 text-sm">
            {consumers.map((c) => (
              <li key={c.id}>
                <span className="font-medium">{c.name}</span> ({c.kind}, input {c.inputName}):{' '}
                {c.formatFits === null
                  ? c.format
                    ? `reads ${c.format}`
                    : 'any format'
                  : c.formatFits
                    ? 'the format fits'
                    : `the format does not fit. ${c.formatProblem ?? ''}`}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-2">
        <h3 className="font-semibold">What others will see</h3>
        <UploadSummaryCard
          summary={{
            title,
            organization: orgs?.find((o) => o.id === orgId)?.title ?? '',
            isPublic,
            license: licenses?.find((l) => l.id === license)?.title ?? '',
            description,
            author,
            contactEmail,
            startDate: DATE.test(startDate) ? startDate : '',
            endDate: DATE.test(endDate) ? endDate : '',
            regionName: region?.name ?? null,
            box: mode === 'region' ? regionBox : mode === 'bbox' ? drawnBox : null,
            files: files.map((f, i) => ({
              name: f.name,
              format: formatFromName(f.name),
              description: fileNotes[i] ?? '',
            })),
            variable: variable ? standardVariableName(variable) : '',
            tags,
            sourceUrl,
            version,
          }}
        />
      </section>

      {problems.length > 0 && (
        <ul role="alert" className="list-disc pl-5 text-sm text-red-700">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      {error && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}
      {busy && progress && (
        <div role="status" data-testid="upload-progress">
          <progress className="h-2 w-full" max={100} value={percent} />
          <p className="text-sm text-muted-foreground">
            {percent}% · file {Math.min(progress.index + 1, progress.count)} of {progress.count}
          </p>
        </div>
      )}
      <Button type="submit" disabled={busy}>
        {busy ? 'Uploading…' : 'Upload'}
      </Button>
    </form>
  );
}
