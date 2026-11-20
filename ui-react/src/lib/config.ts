/**
 * Runtime config accessor.
 *
 * Reads window.__MINT_CONFIG__ at call time so that changes to env-config.js
 * between page loads are always reflected.
 *
 * The VITE_ branch is a whole-object fallback for the one context where no
 * env-config.js is served: the jsdom test environment. It does NOT apply to
 * `npm run dev` — index.html always loads public/env-config.js, so
 * window.__MINT_CONFIG__ is defined there and shadows every value below. Edit
 * public/env-config.js (or run `npm run config:local`) to change local dev.
 */
export function getRuntimeConfig() {
  return (
    window.__MINT_CONFIG__ ?? {
      HASURA_ENDPOINT: import.meta.env.VITE_HASURA_ENDPOINT ?? 'http://localhost:8080/v1/graphql',
      AUTH_SERVER: import.meta.env.VITE_AUTH_SERVER ?? '',
      AUTH_CLIENT_ID: import.meta.env.VITE_AUTH_CLIENT_ID ?? '',
      AUTH_REALM: import.meta.env.VITE_AUTH_REALM ?? '',
      AUTH_PROVIDER: (import.meta.env.VITE_AUTH_PROVIDER as 'keycloak' | 'tapis') ?? 'keycloak',
      DATA_CATALOG_API: import.meta.env.VITE_DATA_CATALOG_API ?? 'https://ckan.tacc.utexas.edu',
      DATA_CATALOG_BROWSE_URL:
        import.meta.env.VITE_DATA_CATALOG_BROWSE_URL ?? 'https://ckan.tacc.utexas.edu',
      MODEL_CATALOG_API: import.meta.env.VITE_MODEL_CATALOG_API ?? 'http://localhost:3002/v2.0.0',
      SEMANTIC_SEARCH_API: import.meta.env.VITE_SEMANTIC_SEARCH_API ?? 'http://localhost:8091',
      SVO_ADAPTER_API: import.meta.env.VITE_SVO_ADAPTER_API ?? '',
    }
  );
}

/**
 * Returns the Data Catalog REST API base URL (no trailing slash).
 *
 * This is the CKAN Action API base; callers append `/api/3/action/...`. It is
 * NOT a browser-facing URL — for the human-browsable catalog page use
 * {@link getDataCatalogBrowseUrl}.
 */
export function getDataCatalogApiUrl(): string {
  const url = getRuntimeConfig().DATA_CATALOG_API ?? 'https://ckan.tacc.utexas.edu';
  return url.replace(/\/$/, '');
}

/**
 * Returns the model catalog REST API base URL, version prefix included and no
 * trailing slash (e.g. https://api.models.mint.local/v2.0.0).
 *
 * The app reads the catalog itself through Hasura. This base exists for the few
 * routes Hasura cannot serve — today the Tapis application proxy, which
 * forwards the user's token to Tapis (see `src/lib/tapis-apps.ts`).
 */
export function getModelCatalogApiUrl(): string {
  const url = getRuntimeConfig().MODEL_CATALOG_API ?? 'http://api.models.mint.local/v2.0.0';
  return url.replace(/\/$/, '');
}

/**
 * Returns the standalone semantic-search service base URL (no trailing slash).
 * The browser calls its existing `/search` endpoint directly.
 */
export function getSemanticSearchApiUrl(): string {
  const url = getRuntimeConfig().SEMANTIC_SEARCH_API ?? 'http://localhost:8091';
  return url.replace(/\/$/, '');
}

/**
 * Returns the Ensemble Manager API base URL, version prefix included and no
 * trailing slash (e.g. http://localhost:3001/v1). Empty when none is configured.
 */
export function getEnsembleManagerApiUrl(): string {
  const url = window.__MINT_CONFIG__?.ENSEMBLE_MANAGER_API ?? '';
  return url.replace(/\/$/, '');
}

/**
 * Returns the SVO adapter API base URL. The adapter is an internal engine behind
 * the Ensemble Manager and the catalog API; the browser no longer calls it.
 */
export function getSvoAdapterApiUrl(): string {
  const url = getRuntimeConfig().SVO_ADAPTER_API ?? '';
  return url.replace(/\/$/, '');
}

/**
 * Returns the human-browsable Data Catalog UI URL (no trailing slash), used as
 * the iframe src on the datasets browse page.
 *
 * Distinct from {@link getDataCatalogApiUrl}: a REST API base and a
 * browser-facing catalog page need not share a host. Falls back to the REST
 * API base for backward compatibility when the browse key is unset, since for a
 * single CKAN deployment both are served from the same origin.
 */
export function getDataCatalogBrowseUrl(): string {
  const url =
    getRuntimeConfig().DATA_CATALOG_BROWSE_URL ??
    getRuntimeConfig().DATA_CATALOG_API ??
    'https://ckan.tacc.utexas.edu';
  return url.replace(/\/$/, '');
}
