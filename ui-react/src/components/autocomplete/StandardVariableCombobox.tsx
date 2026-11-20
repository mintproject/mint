/**
 * StandardVariableCombobox
 *
 * Semantic-search-backed combobox for Standard Variables.
 * Apollo's cache remains the local fallback and supplies the scoped catalog.
 *
 * Filter: case-insensitive substring match on label (primary) and description (secondary).
 * Keyboard: full ARIA combobox pattern via cmdk + Radix Popover.
 *
 * `scope` narrows the list to the variables the caller can act on — see
 * useScopedStandardVariables. The default, `all`, keeps every registration form
 * exactly as it was.
 */

import * as React from 'react';
import { Check, ChevronsUpDown, Plus } from 'lucide-react';

import { cn } from '@/lib/utils';
import { humanizeStandardVariable } from '@/lib/standard-variable-grammar';
import {
  isUnlabeledStandardVariable,
  standardVariableDescription,
  standardVariableName,
} from '@/lib/standard-variable-display';
import { useSemanticSearch } from '@/hooks/useSemanticSearch';
import { Button } from '@/components/ui/button';
import { CreateStandardVariableDialog } from '@/components/autocomplete/CreateStandardVariableDialog';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  useScopedStandardVariables,
  type StandardVariableScope,
} from './useScopedStandardVariables';

export type { StandardVariableScope };

export interface StandardVariableOption {
  id: string;
  label: string;
  description: string | null;
  models?: Array<{
    id: string;
    label: string;
    role: 'input' | 'output';
  }>;
}

export interface StandardVariableComboboxProps {
  /** Optional id used to associate the trigger with an external label. */
  id?: string;
  /** Currently selected standard variable, or null if none selected. */
  value: StandardVariableOption | null;
  /** Called when selection changes. Receives null when cleared. */
  onChange: (sv: StandardVariableOption | null) => void;
  /** Optional placeholder text for the trigger button. */
  placeholder?: string;
  /** Disables the combobox. */
  disabled?: boolean;
  /** Additional className for the trigger button. */
  className?: string;
  /**
   * Narrows the offered list. `all` (the default) offers the whole catalog.
   * `indicator` and `driver` offer only what the thread wizard can act on, and
   * add a link that widens the list back to the whole catalog.
   */
  scope?: StandardVariableScope;
  /** Noun used in the widen/narrow links, e.g. "produces a model". */
  scopeLabel?: string;
  /** Selected outcome used to infer upstream driver variables. */
  driverOutcomeId?: string | null;
  /** Display label for the selected outcome, used to bridge catalog/adapter SVO IDs. */
  driverOutcomeLabel?: string | null;
  /** Selected model configurations used to keep inference task-specific. */
  driverConfigurationIds?: ReadonlyArray<string>;
  /** IDs to place first before the alphabetical catalog order. */
  preferredIds?: ReadonlyArray<string>;
  /**
   * Leave out variables that have no label. For callers that record the label
   * as the variable's name, where an unlabeled row could not be matched later.
   */
  requireLabel?: boolean;
  /**
   * When a search finds nothing, offer to create a standard variable through the
   * find-before-create dialog, then select the new one. For signed-in callers.
   */
  allowCreate?: boolean;
}

export function StandardVariableCombobox({
  id,
  value,
  onChange,
  placeholder = 'Search standard variables...',
  disabled = false,
  className,
  scope = 'all',
  scopeLabel = 'used by a model',
  driverOutcomeId,
  driverOutcomeLabel,
  driverConfigurationIds = [],
  preferredIds = [],
  requireLabel = false,
  allowCreate = false,
}: StandardVariableComboboxProps) {
  const [open, setOpen] = React.useState(false);
  const [search, setSearch] = React.useState('');
  const [showAll, setShowAll] = React.useState(false);
  const [creating, setCreating] = React.useState(false);

  // Reads from Apollo cache — cache-first means no network call if already fetched.
  // The full catalog is fetched only once the user widens a narrowed picker.
  const narrowed = scope !== 'all';
  const { scoped, all, allLoaded, loading } = useScopedStandardVariables(
    scope,
    showAll,
    driverOutcomeId,
    driverOutcomeLabel,
    driverConfigurationIds,
  );

  const options = narrowed && !showAll ? scoped : all;
  const semanticSearch = useSemanticSearch(search, { target: 'svo', limit: 50 });
  const semanticOptions = React.useMemo(
    () =>
      semanticSearch.results?.map((result) => ({
        id: result.id,
        label: result.label ?? '',
        description: result.description ?? null,
        models: Array.isArray(result.models) ? result.models : [],
      })) ?? null,
    [semanticSearch.results],
  );

  /**
   * Semantic results are ranked over the whole catalog, so the scope has to be
   * applied to them too. Without this the ranked list puts back exactly the dead
   * ends the scope removes. If the scope drops every ranked hit, fall back to
   * the plain list rather than showing nothing.
   */
  const rankedOptions = React.useMemo(() => {
    if (semanticOptions === null) return null;
    if (!semanticOptions.length) return [];
    if (!narrowed || showAll) return semanticOptions;
    const inScope = new Set(scoped.map((o) => o.id));
    const kept = semanticOptions.filter((o) => inScope.has(o.id));
    return kept;
  }, [semanticOptions, narrowed, showAll, scoped]);

  /**
   * A thread can already hold a variable the scope does not carry — at TACC one
   * live thread holds an indicator that no configuration produces. Pin the
   * stored value to the top so the user can see what is set, instead of meeting
   * a control that reads as empty.
   */
  const visibleOptions = React.useMemo(() => {
    const listed = rankedOptions ?? options;
    const base = requireLabel ? listed.filter((o) => !isUnlabeledStandardVariable(o)) : listed;
    // Semantic search results already have a query-specific ranking. Apply the
    // task/goal ranking only to the unfiltered catalog list.
    const ordered =
      rankedOptions === null && preferredIds.length > 0
        ? (() => {
            const preferredOrder = new Map(preferredIds.map((id, index) => [id, index]));
            return [...base].sort(
              (a, b) =>
                (preferredOrder.get(a.id) ?? preferredIds.length) -
                (preferredOrder.get(b.id) ?? preferredIds.length),
            );
          })()
        : base;
    if (!value || ordered.some((o) => o.id === value.id)) return ordered;
    return [value, ...ordered];
  }, [rankedOptions, options, preferredIds, value, requireLabel]);

  const handleSelect = React.useCallback(
    (selectedId: string) => {
      if (value?.id === selectedId) {
        // Deselect on re-click
        onChange(null);
      } else {
        const found =
          visibleOptions.find((o) => o.id === selectedId) ??
          all.find((o) => o.id === selectedId) ??
          null;
        onChange(found);
      }
      setOpen(false);
    },
    [value, visibleOptions, all, onChange],
  );

  const triggerLabel = !value
    ? placeholder
    : (standardVariableDescription(value) ??
      (isUnlabeledStandardVariable(value)
        ? standardVariableName(value)
        : (() => {
            const { phenomenon, property } = humanizeStandardVariable(value.label);
            return phenomenon ? `${phenomenon} — ${property}` : property;
          })()));

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            id={id}
            variant="outline"
            role="combobox"
            aria-expanded={open}
            aria-label="Select standard variable"
            disabled={disabled || loading}
            className={cn('w-full justify-between font-normal', className)}
          >
            <span className={cn('truncate', !value && 'text-muted-foreground')}>
              {loading ? 'Loading...' : triggerLabel}
            </span>
            <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-0" align="start">
          <Command shouldFilter={semanticOptions === null}>
            <CommandInput placeholder={placeholder} onValueChange={setSearch} />
            <CommandList>
              <CommandEmpty>
                {semanticSearch.loading ? (
                  'Searching…'
                ) : (
                  <>
                    <span className="block">No matching standard variables.</span>
                    {allowCreate && (
                      <button
                        type="button"
                        className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-primary hover:underline"
                        onClick={() => {
                          setOpen(false);
                          setCreating(true);
                        }}
                      >
                        <Plus className="h-3.5 w-3.5" /> Create a standard variable
                      </button>
                    )}
                  </>
                )}
              </CommandEmpty>
              <CommandGroup>
                {visibleOptions.map((sv) => (
                  <CommandItem
                    key={sv.id}
                    // cmdk identifies items by `value`, which must be UNIQUE. Standard
                    // variables frequently share a label (and many have no description),
                    // so a label-derived value collides across items and breaks click
                    // selection in the browser. Key by the unique id; keep label and
                    // description searchable via `keywords`.
                    value={sv.id}
                    keywords={[sv.label, sv.description ?? ''].filter(Boolean)}
                    onSelect={() => handleSelect(sv.id)}
                  >
                    <Check
                      className={cn(
                        'mr-2 h-4 w-4 shrink-0',
                        value?.id === sv.id ? 'opacity-100' : 'opacity-0',
                      )}
                    />
                    <div className="flex min-w-0 flex-col">
                      {standardVariableDescription(sv) && (
                        <span className="line-clamp-1 font-medium">
                          {standardVariableDescription(sv)}
                        </span>
                      )}
                      <span
                        className={cn(
                          'line-clamp-1',
                          standardVariableDescription(sv) || !isUnlabeledStandardVariable(sv)
                            ? 'text-xs text-muted-foreground'
                            : 'font-medium',
                        )}
                      >
                        {standardVariableName(sv)}
                      </span>
                      {!!sv.models?.length && (
                        <span className="line-clamp-1 text-[11px] text-muted-foreground/80">
                          {sv.models
                            .slice(0, 2)
                            .map((model) => `${model.label} (${model.role})`)
                            .join(' · ')}
                          {sv.models.length > 2 ? ` · +${sv.models.length - 2} more` : ''}
                        </span>
                      )}
                    </div>
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
            {narrowed && (
              // Outside CommandList so cmdk's filter never hides the escape.
              <div className="border-t px-2 py-1.5">
                <button
                  type="button"
                  className="w-full rounded px-1 py-0.5 text-left text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                  onClick={() => setShowAll((v) => !v)}
                >
                  {showAll
                    ? `Showing ${allLoaded ? `all ${all.length}` : 'every'} standard variable — show only the ${scoped.length} ${scopeLabel}`
                    : `Showing the ${scoped.length} ${scopeLabel} — show every standard variable`}
                </button>
              </div>
            )}
          </Command>
        </PopoverContent>
      </Popover>
      {allowCreate && (
        <CreateStandardVariableDialog
          open={creating}
          onOpenChange={setCreating}
          initialSearch={search}
          onCreated={(created) => onChange(created)}
        />
      )}
    </>
  );
}
