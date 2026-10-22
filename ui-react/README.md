# MINT Model Catalog UI (React)

New React/TypeScript frontend for the MINT Model Catalog, replacing the legacy LitElement UI.

## Requirements

- Node 24+
- npm 10+

## Running locally

```bash
docker compose up -d   # from the repository root — Hasura, Postgres, the APIs
npm install
npm run dev            # http://localhost:3000
```

The committed `public/env-config.js` points at that compose stack: Hasura on
8080 and Ensemble Manager on 3001. Nothing else to configure — but the stack has
to be up, because without it every query fails. Local dev writing to production
by default is the thing this avoids.

The stack seeds regions and a model-catalog fixture, and no problem statements.
The modeling pages start empty; sign in and create one. Signing in works locally
— the compose auth webhook validates real Tapis tokens.

To browse TACC's public deployment instead of the stack, set `HASURA_ENDPOINT`
to `https://graphql.mint.tacc.utexas.edu/v1/graphql`, whose `anonymous` role
serves read-only queries and whose CKAN allows the `localhost` origin. Its
schema can lag this checkout's migrations, so a branch that adds one fails
against it.

**Where local configuration comes from.** `index.html` loads `/env-config.js`
before the app, and Vite serves `public/` as-is, so `window.__MINT_CONFIG__` is
always defined under `npm run dev`. The `import.meta.env.VITE_*` fallbacks in
`src/` are whole-object defaults that apply only when `window.__MINT_CONFIG__`
is *absent* — which locally it never is. **Setting a `VITE_*` variable in a
`.env` will not change the dev server.** Change `public/env-config.js` instead:

```bash
cp .env.example .env
$EDITOR .env
npm run config:local   # regenerates public/env-config.js from .env
```

`public/env-config.js` is tracked, so that overwrites a committed file; restore
the defaults with `git checkout -- public/env-config.js`. Editing it by hand is
equally fine — the `.env` route exists so the same key names work for local dev,
the container and Vercel.

`.env.example` documents every key. Two notes on the local defaults:

- **Signing in.** The identity provider allows one callback URL per client, so
  `http://localhost:3000/oauth2/callback` needs its own OAuth2 client id in
  `AUTH_CLIENT_ID`. `mint-localhost-3000` is that client, which is why the dev
  server must stay on port 3000. Anonymous browsing works without it; writes do
  not.
- **Model execution.** `ENSEMBLE_MANAGER_API` points at the stack's Ensemble
  Manager on 3001. Empty it and the thread pages switch execution off rather
  than calling a wrong host. `EXECUTION_ENGINE` must agree with whatever it
  points at: run submission posts to a different route per backend, so a wrong
  value reaches the wrong handler or none.
- **Adapter plan discovery.** Set `SVO_ADAPTER_ENABLED=true` only for a stack
  whose CKAN resources have been synchronized into the SVO Adapter. The
  Parameters step then discovers adapter plans and renders their required
  values. Runs submit adapter-backed models through Ensemble Manager's durable
  parent execution; model dispatch waits for verified adapter outputs. Keep the
  flag disabled until the local Hasura migration and adapter output path have
  been verified.
- **Workflow troubleshooting.** In the Runs step, `View Log` opens the model
  application log for one execution. Adapter-backed runs also show a separate
  Workflow pipeline details panel with the adapter, output-handoff, and model
  application stages, external workflow IDs, failure codes, and errors. When
  available, the panel also shows the Tapis Workflows pipeline definition ID
  and run UUID; the `ue_...` parent ID is kept as an internal Ensemble Manager
  correlation ID. A
  model-backed workflow keeps the model application as a first-class stage
  under the same parent workflow identity; its provider execution ID is shown as a
  stage reference rather than a separate pipeline. A
  post-model adapter is shown as `Deferred until model output` while the model
  is running, and the output handoff remains `Waiting for model output` until
  the model result is registered. The
  latest workflow snapshot is retained for the signed-in user and sub-task in
  the browser so it remains available after navigating away and back; use
  `Refresh workflow` to reconcile it with Ensemble Manager. If refresh is
  unavailable, the last cached state remains visible and is marked as stale.
- **Spatial boundary layers.** The Framing map prefers boundary geometries
  registered in MINT through `/regions` (the Hydrology category is used for the
  GMA registration). The adapter's `GET /spatial/layers` catalog supplies the
  ETL source metadata and remains the fallback for layers that have not yet been
  registered. Region Editor users can load a remote GeoJSON or ArcGIS
  FeatureServer/MapServer layer, choose stable name and identifier properties,
  and save its features as searchable MINT regions. Selecting a registered
  boundary carries the canonical filter/scope values into the adapter plan.
  When the selected boundary has geometry, the Models step also checks catalog
  coverage for required model inputs in the selected spatial scope;
  incompatible candidates are hidden by default and can be restored with
  `Show all model candidates`. Datasets without declared spatial coverage remain
  eligible because their location is unknown rather than known to be outside.
  For the GMA setup, open `/regions/hydrology`, choose `TWDB Statewide GMA
  Boundaries`, load the layer, use `GMAName` for names and `GMAnum` for the
  stable identifier, then add the selected regions.

## Testing

```bash
npm test           # run once
npm run test:watch # watch mode
```

Requires Node 24+. If `npm test` fails with a `crypto.getRandomValues` error, switch to Node 24 (`nvm use`).

## Model ownership

Signed-in users can enable **My models** on the model browse page to filter to
configurations they registered. Owned configurations are marked **Yours** and
can be deleted from their detail view after confirmation. Existing catalog
configurations without registration ownership remain browseable but cannot be
deleted through this control.

## Build

```bash
npm run build      # outputs to dist/
```

## Container

```bash
docker build -t mintproject/mint-ui-react:dev .
docker run --rm -p 8080:80 \
  -e HASURA_ENDPOINT=http://graphql.mint.local/v1/graphql \
  -e AUTH_CLIENT_ID=mint-local \
  -e ENSEMBLE_MANAGER_API=http://ensemble-manager.mint.local \
  mintproject/mint-ui-react:dev
```

The entrypoint regenerates `/usr/share/nginx/html/env-config.js` from the
environment at startup via `scripts/generate-env-config.mjs` — the same module
Vercel runs at build time — so an endpoint can be changed by rolling the
container rather than rebuilding the image.

Configuration keys (each accepts a bare or `VITE_`-prefixed name; empty string
is treated as unset):

| Key | Default |
|-----|---------|
| `HASURA_ENDPOINT` | `http://graphql.mint.local/v1/graphql` |
| `AUTH_SERVER` | `https://portals.tapis.io` |
| `AUTH_CLIENT_ID` | `mint-localhost-3000` |
| `AUTH_REALM` | `` (Keycloak only) |
| `AUTH_PROVIDER` | `tapis` |
| `GOOGLE_MAPS_KEY` | (shared development key) |
| `DATA_CATALOG_API` | `https://ckan.tacc.utexas.edu` (CKAN REST API base, no `/api` suffix) |
| `DATA_CATALOG_BROWSE_URL` | `https://ckan.tacc.utexas.edu` (legacy human-browsable catalog URL) |
| `SEMANTIC_SEARCH_API` | `http://localhost:8091` (standalone semantic-search service base; the UI appends `/search`) |
| `SVO_ADAPTER_API` | omitted outside local compose; `http://localhost:8090` in local compose (canonical spatial-layer catalog) |
| `ENSEMBLE_MANAGER_API` | omitted when unset |
| `SVO_ADAPTER_ENABLED` | omitted when unset; set to `true` to discover adapter plans |
| `MODEL_CATALOG_API` | `http://api.models.mint.local/v2.0.0` (version prefix included; serves the Tapis application proxy) |
| `EXECUTION_ENGINE` | `localex` (`tapis` / `localex` / `wings` — the backend that Ensemble Manager runs) |
| `BRANDING` | `none` (`tacc` shows the TACC + UT Austin strip; the preset lives in `src/lib/branding.ts`) |
| `AUTH_CALLBACK_ORIGIN` | omitted when unset |
| `AUTH_PREVIEW_ORIGIN_ALLOWLIST` | omitted when unset |
| `WELCOME_MESSAGE` | omitted when unset |

## Semantic search

Free-text searches for standard variables use the configured semantic-search
service at `/search?target=svo`; model browse and model-selection searches use
`target=model_configuration`. Region, category, output-variable, scope, and
indicator selections remain hard filters. If the service is unavailable, the
dataset browse page falls back to CKAN name search. Dataset results are then
matched against exact MINT Standard Variable annotations on CKAN resources.
Unit lookup remains local and exact.

## Previous runs and provenance

From a problem-formulation thread's Runs step, open **Previous runs & provenance**
to inspect the server-owned history for that subtask. The page includes legacy
model jobs and unified workflow parents, with execution-time input and
parameter bindings, model/output identifiers, workflow stages, errors, and
authenticated log/file references. Application logs are intentionally separate
from workflow pipeline provenance.

Provider-hosted logs and files are referenced rather than copied into the MINT
database. If a provider has expired or removed an artifact, the history record
remains available and reports that artifact's availability state.

Because the entrypoint writes into the nginx document root, the container does
not support a read-only root filesystem as-is.

## Code Generation

GraphQL types are generated from the Hasura schema:

```bash
npm run codegen
```

## Stack

- Vite 5 + React 18 + TypeScript (strict)
- Apollo Client 3 (GraphQL)
- Tailwind CSS + shadcn/ui
- React Router v6
- React Hook Form + Zod
- Vitest + React Testing Library

## License

[MIT](https://opensource.org/license/mit). Copyright (c) 2026 MINT.
See [LICENSE](LICENSE).
