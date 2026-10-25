# MINT on a laptop

`docker compose up` starts the MINT platform on one machine. It uses Tapis
authentication. You sign in at `http://localhost:3000` and browse the model
catalog.

`compose.yaml` sits at the repository root. This directory holds the files it
mounts.

Job execution is out of scope. Tapis cannot reach a webhook on `localhost`, so a
real job never reports back. Sign-in and catalog browse work.

## Quick start

```bash
docker compose up -d --wait          # the stack, without the frontend
cd ui-react && npm install && npm run dev
```

Open `http://localhost:3000`.

The tracked `ui-react/public/env-config.js` already targets this stack, so host
mode needs no configuration step. `compose/ui-react.env` holds the same values
for the `.env` route (`cp compose/ui-react.env ui-react/.env && npm run
config:local`); use it only when you want to edit them. That command overwrites
the tracked file — restore it with
`git checkout -- ui-react/public/env-config.js`.

## What starts

| Service | Host port | Purpose |
|---|---|---|
| `ui-react` | 3000 | The frontend. Behind the `ui` profile. See below |
| `ensemble-manager` | 3001 | Threads, executions and the Tapis adapter |
| `model-catalog-api` | 3002 | The REST face of the catalog, v2.0.0 |
| `hasura` | 8082 | GraphQL over Postgres, and the console |
| `svo-adapter` | 8090 | Semantic planning, and the adapter UI |
| `semantic-search` | 8091 | Standard-variable embeddings over pgvector |
| `redis` | 6380 | Bull queues for Ensemble Manager |
| `postgres` | none | PostGIS and pgvector. The one database |
| `auth-webhook` | none | Validates Tapis tokens for Hasura |
| `auth-hook-proxy` | none | Removes large GraphQL bodies before auth validation |

`postgres` publishes no host port. The other services reach it on the compose
network. `redis` uses 6380 on the host, because a Homebrew Redis may already
hold 6379.

Two more services run once and exit:

| Service | Purpose |
|---|---|
| `hasura-init` | Applies the migrations, the metadata and, on an empty database, the seeds |
| `fixture-load` | Loads the demo model catalog into the `modelcatalog_*` tables |

Both run on every `up`. Both are idempotent. A second start adds no row.

Each service gets its own `localhost` port. There is no reverse proxy and no
`*.mint.local` host name.

Ensemble Manager listens on 3000 inside its container and cannot be told
otherwise. Compose remaps it to 3001.

## The two ways to run ui-react

Both serve port 3000 and both render the same `window.__MINT_CONFIG__`.

**On the host with Vite. This is the default.** You get hot reload.

```bash
cp compose/ui-react.env ui-react/.env
cd ui-react && npm run config:local && npm run dev
```

`compose/ui-react.env` is tracked. It is the single source of the host
configuration. It enables `SVO_ADAPTER_ENABLED=true`, so outcomes inferred
through an SVO adapter are planned and submitted as workflows rather than
silently falling back to the legacy model-job path.

Adapter workflows use `PT2050-DataX` by default for the Tapis allocation, the
same allocation used by Ensemble Manager app runs. Override it with
`SVO_ADAPTER_TAPIS_ALLOCATION` when starting Compose.

**In a container, behind the `ui` profile.** This builds the production bundle
and serves it with nginx. Use it to check the real image.

```bash
docker compose --profile ui up -d --wait
```

The container reads the same keys as plain environment variables. Keep
`compose/ui-react.env` and the `ui-react` service in `compose.yaml` in step.

Every URL in both ways is a **host** URL. The browser resolves them, not a
container, so a compose service name would not work. This is why the `ui-react`
service declares no `depends_on`: it never speaks to Hasura or Ensemble Manager
itself.

Tapis allows one callback for each client. `mint-localhost-3000` is registered
for `http://localhost:3000/oauth2/callback`, so the frontend must stay on port
3000.

## Profiles

`ui` is the only profile. Without it, `ui-react` does not start, and you run the
frontend on the host.

```bash
docker compose up -d --wait                 # no frontend container
docker compose --profile ui up -d --wait    # with the frontend container
```

## Configuration

Every credential is a development default. Override any of them in a `.env` file
beside `compose.yaml`, or in the shell.

| Variable | Default |
|---|---|
| `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB` | `mint` |
| `HASURA_GRAPHQL_ADMIN_SECRET` | `mint` |
| `MODEL_CATALOG_API` | `http://localhost:3002/v2.0.0` |
| `TAPIS_JWKS_URI` | `https://portals.tapis.io/v3/tenants/portals` |
| `TAPIS_TOKEN_ISSUER` | `https://portals.tapis.io/v3/tokens` |
| `REGION_IMPORT_BODY_LIMIT` | `10485760` (10 MiB) |
| `REGION_IMPORT_MAX_REGIONS` | `500` |
| `REGION_IMPORT_MAX_GEOMETRIES` | `10` per region |
| `REGION_IMPORT_MAX_REGION_BYTES` | `2097152` (2 MiB) |
| `LOG_LEVEL` | `info` |

The Tapis tenant is `portals`.

Shared region imports are restricted by the operator-managed
`public.region_curator` table. Add a curator after the Hasura migration has run:

```sql
INSERT INTO public.region_curator (tenant_id, username)
VALUES ('portals', 'tapis-username')
ON CONFLICT (tenant_id, username) DO UPDATE SET active = true;
```

The UI checks `GET /v2.0.0/regions/import/access` and submits imports to
`POST /v2.0.0/regions/import`. The generic `POST /regions` write route is not
published; imports are validated and committed atomically by the API.
The region-tab plus button uses the same curator check and submits new child
categories to `POST /v2.0.0/regions/categories` before loading their boundaries.

Ensemble Manager reads one committed file, `compose/ensemble-manager.json`.
Compose mounts it read-only. Every host name in it is a compose service name.
The Hasura admin secret is not in it; it comes from the environment.

CKAN stays remote at `https://ckan.tacc.utexas.edu`. This stack runs no CKAN.

## Where the data comes from

The schema comes from the Hasura migrations, the metadata and the seeds. It does
not come from a dump. `backups/production-backup.sql` predates DYNAMO v2.0 and
cannot seed this stack.

The seeds give the regions, the variables and the geometry. They hold no
`modelcatalog_*` row.

The catalog rows come from `graphql_engine/fixtures/modelcatalog.sql`. It holds
the whole controlled vocabulary and a subset of the catalog: 14255 rows, 4.4 MB.
Rebuild it from a production dump with
`graphql_engine/scripts/build-modelcatalog-fixture.sh`.

## Watch mode

`model-catalog-api` and `ensemble-manager` bind-mount their `src` directory and
run in watch mode. An edit restarts the service. No rebuild is needed.

Only `src` is mounted. A whole-directory mount would hide `node_modules` and
`dist`, which the images build.

`graphql_engine/` is mounted whole, so an edit to a migration needs no rebuild
either.

## Reset

```bash
docker compose down                # stop, keep the data
docker compose down -v             # stop and delete the database volume
docker compose up -d --wait        # start again
```

`down -v` gives you the cold start again: the migrations, the seeds and the
fixture all run.

The volume is `mint_postgres-data-16`. Its name carries the Postgres major
version on purpose. Postgres refuses a data directory that another major version
made, and the container exits 1 with `database files are incompatible with
server`. A major version bump therefore takes a new volume name. The old volume
stays on disk, and `docker compose up` still starts. Delete the old volume by
hand when you no longer want it.

To rebuild an image after a dependency change:

```bash
docker compose build --no-cache <service>
```

## Acceptance checklist

The checklist of [issue #186](https://github.com/mintproject/mint/issues/186).
Run it from empty volumes: `docker compose down -v && docker compose up -d --wait`.

| # | Check | How to run it |
|---|---|---|
| 1 | The stack starts from empty volumes. No manual step is needed | `docker compose up -d --wait` |
| 2 | The Hasura console answers on `http://localhost:8082` | `curl -o /dev/null -w '%{http_code}' localhost:8082/console` |
| 3 | The catalog list renders rows before sign-in, through the anonymous role | Open `http://localhost:3000/models` in a private window |
| 4 | Sign-in at `http://localhost:3000` completes against `portals.tapis.io` | Click **Sign In** |
| 5 | `model-catalog-api` answers an authenticated GET | `GET localhost:3002/v2.0.0/modelconfigurations` with a bearer token |
| 6 | Ensemble Manager serves `/v1/ui`, and `GET /v1/problemStatements` returns 200 | `curl localhost:3001/v1/ui/`, then the resource route with a bearer token |

The access token is in `localStorage` under `mint.access_token`.

### Last result

All six checks passed on 2026-08-31, on macOS on Apple Silicon, at commit
`4554f7e`.

| # | Result |
|---|---|
| 1 | Pass. A cold start takes 65 seconds. Eight services start, two of them exit 0 |
| 2 | Pass. `/console` gives 200, `/healthz` gives `OK` |
| 3 | Pass. 35 models render with no token. The Software > Version > Configuration > Setup chain opens, with inputs, outputs, parameters, standard variables and units. The browser console is clean |
| 4 | Pass. The token issuer is `https://portals.tapis.io/v3/tokens`. The header changes to the user name and **Sign Out** |
| 5 | Pass. 200, and 423 KB of catalog rows |
| 6 | Pass. `/v1/ui/` gives 200. `GET /v1/problemStatements` gives 200 and `[]` |

`GET /v1/problemStatements` returns an empty list. This stack seeds no thread.
The route answers, which is what the check asks. Without a token it gives 401.

## Traps

These cost time once. They are fixed in `compose.yaml`, and the comments there
say why.

- `postgis/postgis` and the auth webhook publish **amd64 only**. Both need
  `platform: linux/amd64` on Apple Silicon.
- `pg_isready` needs `-h 127.0.0.1`. Over the unix socket it reports ready during
  `initdb`, and Hasura then starts too early and exits.
- `HASURA_GRAPHQL_AUTH_HOOK_MODE` is `GET` so Hasura forwards the original
  client headers directly.
- `auth-hook-proxy` converts that header-forwarding GET auth hook into the
  tiny POST envelope expected by the Tapis auth webhook. This avoids the
  webhook image's 100 KB JSON-parser limit for geometry registrations while
  preserving `headers.Authorization`, which is where this webhook reads the
  bearer token.
- `HASURA_GRAPHQL_UNAUTHORIZED_ROLE` does nothing in webhook mode. The webhook
  returns the `anonymous` role itself.
- `model-catalog-api` builds the `builder` stage. The final stage runs
  `npm ci --production`, which drops `tsx`, so watch mode cannot start there.
- A healthcheck must call `127.0.0.1`, not `localhost`. Fastify binds IPv4 only,
  `localhost` resolves to `::1` first, and busybox `wget` does not fall back.
- The Hasura image ships no `psql`. Its Dockerfile installs
  `postgresql-client-common`, which has no client binary. `fixture-load` uses the
  Postgres image instead.
- A **data** migration cannot depend on the catalog rows. `hasura migrate apply`
  runs before `fixture-load`, so the `modelcatalog_*` tables are empty. Such a
  migration must select its own foreign key target and insert nothing when the
  target is absent. See
  `graphql_engine/migrations/1771200022000_modflow_2005_hydraulic_head_output`.
- `semantic-search` reads `modelcatalog_standard_variable` as it starts. It waits
  for `hasura-init` and `fixture-load`, and it also survives an empty schema: the
  refresh loop retries.
- `svo-adapter` listens on **8090** inside the container, not 8000. Its image
  runs `uvicorn --port 8090`.
