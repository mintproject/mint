/**
 * The backend's known spatial sources, from the Ensemble Manager's
 * `GET /spatial/layers`. The Ensemble Manager reads them from the SVO adapter; the
 * browser does not call the adapter for this. The list is public reference data,
 * so no token is needed, but one is sent when the user has signed in.
 */
import { getEnsembleManagerApiUrl } from './config';
import { ensembleManagerHeaders } from './ensemble-manager';

/** True when this deployment has an Ensemble Manager to ask for layers. */
export function spatialLayersAvailable(): boolean {
  return getEnsembleManagerApiUrl() !== '';
}

/** The layers, or a rejected promise when the Ensemble Manager answers an error. */
export async function fetchSpatialLayers<T>(signal?: AbortSignal): Promise<T[]> {
  const response = await fetch(`${getEnsembleManagerApiUrl()}/spatial/layers`, {
    headers: ensembleManagerHeaders(),
    signal,
  });
  if (!response.ok) throw new Error(`Spatial layer catalog returned ${response.status}`);
  const payload = (await response.json()) as { layers?: T[] };
  return payload.layers ?? [];
}
