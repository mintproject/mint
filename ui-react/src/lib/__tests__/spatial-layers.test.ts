/**
 * The spatial-layer catalog comes from the Ensemble Manager, never from the SVO
 * adapter: the adapter is an internal engine behind the Ensemble Manager.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { storeTokens } from '@/lib/auth/token-store';
import { fetchSpatialLayers, spatialLayersAvailable } from '@/lib/spatial-layers';

function lastRequest(): [string, RequestInit] {
  const calls = (globalThis.fetch as unknown as Mock).mock.calls;
  return calls[calls.length - 1] as [string, RequestInit];
}

describe('spatial-layers', () => {
  beforeEach(() => {
    localStorage.clear();
    window.__MINT_CONFIG__ = {
      ENSEMBLE_MANAGER_API: 'https://em.example.org/v1/',
      SVO_ADAPTER_API: 'https://adapter.example.org',
    } as typeof window.__MINT_CONFIG__;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ layers: [{ id: 'gma' }] }),
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete (window as { __MINT_CONFIG__?: unknown }).__MINT_CONFIG__;
  });

  it('reads the layers from the Ensemble Manager, not the adapter', async () => {
    const layers = await fetchSpatialLayers<{ id: string }>();
    expect(layers).toEqual([{ id: 'gma' }]);
    expect(lastRequest()[0]).toBe('https://em.example.org/v1/spatial/layers');
  });

  it('sends the signed-in user token when there is one, and works without', async () => {
    await fetchSpatialLayers();
    expect(lastRequest()[1].headers).not.toHaveProperty('Authorization');
    storeTokens({ accessToken: 'abc' });
    await fetchSpatialLayers();
    expect(lastRequest()[1].headers).toMatchObject({ Authorization: 'Bearer abc' });
  });

  it('rejects when the Ensemble Manager answers an error', async () => {
    (globalThis.fetch as unknown as Mock).mockResolvedValue({ ok: false, status: 503 });
    await expect(fetchSpatialLayers()).rejects.toThrow('503');
  });

  it('is unavailable when no Ensemble Manager is configured', () => {
    expect(spatialLayersAvailable()).toBe(true);
    window.__MINT_CONFIG__ = { SVO_ADAPTER_API: 'https://adapter.example.org' } as never;
    expect(spatialLayersAvailable()).toBe(false);
  });
});
