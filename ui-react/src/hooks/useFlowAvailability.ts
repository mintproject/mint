import { useEffect, useState } from 'react';

import { flowAvailability, type FlowAvailability } from '@/lib/flow-availability';
import { useAuth } from '@/lib/auth/useAuth';

/**
 * The adapter's availability answer for a flow, or null while it is unknown.
 *
 * Pass `null` for a configuration that is not a flow: no request is made. Nothing
 * is requested when the user is not signed in, and a failed check stays null so
 * the flow remains usable.
 */
export function useFlowAvailability(flowId: string | null): FlowAvailability | null {
  const { isAuthenticated, accessToken } = useAuth();
  const [answer, setAnswer] = useState<{ key: string; value: FlowAvailability | null } | null>(
    null,
  );
  const key = flowId && isAuthenticated && accessToken ? `${accessToken}\n${flowId}` : null;

  useEffect(() => {
    if (!flowId || !key || !accessToken) return;
    let cancelled = false;
    void flowAvailability(flowId, accessToken).then((value) => {
      if (!cancelled) setAnswer({ key, value });
    });
    return () => {
      cancelled = true;
    };
  }, [flowId, key, accessToken]);

  return key !== null && answer?.key === key ? answer.value : null;
}
