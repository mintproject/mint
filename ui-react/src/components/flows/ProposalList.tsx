/**
 * What the adapter proposed for one slot of the flow, to take with a click.
 *
 * The proposals are exact: each one passes the same fit rule as the check, and
 * nothing is ranked (they come shortest first). A proposal that rests on a piece
 * with a blank contract carries a warning, because blank fits anything.
 */
import { Link } from 'react-router-dom';

import { Button } from '@/components/ui/button';
import type { NeedProviders, Proposal, ProposeResult } from '@/lib/flow-authoring-api';
import type { ProposedChain, ProposedSource } from '@/lib/flow-authoring';
import { slugFromUri } from '@/lib/uri';

export type SuggestionKind = 'input' | 'output' | 'want';

export interface ProposalListProps {
  kind: SuggestionKind;
  result: ProposeResult | 'loading';
  pieceLabel: (id: string) => string;
  sourceLabel: (source: ProposedSource) => string;
  onDirect?: (source: ProposedSource) => void;
  onChain?: (chain: ProposedChain) => void;
  onNext?: (next: Proposal['next'][number]) => void;
  onProduces?: (entry: Proposal['produces'][number]) => void;
  /** Add a flow input bound to a dataset's variable (see `canUseDataset`). */
  onUseDataset?: (
    entry: Proposal['produces'][number],
    need: Proposal['produces'][number]['inputs'][number],
    dataset: NeedProviders['datasets'][number],
  ) => void;
  /** Whether a dataset can become a flow input for this need (button vs advice). */
  canUseDataset?: (
    entry: Proposal['produces'][number],
    need: Proposal['produces'][number]['inputs'][number],
  ) => boolean;
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
        <ul className="space-y-2">
          {proposal.produces.map((item, index) => (
            <li key={index}>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => props.onProduces?.(item)}
              >
                Add {item.label ?? pieceLabel(item.piece)}
              </Button>
              <span className="ml-2 text-muted-foreground">
                {item.complete ? 'every input has a source' : 'some inputs still need a source'}
                {approvalNote(item.approval)}
              </span>
              <ul className="ml-4 list-disc">
                {item.inputs.map((need) => (
                  <li key={need.input}>
                    input {need.input}:{' '}
                    {need.direct.length > 0
                      ? `from ${sourceLabel(need.direct[0]!.source)}`
                      : need.chains.length > 0
                        ? `needs ${need.chains[0]!.pieces.length} converter step(s)`
                        : 'nothing in the flow fits'}
                    {!need.met && need.providers && (
                      <Providers
                        providers={need.providers}
                        canUse={props.canUseDataset?.(item, need) ?? false}
                        onUse={(dataset) => props.onUseDataset?.(item, need, dataset)}
                      />
                    )}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
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

/** What could supply an unmet input: advice, since neither makes the need met. */
function Providers({
  providers,
  canUse,
  onUse,
}: {
  providers: NeedProviders;
  canUse: boolean;
  onUse: (dataset: NeedProviders['datasets'][number]) => void;
}) {
  if (providers.models.length === 0 && providers.datasets.length === 0) return null;
  return (
    <ul className="ml-4 list-disc text-muted-foreground" data-testid="need-providers">
      {providers.models.map((model) => (
        <li key={model.configuration_id}>
          Run model{' '}
          <Link
            className="underline"
            to={`/modelconfigurations/${slugFromUri(model.configuration_id)}`}
          >
            {model.label || model.configuration_id}
          </Link>{' '}
          first{model.output ? ` (its output ${model.output} fits)` : ''}
        </li>
      ))}
      {providers.datasets.map((dataset) => (
        <li key={dataset.data_object_id}>
          {canUse ? (
            <Button type="button" variant="ghost" size="sm" onClick={() => onUse(dataset)}>
              Use dataset {dataset.label || dataset.data_object_id} as a flow input
            </Button>
          ) : (
            <>Use dataset {dataset.label || dataset.data_object_id} as a flow input</>
          )}
        </li>
      ))}
    </ul>
  );
}
