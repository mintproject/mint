/**
 * TapisAppPicker — choose the Tapis application a model runs.
 *
 * The selection is stored as the canonical app URL, so `value` is the component
 * location itself and no view state duplicates it. The app list comes from the
 * user's own Tapis token, read directly from Tapis, so it needs a signed-in user.
 *
 * Ported from the legacy UI's ModelCatalogTapisApp
 * (`ui/src/screens/models/configure/resources/tapis-app.ts`), including its
 * Sync button.
 */
import * as React from 'react';
import { AlertCircle, Check, ChevronsUpDown, RefreshCw } from 'lucide-react';

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
import { cn } from '@/lib/utils';
import type { TapisAppsList } from '@/hooks/useTapisApps';
import {
  buildTapisAppUrl,
  getTapisApp,
  parseTapisAppUrl,
  type TapisApp,
  type TapisAppRef,
} from '@/lib/tapis-apps';

export interface TapisAppPickerProps {
  /** The applications to choose from, read by the caller so it can reload them. */
  list: TapisAppsList;
  /** The component location URL, or '' when no app is chosen. */
  value: string;
  onChange: (url: string) => void;
  /** Called with the full application after the user asks to sync. */
  onSync: (app: TapisApp) => void;
  /** Text warning that a sync would overwrite existing rows, or null. */
  syncWarning?: string | null;
}

function appKey(app: TapisAppRef): string {
  return `${app.id}/${app.version}`;
}

export function TapisAppPicker({
  list,
  value,
  onChange,
  onSync,
  syncWarning,
}: TapisAppPickerProps) {
  const [open, setOpen] = React.useState(false);
  const { apps, loading, error: listError } = list;
  const [syncing, setSyncing] = React.useState(false);
  const [syncError, setSyncError] = React.useState<string | null>(null);

  const selected = parseTapisAppUrl(value);

  const handleSelect = (key: string) => {
    const found = apps.find((a) => appKey(a) === key);
    if (found) onChange(buildTapisAppUrl(found));
    setOpen(false);
  };

  const handleSync = async () => {
    if (!selected) return;
    setSyncing(true);
    setSyncError(null);
    try {
      onSync(await getTapisApp(selected));
    } catch (err: unknown) {
      setSyncError(err instanceof Error ? err.message : 'Could not read the application.');
    } finally {
      setSyncing(false);
    }
  };

  const triggerLabel = selected
    ? appKey(selected)
    : loading
      ? 'Loading applications...'
      : 'Choose an application';

  return (
    <div className="space-y-2">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            role="combobox"
            aria-expanded={open}
            aria-label="Choose a Tapis application"
            disabled={loading || Boolean(listError)}
            className="w-full justify-between font-normal"
          >
            <span className={cn('truncate', !selected && 'text-muted-foreground')}>
              {triggerLabel}
            </span>
            <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-0" align="start">
          <Command>
            <CommandInput placeholder="Search applications..." />
            <CommandList>
              <CommandEmpty>No applications found.</CommandEmpty>
              <CommandGroup>
                {apps.map((app) => (
                  <CommandItem key={appKey(app)} value={appKey(app)} onSelect={handleSelect}>
                    <Check
                      className={cn(
                        'mr-2 h-4 w-4 shrink-0',
                        selected && appKey(selected) === appKey(app) ? 'opacity-100' : 'opacity-0',
                      )}
                    />
                    <span className="truncate">{app.id}</span>
                    <span className="ml-2 text-xs text-muted-foreground">{app.version}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>

      {listError && (
        <p role="alert" className="flex items-start gap-1.5 text-xs text-destructive">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            {listError} You can still enter a component location by hand with &ldquo;Any URL&rdquo;.
          </span>
        </p>
      )}

      {selected && (
        <div className="space-y-1">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={syncing}
            onClick={handleSync}
          >
            <RefreshCw className={cn('mr-2 h-3.5 w-3.5', syncing && 'animate-spin')} />
            Fill inputs and parameters from the application
          </Button>
          <p className="text-xs text-muted-foreground">
            The run matches an input to a Tapis file input, and a parameter to an application
            argument, by name. Keep the names the application gives them.
          </p>
          {syncWarning && <p className="text-xs text-amber-600">{syncWarning}</p>}
          {syncError && (
            <p role="alert" className="text-xs text-destructive">
              {syncError}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
