# model-catalog-api

A Fastify-based REST API that translates the MINT Model Catalog OpenAPI spec into GraphQL queries against a Hasura backend.

## Configuration

The API connects to Hasura via the endpoint and admin-secret environment variables:

| Variable | Default | Description |
|---|---|---|
| `HASURA_GRAPHQL_URL` | `http://testing-mint-hasura.mint.svc.cluster.local/v1/graphql` | Hasura GraphQL endpoint |
| `HASURA_ADMIN_SECRET` | `CHANGEME` | Hasura admin secret (reads and authorized region imports) |
| `TAPIS_JWKS_URI` | `https://portals.tapis.io/v3/tenants/portals` | Tapis tenant key endpoint used to verify import tokens |
| `TAPIS_TOKEN_ISSUER` | `https://portals.tapis.io/v3/tokens` | Required issuer for import tokens |
| `SVO_ADAPTER_API_URL` | unset | Base URL of the SVO adapter. `POST /flows` asks it whether a flow's pieces fit together; unset, that route answers 503 |
| `SVO_ADAPTER_INTERNAL_SERVICE_SECRET` | unset | Shared service secret sent to the adapter as `X-Ensemble-Manager-Secret` on flow checks and availability reads, so they pass the adapter's front door. Its own value, never the Hasura admin secret |
| `REGION_IMPORT_BODY_LIMIT` | `10485760` | Maximum import request body in bytes |
| `REGION_IMPORT_MAX_REGIONS` | `500` | Maximum regions per import |
| `REGION_IMPORT_MAX_GEOMETRIES` | `10` | Maximum geometries per region |
| `REGION_IMPORT_MAX_REGION_BYTES` | `2097152` | Maximum serialized geometry bytes per region |
| `PORT` | `3000` | Server port |
| `LOG_LEVEL` | `info` | Pino log level (`trace`, `debug`, `info`, `warn`, `error`) |

For local development, point to your Hasura instance:

```bash
export HASURA_GRAPHQL_URL=http://localhost:8080/v1/graphql
export HASURA_ADMIN_SECRET=myadminsecretkey
```

### Auth model

- **Reads** use the admin secret (`X-Hasura-Admin-Secret` header). No JWT required.
- **Generic writes** use the legacy Hasura forwarding path where still exposed.
- **Shared region imports** use `POST /v2.0.0/regions/import`. The API verifies the
  Tapis JWT against the configured issuer and tenant key endpoint, checks `(tenant_id, username)`
  in `public.region_curator`, validates the payload, and performs one admin-secret
  Hasura mutation. The nested region and geometry insert is atomic.
- **Shared region subcategories** use `POST /v2.0.0/regions/categories`. The API
  applies the same curator check, validates the top-level parent and normalized
  category name, and atomically creates the category plus its hierarchy edge.

To grant import access:

```sql
INSERT INTO public.region_curator (tenant_id, username)
VALUES ('portals', 'tapis-username')
ON CONFLICT (tenant_id, username) DO UPDATE SET active = true;
```

The generic `POST /regions` route is intentionally not published; clients should
use the import endpoint for shared regions.

## Development

```bash
npm install
npm run dev        # tsx watch — restarts on file changes
```

## Commands

```bash
npm run build      # Compile TypeScript to dist/
npm start          # Run compiled output
npm test           # Run all tests with vitest
npm run codegen    # Regenerate GraphQL types from Hasura schema
```

### Run a single test file

```bash
npx vitest run src/__tests__/integration.test.ts
```

### Integration tests

Integration tests make real HTTP requests against a live API instance to verify end-to-end behavior (e.g., junction-based relationship CRUD). They are **skipped by default** when running `npm test` so they don't break unit test runs or CI.

To run them:

1. **Obtain a Tapis Bearer token** from https://portals.tapis.io/v3/oauth2/webapp

2. **Set environment variables:**

   ```bash
   export MINT_API_TOKEN="<your-tapis-bearer-token>"
   export MINT_API_URL="https://api.models.mint.local/v2.0.0"  # optional, this is the default
   export NODE_TLS_REJECT_UNAUTHORIZED=0                        # only if using self-signed certs
   ```

3. **Run the integration tests:**

   ```bash
   npm test -- junction-integration
   ```

| Variable | Default | Description |
|---|---|---|
| `MINT_API_TOKEN` | *(none)* | Tapis Bearer token. Suite is skipped when unset. |
| `MINT_API_URL` | `https://api.models.mint.local/v2.0.0` | API base URL to test against |
| `NODE_TLS_REJECT_UNAUTHORIZED` | `1` | Set to `0` to allow self-signed TLS certificates |

### Health check

```
GET /health
```

Returns `{ status: "ok", hasura: "connected" }` or `503` if Hasura is unreachable.

### API docs

Swagger UI is served at `/v2.0.0/docs` when the server is running.

## Docker

```bash
docker build -t model-catalog-api .
docker run -p 3000:3000 \
  -e HASURA_GRAPHQL_URL=http://your-hasura/v1/graphql \
  -e HASURA_ADMIN_SECRET=your-secret \
  model-catalog-api
```

## Architecture

### Request flow

```
HTTP request
  -> Fastify (fastify-openapi-glue maps operationId -> handler)
  -> CatalogService Proxy (service.ts), or a dedicated custom handler
  -> CatalogServiceImpl (generic list / getById / create / update / deleteResource)
  -> Apollo Client (hasura/client.ts)
  -> Hasura GraphQL
```

### Key files

- **`src/service.ts`** — A JavaScript `Proxy` wraps `CatalogServiceImpl` and intercepts all operationId method calls from `fastify-openapi-glue`. It parses the operationId pattern (`{resource}_(id_)?(get|post|put|delete)`) and dispatches to the correct generic CRUD handler. This replaces ~230 individual handler files with a single class.

- **`src/hasura/client.ts`** — Two Apollo Client instances: `readClient` (uses admin secret, shared singleton) and `getWriteClient(bearerToken)` (per-request, forwards user JWT for Hasura permission enforcement).

- **`src/hasura/field-maps.ts`** — Field selections per Hasura table, used to build dynamic GraphQL queries.

- **`src/mappers/resource-registry.ts`** — Maps the 46 API resource path segments to their Hasura table name, OWL type URI, and relationship configuration (direct, object, array, junction-table).

- **`src/mappers/response.ts`** / **`src/mappers/request.ts`** — Transform between Hasura row format and the v1.8.0-compatible JSON the API returns.

- **`src/custom-handlers.ts`** — Handlers for the 13 `/custom/` endpoints and `/user/login`. These perform multi-table aggregation queries that cannot be served by the generic Proxy (e.g. fetching a model with all its versions, configurations, and setups in one response).
- **`src/region-import.ts`** — Dedicated curator-authorized region import/access handlers. These verify Tapis JWTs, query `region_curator`, validate GeoJSON, and issue one nested admin-secret mutation.
- **`src/region-category.ts`** — Curator-authorized region subcategory creation. It normalizes names into stable IDs and writes the category plus parent edge atomically.

- **`openapi.yaml`** — The canonical OpenAPI 3.0 spec (244 operations). Served unmodified by Swagger UI. On startup, `app.ts` strips response and request body schemas before registering routes to avoid AJV compilation overhead (~30s -> ~2s startup).

### Software subtypes

Several resource types (`models`, `empiricalmodels`, `hybridmodels`, `emulators`, etc.) share the `modelcatalog_software` Hasura table and are distinguished by a `type` column containing the OWL class URI. The `getSoftwareTypeFilter` function in `service.ts` appends the appropriate `where: { type: { _eq: ... } }` clause automatically.

### ID handling

All resource IDs are full URIs (e.g. `https://w3id.org/okn/i/mint/<uuid>`). The API accepts plain short IDs and prepends the prefix automatically. New resources created via POST get a `randomUUID()`-based URI.

## GraphQL codegen

To regenerate TypeScript types from the live Hasura schema:

```bash
HASURA_GRAPHQL_URL=http://localhost:8080/v1/graphql \
HASURA_ADMIN_SECRET=myadminsecretkey \
npm run codegen
```

Output goes to `src/generated/graphql.ts`.

## License

[MIT](https://opensource.org/license/mit). Copyright (c) 2026 MINT.
See [LICENSE](LICENSE).
