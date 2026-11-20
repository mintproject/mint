import { humanizeStandardVariable } from '@/lib/standard-variable-grammar';

/**
 * How a standard variable reads in a list.
 *
 * Some catalog rows have no label (the SVO adapter's semantic search returns an
 * empty one, and a registered variable may never have been named). The option
 * mapper gives such a row the label "Unnamed standard variable" and, as its
 * description, "Catalog ID: <id>", so the picker used to show only a bare id.
 * These helpers decide what to show instead.
 */

/** The placeholder label `toStandardVariableOption` gives a row with no label. */
export const UNNAMED_STANDARD_VARIABLE = 'Unnamed standard variable';
const CATALOG_ID_PREFIX = 'Catalog ID:';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface VariableLike {
  id: string;
  label?: string | null;
  description?: string | null;
}

/** True when the row has no real label of its own. */
export function isUnlabeledStandardVariable(sv: VariableLike): boolean {
  const label = (sv.label ?? '').trim();
  return !label || label === UNNAMED_STANDARD_VARIABLE;
}

/** The last part of an id: the tail of a URI, or the last 8 characters of a bare UUID. */
function idTail(id: string): string {
  const tail = id.split(/[/#]/).filter(Boolean).pop() ?? id;
  return UUID.test(tail) ? `…${tail.slice(-8)}` : tail;
}

/** A readable name: the label, else the id's last part marked "(no label)". */
export function standardVariableName(sv: VariableLike): string {
  return isUnlabeledStandardVariable(sv) ? `${idTail(sv.id)} (no label)` : sv.label!.trim();
}

/** The row's description, or null when it is absent or only the "Catalog ID:" filler. */
export function standardVariableDescription(sv: VariableLike): string | null {
  const text = (sv.description ?? '').trim();
  return text && !text.startsWith(CATALOG_ID_PREFIX) ? text : null;
}

/**
 * The title an option leads with: the label, humanized ("Document lexicon group
 * — Term count" from `document_lexicon_group__term_count`). A row with no label
 * borrows the id's tail when that is grammar-shaped, else reads as unnamed.
 */
export function standardVariableTitle(sv: VariableLike): string {
  const source = isUnlabeledStandardVariable(sv) ? idTail(sv.id) : sv.label!.trim();
  if (isUnlabeledStandardVariable(sv) && !source.includes('__')) return standardVariableName(sv);
  const { phenomenon, property } = humanizeStandardVariable(source);
  if (phenomenon) return `${phenomenon} — ${property}`;
  // Not grammar (no `__`): the label is the whole name, so only spell out its joiners.
  const spaced = property.replace(/[~_]+/g, ' ').replace(/\s+/g, ' ').trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** A key that makes two rows naming the same variable collide; null for unlabeled rows. */
export function standardVariableLabelKey(sv: VariableLike): string | null {
  return isUnlabeledStandardVariable(sv) ? null : sv.label!.trim().toLowerCase();
}

/** Drop repeats by id, then (for labeled rows) by label, keeping the first seen. */
export function dedupeStandardVariables<T extends VariableLike>(
  rows: ReadonlyArray<T>,
  { byLabel = false }: { byLabel?: boolean } = {},
): T[] {
  const ids = new Set<string>();
  const labels = new Set<string>();
  const kept: T[] = [];
  for (const row of rows) {
    if (ids.has(row.id)) continue;
    const key = byLabel ? standardVariableLabelKey(row) : null;
    if (key !== null && labels.has(key)) continue;
    ids.add(row.id);
    if (key !== null) labels.add(key);
    kept.push(row);
  }
  return kept;
}
