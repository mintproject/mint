import * as React from 'react';

import { listTapisApps, type TapisAppRef } from '@/lib/tapis-apps';

export interface TapisAppsList {
  apps: TapisAppRef[];
  loading: boolean;
  /** A readable message when the list could not be read, else null. */
  error: string | null;
  /** Reads the list again, for example after an app was created. */
  reload: () => void;
}

function appKey(app: TapisAppRef): string {
  return `${app.id}/${app.version}`;
}

/**
 * The Tapis applications the signed-in user may see in one tenant. With no
 * tenant, which is a deployment that does not use Tapis, it reads nothing.
 */
export function useTapisApps(tenant: string | null): TapisAppsList {
  const [apps, setApps] = React.useState<TapisAppRef[]>([]);
  const [loading, setLoading] = React.useState(tenant !== null);
  const [error, setError] = React.useState<string | null>(null);
  const [generation, setGeneration] = React.useState(0);

  React.useEffect(() => {
    if (tenant === null) {
      setApps([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    listTapisApps(tenant)
      .then((rows) => {
        if (cancelled) return;
        setApps([...rows].sort((a, b) => appKey(a).localeCompare(appKey(b))));
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Could not list applications.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [tenant, generation]);

  const reload = React.useCallback(() => setGeneration((g) => g + 1), []);

  return { apps, loading, error, reload };
}
