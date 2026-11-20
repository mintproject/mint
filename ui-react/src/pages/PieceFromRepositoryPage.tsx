import * as React from 'react';
import { Link } from 'react-router-dom';

import { PieceFromRepositoryForm } from '@/components/registration/PieceFromRepositoryForm';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  buildRequest,
  originVerification,
  formProblems,
  initialPieceForm,
  registerPiece,
  type PieceFormState,
  type PiecePreview,
} from '@/lib/piece-authoring';

function PreviewPanel({ preview }: { preview: PiecePreview }) {
  return (
    <Card aria-label="What will be stored">
      <CardHeader>
        <CardTitle>{preview.dry_run ? 'What will be stored' : 'Stored'}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p className="text-xs text-muted-foreground">
          The piece&apos;s id is assigned when it is registered.
        </p>
        <p>
          Source: <code>{preview.origin.repository}</code> at{' '}
          <code className="break-all">{preview.origin.commit}</code>,{' '}
          <code>{preview.origin.path}</code>. {preview.source_bytes} bytes, SHA-256{' '}
          <code className="break-all">{preview.source_sha256}</code>
        </p>
        <p>Origin: {originVerification(preview.origin)}</p>
        <p>
          Entrypoint: <code>{preview.entrypoint}</code>. Visibility: {preview.visibility}.
        </p>
        {preview.warnings.map((warning) => (
          <p key={warning} role="status" className="text-amber-700">
            {warning}
          </p>
        ))}
        <div>
          <p className="font-medium">Contracts</p>
          {preview.contracts.map((c, i) => (
            <p key={i} className="break-all text-xs text-muted-foreground">
              {c.role}: {c.standard_variable_uri}
              {c.format ? ` · ${c.format}` : ''}
              {c.unit ? ` · ${c.unit}` : ''}
            </p>
          ))}
        </div>
        {Object.keys(preview.arguments).length > 0 && (
          <div>
            <p className="font-medium">Run arguments</p>
            {Object.entries(preview.arguments).map(([name, schema]) => (
              <p key={name} className="text-xs text-muted-foreground">
                {name} ({schema.type})
                {schema.default !== undefined ? `, default ${String(schema.default)}` : ''}
                {preview.required.includes(name) ? ', required' : ''}
              </p>
            ))}
          </div>
        )}
        {preview.secrets.length > 0 && (
          <p>Secrets: {preview.secrets.map((s) => s.name).join(', ')}</p>
        )}
        {preview.sends_data_to.length > 0 && (
          <p>
            Sends data to: {preview.sends_data_to.map((s) => `${s.service} (${s.what})`).join('; ')}
          </p>
        )}
        <details>
          <summary className="cursor-pointer">The source, as fetched</summary>
          <pre className="mt-2 max-h-96 overflow-auto rounded bg-muted p-3 text-xs">
            {preview.source}
          </pre>
        </details>
      </CardContent>
    </Card>
  );
}

export function PieceFromRepositoryPage() {
  const [form, setForm] = React.useState<PieceFormState>(initialPieceForm);
  const [preview, setPreview] = React.useState<PiecePreview | null>(null);
  const [created, setCreated] = React.useState<PiecePreview | null>(null);
  const [problems, setProblems] = React.useState<string[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  // Any change to the form makes the preview stale: it must be asked for again.
  const change = (next: PieceFormState) => {
    setForm(next);
    setPreview(null);
    setCreated(null);
    setError(null);
  };

  const run = async (dryRun: boolean) => {
    const found = formProblems(form);
    setProblems(found);
    if (found.length > 0) return;
    setBusy(true);
    setError(null);
    try {
      const result = await registerPiece(buildRequest(form, dryRun));
      if (dryRun) setPreview(result);
      else setCreated(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The request failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="container space-y-6 py-6">
      <div>
        <h1 className="text-2xl font-bold">Register a piece</h1>
        <p className="text-muted-foreground">
          A piece&apos;s code is one file of a public GitHub repository at a pinned commit. The
          adapter fetches it, so what is stored is exactly what is in the repository.
        </p>
      </div>
      <Card>
        <CardContent className="pt-6">
          <PieceFromRepositoryForm value={form} onChange={change} />
        </CardContent>
      </Card>
      {problems.length > 0 && (
        <ul role="alert" className="list-disc pl-5 text-sm text-destructive">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex gap-3">
        <Button type="button" variant="outline" disabled={busy} onClick={() => void run(true)}>
          Preview
        </Button>
        <Button
          type="button"
          disabled={busy || !preview || !!created}
          onClick={() => void run(false)}
        >
          Register this piece
        </Button>
      </div>
      {preview && !created && <PreviewPanel preview={preview} />}
      {created && (
        <div role="status" className="space-y-2 text-sm">
          <p>
            Registered <code className="break-all">{created.process_id}</code> as{' '}
            {created.owner_username}.
            {created.visibility !== 'private' && ' It needs approval before others can run it.'}
          </p>
          <Link
            className="underline"
            to={`/etl/approvals/${encodeURIComponent(created.process_id ?? '')}`}
          >
            Open its approval page
          </Link>
        </div>
      )}
    </div>
  );
}
