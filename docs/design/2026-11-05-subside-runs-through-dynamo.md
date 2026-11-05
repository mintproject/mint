# SUBSIDE runs through DYNAMO

Status: Approved (2026-11-05, rev 3; user approved after architect and skeptic review and answered Q1 and Q8). Implementing.

Repos touched: `monorepo/` (Ensemble Manager, compose) and `subside/` (UI and API).

Related specs (cited, not restated):
- [2026-11-05-output-publish-etl.md](2026-11-05-output-publish-etl.md) (Implementing): the `publish` flag on `POST /plans`, `GET /plans/publishers`, `output_handoff.publication`.
- [2026-11-05-app-input-binding.md](2026-11-05-app-input-binding.md) (Implemented): how the AOI reaches the app input `aoi-geojson`.
- [2026-11-05-aoi-etl-piece.md](2026-11-05-aoi-etl-piece.md) (Implemented): the bridge derives the AOI from the thread's region.
- [2026-11-04-svo-adapter-secrets-store.md](2026-11-04-svo-adapter-secrets-store.md): owner-provided secrets such as `earthdata`.

## Objective

SUBSIDE's UI submits, lists and reads model runs through DYNAMO (the MINT Ensemble Manager, EM, plus the svo-adapter bridge) instead of through SUBSIDE's own API and its Tapis Workflows pipelines. Publication of outputs to CKAN and STAC goes through DYNAMO's `publish` flag. The SUBSIDE API keeps the functions DYNAMO does not provide (OPERA frame availability, forecast, auth config, STAC proxy). Its run endpoints are retired.

Non-goals: changing the MINT catalog model definitions or the analysis containers; changing the map/STAC rendering; deploying anything (the user's instruction: nothing deployed, test locally); server-side STAC ownership (publish spec follow-up); a shared or curated-region workflow beyond what SUBSIDE draws.

## User need

- **Primary user:** a SUBSIDE end user (hydrogeology or subsidence domain user, not a developer) who runs OPERA DISP-S1 analyses for an area of interest; Waco is the first region.
- **Secondary user:** the SUBSIDE maintainer, who must run the whole stack locally and see runs in one place.
- **Tertiary user:** the DYNAMO operator, who wants SUBSIDE runs in the same run history and publication flow as other DYNAMO apps.
- **Job to be done:** "Run a WERC or H2I analysis for my area and get the displacement and velocity products on the map, published where the team can find them, without handling Tapis or Earthdata credentials myself."
- **Current pain:** the SUBSIDE form asks for Earthdata credentials on every run (`subside/api/models.py` `RunRequest`); SUBSIDE runs live in Tapis Workflows pipelines separate from DYNAMO runs, with publication defined inline in the pipelines and not reusable.
- **Definition of success:** (1) from the SUBSIDE UI a user picks a region and dates, submits, and watches the run go queued → running → completed without another app; (2) after publication the products appear on the SUBSIDE map with the publication state in the run list; (3) the user never types Earthdata credentials; (4) a double-click or a retry never creates a second HPC job.

## Current code/system summary

Verified in code on 2026-11-05.

- **SUBSIDE run request.** `subside/api/models.py` `RunRequest` (94-118): `pipeline` (h2i|werc), `start_date`, `end_date`, `aoi_geojson`, `allocation`, `num_workers` (4), `min_overlap_percent` (50), `max_minutes`, `reference_mode` (auto|point|manual), `reference_lat/lon`, `anchor_radius_m` (5000), `n_reference_pixels` (25), `update_conda_env`, Earthdata fields. No `frame_ids`.
- **SUBSIDE run routes and service.** `api/main.py` 262-327: `POST /runs/estimate`, `POST /runs`, `GET /runs`, `GET /runs/{id}`, `GET /runs/{id}/results`, `GET /runs/{id}/file`. `api/services/manager.py`: `list_runs` lists Tapis Workflows runs of the two registered SUBSIDE pipelines; `normalize_status` → `queued | running | completed | failed | cancelled` (+ `recovering`); `get_results` reads the run archive.
- **SUBSIDE UI.** `ui/src/components/mapworkbench/SubsideAnalysis.jsx` owns the form and run list (`submitRun` ~481, `listRuns` ~383, `getRunStatus` ~329 polled every 5 s, `getRunResults` ~351, used for the bbox and date window of the STAC lookup); `StacResults.jsx` renders STAC results; `ui/src/lib/subsideApi.js` is the client (`X-Tapis-Token` header, base `VITE_SUBSIDE_API_BASE`); `ui/src/lib/stacApi.js` searches the collection `VITE_STAC_COLLECTION` and exposes `itemLayers`, `itemDownloads`, `itemMeta`; `estimateRuntime.js` is client-side. Runtime keys: `VITE_SUBSIDE_API_BASE`, `VITE_STAC_API_BASE`, `VITE_STAC_COLLECTION`, `VITE_STAC_CONTEXT_COLLECTION`, `VITE_CKAN_BASE`, `VITE_CKAN_ORG`.
- **MINT catalog.** WERC `https://w3id.org/okn/i/mint/opera-disp-s1-werc` parameters: START_DATE, END_DATE, FRAME_IDS, NUM_WORKERS, MIN_OVERLAP_PERCENT, RESULTS_DIR, REQUIRE_PRODUCTS, REFERENCE_MODE, REFERENCE_LAT, REFERENCE_LON, ANCHOR_RADIUS_M, N_REFERENCE_PIXELS, ANCHOR_DIR, DISPLACEMENT_GEOTIFF_NAME, VELOCITY_GEOTIFF_NAME; secret `earthdata` (owner-provided, seeded on dev). H2I `opera-disp-s1-h2i-lab` (`subside/tapis/workflow_apps/opera-disp-s1.model-catalog.yaml`): start/end date, frame ids, workers, min overlap, results dir, require products, preview only; no reference parameters. Both bind the AOI input `aoi-geojson`, derived by the bridge from the thread region.
- **EM services to reuse.** `tasksService.createTaskWithThread(problemStatementId, task, thread, auth)` (`tasksService.ts:81`) creates task + subtask, inheriting and validating the region. `subTasksService.setupModelConfigurationAndBindings(subtaskId, {model_id, data, parameters}, auth)` (`subTasksService.ts:323`) adds the model and sets data and parameter bindings in one call. `problemStatementsService` creates problem statements. All three **overwrite permissions with `userid: "*"`** (read, write, execute; `problemStatementsService.ts:51-59`, `tasksService.ts:64`, `subTasksService.ts:242-244`) and swallow GraphQL failures into generic 500s.
- **EM unified execution.** `paths/unifiedExecution.ts`: `POST /plans`, `GET /plans/publishers`, `POST /plans/submit`, `GET /plans/runs/:runId`, `POST /plans/runs/:runId/cancel`, `GET /plans/:planId` (route order matters: `/:planId` would swallow a later static path). `unifiedExecutionStore` records carry `thread_id` and `idempotency_key`; `listByThread(threadId, modelId?)` exists; `insert` is idempotent on `plan_id`; the store uses the admin secret, so permission checks are the caller's job. `getRun` reconciles parent status lazily, so a list read from stored rows is stale until each run is read. `cancelRun` sets `status: "failed"` with `failure_code: "CANCELLED_BY_USER"` and returns 409 `RUN_NOT_CANCELLABLE` when no adapter child is active. `submit()` forwards `dry_run` to the adapter for adapter plans only.
- **Status vocabulary.** `planned`, `model_dispatching`, `model_submitted`, `model_running`, `model_succeeded`, `output_registering`, `output_verifying`, `output_verified`, `adapter_dispatching`, `adapter_running`, `completed`, `failed`, `unknown`, `model_unknown`, `adapter_unknown`. `output_handoff` = `{resource_uri, data_object_id, bound_plan_id?, publication?}`.
- **Dates.** Thread dates feed input discovery (`useModelInputService.ts:19-25`, `time_period`); the job's START_DATE/END_DATE come from the thread's parameter bindings. Both must agree.
- **Auth.** The EM verifies bearer JWTs against a configured public key (`utils/authUtils.ts`); CORS is open (`server.ts:76`, `app.use(cors())`). The EM accepted the user's `portals.tapis.io` Tapis JWT for the Waco plan and submit on 2026-11-05. Username today comes from Keycloak's `preferred_username` (`config/keycloak-adapter.ts:72`); a Tapis JWT carries it as `tapis/username`.
- **Regions.** `region{id,name,category_id,parent_region_id,geometries}`, `region_geometry{id,region_id,geometry}`; the EM has no region write, only `checkRegionExistsByIdV2` (`subTasksService.ts:580`). `model-catalog-api/src/region-import.ts` already validates GeoJSON with size and count caps (8-10, 221-253), verifies the Tapis JWT, gates writes on a `region_curator` table (13-27) and inserts `region` with nested `geometries` (29-38, 352), storing each geometry as a JSON string (310). The Waco region `subside-aoi-waco` (category `subsidence_aoi`, parent `texas`) was inserted by hand.
- **Local stack.** `compose.yaml`: EM on `localhost:3001` (source mounted, watch mode), svo-adapter on `localhost:8090`, Hasura on `localhost:8082`. The compose fixtures do not contain the OPERA configurations or a secrets-store key.

## Proposed design

### 0. Identity

`utils/authUtils.ts` gains `usernameFromToken(token)`: the verified JWT's `tapis/username` claim, else `preferred_username`, else 401. This username is the `user_id` written into `problem_statement_permission` (and task/thread permissions) for everything this spec creates, and the owner matched by every read.

### 1. EM `POST /regions`

Creates or finds a region from GeoJSON. Lives in `paths/regions.ts` + `services/regionsService.ts` + `classes/graphql/queries/region/*.graphql` (existing pattern).

- Body: `{ name, geojson, category_id = "subsidence_aoi", parent_region_id?: string }`. Response `{ region_id, created }`.
- Validation is ported from `region-import.ts` (geometry type Polygon|MultiPolygon, WGS84 bounds, ring closure, vertex and byte caps). The curator gate is **not** applied: these are user AOIs, not curated reference regions.
- Canonicalisation before hashing: coordinates rounded to 6 decimals, outer rings counter-clockwise and holes clockwise, each ring rotated to start at its lexicographically smallest vertex, closing vertex dropped, MultiPolygon parts sorted. `region.id = "aoi-" + sha256(canonical)[:16]`. Insert with `on_conflict: {constraint: region_pkey, update_columns: []}`; the response's `created` is whether a row was inserted. This makes dedup exact for redraws of the same shape, race-free, and needs no migration or hash column. Near-identical hand-drawn polygons are different regions, by design.
- `parent_region_id` is optional and null by default (no `texas` assumption; the FK would fail where fixtures lack it).

### 2. EM `POST /plans/scenario`

One call that gives a client a run. New `services/scenarioService.ts`; route added to `paths/unifiedExecution.ts` **before** `GET /plans/:planId`.

Request:

```json
{
  "idempotency_key": "client uuid, required",
  "app_label": "SUBSIDE",
  "name": "WERC Waco 2024-01..2024-12",
  "region": { "region_id": "aoi-…" } | { "geojson": {...}, "name": "…" },
  "model_id": "https://w3id.org/okn/i/mint/opera-disp-s1-werc",
  "start_date": "2024-01-01",
  "end_date": "2024-12-31",
  "parameter_values": { "NUM_WORKERS": 4, "MIN_OVERLAP_PERCENT": 50, "REFERENCE_MODE": "auto" },
  "publish": ["ckan", "stac"],
  "max_minutes": 240,
  "dry_run": false
}
```

Behaviour, with submit last so every earlier step is safely re-runnable:
1. **Idempotency.** Look up `unified_execution` by `idempotency_key` for this caller; if found, return it (200, `reused: true`). Otherwise continue.
2. **Standing problem statement.** `id = "ps-" + sha256(username + "|" + app_label)[:16]`, name `"<app_label> runs"`, region null, permissions `[{userid: username, read, write, execute, owner: true}]`, created with insert-on-conflict (race-free, no lookup path needed). `problemStatementsService`, `tasksService` and `subTasksService` gain an optional `permissions` argument that, when given, replaces today's `"*"` default; nothing else about them changes.
3. **Region.** `region_id` as given, or step 1 of §1 for `geojson`.
4. **Task.** One task per (problem statement, region): `id = "task-" + sha256(ps_id + "|" + region_id)[:16]`, named after the region, insert-on-conflict. The task carries the region and the model's response variable.
5. **Thread.** One thread per run, via `createTaskWithThread` semantics for the thread part only (the task already exists): name from the request, dates `start_date`/`end_date`, permissions as step 2.
6. **Model and bindings.** `setupModelConfigurationAndBindings(threadId, {model_id, data: [], parameters})` where `parameters` = the request's `parameter_values` plus `START_DATE`/`END_DATE` derived from the top-level dates. A request whose `parameter_values` contains START_DATE or END_DATE with a different value is rejected (422 `DATES_CONFLICT`). Dates are passed as `YYYY-MM-DD` strings end to end; no `Date` conversion.
7. **Plan and submit.** `POST /plans` body `{executor: "ensemble_manager", thread_id, model_id, execution_engine: "tapis", publish}` then `POST /plans/submit` `{plan_id, parameter_values (publish parameters only), max_minutes, idempotency_key, dry_run}` through the existing service functions in-process.
8. Response `{ problem_statement_id, task_id, thread_id, plan_id, run_id, status, reused }`.

Failure: the response names the step and the ids created so far; nothing created before submit is harmful (an empty thread is visible in the MINT UI and can be deleted). A failure after submit succeeded cannot lose the run: the next identical request hits step 1 and returns it. Errors from the reused services are surfaced with their codes, not re-wrapped as generic 500s.

### 3. EM `GET /plans/runs`

`GET /plans/runs?problem_statement_id=&app_label=&limit=` (static path registered before `/runs/:runId`). Resolves the problem statement (by id, or by `app_label` → the caller's standing id), checks the caller's read permission through `problemStatementsService.getProblemStatementById` (user token), collects its threads, and returns `listByThreads(threadIds)` (a new store query, `thread_id _in`, ordered by `created_at desc`). Each row: `run_id, name, thread_id, model_id, status, failure_code, created_at, output_handoff`. Rows are the stored status; the UI reads `GET /plans/runs/:runId` for each non-terminal row to get the reconciled status (see §5 polling).

Status mapping, owned by `dynamoApi.js` and unit-tested over the full vocabulary:

| Unified EM status | SUBSIDE display |
|---|---|
| planned, model_dispatching, model_submitted | queued |
| model_running, model_succeeded, output_registering, output_verifying, output_verified, adapter_dispatching, adapter_running | running |
| completed | completed (publication state shown from `output_handoff.publication`) |
| failed with `failure_code == "CANCELLED_BY_USER"` | cancelled |
| failed (other) | failed |
| unknown, model_unknown, adapter_unknown | unknown |

`recovering` has no DYNAMO equivalent and is dropped. Cancel is offered only while an adapter child is active (`RUN_NOT_CANCELLABLE` otherwise).

### 4. Parameter mapping (RunRequest → catalog)

WERC:

| SUBSIDE field | Catalog parameter | Notes |
|---|---|---|
| pipeline = werc | `model_id` = WERC configuration | pipeline selects the model |
| start_date / end_date | thread dates **and** START_DATE / END_DATE | derived by the composite from the single top-level pair |
| aoi_geojson | region → input `aoi-geojson` | derived by the bridge from the thread region |
| (none) | FRAME_IDS | catalog default (blank); the app discovers frames from the AOI, as today |
| allocation | managed plan parameter | not user-settable |
| max_minutes | `max_minutes` on submit | walltime |
| num_workers / min_overlap_percent | NUM_WORKERS / MIN_OVERLAP_PERCENT | direct |
| reference_mode / lat / lon | REFERENCE_MODE / REFERENCE_LAT / REFERENCE_LON | direct |
| anchor_radius_m / n_reference_pixels | ANCHOR_RADIUS_M / N_REFERENCE_PIXELS | direct |
| update_conda_env | none | dropped; the app image owns its environment |
| earthdata_* | secret `earthdata` | owner-provided; removed from the form |
| (none) | RESULTS_DIR, REQUIRE_PRODUCTS, ANCHOR_DIR, *_GEOTIFF_NAME | catalog defaults |

H2I: start/end date, FRAME_IDS (blank), NUM_WORKERS, MIN_OVERLAP_PERCENT as WERC; no reference parameters (the UI hides them for H2I); preview-only stays at its default.

A contract test reads `opera-disp-s1.model-catalog.yaml` and asserts label **and** type for every mapped parameter.

### 5. SUBSIDE UI

- New `ui/src/lib/dynamoApi.js`; base from a new runtime key `VITE_DYNAMO_API_BASE` (`http://localhost:3001/v1` locally). Functions: `createRegion`, `submitScenario` (generates and stores the `idempotency_key` per form submission; the button is disabled until the call settles), `listRuns`, `getRun`, `cancelRun`, `getPublishers`, `toSubsideStatus`.
- `SubsideAnalysis.jsx`: submit, list, status and results switch to `dynamoApi.js` when `VITE_RUN_BACKEND=dynamo` (default `legacy` until local verification passes). Earthdata fields removed in dynamo mode; 422 `SECRET_REQUIRED` relayed by the EM is shown as "this model's owner has not provided its Earthdata login".
- **Polling.** The list is refreshed, then each non-terminal row is read through `getRun` with backoff 5 s → 15 s → 60 s, paused while the tab is hidden. Terminal rows are not polled.
- **Results.** The bbox for the STAC lookup comes from the run's region geometry (the UI drew it, or fetches `region_geometry` through the EM's existing thread read) and the date window from the thread dates. After publication, `output_handoff.publication.stac_item` is the results record and `itemDownloads`/`itemLayers` give downloads and layers; before publication the model output location `output_handoff.resource_uri` is shown. The legacy archive-reading results endpoint is not used for DYNAMO runs.
- Publish control: `GET /plans/publishers?model_id=` drives the choice, default `ckan+stac` (publish spec UI section applies).
- SUBSIDE API endpoints still used in dynamo mode: availability (for the frame preview, anonymous today), auth config and token exchange, STAC proxy. `/runs/estimate` is not used by the UI (the estimate is client-side in `estimateRuntime.js`); it is kept but not relied on.

### 6. SUBSIDE API

Run endpoints (`POST /runs`, `GET /runs`, `GET /runs/{id}`, `GET /runs/{id}/results`, `GET /runs/{id}/file`) are marked deprecated in OpenAPI and, behind `SUBSIDE_LEGACY_RUNS=false`, return 410 with a pointer to DYNAMO. Pre-cutover runs are not listed (D7).

## Files likely affected

Monorepo:
- `mint-ensemble-manager/src/utils/authUtils.ts` (`usernameFromToken`); `services/problemStatementsService.ts`, `tasksService.ts`, `subTasksService.ts` (optional `permissions`; surfaced errors); new `services/regionsService.ts`, `services/scenarioService.ts`; `paths/regions.ts`; `paths/unifiedExecution.ts` (`/scenario`, `/runs` before the param routes); `services/unifiedExecutionStore.ts` (`listByThreads`, lookup by `idempotency_key`); `classes/graphql/queries/region/*.graphql`; `api-doc.ts`; tests.
- `compose/README.md`: local SUBSIDE wiring; a documented loader step for the OPERA configurations (see Test plan).

SUBSIDE:
- `ui/src/lib/dynamoApi.js` (new), `ui/src/lib/subsideApi.js`, `ui/src/lib/runtimeConfig.js`, `ui/src/components/mapworkbench/SubsideAnalysis.jsx`, tests; `ui/.env.example`.
- `api/main.py`, `api/models.py` (deprecation flag and 410), `api/README.md`, `ARCHITECTURE.md`.

## API/schema changes

- New EM routes: `POST /regions`, `POST /plans/scenario`, `GET /plans/runs`. New error codes: `DATES_CONFLICT`, `REGION_INVALID`, `SCENARIO_STEP_FAILED {step, created}`.
- Existing services gain an optional `permissions` parameter (default unchanged).
- No database migration: deterministic ids with insert-on-conflict replace lookup columns.
- SUBSIDE API: run endpoints deprecated behind `SUBSIDE_LEGACY_RUNS`.

## Data flow

Draw region → `POST /regions` → `region_id` → `POST /plans/scenario` (idempotency key, dates, values, publish) → EM: standing problem statement → task per region → thread per run → model + bindings (dates once) → `POST /plans` → `POST /plans/submit` → adapter plans the AOI step and submits the Tapis job → UI polls `GET /plans/runs` + `GET /plans/runs/:id` with backoff → on completion the publish step writes CKAN + STAC (publish spec) → UI shows `publication` links; the map reads STAC as before.

## Risks and tradeoffs

- **Permissions change inside shared services.** The optional argument keeps every existing caller on `"*"`. A test asserts the default is unchanged.
- **Standing objects per user** concentrate history; reads check the problem statement permission on every call. Row growth is one thread per run and one task per region, not per run.
- **Exact-redraw dedup only.** Near-duplicate polygons create separate regions; acceptable, stated in the contract. Caps bound the size.
- **Idempotency scope.** The key is per caller; a lost response after a successful submit is recovered by the retry. Steps before submit may leave an empty thread on a failure; it is visible and deletable.
- **Stale list status.** `GET /plans/runs` returns stored rows; the UI reads active rows individually. The polling backoff bounds the load (one 60 s read per active run after the first minute).
- **Owner secret availability.** A model whose owner has not provided `earthdata` cannot run; surfaced at submit as `SECRET_REQUIRED`.
- **Parameter drift.** Covered by the contract test on labels and types.
- **Dependence on the publish branch** (Implementing) for the publication part of success.

## Alternatives considered

- **SUBSIDE API as the single front door calling DYNAMO server-side.** Rejected: the user's direction is to submit through DYNAMO, and a proxy keeps two run models in SUBSIDE's API.
- **Region creation in model-catalog-api's `region-import`.** Its validation is reused, but its curator gate is for reference regions and end users are not curators; a user-AOI write belongs with the run API. Recorded as the alternative if region ownership should later be unified.
- **Direct Hasura region writes from the browser.** Rejected: exposes insert permissions to every session.
- **Compose the run from separate EM calls in the UI.** Rejected: the UI would own sequencing and partial-failure handling.
- **Reuse `GET /threads/:id/runs`.** Rejected: it 404s without the run-history service and is per thread.
- **Random ids with find-or-create.** Rejected: racy and needs lookup columns; deterministic ids with insert-on-conflict need neither.

## Test plan

Unit (EM, Jest): `usernameFromToken` (tapis claim, keycloak claim, missing → 401); regions (canonicalisation: rotation, winding, rounding, closing vertex; same shape twice → one row, `created` false; invalid geometry and caps → `REGION_INVALID`; parent optional); scenario (step order with submit last; standing problem statement created once across two concurrent calls; permissions are the caller only and existing callers still get `"*"`; `DATES_CONFLICT`; `START_DATE`/`END_DATE` equal the top-level dates in the bindings; repeated `idempotency_key` returns the same run with `reused: true` and no second submit; a failure at step N reports `{step, created}`; `dry_run` reaches the adapter submit); `GET /plans/runs` (permission filter; `listByThreads` ordering; route order vs `/runs/:runId` and `/:planId`).

Unit (SUBSIDE, Vitest): `dynamoApi` request shapes incl. the idempotency key; `toSubsideStatus` over the full vocabulary incl. `CANCELLED_BY_USER`; polling backoff and pause-on-hidden; no Earthdata fields in dynamo mode; H2I hides reference fields; `SECRET_REQUIRED` message; results bbox/dates from region and thread.

Contract: parameter labels and types vs `opera-disp-s1.model-catalog.yaml`.

Local end-to-end (compose stack + SUBSIDE Vite dev server with `VITE_DYNAMO_API_BASE=http://localhost:3001/v1`, `VITE_RUN_BACKEND=dynamo`):
- Deliverable: `compose` step loading the two OPERA configurations into the local catalog (`modflow-executables/scripts/register_subside_to_mint.py` against local Hasura) and running the adapter sync, documented in `compose/README.md`.
- **Asserted:** region create and redraw-dedup from the real map drawing; scenario creates problem statement, task, thread, bindings with the expected parameter values and dates; the adapter receives the submit with `dry_run: true` and returns a generated pipeline containing the AOI step and the model task; the run appears in the list with status `planned`/`model_submitted`; a repeated submit returns `reused: true`.
- **Stubbed (fake adapter responses):** status transitions through to `completed`, `output_handoff.publication`, `CANCELLED_BY_USER`, `SECRET_REQUIRED`.
- **Not verifiable locally:** Tapis job submission and HPC execution, CKAN/STAC writes, the real secrets store. These happen only in an approved dev run after the publish spec's rollout.

## Documentation plan

`subside/README.md`, `ARCHITECTURE.md`, `api/README.md` (run flow via DYNAMO; deprecated routes); `ui/.env.example` (`VITE_DYNAMO_API_BASE`, `VITE_RUN_BACKEND`); EM `api-doc.ts`; `compose/README.md` (local SUBSIDE wiring and OPERA fixture loading); DSO-Architecture `docs/services/` SUBSIDE and Ensemble Manager pages and `docs/dev/environment-variables.md`, after implementation, no deploy.

## Rollout/rollback plan

Local only. 1. EM changes behind tests; local stack. 2. UI client with `VITE_RUN_BACKEND=legacy` default; verify `dynamo` locally. 3. Flip the default on the user's approval. 4. Deprecate SUBSIDE run routes one release later. Rollback: `VITE_RUN_BACKEND=legacy`; EM routes are additive. Runs created in dynamo mode are not visible in legacy mode and vice versa; the flag is a development switch, not a user-facing toggle.

## Open questions

None blocking. Q1 and Q8 decided by the user on 2026-11-05 (see Decisions D6, D7).

Resolved in rev 2/3 against code: identity (tapis/username), region storage and validation (region-import), dates (single source), cancel mapping, list source (`listByThreads`), dry-run path, CORS (open), frame ids (blank), results bbox/dates (region + thread), estimate (client-side), polling cadence, local E2E scope.

## Decisions

- **D1.** `POST /regions` in the EM with region-import's validation, deterministic hash ids and insert-on-conflict; no curator gate for user AOIs.
- **D2.** `POST /plans/scenario` as `scenarioService` over `createTaskWithThread`/`setupModelConfigurationAndBindings`/unified plan+submit, with a required client `idempotency_key`, submit last, deterministic standing ids, dates single-sourced.
- **D3.** SUBSIDE run endpoints deprecated behind `SUBSIDE_LEGACY_RUNS` for one release.
- **D4.** Earthdata fields removed from the form; the owner secret is the source.
- **D5.** Publication via the EM `publish` flag.
- **D6 (user, 2026-11-05).** One standing problem statement per user per app label, permissions = the caller only. "one standing problem statement per user is fine."
- **D7 (user, 2026-11-05).** Pre-cutover Tapis Workflows runs are dropped from the SUBSIDE run list; their published products stay on the map through STAC. No legacy list. "dropping them is fine."
- 2026-11-05 (rev 3, architect + skeptic): services gain an optional `permissions` override (they hard-code `"*"` today); cancel maps from `failed` + `CANCELLED_BY_USER`; `GET /plans/runs` built on a new `listByThreads` store query with per-row reconciliation by the UI; region creation reuses region-import validation and uses hash-derived ids instead of a hash column; idempotency key required; dates single-sourced with `DATES_CONFLICT`; frame-id contradiction removed (blank); results bbox/dates sourced from region and thread; polling backoff; E2E split into asserted/stubbed/not-verifiable with an OPERA fixture loader as a deliverable; "no schema change" holds via deterministic ids.

- 2026-11-05 (implementation deviations, EM): the region is created before the
  standing problem statement because `problem_statement.region_id` is NOT NULL;
  the standing statement and the per-region task take the first run's region and
  dates. Parameters are bound by catalog parameter id with defaults filled from
  the catalog (422 `UNKNOWN_PARAMETER` for names neither the model nor the plan
  declares). The task carries the model's response variable; the thread's is left
  empty. The three services take an options object `{permissions, id, ifAbsent}`.
  `unifiedExecutionService.submit` now forwards `dry_run` on the composite path
  (it previously ignored it and would have started a real job) and leaves the
  record `planned`. `useModelParameterService` skips `parameter_type: "secret"`
  rows. `addProblemStatement`/`addTask`/`addThread` throw GraphQL errors instead
  of returning null. An unreadable explicit `problem_statement_id` → 403; an
  idempotency key already used by another user → 409 `IDEMPOTENCY_KEY_CONFLICT`.
  Run rows and the scenario response carry `region {id, name, bbox}` and
  `thread {start_date, end_date}`. Live check: the regions route's error
  responses needed JSON schemas in the OpenAPI JSDoc, or response validation
  turned every 401/422 into a 500.
- 2026-11-05 (implementation deviations, SUBSIDE): the UI had no test
  infrastructure, so Vitest + Testing Library were added; the form never showed
  Earthdata fields (the API used a service account), so D4 was already true; the
  results bbox falls back to a per-run cache and the live drawing when the run
  row has no region; `NUM_WORKERS` defaults to 4 (legacy parity) rather than the
  catalog's 2; the contract test depends on the catalog YAML's uncommitted
  `tapisEnvKey`/`hasSecret` declarations in the subside repo.

## User feedback / decisions

- 2026-11-05: "we want to use DYNAMO instead of the API to submit workflows"; "lets build it. don't deploy anything we'll have to test it locally". Test plan is local; nothing is deployed.
- 2026-11-05: Q1 → per-user standing problem statement; Q8 → drop pre-cutover runs. Spec approved; implementation started.
