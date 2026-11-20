import { useEffect, useState } from 'react';

import { useAuth } from '@/lib/auth/useAuth';
import { fetchFlowSettings, type FlowSettings } from '@/lib/flow-settings';

/**
 * The settings of each flow in `flowIds` as a runner meets them, by flow id. A flow
 * whose settings could not be read is absent, so the form falls back to the catalog's
 * parameter rows and stays usable.
 */
export function useFlowSettings(flowIds: string[]): Record<string, FlowSettings> {
  const { isAuthenticated, accessToken } = useAuth();
  const [found, setFound] = useState<Record<string, FlowSettings>>({});
  const wanted = flowIds.join('\n');

  useEffect(() => {
    if (!wanted || !isAuthenticated || !accessToken) return;
    const controller = new AbortController();
    for (const id of wanted.split('\n')) {
      void fetchFlowSettings(id, accessToken, controller.signal).then((settings) => {
        if (settings && !controller.signal.aborted) {
          setFound((previous) => ({ ...previous, [id]: settings }));
        }
      });
    }
    return () => controller.abort();
  }, [wanted, isAuthenticated, accessToken]);

  return found;
}
