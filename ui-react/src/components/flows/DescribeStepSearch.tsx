/**
 * "Describe what this step should do": a free-text search over the ETL pieces,
 * ranked by meaning (`/search?target=etl_piece`). Each result shows what the
 * piece takes and returns; "Add as a step" adds it and the live check then
 * decides whether it fits, as for any step.
 *
 * The semantic service may list only public and shared pieces, so the caller's
 * own private pieces (from the list the form already loads) are matched on their
 * words and appended. If the service is down the form carries on with those.
 */
import { useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import {
  useSemanticSearch,
  type SemanticPieceResult,
  type SemanticPieceSlot,
} from '@/hooks/useSemanticSearch';
import type { PickerPiece } from '@/graphql/queries/flow-authoring';
import { slugFromUri } from '@/lib/uri';

const LIMIT = 8;

export interface DescribeStepSearchProps {
  /** The pieces the user may see; their private ones are merged into the results. */
  pieces: PickerPiece[];
  onAdd: (pieceId: string) => void;
  /** Wait before a typed query is searched. Tests set 0. */
  delayMs?: number;
}

const words = (text: string) =>
  text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 2);

/** The user's own private pieces that share a word with the query. */
function privateMatches(
  pieces: PickerPiece[],
  query: string,
  already: Set<string>,
): SemanticPieceResult[] {
  const wanted = words(query);
  if (wanted.length === 0) return [];
  return pieces
    .filter((piece) => piece.visibility === 'private' && !already.has(piece.id))
    .filter((piece) => {
      const own = new Set(words(`${piece.label ?? ''} ${piece.description ?? ''}`));
      return wanted.some((word) => own.has(word));
    })
    .map((piece) => ({
      id: piece.id,
      label: piece.label,
      description: piece.description,
      visibility: piece.visibility,
      owner_username: piece.owner_username,
    }));
}

function slots(items: SemanticPieceSlot[] | undefined): string {
  if (!items || items.length === 0) return 'not stated';
  return items
    .map((slot) => {
      const name =
        slot.label?.trim() ||
        (slot.standard_variable_uri ? slugFromUri(slot.standard_variable_uri) : 'any variable');
      return slot.format ? `${name} (${slot.format})` : name;
    })
    .join(', ');
}

export function DescribeStepSearch({ pieces, onAdd, delayMs = 400 }: DescribeStepSearchProps) {
  const [text, setText] = useState('');
  const query = useDebouncedValue(text, delayMs);
  const { results, loading, error } = useSemanticSearch(query, {
    target: 'etl_piece',
    limit: LIMIT,
    minLength: 3,
  });

  const merged = useMemo<SemanticPieceResult[]>(() => {
    const ranked = (results ?? []) as SemanticPieceResult[];
    return [
      ...ranked,
      ...privateMatches(pieces, query, new Set(ranked.map((result) => result.id))),
    ];
  }, [results, pieces, query]);

  return (
    <div className="mt-3 space-y-2" data-testid="describe-step">
      <label className="block text-xs">
        Describe what this step should do
        <Input
          className="mt-1"
          aria-label="Describe what this step should do"
          placeholder="e.g. count how often lexicon terms appear"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      </label>
      {loading && <p className="text-xs text-muted-foreground">Searching the pieces…</p>}
      {error && (
        <p className="text-xs text-muted-foreground">
          Search by description is unavailable right now. You can still pick a piece by name.
        </p>
      )}
      {merged.length > 0 && (
        <ul className="space-y-2" aria-label="Pieces that match the description">
          {merged.map((piece) => (
            <li key={piece.id} className="rounded border p-2 text-xs">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{piece.label?.trim() || piece.id}</span>
                {piece.visibility === 'private' && (
                  <span className="text-muted-foreground">(private, yours)</span>
                )}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  aria-label={`Add ${piece.label?.trim() || piece.id} as a step`}
                  onClick={() => onAdd(piece.id)}
                >
                  Add as a step
                </Button>
              </div>
              {piece.description && <p className="mt-1">{piece.description}</p>}
              <p className="mt-1 text-muted-foreground">
                Takes: {slots(piece.inputs)}. Returns: {slots(piece.outputs)}.
              </p>
            </li>
          ))}
        </ul>
      )}
      {!loading &&
        !error &&
        results !== null &&
        merged.length === 0 &&
        query.trim().length >= 3 && (
          <p className="text-xs text-muted-foreground">No piece matches that description.</p>
        )}
    </div>
  );
}
