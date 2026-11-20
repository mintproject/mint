import * as React from 'react';
import { Link, useParams } from 'react-router-dom';

import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  getApproval,
  originVerification,
  setApproval,
  type PieceApprovalDetail,
} from '@/lib/piece-authoring';

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-1 text-sm">{children}</CardContent>
    </Card>
  );
}

export function PieceApprovalPage() {
  const { specId = '' } = useParams();
  const [piece, setPiece] = React.useState<PieceApprovalDetail | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [confirm, setConfirm] = React.useState<'approve' | 'withdraw' | null>(null);

  const load = React.useCallback(async () => {
    try {
      setPiece(await getApproval(specId));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the piece.');
    }
  }, [specId]);

  React.useEffect(() => {
    void load();
  }, [load]);

  const decide = async (approved: boolean) => {
    if (!piece) return;
    try {
      // The hash shown on this page is the one approved; the adapter refuses if the
      // piece has changed since it was read.
      await setApproval(
        piece.spec_id,
        approved,
        approved ? (piece.approval_sha256 ?? undefined) : undefined,
      );
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The change was not made.');
    }
  };

  if (error && !piece) {
    return (
      <div className="container py-6">
        <p role="alert" className="text-destructive">
          {error}
        </p>
        <Link className="underline" to="/etl/approvals">
          Back to approvals
        </Link>
      </div>
    );
  }
  if (!piece) return <div className="container py-6 text-muted-foreground">Loading piece…</div>;

  const properties = piece.arguments.properties ?? {};
  return (
    <div className="container space-y-4 py-6">
      <Link className="text-sm underline" to="/etl/approvals">
        All approvals
      </Link>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold">{piece.label ?? piece.spec_id}</h1>
          <p className="break-all text-xs text-muted-foreground">
            {piece.spec_id} · version {piece.version ?? 'unversioned'} · owner{' '}
            {piece.owner_username} · {piece.visibility}
          </p>
        </div>
        {piece.approved ? (
          <Badge>approved</Badge>
        ) : piece.lapsed ? (
          <Badge variant="destructive">approval lapsed: the piece changed</Badge>
        ) : (
          <Badge variant="secondary">awaiting approval</Badge>
        )}
      </div>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}

      <Section title="What an approval covers">
        <p>
          Approval hash: <code className="break-all">{piece.approval_sha256}</code>
        </p>
        <p>
          Source SHA-256: <code className="break-all">{piece.source_sha256}</code>
        </p>
        <p>
          Entrypoint: <code>{piece.entrypoint ?? 'none (a script)'}</code>
        </p>
        {piece.origin && (
          <p>
            From{' '}
            <a
              className="underline"
              href={`https://github.com/${piece.origin.repository}/blob/${piece.origin.commit}/${piece.origin.path}`}
              target="_blank"
              rel="noreferrer"
            >
              {piece.origin.repository}
            </a>{' '}
            at <code className="break-all">{piece.origin.commit}</code>,{' '}
            <code>{piece.origin.path}</code>
          </p>
        )}
        <p>
          Origin: <strong>{originVerification(piece.origin)}</strong>
        </p>
        <p>
          The hash covers the source, the entrypoint, the task inputs bound to arguments, the
          declared arguments, the secrets and the data-sent statement. Changing any of them ends the
          approval.
        </p>
      </Section>

      <Section title="Where its data goes">
        {piece.sends_data_to.length === 0 ? (
          <p className="text-muted-foreground">The author declared nothing sent outside DYNAMO.</p>
        ) : (
          piece.sends_data_to.map((s) => (
            <p key={s.service}>
              <strong>{s.service}</strong>: {s.what}
            </p>
          ))
        )}
      </Section>

      <Section title="Secrets it asks for">
        {piece.secrets.length === 0 ? (
          <p className="text-muted-foreground">None.</p>
        ) : (
          piece.secrets.map((s) => (
            <p key={s.name}>
              <strong>{s.label}</strong> ({s.name}) fills{' '}
              {Object.entries(s.env)
                .map(([input, field]) => `${input} from ${field}`)
                .join(', ')}
            </p>
          ))
        )}
      </Section>

      <Section title="Arguments">
        {Object.keys(properties).length === 0 ? (
          <p className="text-muted-foreground">None declared.</p>
        ) : (
          Object.entries(properties).map(([name, schema]) => (
            <p key={name}>
              <code>{name}</code> ({schema.type ?? 'any'})
              {schema.default !== undefined ? `, default ${JSON.stringify(schema.default)}` : ''}
            </p>
          ))
        )}
        {Object.entries(piece.env_from_args).map(([input, arg]) => (
          <p key={input} className="text-xs text-muted-foreground">
            task input {input} is set from {arg}
          </p>
        ))}
      </Section>

      <Section title="Contracts">
        {piece.contracts.map((c, i) => (
          <p key={i} className="break-all text-xs">
            {c.role}: {c.standard_variable_uri}
            {c.format ? ` · ${c.format}` : ''}
            {c.unit ? ` · ${c.unit}` : ''}
          </p>
        ))}
      </Section>

      <Section title="Source">
        <pre className="max-h-[32rem] overflow-auto rounded bg-muted p-3 text-xs">
          {piece.source}
        </pre>
      </Section>

      <Section title="Approval history">
        {piece.history.length === 0 ? (
          <p className="text-muted-foreground">Never approved.</p>
        ) : (
          piece.history.map((h, i) => (
            <p key={i}>
              {h.approved ? 'Approved' : 'Withdrawn'} by {h.by}
              {h.at ? ` on ${h.at}` : ''}
              {h.sha256 ? <code className="ml-2 break-all text-xs">{h.sha256}</code> : null}
            </p>
          ))
        )}
      </Section>

      {piece.is_admin ? (
        <div className="flex gap-3">
          {!piece.approved && (
            <Button type="button" onClick={() => setConfirm('approve')}>
              Approve this piece
            </Button>
          )}
          {(piece.approved || piece.lapsed) && (
            <Button type="button" variant="destructive" onClick={() => setConfirm('withdraw')}>
              Withdraw approval
            </Button>
          )}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          Read-only: only catalog administrators can approve or withdraw.
        </p>
      )}
      <ConfirmDialog
        open={confirm === 'approve'}
        onOpenChange={(open) => !open && setConfirm(null)}
        title="Approve this piece?"
        description="Other users will be able to run exactly this code, with the arguments, secrets and data destinations shown here, using their own Tapis token."
        confirmLabel="Approve"
        onConfirm={() => void decide(true)}
      />
      <ConfirmDialog
        open={confirm === 'withdraw'}
        onOpenChange={(open) => !open && setConfirm(null)}
        title="Withdraw approval?"
        description="Other users will no longer be able to run this piece."
        confirmLabel="Withdraw"
        variant="destructive"
        onConfirm={() => void decide(false)}
      />
    </div>
  );
}
