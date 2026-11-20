/**
 * EditedInputNote — says that a flow run continued on a file its user edited.
 *
 * Shown on the run and on its results, so that nobody reads the counts as if the
 * flow's own draft had been used. It names who edited the file and when, the
 * catalog dataset it was uploaded to, and the hash of the file the run fetched.
 */
import type { UnifiedRunReplacement } from '@/lib/ensemble-manager';

/** What the edited file is called in a sentence: a lexicon, or just a file. */
function editedFileKind(replacement: Pick<UnifiedRunReplacement, 'check'>): string {
  return replacement.check === 'lexicon' ? 'lexicon' : 'file';
}

function when(stamp: string | undefined): string {
  const date = stamp ? new Date(stamp) : null;
  return date && !Number.isNaN(date.getTime())
    ? `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`
    : '';
}

export function EditedInputNote({ replacement }: { replacement: UnifiedRunReplacement }) {
  const kind = editedFileKind(replacement);
  const details = [
    replacement.replaced_by && `Edited by ${replacement.replaced_by}`,
    when(replacement.replaced_at) && `on ${when(replacement.replaced_at)}`,
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <div
      className="rounded border border-amber-200 bg-amber-50 px-2 py-2 text-xs text-amber-900"
      data-testid="edited-input-note"
    >
      <div className="font-medium">This result used an edited {kind}.</div>
      <div>
        {details && `${details}. `}
        {replacement.dataset_id && (
          <>
            Catalog dataset <code>{replacement.dataset_id}</code>
            {replacement.file ? <>, replacing {replacement.file}</> : null}.{' '}
          </>
        )}
        {replacement.sha256 && (
          <>
            File fetched by the run:{' '}
            <code title={replacement.sha256}>{replacement.sha256.slice(0, 12)}</code>
            {typeof replacement.bytes === 'number' ? <> ({replacement.bytes} bytes)</> : null}.
          </>
        )}
      </div>
    </div>
  );
}
