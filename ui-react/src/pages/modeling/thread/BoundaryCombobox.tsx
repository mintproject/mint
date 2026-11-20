import { useMemo, useState } from 'react';
import { Check, ChevronDown, ChevronRight, ChevronsUpDown } from 'lucide-react';

import { cn } from '@/lib/utils';
import {
  boundaryGroups,
  filterBoundaryOptions,
  type BoundaryOption,
} from '@/lib/spatial-boundaries';
import { Button } from '@/components/ui/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

interface BoundaryComboboxProps {
  options: BoundaryOption[];
  /** The selected option's value, or '' for all boundaries. */
  value: string;
  /** Shown on the trigger when nothing in `options` is selected, e.g. a saved region's name. */
  fallbackLabel?: string;
  disabled?: boolean;
  onSelect: (option: BoundaryOption | null) => void;
}

/**
 * Type-to-filter picker for a layer's boundaries. Options show names only,
 * grouped under their category when there is one. A family of numbered parts is
 * one row that selects the whole region; its chevron expands the parts.
 */
export function BoundaryCombobox({
  options,
  value,
  fallbackLabel,
  disabled,
  onSelect,
}: BoundaryComboboxProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  const visible = useMemo(() => filterBoundaryOptions(options, query), [options, query]);
  const groups = useMemo(() => boundaryGroups(visible), [visible]);
  const selected = useMemo(
    () => options.flatMap((o) => [o, ...(o.parts ?? [])]).find((option) => option.value === value),
    [options, value],
  );
  const triggerLabel = selected?.label ?? fallbackLabel ?? 'All boundaries';

  const choose = (option: BoundaryOption | null) => {
    onSelect(option);
    setOpen(false);
  };

  const renderOption = (option: BoundaryOption) => {
    // While filtering, a family shows the parts that matched.
    const isExpanded = Boolean(option.parts) && (query.trim() !== '' || expanded.has(option.value));
    return (
      <div key={option.value}>
        <div className="flex items-center">
          {option.parts ? (
            <button
              type="button"
              aria-label={`${isExpanded ? 'Collapse' : 'Expand'} ${option.label}`}
              aria-expanded={isExpanded}
              className="rounded p-1 hover:bg-accent"
              onClick={() =>
                setExpanded((current) => {
                  const next = new Set(current);
                  if (next.has(option.value)) next.delete(option.value);
                  else next.add(option.value);
                  return next;
                })
              }
            >
              {isExpanded ? (
                <ChevronDown className="h-3.5 w-3.5" />
              ) : (
                <ChevronRight className="h-3.5 w-3.5" />
              )}
            </button>
          ) : (
            <span className="w-6" />
          )}
          <CommandItem
            className="flex-1"
            value={option.value}
            keywords={[option.label]}
            onSelect={() => choose(option)}
          >
            <Check
              className={cn(
                'mr-2 h-3.5 w-3.5',
                value === option.value ? 'opacity-100' : 'opacity-0',
              )}
            />
            <span className="truncate">{option.label}</span>
          </CommandItem>
        </div>
        {isExpanded &&
          option.parts?.map((part) => (
            <div key={part.value} className="pl-6">
              <CommandItem value={part.value} keywords={[part.label]} onSelect={() => choose(part)}>
                <Check
                  className={cn(
                    'mr-2 h-3.5 w-3.5',
                    value === part.value ? 'opacity-100' : 'opacity-0',
                  )}
                />
                <span className="truncate">{part.label}</span>
              </CommandItem>
            </div>
          ))}
      </div>
    );
  };

  const ungrouped = visible.filter((option) => !option.group);

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery('');
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-label="Spatial boundary feature"
          disabled={disabled}
          className="h-7 min-w-0 flex-1 justify-between px-2 text-xs font-normal"
        >
          <span className="truncate">{triggerLabel}</span>
          <ChevronsUpDown className="ml-2 h-3.5 w-3.5 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-0" align="start">
        <Command shouldFilter={false}>
          <CommandInput placeholder="Search boundaries..." value={query} onValueChange={setQuery} />
          <CommandList>
            <CommandEmpty>No matching boundaries.</CommandEmpty>
            {query.trim() === '' && (
              <CommandGroup>
                <CommandItem value="" keywords={['all boundaries']} onSelect={() => choose(null)}>
                  <Check
                    className={cn('mr-2 h-3.5 w-3.5', value === '' ? 'opacity-100' : 'opacity-0')}
                  />
                  All boundaries
                </CommandItem>
              </CommandGroup>
            )}
            {ungrouped.length > 0 && <CommandGroup>{ungrouped.map(renderOption)}</CommandGroup>}
            {groups.map((group) => (
              <CommandGroup key={group} heading={group}>
                {visible.filter((option) => option.group === group).map(renderOption)}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
