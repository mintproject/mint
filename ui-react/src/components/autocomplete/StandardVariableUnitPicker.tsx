/**
 * StandardVariableUnitPicker
 *
 * Option C — a single merged "Standard variable & unit" field for the model
 * Input/Output row. A compact trigger opens a modal dialog that runs a guided
 * phenomenon → property → unit flow:
 *
 *  - Browse: pick a phenomenon, then its property (CSDMS grammar as navigation,
 *    via buildPhenomenonGroups). Duplicate labels collapse to one entry.
 *  - Search: type to rank across all variables (rankStandardVariables); the
 *    non-grammar / human-named labels are reachable only here.
 *  - Unit: radio cards seeded from the variable's presentations
 *    (useVariableUnits); "search all" expands to the full unit list grouped by
 *    physical dimension (unit-dictionary).
 *  - Create gate: a quiet footer affordance, plus a primary call-to-action at a
 *    search dead-end — opens an inline CreateStandardVariableForm, then selects
 *    the newly created variable.
 *
 * Resolving sets BOTH the standard variable and the unit via onResolve; the
 * caller keeps them as two independent form fields, so the mutation is unchanged.
 */

import * as React from 'react';
import { ChevronsUpDown, Plus, Search } from 'lucide-react';

import { usePrefetchReferenceDataQuery } from '@/graphql/generated/graphql';
import { useRecentStandardVariables } from '@/hooks/useRecentStandardVariables';
import { useVariableUnits, type UnitOption } from '@/hooks/useVariableUnits';
import { buildPhenomenonGroups } from '@/lib/standard-variable-browse';
import { humanizeStandardVariable } from '@/lib/standard-variable-grammar';
import { highlightRanges } from '@/lib/standard-variable-search';
import { DIMENSION_ORDER, prettyUnit, unitDimension, unitName } from '@/lib/unit-dictionary';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { CreateStandardVariableForm } from '@/components/autocomplete/CreateStandardVariableForm';
import type { StandardVariableOption } from '@/components/autocomplete/StandardVariableCombobox';
import { useStandardVariableMatches } from '@/components/autocomplete/useStandardVariableMatches';

export interface StandardVariableUnitPickerProps {
  /** Currently resolved standard variable, or null. */
  variable: StandardVariableOption | null;
  /** Currently resolved unit, or null. */
  unit: UnitOption | null;
  /** Called when the user confirms a variable (+ unit) selection. */
  onResolve: (variable: StandardVariableOption | null, unit: UnitOption | null) => void;
  disabled?: boolean;
  className?: string;
}

/** Render text with the query substrings highlighted. */
function Highlighted({ text, query }: { text: string; query: string }) {
  const ranges = highlightRanges(text, query);
  if (ranges.length === 0) return <>{text}</>;
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  ranges.forEach(([start, end], i) => {
    if (cursor < start) parts.push(text.slice(cursor, start));
    parts.push(
      <mark key={i} className="rounded-sm bg-yellow-200 px-0.5 text-inherit">
        {text.slice(start, end)}
      </mark>,
    );
    cursor = end;
  });
  if (cursor < text.length) parts.push(text.slice(cursor));
  return <>{parts}</>;
}

function triggerText(variable: StandardVariableOption | null): string {
  if (!variable) return 'Choose standard variable & unit…';
  const { phenomenon, property } = humanizeStandardVariable(variable.label);
  return phenomenon ? `${phenomenon} — ${property}` : property;
}

export function StandardVariableUnitPicker({
  variable,
  unit,
  onResolve,
  disabled = false,
  className,
}: StandardVariableUnitPickerProps) {
  const [open, setOpen] = React.useState(false);
  const [search, setSearch] = React.useState('');
  const [phenomenon, setPhenomenon] = React.useState<string | null>(null);
  const [draftVariable, setDraftVariable] = React.useState<StandardVariableOption | null>(variable);
  const [draftUnit, setDraftUnit] = React.useState<UnitOption | null>(unit);
  const [showAllUnits, setShowAllUnits] = React.useState(false);
  const [unitSearch, setUnitSearch] = React.useState('');
  const [creating, setCreating] = React.useState(false);

  const { data, loading } = usePrefetchReferenceDataQuery({ fetchPolicy: 'cache-first' });
  const { recordUse } = useRecentStandardVariables();
  const { unitsForVariable, canonicalIdForLabel } = useVariableUnits();

  const options: StandardVariableOption[] = React.useMemo(() => {
    if (!data?.modelcatalog_standard_variable) return [];
    return data.modelcatalog_standard_variable.map((sv) => ({
      id: sv.id,
      label: sv.label ?? '',
      description: sv.description ?? null,
    }));
  }, [data]);

  const allUnits: UnitOption[] = React.useMemo(() => {
    if (!data?.modelcatalog_unit) return [];
    return data.modelcatalog_unit.map((u) => ({ id: u.id, label: u.label ?? '' }));
  }, [data]);

  const phenomenonGroups = React.useMemo(() => buildPhenomenonGroups(options), [options]);
  const {
    results: searchResults,
    loading: searchLoading,
    isDeadEnd,
  } = useStandardVariableMatches(search, options);

  const suggestedUnits = React.useMemo(() => {
    if (!draftVariable) return [];
    const canonicalId = canonicalIdForLabel(draftVariable.label) ?? draftVariable.id;
    return unitsForVariable(canonicalId);
  }, [draftVariable, canonicalIdForLabel, unitsForVariable]);

  const resetDrafts = React.useCallback(() => {
    setSearch('');
    setPhenomenon(null);
    setShowAllUnits(false);
    setUnitSearch('');
    setCreating(false);
    setDraftVariable(variable);
    setDraftUnit(unit);
  }, [variable, unit]);

  const handleOpenChange = React.useCallback(
    (next: boolean) => {
      setOpen(next);
      if (next) resetDrafts();
    },
    [resetDrafts],
  );

  const selectVariable = React.useCallback(
    (opt: StandardVariableOption) => {
      const canonicalId = canonicalIdForLabel(opt.label) ?? opt.id;
      const resolved: StandardVariableOption = { ...opt, id: canonicalId };
      setDraftVariable(resolved);
      setShowAllUnits(false);
      setUnitSearch('');
      const suggested = unitsForVariable(canonicalId);
      setDraftUnit(suggested[0] ?? null);
    },
    [canonicalIdForLabel, unitsForVariable],
  );

  const confirm = React.useCallback(() => {
    onResolve(draftVariable, draftUnit);
    if (draftVariable) recordUse(draftVariable);
    setOpen(false);
  }, [draftVariable, draftUnit, onResolve, recordUse]);

  const startCreate = React.useCallback(() => setCreating(true), []);

  const handleCreated = React.useCallback(
    (created: StandardVariableOption) => {
      setCreating(false);
      setSearch('');
      selectVariable(created);
    },
    [selectVariable],
  );

  const propertiesForPhenomenon = React.useMemo(() => {
    if (!phenomenon) return [];
    return phenomenonGroups.find((g) => g.phenomenon === phenomenon)?.properties ?? [];
  }, [phenomenonGroups, phenomenon]);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-label="Choose standard variable and unit"
          disabled={disabled || loading}
          className={cn('w-full justify-between font-normal', className)}
        >
          <span className="flex min-w-0 items-center gap-2 truncate">
            <span className={cn('truncate', !variable && 'text-muted-foreground')}>
              {loading ? 'Loading…' : triggerText(variable)}
            </span>
            {variable && unit && (
              <span className="rounded border border-emerald-200 bg-emerald-50 px-1.5 font-mono text-[11px] text-emerald-700">
                {prettyUnit(unit.label)}
              </span>
            )}
          </span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </DialogTrigger>

      <DialogContent className="max-w-xl gap-0 overflow-hidden p-0">
        <DialogHeader className="border-b px-4 py-3">
          <DialogTitle className="text-base">Choose standard variable &amp; unit</DialogTitle>
          <DialogDescription className="sr-only">
            Pick a phenomenon and property, then a unit, or search for a standard variable.
          </DialogDescription>
        </DialogHeader>

        {creating ? (
          <CreateStandardVariableForm
            initialName={search.trim()}
            initialPhenomenon={phenomenon}
            onCreated={handleCreated}
            onCancel={() => setCreating(false)}
          />
        ) : (
          <>
            <div className="flex items-center gap-2 border-b px-4 py-2.5">
              <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
              <input
                aria-label="Search standard variables"
                placeholder="Search standard variables…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              />
            </div>

            <div className="min-h-[200px]">
              {search.trim() === '' ? (
                // ---- browse: phenomenon | property (each scrolls independently) ----
                <div className="grid grid-cols-2">
                  <div className="max-h-[280px] overflow-auto border-r">
                    <div className="sticky top-0 z-10 bg-background px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                      1 · Phenomenon
                    </div>
                    {phenomenonGroups.map((g) => (
                      <button
                        key={g.phenomenon}
                        type="button"
                        onClick={() => setPhenomenon(g.phenomenon)}
                        className={cn(
                          'flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-accent',
                          phenomenon === g.phenomenon && 'bg-accent font-medium',
                        )}
                      >
                        <span className="truncate">{g.phenomenon}</span>
                        <span className="font-mono text-[10px] text-muted-foreground">
                          {g.properties.length}
                        </span>
                      </button>
                    ))}
                  </div>
                  <div className="max-h-[280px] overflow-auto">
                    <div className="sticky top-0 z-10 bg-background px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                      2 · Property
                    </div>
                    {phenomenon === null ? (
                      <p className="px-3 py-2 text-sm text-muted-foreground">
                        Select a phenomenon →
                      </p>
                    ) : (
                      propertiesForPhenomenon.map((p) => (
                        <button
                          key={p.label}
                          type="button"
                          onClick={() =>
                            selectVariable({
                              id: p.svId,
                              label: p.label,
                              description: p.description,
                            })
                          }
                          className={cn(
                            'block w-full px-3 py-2 text-left text-sm hover:bg-accent',
                            draftVariable?.label === p.label && 'bg-accent font-medium',
                          )}
                        >
                          {p.property}
                        </button>
                      ))
                    )}
                  </div>
                </div>
              ) : isDeadEnd ? (
                // ---- dead-end: find-before-create ----
                <div className="px-4 py-4">
                  <p className="text-sm">
                    No standard variable matches <span className="font-semibold">“{search}”</span>.
                  </p>
                  <button
                    type="button"
                    onClick={startCreate}
                    className="mt-4 flex w-full items-center gap-3 rounded-lg border border-dashed border-primary bg-primary/5 px-4 py-3 text-left hover:bg-primary/10"
                  >
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground">
                      <Plus className="h-4 w-4" />
                    </span>
                    <span>
                      <span className="block text-sm font-semibold">
                        Create “{search.trim()}” as a new standard variable
                      </span>
                      <span className="block text-xs text-muted-foreground">
                        Opens a short form to confirm the details
                      </span>
                    </span>
                  </button>
                </div>
              ) : (
                // ---- search results ----
                <div className="max-h-[280px] overflow-auto py-1">
                  {searchLoading && searchResults.length === 0 ? (
                    <p className="px-4 py-6 text-center text-sm text-muted-foreground">
                      Searching standard variables…
                    </p>
                  ) : (
                    searchResults.map((opt) => {
                      const { phenomenon: ph, property } = humanizeStandardVariable(opt.label);
                      return (
                        <button
                          key={opt.id}
                          type="button"
                          onClick={() => selectVariable(opt)}
                          className={cn(
                            'block w-full px-4 py-2 text-left hover:bg-accent',
                            draftVariable?.label === opt.label && 'bg-accent',
                          )}
                        >
                          <span className="block text-sm font-medium">
                            {ph && <span className="mr-1.5 text-muted-foreground">{ph} —</span>}
                            <Highlighted text={property} query={search} />
                          </span>
                          <span className="block font-mono text-[10px] text-muted-foreground">
                            <Highlighted text={opt.label} query={search} />
                          </span>
                        </button>
                      );
                    })
                  )}
                </div>
              )}
            </div>

            {/* ---- unit step ---- */}
            {draftVariable && (
              <div className="border-t bg-muted/40 px-4 py-3">
                <div className="text-xs font-semibold text-foreground">
                  Unit <span className="text-primary">*</span>
                </div>
                {!showAllUnits && suggestedUnits.length > 0 ? (
                  <>
                    <p className="mb-2 mt-0.5 text-[11px] text-muted-foreground">
                      Used with this variable — one tap:
                    </p>
                    <div className="flex flex-col gap-1.5">
                      {suggestedUnits.map((u) => (
                        <button
                          key={u.id}
                          type="button"
                          onClick={() => setDraftUnit(u)}
                          className={cn(
                            'flex items-center gap-3 rounded-lg border px-3 py-2 text-left text-sm',
                            draftUnit?.id === u.id
                              ? 'border-primary bg-primary/5 ring-1 ring-primary'
                              : 'hover:border-foreground/40',
                          )}
                        >
                          <span className="min-w-[64px] font-mono">{prettyUnit(u.label)}</span>
                          <span className="text-muted-foreground">{unitName(u.label)}</span>
                        </button>
                      ))}
                    </div>
                    <button
                      type="button"
                      onClick={() => setShowAllUnits(true)}
                      className="mt-2 text-xs font-semibold text-primary hover:underline"
                    >
                      Need a different unit? Search all units ↓
                    </button>
                  </>
                ) : (
                  <>
                    <p className="mb-2 mt-0.5 text-[11px] text-muted-foreground">
                      {suggestedUnits.length > 0
                        ? 'Search the full list:'
                        : 'No unit on record — search all units:'}
                    </p>
                    <div className="mb-1.5 flex items-center gap-2 rounded-md border bg-background px-2.5 py-1.5">
                      <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      <input
                        aria-label="Search units"
                        placeholder="Search units by symbol or name…"
                        value={unitSearch}
                        onChange={(e) => setUnitSearch(e.target.value)}
                        className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
                      />
                    </div>
                    <div className="max-h-[150px] overflow-auto">
                      {DIMENSION_ORDER.map((dim) => {
                        const ql = unitSearch.trim().toLowerCase();
                        const items = allUnits.filter(
                          (u) =>
                            unitDimension(u.label) === dim &&
                            (ql === '' ||
                              `${u.label} ${unitName(u.label)}`.toLowerCase().includes(ql)),
                        );
                        if (items.length === 0) return null;
                        return (
                          <div key={dim}>
                            <div className="px-1 pb-0.5 pt-2 text-[10px] font-bold uppercase tracking-wide text-muted-foreground">
                              {dim}
                            </div>
                            {items.map((u) => (
                              <button
                                key={u.id}
                                type="button"
                                onClick={() => setDraftUnit(u)}
                                className={cn(
                                  'flex w-full items-center gap-3 rounded px-2 py-1.5 text-left text-sm hover:bg-accent',
                                  draftUnit?.id === u.id && 'bg-primary/5',
                                )}
                              >
                                <span className="min-w-[96px] font-mono text-[13px]">
                                  {prettyUnit(u.label)}
                                </span>
                                <span className="text-xs text-muted-foreground">
                                  {unitName(u.label)}
                                </span>
                              </button>
                            ))}
                          </div>
                        );
                      })}
                    </div>
                  </>
                )}
              </div>
            )}

            {/* ---- footer: quiet create gate + resolve ---- */}
            <div className="flex items-center justify-between gap-3 border-t px-4 py-3">
              {!isDeadEnd ? (
                <button
                  type="button"
                  onClick={startCreate}
                  className="inline-flex items-center gap-2 text-xs font-semibold text-primary hover:underline"
                >
                  <Plus className="h-3.5 w-3.5" /> Can&apos;t find it? Create a new standard
                  variable
                </button>
              ) : (
                <span />
              )}
              <Button type="button" size="sm" disabled={!draftVariable} onClick={confirm}>
                Use variable + unit
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
