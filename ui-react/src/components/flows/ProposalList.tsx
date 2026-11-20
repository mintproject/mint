/**
 * What the adapter proposed for one slot of the flow, to take with a click.
 *
 * The proposals are exact: each one passes the same fit rule as the check, and
 * nothing is ranked (they come shortest first). A proposal that rests on a piece
 * with a blank contract carries a warning, because blank fits anything.
 */
import { Button } from '@/components/ui/button';
import type { Proposal, ProposeResult } from '@/lib/flow-authoring-api';
import type { ProposedChain, ProposedSource } from '@/lib/flow-authoring';
import type { RouteChoice } from '@/lib/flow-routes';

import { RouteList } from './RouteList';

export type SuggestionKind = 'input' | 'output' | 'want';

export interface ProposalListProps {
  kind: SuggestionKind;
  result: ProposeResult | 'loading';
  pieceLabel: (id: string) => string;
  sourceLabel: (source: ProposedSource) => string;
  onDirect?: (source: ProposedSource) => void;
  onChain?: (chain: ProposedChain) => void;
  onNext?: (next: Proposal['next'][number]) => void;
  /** The wanted variable's label, for the group headings of a "want" answer. */
  wantedLabel?: string;
  /** Take a whole route into the flow, with the provider chosen for an unmet input. */
  onAddRoute?: (entry: Proposal['produces'][number], choice?: RouteChoice) => void;
}

const approvalNote = (approval?: string | null) =>
  approval === 'denied' ? ' (you cannot run this piece yet)' : '';

export function ProposalList(props: ProposalListProps) {
  const { kind, result, pieceLabel, sourceLabel } = props;
  if (result === 'loading') {
    return <p className="mt-1 text-xs text-muted-foreground">Looking for what fits…</p>;
  }
  if ('error' in result) {
    return (
      <p role="alert" className="mt-1 text-xs text-destructive">
        {result.error}
      </p>
    );
  }
  const { proposal } = result;
  const empty =
    kind === 'input'
      ? proposal.direct.length + proposal.chains.length === 0
      : kind === 'output'
        ? proposal.next.length === 0
        : proposal.produces.length === 0;
  return (
    <div className="mt-1 rounded border bg-muted/30 p-2 text-xs" data-testid="proposals">
      {empty && <p>Nothing in the catalog fits.</p>}
      {proposal.direct.length > 0 && (
        <ul className="space-y-1">
          {proposal.direct.map((item, index) => (
            <li key={index}>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => props.onDirect?.(item.source)}
              >
                Use {sourceLabel(item.source)}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {proposal.chains.length > 0 && (
        <ul className="mt-1 space-y-1">
          {proposal.chains.map((chain, index) => (
            <li key={index}>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => props.onChain?.(chain)}
              >
                Convert {sourceLabel(chain.from)} through{' '}
                {chain.pieces.map((piece) => pieceLabel(piece.piece)).join(' then ')}
              </Button>
              {chain.lossy && <span className="ml-2 text-amber-700">loses information</span>}
            </li>
          ))}
        </ul>
      )}
      {proposal.next.length > 0 && (
        <ul className="space-y-1">
          {proposal.next.map((item, index) => (
            <li key={index}>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => props.onNext?.(item)}
              >
                Add {item.label ?? pieceLabel(item.piece)} (input {item.input})
              </Button>
              <span className="ml-2 text-muted-foreground">{approvalNote(item.approval)}</span>
            </li>
          ))}
        </ul>
      )}
      {proposal.produces.length > 0 && (
        <RouteList
          produces={proposal.produces}
          wantedLabel={props.wantedLabel ?? 'the wanted result'}
          pieceLabel={pieceLabel}
          sourceLabel={sourceLabel}
          onAddRoute={(entry, choice) => props.onAddRoute?.(entry, choice)}
        />
      )}
      {proposal.warnings.length > 0 && (
        <p className="mt-1 text-amber-700">
          {proposal.warnings.map((w) => pieceLabel(w.piece)).join(', ')}: a blank contract fits
          anything, so check these.
        </p>
      )}
      {proposal.cut && (
        <p className="mt-1 text-muted-foreground">
          More fit than are shown, or the search stopped at its limit.
        </p>
      )}
    </div>
  );
}
