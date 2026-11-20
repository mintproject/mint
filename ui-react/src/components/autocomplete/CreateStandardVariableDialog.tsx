/**
 * CreateStandardVariableDialog
 *
 * The find-before-create gate as a stand-alone dialog, for pages that have no
 * picker of their own (the Variables page, the upload page's combobox). Step one
 * searches the catalog and lists close matches; only then is the create form
 * offered, so a duplicate is a deliberate choice. Step two is the same
 * CreateStandardVariableForm the model configuration picker uses.
 */

import * as React from 'react';
import { Plus, Search } from 'lucide-react';

import { usePrefetchReferenceDataQuery } from '@/graphql/generated/graphql';
import { humanizeStandardVariable } from '@/lib/standard-variable-grammar';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { CreateStandardVariableForm } from '@/components/autocomplete/CreateStandardVariableForm';
import type { StandardVariableOption } from '@/components/autocomplete/StandardVariableCombobox';
import { useStandardVariableMatches } from '@/components/autocomplete/useStandardVariableMatches';

export interface CreateStandardVariableDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Seed for the search, e.g. what the user typed in a picker. */
  initialSearch?: string;
  /** Called with the new variable once it exists. The dialog closes itself. */
  onCreated: (variable: StandardVariableOption) => void;
}

export function CreateStandardVariableDialog({
  open,
  onOpenChange,
  initialSearch = '',
  onCreated,
}: CreateStandardVariableDialogProps) {
  const [search, setSearch] = React.useState(initialSearch);
  const [creating, setCreating] = React.useState(false);

  // Start every opening from the seed, at the search step.
  React.useEffect(() => {
    if (open) {
      setSearch(initialSearch);
      setCreating(false);
    }
  }, [open, initialSearch]);

  const { data } = usePrefetchReferenceDataQuery({ fetchPolicy: 'cache-first', skip: !open });
  const catalog = React.useMemo<StandardVariableOption[]>(
    () =>
      (data?.modelcatalog_standard_variable ?? []).map((sv) => ({
        id: sv.id,
        label: sv.label ?? '',
        description: sv.description ?? null,
      })),
    [data],
  );
  const { results, loading } = useStandardVariableMatches(search, catalog);
  const query = search.trim();

  const handleCreated = (variable: StandardVariableOption) => {
    onOpenChange(false);
    onCreated(variable);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl gap-0 overflow-hidden p-0">
        <DialogHeader className="border-b px-4 py-3">
          <DialogTitle className="text-base">Create a standard variable</DialogTitle>
          <DialogDescription className="sr-only">
            Search for an existing standard variable first, then create a new one if none fits.
          </DialogDescription>
        </DialogHeader>

        {creating ? (
          <CreateStandardVariableForm
            initialName={query}
            onCreated={handleCreated}
            onCancel={() => setCreating(false)}
          />
        ) : (
          <>
            <div className="flex items-center gap-2 border-b px-4 py-2.5">
              <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
              <input
                aria-label="Search for an existing standard variable"
                placeholder="Search before creating…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              />
            </div>

            <div className="max-h-[280px] min-h-[120px] overflow-auto px-4 py-3">
              {query === '' ? (
                <p className="text-sm text-muted-foreground">
                  Search first. A variable that already exists is better than a near-duplicate.
                </p>
              ) : loading && results.length === 0 ? (
                <p className="text-sm text-muted-foreground">Searching standard variables…</p>
              ) : results.length === 0 ? (
                <p className="text-sm">
                  No standard variable matches <span className="font-semibold">“{query}”</span>.
                </p>
              ) : (
                <>
                  <p className="mb-2 text-sm">Did you mean one of these?</p>
                  <ul aria-label="Close matches" className="space-y-1">
                    {results.slice(0, 8).map((sv) => {
                      const { phenomenon, property } = humanizeStandardVariable(sv.label);
                      return (
                        <li key={sv.id} className="rounded border px-3 py-1.5">
                          <span className="block text-sm font-medium">
                            {phenomenon ? `${phenomenon} — ${property}` : property}
                          </span>
                          <span className="block font-mono text-[10px] text-muted-foreground">
                            {sv.label}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                </>
              )}
            </div>

            <div className="flex items-center justify-end gap-2 border-t px-4 py-3">
              <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={query === ''}
                onClick={() => setCreating(true)}
              >
                <Plus className="mr-1 h-3.5 w-3.5" />
                {results.length > 0 ? 'None of these: create' : 'Create'} “{query}”
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
