# svo-adapter-service

FastAPI sidecar that plans SVO-to-SVO ETL pipelines to make data objects
model-ready for MINT. See [`../docs/svo-adapter-service.md`](../docs/svo-adapter-service.md)
for the full architecture.

## How this reuses MINT's existing PostgreSQL + Hasura architecture

- **Same database, new schema.** Tables live in a dedicated `adapter` schema in
  the same PostgreSQL instance as `modelcatalog_*`. No model-catalog table is
  altered. The migration is in `graphql_engine/migrations/` like every other
  MINT migration.
- **Same Hasura.** The 9 `adapter.*` tables are tracked in
  `graphql_engine/metadata/tables.yaml`. They get GraphQL CRUD for free, exactly
  like the model catalog.
- **Same access pattern.** This service reads/writes metadata **through Hasura
  GraphQL**, not via a private Postgres connection. Reads use the admin secret;
  user writes forward the caller's JWT — the `model-catalog-api` convention.
- **Same separation of concerns.** Hasura does CRUD. This service does only what
  Hasura can't: multi-dimensional compatibility, transform-path search, Tapis
  workflow generation, provenance.
- **Same "URI everywhere".** PKs are TEXT (URI-capable); cross-links to the model
  catalog are stored as URIs.

## MINT catalog sync

The bundled GMA DFC registry uses version-specific cell-by-cell budget contracts
(`cbc-mf6`, `cbc-mfusg`, `cbc-mf2000`, `cbc-mf96`, and `cbc-mf2005`). The
model-catalog output specification must carry the matching `has_format` value
for the planner to connect a MODFLOW output to the corresponding drain/spring
extraction transform. A generic display label such as `cbb` is not sufficient.

After deploying a changed fixture, refresh the registry with:

```bash
curl -X POST http://localhost:8090/admin/seed-gma-dfc
```

The adapter can pull ModelConfigurations directly from the MINT catalog (same
Hasura/Postgres) and register them as `adapter.transform_spec` rows.

```bash
# Preview what would be created/updated/deleted (no writes):
curl -X POST http://localhost:8090/admin/sync-from-mint?dry_run=true

# Run the sync (also triggers a background edge-recompute):
curl -X POST http://localhost:8090/admin/sync-from-mint

# Check state:
curl http://localhost:8090/admin/sync-status
```

**How it works:**

- Each MINT `ModelConfiguration` with at least one typed I/O presentation becomes
  one `transform_spec` row. Configs with no presentations (standalone models) are
  skipped.
- One contract is created per `(DatasetSpecification, VariablePresentation)` pair.
  Standard variable URIs and units are carried through to the BFS planner.
- `env_from_args` is built from MINT parameter labels following the convention
  table in `mint_sync.py`. Non-standard labels are warned and skipped.
  Spatial labels are normalized onto canonical arg names (`geometry_source_uri`,
  `geometry_filter_value`, `spatial_scope_id`, `spatial_scope_name`,
  `model_layer`) while still accepting legacy aliases.
- If a `ModelConfiguration` has `tapis_app_id` set, the generated Tapis pipeline
  uses a `tapis_job` task (batch HPC job). Without it, a hosted OWE `function`
  task runs using `task_code.get_code(transform_type)`.
- MINT is the sole source of truth: adapter rows whose `mint_model_config_id` no
  longer appears in MINT are deleted on the next sync. Hand-created rows (null
  `mint_model_config_id`) are never touched.
- `POST /admin/sync-from-mint` fires `recompute-edges` in the background whenever
  it creates, updates, or deletes rows, so multi-hop BFS planning is consistent
  immediately after sync.

**Startup sync:** set `SVO_ADAPTER_MINT_SYNC_ON_STARTUP=true` to run the sync
automatically when the service starts.

**Required env vars** (in addition to `SVO_ADAPTER_HASURA_GRAPHQL_URL`):

```
SVO_ADAPTER_HASURA_ADMIN_SECRET=<hasura-admin-secret>
```

The adapter uses the Hasura admin secret for synchronization because this is a
system reconciliation operation and must not depend on the caller's catalog
role or row-level permissions.

**Unresolved Tapis apps:** `GET /admin/sync-status` reports `unresolved_count` —
specs that were synced but have no `tapis_app_id`. These use OWE function tasks
until an admin registers the app in Tapis and sets `tapis_app_id` on the MINT
`ModelConfiguration`, then re-runs the sync.

## Semantic SVO search

The local Compose stack includes `semantic-search` on port `8091`. It uses the
pgvector-backed standard-variable index and embeds each variable together with
the model configurations, software, and model versions linked to that variable.
This means a query such as `wildfire` can return canonical SVO variables from
ELMFIRE and QUIC-Fire configurations, with each result showing whether the
variable is a model input or output. The React SVO selector uses this endpoint
for queries of two or more characters and falls back to the catalog text list
if the service is unavailable.

The service performs an initial full index at startup. Hasura event triggers
normally POST catalog changes to the service immediately; a 60-second fallback
check also catches imports or writes that bypass Hasura. Only variables whose
indexed text changed are re-embedded. Set
`SVO_EMBEDDING_REFRESH_SECONDS` in Compose to change the interval (minimum five
seconds). A restart still forces a full rebuild:

```bash
docker compose up -d --build semantic-search
curl 'http://localhost:8091/search?q=wildfire&limit=20'
```

## Layout

```
app/
  config.py      # settings (Hasura URL/secret, Tapis, geo_actor) via SVO_ADAPTER_*
  hasura.py      # async GraphQL client + all GraphQL queries/mutations
  mint_sync.py   # MINT catalog → adapter.transform_spec sync
  task_code.py   # OWE function task code builders (point_extract, unit_convert, …)
  models.py      # Pydantic models + the DataObjectContract
  planner.py     # six-dimension compatibility + BFS transform-path search
  tapis.py       # plan_json → Tapis Workflows pipeline + register/run
  store.py       # in-memory Hasura stub for demo mode
  main.py        # FastAPI endpoints
examples/        # sample request/response payloads
```

## Run (dev)

```bash
cd svo-adapter-service
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
export SVO_ADAPTER_HASURA_GRAPHQL_URL=http://localhost:8080/v1/graphql
export SVO_ADAPTER_HASURA_ADMIN_SECRET=...   # same Hasura as the model catalog
uvicorn app.main:app --reload --port 8090
```

Apply the schema first (from `graphql_engine/`): `hasura migrate apply && hasura metadata apply`.

### Ensemble Manager post-model adapters

For a model output that needs an SVO transform before it satisfies the selected
response variable, Ensemble Manager creates a deferred adapter plan through
`POST /plans/deferred`. A new post-model run submits one composite Tapis
workflow: its first task is the model job, followed by a server-owned output
handoff and the SVO adapter tasks. The browser never supplies the model output
URI or data-object ID. The deferred bind endpoint remains available for legacy
or recovery runs that were created before composite submission was enabled.
Apply the migrations before testing this path, including the adapter
workflow-run idempotency migration.

For a non-demo deployment, set `SVO_ADAPTER_INTERNAL_SERVICE_SECRET` on both
services. Ensemble Manager sends it only on its server-to-server adapter calls;
the adapter rejects client attempts to claim an owned model-output object.

Adapter workflows default their Tapis allocation to `PT2050-DataX`, matching
the allocation used by Ensemble Manager's Tapis app runs. Override it with
`SVO_ADAPTER_TAPIS_ALLOCATION` when deploying to a different allocation. The
value is service-managed and is not a user-entered dataset parameter.

### Per-run Tapis tokens for long workflows

The caller's UI token can expire while a workflow is still running (the
composite model stage then fails with `MODEL_PROVIDER_AUTH_FAILED`). Set
`SVO_ADAPTER_RUN_TOKEN_ENABLED=true` and `/workflows/submit` and
`/transform-specs/{id}/test` will swap the `tapis_token` workflow arg for a
separate user-associated token minted via `POST /v3/tokens`. Registration and
the run call still use the caller's token.

- `SVO_ADAPTER_RUN_TOKEN_TTL_SECONDS` (default 43200), clamped to
  `..._TTL_MIN_SECONDS` (900) and `..._TTL_MAX_SECONDS` (172800).
- `SVO_ADAPTER_RUN_TOKEN_TARGET_PREFIX` (default `svo-adapter-run`).
- The token is not stored or logged, and is not revoked early; it expires after
  its TTL. If minting fails the submit returns 502 `RUN_TOKEN_MINT_FAILED` and
  the caller's token is never used for the run.
- Runs longer than the TTL still fail; a refresh broker is a possible follow-up
  (see `../docs/design/2026-10-28-svo-adapter-workflow-token-lifecycle.md`).
- Off by default. The mint contract is verified only for SUBSIDE on `portals`;
  confirm it against a sandbox run before enabling.

## Demo UI (zero infra)

A bundled standalone single-page UI (`static/index.html`) walks the whole flow —
register the ETL pieces, check readiness, plan, generate, and run a Tapis
Workflows pipeline. **Demo mode** backs every Hasura call with an in-memory store
so it runs with no Hasura/Postgres/Tapis:

```bash
cd svo-adapter-service
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
SVO_ADAPTER_DEMO_MODE=1 uvicorn app.main:app --reload --port 8090
# open http://localhost:8090/  -> click "Load SUBSIDE WERC pieces" -> step through 1-6
```

Click **Load SUBSIDE WERC pieces** to seed the SUBSIDE pipeline as `transform_spec`s
(`POST /admin/seed-subside-werc`), then walk steps 1–6. "Submit run" defaults to
**dry-run** (registers + returns the pipeline definition without triggering Tapis —
no `workflows` grant needed). Headless equivalent: `python tests/test_demo_api.py`.

Same UI, real backend: drop `SVO_ADAPTER_DEMO_MODE` and point at a live Hasura
(the readiness/plan target can still be supplied inline via `target_contract`, so
a populated model catalog is optional).

The UI is live-only: it reads the persistent transform/data-object registry from
Hasura and submits forecast and DFC workflows to Tapis. Start Hasura and apply the
schema before opening `http://localhost:8000/ui/`.

## Registering reusable ETL pieces

Open the **ETL Pieces** tab to register a transform through the same
`POST /transform-specs` registry flow used by the backend. A piece may include
Python source and an entrypoint for a lightweight inline Tapis/OWE `function` task,
or a `tapis_app_id`/version for a heavier `tapis_job`. Generated workflows can mix
both task types. The adapter stores the definition and materializes function tasks
inline when registering each generated pipeline; it never executes submitted Python
locally.

The service exposes `GET /etl/common-variables` for the canonical ETL/UI runtime
arg contract and accepted legacy aliases, and `GET /spatial/layers` for the
backend-owned spatial layer catalog. `GET /runtime-defaults` retains a compact
compatibility payload for the standalone UI and never returns `tapis_token`.
The React MINT UI consumes `/spatial/layers` through its `SVO_ADAPTER_API`
runtime setting. That catalog owns reusable ETL source metadata, including the
TWDB GMA, GCD, and county ArcGIS layers. The Framing map first uses geometries
registered in MINT's `/regions` workflow; when a layer has not been registered,
it falls back to querying the catalogued external GeoJSON/ArcGIS source. The
Region Editor accepts remote GeoJSON and ArcGIS FeatureServer/MapServer URLs so
new boundary sources can be registered without adding UI constants.

### Canonical ETL variable contract

New ETLs should declare canonical argument names in `env_from_args` and emit
canonical workflow arguments. Geometry/file mechanics are separate from semantic
scope: use `geometry_source_uri`, `geometry_source_type`, `geometry_layer`,
`geometry_filter_field`, `geometry_filter_value`, `geometry_crs`, and
`geometry_format` for sources, and `spatial_scope_type`, `spatial_scope_id`,
`spatial_scope_name`, and `spatial_resolution` for the meaning of the selected
area. Model inputs use `grid_uri`, `model_layer`, `stress_period`, and `timestep`.

`source_uri` remains the runtime/model input URI; it is not automatically treated
as a geometry source. Existing aliases such as `gma_boundary_uri`,
`location_file_uri`, `boundary_query_field`, `boundary_query_value`, `gma_id`,
`area_type`, `area`, `county_name`, `gcd_name`, `aquifer`, `layer`, and
`time_step` are normalized at ingress. Canonical values win when both forms are
present. `tapis_token` is injected at execution time and is runtime-only. The
default common-variable response omits runtime-only definitions; integrations
that need their metadata may request `?include_runtime=true`, which still never
returns a token value.

The DFC pieces that use both a GMA boundary and a second DFC-area boundary retain
`dfc_area_boundary_uri` as a compatibility-only second input; collapsing those
two URIs into one value would change the transform semantics.

Problem-framing recommendation calls may include an optional `spatial_conditions`
map using the same scope/resolution keys. The map is structured context for
recommendation requests and is kept separate from the free-text problem title.

### Bulk-register the checked-in ETL catalog

The checked-in transform manifests can be registered into the MINT Model Catalog
with the idempotent loader below. It is dry-run by default:

```bash
python3 scripts/register_existing_etl_pieces.py
python3 scripts/register_existing_etl_pieces.py \
  --apply \
  --endpoint https://mintdevgraphql.pods.portals.tapis.io/v1/graphql \
  --admin-secret "$HASURA_GRAPHQL_ADMIN_SECRET"
```

The loader registers one row per stable ETL ID, collapses identical shared
definitions, and fails on conflicting definitions instead of silently letting
one pipeline overwrite another.

## TWDB GAM archive catalog

Use `scripts/reconcile_twdb_gams.py` to audit the complete TWDB groundwater-model
download table against the live `twdb-gams` CKAN organization. It is dry-run by
default and requires `--apply --yes` plus CKAN/Tapis credentials for approved
writes. See [the reconciliation runbook](docs/twdb-gam-ckan-reconciliation.md)
for the evidence files, recovery log, and archive-versus-SVO metadata policy.

Use `scripts/reconcile_ckan_svos.py` for the reviewed TWDB SVO/spatial correction
set. It is also dry-run by default, pins every live package/resource identity and
expected prior value, and requires `--apply --yes` for writes:

```bash
python3 scripts/reconcile_ckan_svos.py --output /tmp/ckan-svo-audit
python3 scripts/reconcile_ckan_svos.py \
  --output /tmp/ckan-svo-apply \
  --credentials-file ../.env \
  --apply --yes
```

CKAN spatial coverage belongs on the dataset. SVO annotations belong on the
resource that provides them, including reviewed complete model archives. The
adapter keeps MODFLOW ZIP/ZIPX/7Z bundles as `zip`; only explicitly identified
shapefile bundles become `shapefile-zip`.

MODFLOW complete simulation archives should also carry the exact version label
for the model contract they support: `groundwater_model_modflow6_simulation_archive`,
`groundwater_model_modflow2000_simulation_archive`,
`groundwater_model_modflow2005_simulation_archive`, or
`groundwater_model_modflow96_simulation_archive`. A multi-version archive may
carry more than one label; retain the archive's reviewed contained-variable
annotations as well.
