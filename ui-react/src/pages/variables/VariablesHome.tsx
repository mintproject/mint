import {
  flexRender,
  getCoreRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
} from '@tanstack/react-table';
import { ChevronDown, ChevronUp, ChevronsUpDown, Copy, ChevronRight, Plus } from 'lucide-react';
import { useEffect, useMemo, useState, useCallback, type ReactNode } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useGetStandardVariablesWithUnitsQuery } from '@/graphql/generated/graphql';
import type { GetStandardVariablesWithUnitsQuery } from '@/graphql/generated/graphql';
import { highlightRanges } from '@/lib/standard-variable-search';
import {
  CATEGORY_ORDER,
  deriveDisplayFields,
  type StandardVariableCategory,
} from '@/lib/standard-variable-taxonomy';
import { searchVariableRows } from '@/lib/variable-catalog-search';
import { useSemanticSearch } from '@/hooks/useSemanticSearch';
import { useAuth } from '@/lib/auth/useAuth';
import { CreateStandardVariableDialog } from '@/components/autocomplete/CreateStandardVariableDialog';
import type { StandardVariableOption } from '@/components/autocomplete/StandardVariableCombobox';

type StandardVariable =
  GetStandardVariablesWithUnitsQuery['modelcatalog_standard_variable'][number];

type StandardVariableUnit = { id: string; label: string };

/**
 * A standard variable enriched with its deduplicated set of units and its
 * derived taxonomy fields: a domain `category`, whether the label is
 * unnamed/UUID-shaped, and the `displayLabel` to show (the description when the
 * raw label is an unnamed UUID, so scientists never see a bare UUID).
 */
type StandardVariableRow = StandardVariable & {
  units: StandardVariableUnit[];
  category: StandardVariableCategory;
  isUnnamed: boolean;
  displayLabel: string;
};

/** Sentinel value for the "all categories" option (Radix Select forbids ''). */
const ALL_CATEGORIES = '__all__';

/**
 * Gather the units a standard variable is available in through its
 * variable_presentations reverse relationship, deduplicated by unit id.
 */
function dedupeUnits(variable: StandardVariable): StandardVariableUnit[] {
  const seen = new Map<string, StandardVariableUnit>();
  for (const presentation of variable.variable_presentations) {
    const unit = presentation.unit;
    if (unit && !seen.has(unit.id)) {
      seen.set(unit.id, { id: unit.id, label: unit.label });
    }
  }
  return Array.from(seen.values());
}

// ─── Highlight helper ─────────────────────────────────────────────────────────

/** Render `text` with the case-insensitive query substrings wrapped in <mark>. */
function Highlighted({ text, query }: { text: string; query: string }) {
  const ranges = highlightRanges(text, query);
  if (ranges.length === 0) return <>{text}</>;
  const parts: ReactNode[] = [];
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

// ─── Column definition ────────────────────────────────────────────────────────

/**
 * Columns are built per-query so cells can highlight the matched substrings.
 * `query` is the trimmed search string ('' when not searching).
 */
function buildColumns(query: string): ColumnDef<StandardVariableRow>[] {
  return [
    {
      id: 'copy',
      header: '',
      cell: ({ row }) => <CopyButton value={row.original.label ?? ''} />,
      enableSorting: false,
      enableColumnFilter: false,
      size: 48,
    },
    {
      id: 'standard_variable',
      accessorFn: (row) => row.displayLabel,
      header: 'Standard Variable',
      cell: ({ row }) => {
        // Unnamed/UUID rows are shown by their description (displayLabel); their
        // raw UUID is never rendered. Named rows show label above description.
        const { displayLabel, isUnnamed } = row.original;
        const description = row.original.description ?? 'No description available';
        return (
          <div>
            <div className="font-medium text-[#2c3e50]">
              <Highlighted text={displayLabel} query={query} />
            </div>
            {!isUnnamed && (
              <div className="break-words pr-4 text-sm leading-relaxed text-[#6c757d]">
                <Highlighted text={description} query={query} />
              </div>
            )}
          </div>
        );
      },
    },
    {
      id: 'category',
      accessorFn: (row) => row.category,
      header: 'Category',
      cell: ({ row }) => (
        <Badge variant="outline" className="whitespace-nowrap font-normal text-[#495057]">
          {row.original.category}
        </Badge>
      ),
    },
    {
      id: 'units',
      header: 'Units',
      enableSorting: false,
      cell: ({ row }) => {
        const units = row.original.units;
        if (units.length === 0) {
          return <span className="text-sm italic text-[#adb5bd]">No units</span>;
        }
        return (
          <div className="flex flex-wrap gap-1">
            {units.map((unit) => (
              <Badge key={unit.id} variant="secondary" className="font-normal">
                <Highlighted text={unit.label} query={query} />
              </Badge>
            ))}
          </div>
        );
      },
    },
  ];
}

// ─── Copy button ──────────────────────────────────────────────────────────────

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    if (!value) return;
    navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [value]);

  return (
    <div className="group relative inline-block">
      <button
        type="button"
        onClick={handleCopy}
        title="Copy standard variable name"
        aria-label="Copy standard variable name"
        className="inline-flex h-8 w-8 items-center justify-center rounded text-[#6c757d] opacity-60 transition-all hover:bg-[#f1f3f5] hover:opacity-100"
      >
        <Copy size={16} />
      </button>
      {/* Tooltip */}
      <span className="pointer-events-none absolute bottom-full left-1/2 mb-2 -translate-x-1/4 whitespace-nowrap rounded bg-[#2c3e50] px-2 py-1 text-xs text-white opacity-0 transition-opacity group-hover:opacity-100">
        {copied ? 'Copied!' : 'Click to copy standard variable name'}
      </span>
    </div>
  );
}

// ─── Sort icon ────────────────────────────────────────────────────────────────

function SortIcon({ direction }: { direction: 'asc' | 'desc' | false }) {
  if (direction === 'asc') return <ChevronUp size={14} />;
  if (direction === 'desc') return <ChevronDown size={14} />;
  return <ChevronsUpDown size={14} className="opacity-40" />;
}

// ─── Explanation section ──────────────────────────────────────────────────────

function ExplanationSection({ expanded, onToggle }: { expanded: boolean; onToggle: () => void }) {
  return (
    <div className="mb-6">
      <button
        type="button"
        onClick={onToggle}
        className="mb-3 flex items-center gap-1 text-sm text-[#6c757d] hover:text-[#495057]"
        aria-expanded={expanded}
      >
        <ChevronRight
          size={16}
          className={`transition-transform duration-200 ${expanded ? 'rotate-90' : ''}`}
        />
        {expanded ? 'Hide explanation' : 'Show explanation'}
      </button>

      {expanded && (
        <div className="mb-4 grid grid-cols-1 gap-4 md:grid-cols-2">
          <div className="rounded-lg bg-white p-4 shadow-sm">
            <h4 className="mb-2 text-sm font-semibold text-[#2c3e50]">
              What is a Standard Variable?
            </h4>
            <p className="text-sm leading-relaxed text-[#6c757d]">
              A standard variable is necessary to refer to all variables using the same nomenclature
              in a domain ontology. For example, a standard variable may be a{' '}
              <a
                href="https://scientificvariablesontology.org/svo/"
                target="_blank"
                rel="noreferrer"
                className="underline"
              >
                SVO variable
              </a>
              . Standard variables serve as the common language that connects data and models across
              the catalog.
            </p>
          </div>

          <div className="rounded-lg bg-white p-4 shadow-sm">
            <h4 className="mb-2 text-sm font-semibold text-[#2c3e50]">What are Units?</h4>
            <p className="text-sm leading-relaxed text-[#6c757d]">
              The Units column lists the units a standard variable has been used with across the
              catalog. A variable can appear in several units; a variable with no recorded usage
              shows no units.
            </p>
          </div>

          <div className="rounded-lg bg-white p-4 shadow-sm md:col-span-2">
            <h4 className="mb-2 text-sm font-semibold text-[#2c3e50]">
              How to Use Standard Variables
            </h4>
            <p className="text-sm leading-relaxed text-[#6c757d]">
              The standard variable will be required on your model inputs and datasets (data
              catalog). Use the search bar below to find the appropriate standard variable for your
              data or model. You can click the copy button next to each variable to easily copy its
              name.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

/** Explore Variables — searchable, sortable, paginated standard-variable catalog. */
export function VariablesHome() {
  const { data, loading, error, refetch } = useGetStandardVariablesWithUnitsQuery();
  const { isAuthenticated } = useAuth();
  const [createOpen, setCreateOpen] = useState(false);
  const [justCreated, setJustCreated] = useState<StandardVariableOption | null>(null);

  const [sorting, setSorting] = useState<SortingState>([]);
  const [search, setSearch] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string>(ALL_CATEGORIES);
  const [explanationExpanded, setExplanationExpanded] = useState(true);

  const query = search.trim();
  const isSearching = query !== '';
  const semanticSearch = useSemanticSearch(query, { target: 'svo', limit: 100 });

  const rows = useMemo<StandardVariableRow[]>(
    () =>
      (data?.modelcatalog_standard_variable ?? []).map((variable) => ({
        ...variable,
        units: dedupeUnits(variable),
        ...deriveDisplayFields(variable.label, variable.description),
      })),
    [data],
  );

  // Demote unnamed/UUID rows below named rows in the default (unsorted) order.
  // Stable partition preserves the query order within each group; they are
  // demoted, never hidden.
  const demotedRows = useMemo<StandardVariableRow[]>(
    () => [...rows.filter((r) => !r.isUnnamed), ...rows.filter((r) => r.isUnnamed)],
    [rows],
  );

  // Category options follow the canonical order (with "Unnamed / Other" last),
  // restricted to categories actually present in the data.
  const categoryOptions = useMemo<StandardVariableCategory[]>(() => {
    const present = new Set(demotedRows.map((r) => r.category));
    return CATEGORY_ORDER.filter((c) => present.has(c));
  }, [demotedRows]);

  const categoryFiltered = useMemo<StandardVariableRow[]>(
    () =>
      selectedCategory === ALL_CATEGORIES
        ? demotedRows
        : demotedRows.filter((r) => r.category === selectedCategory),
    [demotedRows, selectedCategory],
  );

  const semanticRows = useMemo<StandardVariableRow[] | null>(() => {
    if (!semanticSearch.results) return null;
    const rowsById = new Map(categoryFiltered.map((row) => [row.id, row]));
    return semanticSearch.results.flatMap((result) => {
      const row = rowsById.get(result.id);
      return row ? [row] : [];
    });
  }, [categoryFiltered, semanticSearch.results]);

  // While searching, semantic results preserve the catalog rows (including
  // units and categories) and their service ranking. A failed/unavailable
  // service falls back to the existing local ranker; category remains local
  // and therefore a hard filter in both paths.
  const displayRows = useMemo<StandardVariableRow[]>(() => {
    if (isSearching) return semanticRows ?? searchVariableRows(categoryFiltered, query);
    if (!justCreated) return categoryFiltered;
    // Pin the variable the user just created at the top, whether or not the
    // refetched catalog has reached us yet.
    const known = rows.find((r) => r.id === justCreated.id);
    const pinned: StandardVariableRow = known ?? {
      __typename: 'modelcatalog_standard_variable',
      id: justCreated.id,
      label: justCreated.label,
      description: justCreated.description,
      variable_presentations: [],
      units: [],
      ...deriveDisplayFields(justCreated.label, justCreated.description),
    };
    return [pinned, ...categoryFiltered.filter((r) => r.id !== justCreated.id)];
  }, [categoryFiltered, isSearching, query, semanticRows, justCreated, rows]);

  const columns = useMemo(() => buildColumns(query), [query]);

  const table = useReactTable({
    data: displayRows,
    columns,
    state: { sorting: isSearching ? [] : sorting },
    onSortingChange: setSorting,
    enableSorting: !isSearching,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    initialState: { pagination: { pageSize: 25 } },
    // The ranked `displayRows` reference changes whenever the query changes;
    // react-table's default autoReset would resync page state on every data
    // change, which combined with Apollo's fresh result objects can loop. Manage
    // the page reset explicitly instead (see below).
    autoResetPageIndex: false,
  });

  // Start each new/changed search (and each return to the unfiltered list) at
  // the first page so pagination applies from the top of the ranked results.
  useEffect(() => {
    table.setPageIndex(0);
  }, [query, selectedCategory, table]);

  return (
    <div>
      {/* Page header */}
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-[#212529]">Explore Variables</h1>
          <p className="mt-1 text-base text-[#6c757d]">
            Standard variables and the units they are used in
          </p>
        </div>
        {isAuthenticated ? (
          <Button type="button" onClick={() => setCreateOpen(true)}>
            <Plus className="mr-1 h-4 w-4" /> Create a standard variable
          </Button>
        ) : (
          <p className="text-sm text-[#6c757d]">Sign in to add a standard variable</p>
        )}
      </div>

      {justCreated && (
        <div role="status" className="mb-4 rounded-lg bg-green-50 px-4 py-2 text-sm text-green-800">
          Created standard variable <span className="font-semibold">{justCreated.label}</span>. It
          is pinned to the top of the list.
        </div>
      )}
      <CreateStandardVariableDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={(created) => {
          setJustCreated(created);
          setSearch('');
          setSelectedCategory(ALL_CATEGORIES);
          void refetch();
        }}
      />

      {/* Collapsible explanation */}
      <ExplanationSection
        expanded={explanationExpanded}
        onToggle={() => setExplanationExpanded((v) => !v)}
      />

      {/* Search bar + category filter */}
      <div className="mb-4 flex items-center gap-3">
        <div className="flex flex-1 items-center rounded-lg bg-white px-4 py-2 shadow-sm">
          <Input
            type="text"
            placeholder="Search standard variables..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="border-none text-[#495057] shadow-none placeholder:text-[#adb5bd] focus-visible:ring-0"
            aria-label="Search standard variables"
          />
          {isSearching && semanticSearch.loading && (
            <span className="sr-only" role="status">
              Searching standard variables…
            </span>
          )}
        </div>
        <Select value={selectedCategory} onValueChange={setSelectedCategory}>
          <SelectTrigger className="w-[220px] bg-white shadow-sm" aria-label="Filter by category">
            <SelectValue placeholder="All categories" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_CATEGORIES}>All categories</SelectItem>
            {categoryOptions.map((category) => (
              <SelectItem key={category} value={category}>
                {category}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Table */}
      <div className="relative overflow-visible rounded-lg bg-white shadow-sm">
        {loading && (
          <div className="p-8 text-center text-[#6c757d]">Loading standard variables…</div>
        )}

        {error && (
          <div className="p-8 text-center text-red-600">
            Failed to load standard variables. {error.message}
          </div>
        )}

        {!loading && !error && (
          <table className="w-full border-collapse" role="table" aria-label="Standard variables">
            <thead>
              {table.getHeaderGroups().map((headerGroup) => (
                <tr key={headerGroup.id}>
                  {headerGroup.headers.map((header) => (
                    <th
                      key={header.id}
                      style={{ width: header.getSize() !== 150 ? header.getSize() : undefined }}
                      className="sticky top-0 z-10 border-b-2 border-[#dee2e6] bg-[#f8f9fa] px-4 py-3 text-left text-sm font-semibold text-[rgb(72,72,72)]"
                    >
                      {header.isPlaceholder ? null : header.column.getCanSort() ? (
                        <button
                          type="button"
                          onClick={header.column.getToggleSortingHandler()}
                          className="flex items-center gap-1 hover:text-[#495057]"
                        >
                          {flexRender(header.column.columnDef.header, header.getContext())}
                          <SortIcon direction={header.column.getIsSorted()} />
                        </button>
                      ) : (
                        flexRender(header.column.columnDef.header, header.getContext())
                      )}
                    </th>
                  ))}
                </tr>
              ))}
            </thead>
            <tbody>
              {table.getRowModel().rows.length === 0 ? (
                <tr>
                  <td colSpan={columns.length} className="px-4 py-8 text-center text-[#6c757d]">
                    No standard variables found.
                  </td>
                </tr>
              ) : (
                table.getRowModel().rows.map((row, idx) => (
                  <tr
                    key={row.id}
                    className={`border-b border-[#dee2e6] transition-colors hover:bg-[#EEEEEE] ${idx % 2 === 0 ? 'bg-[#F9F9F9]' : 'bg-[#F2F2F2]'}`}
                  >
                    {row.getVisibleCells().map((cell) => (
                      <td key={cell.id} className="px-4 py-3 align-top text-sm text-[#212529]">
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </td>
                    ))}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        )}
      </div>

      {/* Pagination controls */}
      {!loading && !error && table.getPageCount() > 1 && (
        <div className="mt-4 flex items-center justify-between">
          <span className="text-sm text-[#6c757d]">
            Page {table.getState().pagination.pageIndex + 1} of {table.getPageCount()} (
            {table.getPrePaginationRowModel().rows.length} rows)
          </span>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => table.previousPage()}
              disabled={!table.getCanPreviousPage()}
            >
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => table.nextPage()}
              disabled={!table.getCanNextPage()}
            >
              Next
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
