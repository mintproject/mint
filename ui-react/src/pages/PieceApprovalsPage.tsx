import * as React from 'react';
import { Link } from 'react-router-dom';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { listApprovals, type PieceSummary } from '@/lib/piece-authoring';

function Row({ piece }: { piece: PieceSummary }) {
  return (
    <Card>
      <CardContent className="flex flex-wrap items-center justify-between gap-3 py-4">
        <div className="min-w-0">
          <Link
            className="font-medium underline"
            to={`/etl/approvals/${encodeURIComponent(piece.spec_id)}`}
          >
            {piece.label ?? piece.spec_id}
          </Link>
          <p className="break-all text-xs text-muted-foreground">
            {piece.spec_id} · owner {piece.owner_username ?? 'unknown'} · {piece.visibility}
          </p>
          {piece.approved && (
            <p className="text-xs text-muted-foreground">
              Approved by {piece.approved_by} {piece.approved_at ? `on ${piece.approved_at}` : ''}
            </p>
          )}
        </div>
        {piece.approved ? (
          <Badge>approved</Badge>
        ) : piece.lapsed ? (
          <Badge variant="destructive">approval lapsed</Badge>
        ) : (
          <Badge variant="secondary">awaiting approval</Badge>
        )}
      </CardContent>
    </Card>
  );
}

export function PieceApprovalsPage() {
  const [data, setData] = React.useState<{ is_admin: boolean; pieces: PieceSummary[] } | null>(
    null,
  );
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let live = true;
    listApprovals()
      .then((result) => live && setData(result))
      .catch(
        (e: unknown) => live && setError(e instanceof Error ? e.message : 'Could not load pieces.'),
      );
    return () => {
      live = false;
    };
  }, []);

  // A private piece runs only for its owner, so it has nothing to approve.
  const shared = (data?.pieces ?? []).filter((p) => p.visibility !== 'private');
  const awaiting = shared.filter((p) => !p.approved);
  const approved = shared.filter((p) => p.approved);

  return (
    <div className="container space-y-6 py-6">
      <div>
        <h1 className="text-2xl font-bold">Piece approvals</h1>
        <p className="text-muted-foreground">
          A shared or public piece runs for other users only once an administrator has approved the
          code as it is now.
          {data && !data.is_admin && ' You can read these pages; only administrators can approve.'}
        </p>
      </div>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      {!data && !error && <p className="text-muted-foreground">Loading pieces…</p>}
      {data && (
        <>
          <section className="space-y-3" aria-label="Awaiting approval">
            <h2 className="text-lg font-semibold">Awaiting approval ({awaiting.length})</h2>
            {awaiting.length === 0 && (
              <p className="text-sm text-muted-foreground">Nothing is waiting.</p>
            )}
            {awaiting.map((p) => (
              <Row key={p.spec_id} piece={p} />
            ))}
          </section>
          <section className="space-y-3" aria-label="Approved">
            <h2 className="text-lg font-semibold">Approved ({approved.length})</h2>
            {approved.length === 0 && (
              <p className="text-sm text-muted-foreground">Nothing is approved yet.</p>
            )}
            {approved.map((p) => (
              <Row key={p.spec_id} piece={p} />
            ))}
          </section>
        </>
      )}
    </div>
  );
}
