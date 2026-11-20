/**
 * Shown when "Find pieces that make it" finds nothing exact: the standard
 * variables CLOSE to the wanted one (`/similar`), and the pieces that make each
 * (the propose route, once per close variable, at most MAX_CLOSE of them).
 *
 * None of this is an exact match, and it says so. Choosing a piece adds it as a
 * step, and the live check decides whether it fits; choosing a variable makes it
 * the wanted result instead.
 */
import { useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { fetchSimilarVariables } from '@/hooks/useSemanticSearch';
import { buildCheckBody, type FlowDraft } from '@/lib/flow-authoring';
import { proposeForFlow, type Proposal } from '@/lib/flow-authoring-api';
import { slugFromUri } from '@/lib/uri';

export const MAX_CLOSE = 3;

interface CloseEntry {
  id: string;
  label: string;
  produces: Proposal['produces'];
}

export interface CloseVariableProposalsProps {
  wanted: { id: string; label: string };
  draft: FlowDraft;
  token: string;
  pieceLabel: (id: string) => string;
  onAdd: (entry: Proposal['produces'][number]) => void;
  onWant: (variable: { id: string; label: string }) => void;
  /** Wait before the lookups start. Tests set 0. */
  delayMs?: number;
}

export function CloseVariableProposals({
  wanted,
  draft,
  token,
  pieceLabel,
  onAdd,
  onWant,
  delayMs = 400,
}: CloseVariableProposalsProps) {
  const [entries, setEntries] = useState<CloseEntry[] | null>(null);
  const draftRef = useRef(draft);
  draftRef.current = draft;

  useEffect(() => {
    setEntries(null);
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const similar = (
            await fetchSimilarVariables(wanted.id, {
              limit: MAX_CLOSE + 1,
              signal: controller.signal,
            })
          )
            .filter((item) => item.id !== wanted.id)
            .slice(0, MAX_CLOSE);
          const body = buildCheckBody(draftRef.current);
          const found = await Promise.all(
            similar.map(async (item): Promise<CloseEntry | null> => {
              const result = await proposeForFlow(
                body,
                { contract: { standard_variable_uri: item.id } },
                token,
                controller.signal,
              );
              if ('error' in result || result.proposal.produces.length === 0) return null;
              return {
                id: item.id,
                label: item.label?.trim() || slugFromUri(item.id),
                produces: result.proposal.produces,
              };
            }),
          );
          if (!controller.signal.aborted) {
            setEntries(found.filter((entry): entry is CloseEntry => entry !== null));
          }
        } catch {
          // The semantic service is optional: with it down there is nothing to add.
          if (!controller.signal.aborted) setEntries([]);
        }
      })();
    }, delayMs);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [wanted.id, token, delayMs]);

  if (entries === null) {
    return <p className="mt-1 text-xs text-muted-foreground">Looking for close variables…</p>;
  }
  if (entries.length === 0) return null;
  return (
    <div className="mt-2 rounded border border-dashed p-2 text-xs" data-testid="close-variables">
      <p>
        No piece makes <em>{wanted.label}</em> exactly. These make close variables:
      </p>
      <ul className="mt-1 space-y-2">
        {entries.map((entry) => (
          <li key={entry.id}>
            <span className="font-medium">{entry.label}</span>{' '}
            <span className="text-amber-700">(close, not an exact match)</span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-label={`Want ${entry.label} instead`}
              onClick={() => onWant({ id: entry.id, label: entry.label })}
            >
              Want this instead
            </Button>
            <ul className="ml-4 list-disc">
              {entry.produces.map((piece, index) => (
                <li key={index}>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    aria-label={`Add ${piece.label ?? pieceLabel(piece.piece)} for ${entry.label}`}
                    onClick={() => onAdd(piece)}
                  >
                    Add {piece.label ?? pieceLabel(piece.piece)}
                  </Button>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </div>
  );
}
