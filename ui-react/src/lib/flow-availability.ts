/**
 * Whether the signed-in user could run a flow: the catalog API's
 * `GET /flows/{id}/availability`, which asks the SVO adapter as the user.
 *
 * The answer says per step whether the caller may run its piece, and reveals
 * nothing about a piece the caller cannot see beyond `piece_missing`. This is a
 * courtesy check: plan and submit refuse a flow the user may not run all the same,
 * so every way this check can fail (no token, a network error, a catalog with no
 * adapter or without the route, a malformed answer) yields `null` and the caller
 * shows nothing.
 */
import { getModelCatalogApiUrl } from './config';

export type FlowStepReason = 'piece_missing' | 'not_approved' | 'stored_source_disabled';

export interface FlowAvailability {
  flow_id: string;
  available: boolean;
  steps: { position: number; runnable: boolean; reason: FlowStepReason | null }[];
}

/** One line for the first reason a flow is not available, or null when it is. */
export function flowUnavailableMessage(availability: FlowAvailability | null): string | null {
  if (!availability || availability.available) return null;
  const reasons = availability.steps.map((step) => step.reason);
  if (reasons.includes('piece_missing')) return 'A piece of this flow was deleted.';
  if (reasons.includes('not_approved') || reasons.includes('stored_source_disabled')) {
    return 'A piece of this flow is not approved for your account.';
  }
  return null;
}

function isAvailability(value: unknown): value is FlowAvailability {
  if (typeof value !== 'object' || value === null) return false;
  const body = value as Record<string, unknown>;
  return typeof body.available === 'boolean' && Array.isArray(body.steps);
}

export async function fetchFlowAvailability(
  flowId: string,
  token: string | null,
  signal?: AbortSignal,
): Promise<FlowAvailability | null> {
  const base = getModelCatalogApiUrl();
  if (!base || !token) return null;
  try {
    const response = await fetch(`${base}/flows/${encodeURIComponent(flowId)}/availability`, {
      headers: { Authorization: `Bearer ${token}` },
      signal,
    });
    if (!response.ok) return null;
    const body: unknown = await response.json();
    return isAvailability(body) ? body : null;
  } catch {
    return null;
  }
}

// One request per flow per session. A failed or unanswered check is not kept, so
// the next card to ask tries again.
const cache = new Map<string, Promise<FlowAvailability | null>>();

export function flowAvailability(
  flowId: string,
  token: string | null,
): Promise<FlowAvailability | null> {
  const key = `${token ?? ''}\n${flowId}`;
  let pending = cache.get(key);
  if (!pending) {
    pending = fetchFlowAvailability(flowId, token);
    cache.set(key, pending);
    void pending.then((result) => {
      if (result === null) cache.delete(key);
    });
  }
  return pending;
}

/** For tests: forget every answer. */
export function clearFlowAvailabilityCache(): void {
  cache.clear();
}
