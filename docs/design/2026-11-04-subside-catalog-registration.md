# SUBSIDE catalog registration: models, ETL pieces, and products

Status: Implemented on dev (2026-11-04: all PRs merged and deployed; OPERA + forecast registered; apps and pipelines re-registered by the owner; owner secret seeded; CKAN backfill done; 31 SUBSIDE data objects synced; engine canary healthy). Pending: the end-to-end H2I run from a DYNAMO thread.

## Objective

Make SUBSIDE a first-class, runnable model family in DYNAMO dev the same way
MODFLOW is today: the two OPERA DISP-S1 analyses (H2I, WERC) and the subsidence
forecast appear in the MINT model catalog wired to their Tapis apps, every ETL
piece SUBSIDE relies on is in the ETL catalog with usable contracts, SUBSIDE's
published displacement products are SVO-typed data objects the adapter planner
can consume, and a run submitted from a DYNAMO thread actually receives its
dates, AOI and Earthdata credential.

Non-goals: changing the SUBSIDE analysis code or its Tapis apps beyond the
WERC archive fix in deliverable 0; changing the planner's compatibility
algorithm; production (non-dev) catalog writes.

## User need

DYNAMO users should be able to pick "H2I Lab" or "WERC" under OPERA in a
thread, set the AOI and date range, run it on ls6, and have the result land in
CKAN and STAC and come back as a typed data object that later steps (the
forecast, the MODFLOW–subsidence bridge) can consume. Today only the MODFLOW
engines have that path; SUBSIDE is run from its own UI and its outputs are
invisible to the adapter.

## Current code/system summary

Verified against the dev stack and the code on 2026-11-04:

- **ETL catalog (dev Hasura `modelcatalog_etl_process`)**: 52 pieces, and the
  adapter's `adapter_transform_spec` mirrors all 52 one-to-one (MINT is the
  source of truth; `svo-adapter-service/app/mint_sync.py`). The nine
  SUBSIDE/forecast pieces are already there: `ts-subside-run-h2i`,
  `ts-subside-run-werc` (runtime `tapis_app`, app ids + version 0.1.1 + GHCR
  image), `ts-subside-h2i-publish`, `ts-subside-werc-publish`,
  `ts-subside-stac-publish`, `ts-adapter-format-convert`, `ts-subside-forecast`,
  `ts-head-m-to-ft-msl`, `ts-elevation-m-to-ft`. Import path:
  `svo-adapter-service/scripts/register_existing_etl_pieces.py`.
- **ETL contract gap**: `etl_process_contract` has no metadata column. The
  adapter's `catalog` compatibility dimension (what pulls `stac-publish` into a
  plan for a cataloged target) lives in contract metadata in the fixtures and
  does not round-trip through MINT. `mint_sync.etl_process_to_spec_row`
  (mint_sync.py:286-308) forwards `schema_requirement_json` untouched and sets
  `metadata_json` only to `{"mint_position": …}`; the planner reads
  `c.get("catalog") or metadata_json.get("catalog")` (planner.py:202-215).
  On dev the `ts-subside-stac-publish` output contract is empty. H2I's output
  has no unit; WERC's is `mm/yr`.
- **Model catalog (dev)**: MODFLOW 6/2000/96/USG/2005 configurations exist
  with `has_component_location = https://portals.tapis.io/v3/apps/<app>/<ver>`.
  No OPERA/SUBSIDE software; no `subside-forecast` (registered only locally by
  `modflow-executables/scripts/register_forecast_to_mint.py`). An older
  `wmobley-insar-deformation-processing-workflow` software exists: a generic
  InSAR description (DEM, orbit files, SAR scenes in; coherence, displacement
  time series, velocity out), no Tapis app, no parameters, zero threads.
- **SUBSIDE catalog YAML**:
  `subside/tapis/workflow_apps/opera-disp-s1.model-catalog.yaml` (597 lines)
  describes OPERA → DISP-S1 Analysis 0.1.1 → H2I Lab + WERC with full
  metadata. Written for the production REST API, never registered anywhere.
  Stale in four ways: no H2I displacement COG output, no SVO bindings,
  `tapis://portals/apps/…` component locations, image pinned to a pruned
  `sha-07c92cf` tag.
- **Tapis apps (portals)**: `subside-h2i-opera-analysis` 0.1.1 and
  `subside-werc-opera-analysis` 0.1.1 are public, owner wmobley, image
  `ghcr.io/wmobley/subside-*-opera-analysis:main`, `execSystemId: ls6` in the
  repo app.json. File inputs `aoi-geojson` and `earthdata-netrc` are both
  OPTIONAL. **Every user parameter is an `envVariables` entry** (`START_DATE`,
  `END_DATE`, `FRAME_IDS`, `NUM_WORKERS`, `MIN_OVERLAP_PERCENT`, WERC
  `REFERENCE_MODE/LAT/LON`, `ANCHOR_RADIUS_M`, `N_REFERENCE_PIXELS`, …);
  `appArgs` holds only FIXED entries. Envelope 240 min, 16 cores, 128 GB
  (H2I) / 32 GB (WERC).
- **Ensemble Manager composite path**
  (`mint-ensemble-manager/src/classes/tapis/adapters/TapisJobService.ts`):
  `createJobRequest` hardcodes `envVariables: []` (line 49), maps model
  parameters only onto non-FIXED `appArgs` by name (112-141), skips an
  OPTIONAL file input with no same-named model input (219-227) or with no
  bound dataset (238-246), and defaults `maxMinutes` to 60 (41). The adapter
  embeds the resulting `job_definition` verbatim in the model task's code
  (`app/tapis.py:575-588`), which is persisted in the Workflows pipeline
  definition. The adapter's `earthdata_netrc_uri` arg and `_file_inputs`
  (tapis.py:59, 800-809) apply only to ETL step tasks, not the model job.
  **Consequence: a SUBSIDE run submitted today would start with app-default
  dates, no AOI, no credential, and a 60-minute limit.**
- **Credential handling today**: SUBSIDE's API mints a per-run `.netrc` from
  `EARTHDATA_USERNAME/PASSWORD` in its pod env onto `cloud.data`
  (`api/services/manager.py::_stage`) with no deletion. The analysis code
  reads `EARTHDATA_USERNAME/PASSWORD` from the environment and writes its own
  `0600 ~/.netrc` on the compute node when they are present
  (`analysis/etl/auth.py:45-64`, `analysis/h2i_lab/download.py:31-52`).
  **H2I's app excludes `.netrc` from the archive and its run.sh traps cleanup;
  WERC's app has `excludes: []` and no trap** (werc/app-cpu.json:246,
  werc/run.sh:46-48). Exposure sizing: Tapis archives `execSystemOutputDir`
  (`${JobWorkingDir}/output`) plus launch files, and the netrc is staged to
  `${JobWorkingDir}`, so it was most likely never archived. What WERC runs
  leave behind is a `0600` copy at `$HOME/.netrc` on ls6 (owner-readable
  only) and the staged copy in the job working directory on scratch. Fix for
  consistency and defence in depth; rotation not required on this basis.
- **Products**: 26 SUBSIDE datasets in CKAN org `stac-datasets` (collection
  `subsidence-rates`) with COG, PNG, manifest and source NetCDF resources.
  None carry `mint_standard_variables`, so the adapter's `sync-from-ckan`
  (ckan_sync.py:207, 352) yields zero SUBSIDE data objects. The dev adapter's
  `SVO_ADAPTER_CKAN_SYNC_ORG` is empty. Resource fields are written by
  `stac-platform/stacmap/ckan.py` via `resource_patch` with a full field set
  (ckan.py:248, 275).
- **Units (code + original notebooks)**: H2I COG in metres
  (`h2i_lab/metadata.py` `UNIT = "m"`; the `OPERA Surface Displacement`
  notebook does the same). WERC cumulative displacement in millimetres,
  velocity in mm/year (`werc/export.py:86, 153`; the `OPERA DISP-S1` notebook
  multiplies by 1000 and labels maps "[mm]" / "[mm/year]").
- **Standard variables on dev**: `land_surface__displacement`,
  `land_surface__displacement_rate`, `land_surface__subsidence`,
  `land_surface__elevation`, `groundwater__hydraulic_head`,
  `aquifer__storativity` exist. Unit `mm` does not.

## Proposed design

Six deliverables, each its own PR and approval gate. Order matters.

### 0. WERC credential hygiene (immediate, independent of the rest)

- `werc/app-cpu.json`: `archiveFilter.excludes: [".netrc"]`, matching H2I.
- `werc/run.sh`: add H2I's `trap 'rm -f ".netrc" "${HOME}/.netrc"' EXIT HUP INT TERM`.
- Re-register the WERC app, confirm with `GET /v3/apps/subside-werc-opera-analysis/0.1.1`.
- As the app owner on ls6: remove any leftover `$HOME/.netrc` and check one
  recent WERC job archive for `.netrc` to confirm the exposure sizing above.
  Rotate the Earthdata password only if a copy is found outside owner-only
  locations.

### 1. Ensemble Manager: deliver parameters and the envelope to the job

In `TapisJobService.createJobRequest`:

- Build `parameterSet.envVariables` from the app's declared `envVariables`:
  for each non-FIXED entry whose `key` matches a model parameter name, emit
  `{key, value}` from the seed; skip entries whose resolved value is empty
  (so blank `FRAME_IDS` is not sent); leave entries with no matching model
  parameter to the app default. Existing MODFLOW apps declare no env
  variables, so behaviour there is unchanged.
- `maxMinutes`: use the caller's value if given, else
  `app.jobAttributes.maxMinutes`, else 60. Pass `memoryMB` through from the
  app when present.
- Tests in `jobs.test.ts`: a SUBSIDE-shaped app yields `START_DATE`/`END_DATE`
  in `envVariables`, blank values are dropped, FIXED env entries are never
  sent, MODFLOW fixtures are byte-identical to before.
- Adapter guard: `settings.model_task_max_exec_seconds` and the run token
  deadline must cover 240 min plus ls6 queue wait (observed 20 min–18 h);
  document the required dev values.

AOI delivery needs no code: the catalog registers `aoi-geojson` as an
optional input, and a thread binds a GeoJSON dataset to it; the EM already
maps bound datasets to `fileInputs`. Document in the user guide that an AOI
dataset must be selected, or the app falls back to `FRAME_IDS`.

### 2. Adapter: Earthdata credential as a run-time env injection (no file on Corral)

Replaces the rev-1 netrc-on-`cloud.data` design, which all three reviewers
rejected (no cleanup exists, file mode uncontrollable through Tapis Files,
WERC archived it).

- Settings `SVO_ADAPTER_EARTHDATA_USERNAME` / `SVO_ADAPTER_EARTHDATA_PASSWORD`
  as `SecretStr`, injected into the `mintdevsvo` pod from a Kubernetes/Tapis
  secret, never a literal in Helm values or git. A dedicated low-privilege
  Earthdata account, not a personal one. Rotation owner documented.
- New endpoint `GET /runs/{run_id}/credentials/earthdata`, authorised exactly
  like `/runs/{id}/signal` (the run's signal token, rate-limited, only while
  the run is active, provenance event `run.credential.issued` with no payload
  beyond the credential name). Returns `{username, password}` once per task
  attempt; 404 when the adapter has no credential configured.
- The model task (`_model_execution_code`) fetches it immediately before
  `POST /v3/jobs/submit` and appends `EARTHDATA_USERNAME` /
  `EARTHDATA_PASSWORD` to `job_definition.parameterSet.envVariables` **in
  memory**. The persisted pipeline definition, Hasura rows, provenance and
  logs never contain the values. It also strips any `earthdata-netrc` entry
  from `fileInputs` so a user-supplied file can never override the system
  credential. Only configurations whose app declares no `EARTHDATA_*` FIXED
  env entries are eligible; the task checks the app's env keys at submit.
- On the compute node `analysis/etl/auth.py` / `download.py` already turn the
  env vars into a `0600 ~/.netrc`, and both apps' run.sh (after deliverable 0)
  remove it on exit; archives exclude it.
- Redaction: extend `error_handling._SECRET_KEY` to `password`; add
  `earthdata` to `_public_workflow_args`' denylist; a regression test submits
  with a sentinel password and asserts it appears in no log line, Hasura row,
  provenance event or API response.
- **Residual exposure**: the Tapis job record (`parameterSet.envVariables`)
  is readable by the job owner, i.e. the submitting DYNAMO user. That is the
  same person who could read a staged netrc, and nobody else. Acceptable for
  dev. Follow-up dated 2026-12: Tapis Security Kernel secret injection, which
  would remove the value from the job record too.
- The catalog does **not** register `earthdata-netrc` as an input at all
  (skeptic finding 2: the EM would either skip it or demand a dataset).

### 3. Register the OPERA models (dev model catalog)

Script `modflow-executables/scripts/register_subside_to_mint.py`, a thin
loader for the catalog YAML. It reuses only the transport layer of
`register_to_mint.py` (`post`, `_put`, `reset_catalog`, `patch_*`,
`_legacy_payload`), not the MODFLOW `build_*` payload builders (the YAML is
already a nested REST document). The YAML stays the single source of truth
and is corrected in place:

- Add the H2I **displacement COG** output (`disp_displacement.tif`) as the
  **first** declared output, so the EM's default `output_name` resolves to it
  (TapisExecutionService.ts:214-233 takes `output_files[0]` when the thread
  does not name one). Likewise make WERC's cumulative displacement GeoTIFF
  first; velocity second.
- SVO bindings: H2I COG → `land_surface__displacement` [m]; WERC cumulative →
  `land_surface__displacement` [mm]; WERC velocity →
  `land_surface__displacement_rate` [mm/yr]. Register the `mm` unit row first
  (FK from variable_presentation). Register no netrc input (see 2).
- Component location `https://portals.tapis.io/v3/apps/<app>/0.1.1` and
  `tapis_app_id` / `tapis_app_version`; image tag `:main`.

Hierarchy (ids from the YAML, kept stable because `mint_sync` keys off them):

```
Software  opera  "OPERA"
└─ SoftwareVersion  opera-disp-s1-analysis  "OPERA DISP-S1 Analysis" 0.1.1
   ├─ ModelConfiguration  opera-disp-s1-h2i-lab  "H2I Lab — acquire + preview"
   │    app subside-h2i-opera-analysis 0.1.1
   │    inputs:  AOI GeoJSON (optional)
   │    params:  START_DATE, END_DATE, FRAME_IDS, NUM_WORKERS, MIN_OVERLAP_PERCENT,
   │             RESULTS_DIR, REQUIRE_PRODUCTS, PREVIEW_ONLY   (names = app env keys)
   │    outputs: 1 displacement COG -> land_surface__displacement [m]
   │             run manifest, cropped NetCDFs, preview HTML, overlay PNG, zip
   └─ ModelConfiguration  opera-disp-s1-werc  "WERC — referenced velocity"
        app subside-werc-opera-analysis 0.1.1
        params: H2I set + REFERENCE_MODE, REFERENCE_LAT, REFERENCE_LON,
                ANCHOR_RADIUS_M, N_REFERENCE_PIXELS, …
        outputs: 1 cumulative displacement GeoTIFF -> land_surface__displacement [mm]
                 2 velocity GeoTIFF -> land_surface__displacement_rate [mm/yr]
                 WERC manifest, reference anchor JSON, H2I artifacts
```

Parameter **names must equal the app env keys** so deliverable 1's mapping
finds them. The YAML's human labels stay as labels.

Hosted-API registration checklist (MODFLOW precedent, mandatory not optional):
`--legacy-api-schema` strips `tapis_app_id`/`tapis_app_version`
(register_to_mint.py:512-537) → patch them via Hasura after create; nested
creates top-down so FKs are set; `keywords`/`type` scalar; scalar
`has_standard_variable`/`uses_unit` columns patched via Hasura
(`patch_presentation_links`); `same_as` arrays via Hasura. `--dry-run`
snapshot test asserts the wire payload under the legacy flag loses
`tapis_app_id` so the patch step is covered. Live check before first run:
`GET /v3/apps/<id>/0.1.1` for `execSystemId`, queue and that the queue admits
128 GB.

The forecast is registered on dev by running `register_forecast_to_mint.py`
against the dev API. Deleting the old InSAR entry is a **separate approved
step after** the OPERA registration succeeds, not part of the script.

### 4. ETL contracts: make the `catalog` marker round-trip

- `register_existing_etl_pieces.py` writes the marker namespaced and merged,
  never replacing existing schema JSON:
  `schema_requirement_json = {**existing, "_svo": {"catalog": "ckan+stac"}}`.
- `mint_sync.etl_process_to_spec_row` lifts `_svo.catalog` into
  `metadata_json["catalog"]` and **removes** the `_svo` key from the
  `schema_requirement_json` it forwards, so `schema_json` comparisons see no
  stray key. Test: stripped schema reaches `schema_json`; `catalog` reaches
  metadata.
- Target side: a cataloged target must carry `catalog=ckan+stac` itself
  (`_check_catalog` is compatible when the target has none, planner.py:156-159);
  the adapter's `target_model_input_cataloged` variant is where it lives.
  State this in the fixture and the planner test.
- `_catalogs` normalises `ckan+stac:<org>` (qaqc.py:423 writes it) to tokens.
- Fixtures: H2I output unit `m`, WERC cumulative `mm`, explicit
  `ts-subside-stac-publish` output contract (format geotiff, catalog
  ckan+stac). Add two generic unit pieces `ts-displacement-m-to-mm` /
  `ts-displacement-mm-to-m` so a consumer wanting one unit can plan from the
  other (H2I and WERC share one standard variable with different units).
- Planner test built from **MINT-shaped rows** (not fixtures): a cataloged
  H2I target plans `[run-h2i, stac-publish]`.
- Record a dated follow-up: a real `catalog` column on
  `etl_process_contract`, or this becomes the documented permanent convention.

### 5. Type the SUBSIDE products so they become data objects

- `stacmap.ckan.upload_resource` / `link_resource`: optional
  `standard_variables: list[str]` written as the CKAN resource field
  `mint_standard_variables` (comma-joined, as `ntgam_publish.py` does).
  `stacmap.publish` takes a **role → variable mapping from the run manifest**
  (`displacement_cog` → `land_surface__displacement`, `velocity_geotiff` →
  `land_surface__displacement_rate`); stac-platform hardcodes no SVO names.
- Pipelines (`h2i-opera.yaml`, `werc-opera.yaml`, `subside-publish.yaml`)
  pass the mapping through the stac-publish task from the manifest; rebuild
  the stac-platform image and re-register the three pipelines.
- `ckan_sync.py` `STDVAR_TO_SVO` (line ~30) has `land_surface__subsidence_rate`
  but **neither** `land_surface__displacement` nor
  `land_surface__displacement_rate`; add both (w3id namespace) or every SUBSIDE
  resource is skipped with a warning at line ~235. Verified 2026-11-04: the
  CKAN scheming schema for dataset type `dataset` already defines
  `mint_standard_variables` as a resource field, so the backfill will persist.
- Role source: every SUBSIDE resource already carries `subside_asset_role`,
  `subside_asset_key` and `subside_pipeline` as resource fields (verified on a
  live dataset), so the backfill and stacmap type by `subside_asset_role`
  without parsing the manifest JSON.
- **Backfill** of the 26 datasets, `stac-platform/scripts/backfill_svo_fields.py`:
  JSON `resource_patch` with the minimal payload `{id, mint_standard_variables}`
  (never the multipart full-field path, which can reset `url_type`); role
  taken from the resource's own `subside_asset_role` field, not the filename
  (velocity vs cumulative are both `.tif`); full pre-image of every touched
  resource in the rollback manifest; one-dataset canary with read-back diff
  of `url`, `url_type`, `format`, `size`, `stac_item_id` before the rest;
  dry-run default; runs under the ckan-publisher gate with explicit approval.
- Dev adapter: set `SVO_ADAPTER_CKAN_SYNC_ORG=stac-datasets`, run
  `POST /admin/sync-from-ckan` once; the stac-publish task then calls the
  same endpoint best-effort after each publish so new products appear without
  waiting for the next sync. State the latency in the user guide.

### 6. Verify end to end on dev

Before the live run: `canary.py` plus `diagnose_stalls.py` to confirm the
Workflows engine is launching (it wedges runs at random; a stall is not a spec
failure). Then a DYNAMO thread with `opera-disp-s1-h2i-lab`, an AOI dataset
bound, a short date window; confirm the generated job request carries
`START_DATE`/`END_DATE`, the AOI file input, 240 min, and that the adapter
plan for the cataloged target is `[model → publish → stac-publish]`; dry-run
submit; one live run with the user's token; confirm CKAN dataset, STAC item,
and that the new COG becomes a `land_surface__displacement` data object.

## Files likely affected

- 0: `subside/tapis/workflow_apps/werc/app-cpu.json`, `werc/run.sh`
- 1: `monorepo/mint-ensemble-manager/src/classes/tapis/adapters/TapisJobService.ts`,
  `TapisExecutionService.ts` (maxMinutes fallback), `__tests__/jobs.test.ts`
- 2: `monorepo/svo-adapter-service/app/config.py`, `app/main.py` (credential
  endpoint), `app/tapis.py` (`_model_execution_code`), `app/error_handling.py`,
  tests; `mintdevsvo` pod secret; `charts/mint` values for the secret ref
- 3: `subside/tapis/workflow_apps/opera-disp-s1.model-catalog.yaml`;
  `modflow-executables/scripts/register_subside_to_mint.py` (new) and its test
- 4: `monorepo/svo-adapter-service/scripts/register_existing_etl_pieces.py`,
  `app/mint_sync.py`, `app/planner.py` (`_catalogs`), `examples/subside_*_transforms.json`,
  `tests/test_mint_etl_sync.py`, planner test
- 5: `stac-platform/stacmap/ckan.py`, `stacmap/publish.py`, tests,
  `stac-platform/scripts/backfill_svo_fields.py` (new);
  `subside/tapis/workflows/pipelines/{h2i-opera,werc-opera,subside-publish}.yaml`
- Docs: DSO-Architecture `docs/services/svo-adapter.md` (credential endpoint,
  sync org), `docs/services/stac-api.md` or stac-platform page (resource
  field), `docs/services/mint-platform.md` (env-var parameter mapping);
  `monorepo/ui-react/docs/docs/data-scientist/make-model.md` (SUBSIDE example,
  AOI dataset requirement)

## API/schema changes

- Adapter: new `GET /runs/{run_id}/credentials/earthdata` (signal-token auth).
- EM: job requests gain `envVariables` for apps that declare them; no API change.
- CKAN: optional resource field `mint_standard_variables` on SUBSIDE resources.
- stacmap: optional `standard_variables` argument on two `CkanClient` methods.
- MINT: one new unit row (`mm`); no table changes.

## Data flow

```
DYNAMO thread (opera-disp-s1-h2i-lab, AOI dataset, dates)
  → EM createJobRequest: envVariables from parameters, AOI fileInput, 240 min
  → svo-adapter /workflows/submit (job_definition embedded in model task)
  → Workflows model task: GET credentials (signal token) → add EARTHDATA_* env
    → POST /v3/jobs/submit → poll → output_uri = …/disp_displacement.tif
  → publish (manifest) → stac-publish (stacmap: CKAN resource with
    mint_standard_variables, STAC item) → best-effort adapter sync-from-ckan
  → adapter_data_object typed land_surface__displacement [m]
  → planner source for the forecast bridge / MODFLOW comparison
```

## Risks and tradeoffs

- **Credential in the job record.** The submitting user can read the shared
  Earthdata password from their own Tapis job definition. Equivalent to the
  netrc exposure SUBSIDE already has, with nobody else exposed. Dev-only;
  SK secret injection is the dated follow-up and a hard requirement for
  production.
- **EM change touches every model.** The env-variable mapping is additive and
  gated on the app declaring env variables; MODFLOW fixtures must stay
  byte-identical in tests.
- **Hosted catalog write path.** Never exercised for a parameter-heavy tree;
  the Hasura patch checklist above is where it has failed before.
- **Catalog marker in a shared JSON column.** Namespaced and merged, stripped
  on sync; still a convention rather than a column until MINT adds one.
- **Backfill on 26 public datasets.** Minimal-payload JSON patch, canary,
  full pre-images. The STAC bridge reconcile may re-read touched datasets
  (metadata_modified changes); harmless but noisy.
- **Planner fit.** A SUBSIDE run is parameter-driven; the planner cannot start
  one from a data object. Only the output side joins the planner graph.
- **Multi-asset output.** The composite handoff is one URI; it is the first
  declared output (the COG). PNG/NetCDF/manifest reach CKAN via publish, not
  via the handoff.

## Alternatives considered

- **Per-run `.netrc` on `cloud.data`** (rev 1). Rejected: no cleanup path
  exists in the adapter, Tapis Files cannot set file mode, WERC archived it.
- **Register models through the DYNAMO UI** by pasting `app.json`. Not
  reproducible; SVO typing still needs a script. Fine for a one-off check.
- **Adapter injects env vars instead of the EM.** The adapter never sees
  parameter values, only the job definition; the EM owns the descriptor per
  the composite design.
- **stac-publish registers the data object directly with the adapter.** Adds
  a stac-platform → adapter auth edge and a second write path; the 26
  existing datasets would still need the CKAN field.
- **Real `catalog` column on `etl_process_contract`.** Cleaner; needs a
  Hasura migration in MINT; deferred with a date.

## Test plan

- 0: `GET` the live WERC app shows the exclude; a canary WERC job archive has
  no `.netrc`.
- 1: `jobs.test.ts` cases listed in deliverable 1.
- 2: sentinel-password leak test across logs, Hasura rows, provenance, API
  responses; credential endpoint rejects a wrong or expired signal token;
  `fileInputs` loses any `earthdata-netrc` entry.
- 3: dry-run snapshot of payloads; wire payload under legacy flag loses
  `tapis_app_id`; after apply, Hasura shows both configs with `tapis_app_id`,
  component location, three typed outputs, `mm` unit.
- 4: mint_sync round-trip test; planner test from MINT-shaped rows.
- 5: stacmap payload tests; backfill dry-run lists exactly the TIFF resources
  with the right variable per role; canary read-back diff clean.
- 6: the end-to-end run in deliverable 6.

## Documentation plan

Pages listed under Files likely affected. The user guide gains a SUBSIDE
example that states the AOI dataset requirement and the publish-to-visible
latency.

## Rollout/rollback plan

Dev only. 0 is a straight app re-register (previous version stays). 1 and 2
ship behind the existing dev deploy; 2 is inert until the pod secret is set.
3: `--reset` removes the OPERA rows. 4: re-import is an upsert on stable ids.
5: apply the rollback manifest's pre-images; unset `SVO_ADAPTER_CKAN_SYNC_ORG`;
synced data objects deletable by resource id.

## Open questions

None open. (Queue question resolved 2026-11-04 by reading the live apps:
both SUBSIDE apps declare `execSystemId=ls6`, `execSystemLogicalQueue=vm-small`,
240 min, 128000 MB (H2I) / 32000 MB (WERC), and the existing 26 products came
from exactly those settings, so the EM needs no queue override.)

## Decisions

- 2026-11-04: ETL pieces are already in the dev ETL catalog; the work there is
  contract completeness, not registration.
- 2026-11-04: Models are registered by script (reproducible), not via the UI.
- 2026-11-04: The existing `opera-disp-s1.model-catalog.yaml` is the metadata
  source; the script loads it and reuses only the MODFLOW transport helpers.
- 2026-11-04: Output units from code and notebooks: H2I COG metres; WERC
  cumulative millimetres, velocity mm/year. `mm` unit row added.
- 2026-11-04 (rev 2): Earthdata credential delivered as run-time job env
  variables fetched by the model task from the adapter under the signal
  token; no netrc file on Corral; no catalog input for it. SK secret is the
  dated production follow-up (2026-12).
- 2026-11-04 (rev 2): EM gains env-variable parameter mapping and app-based
  `maxMinutes`; without it SUBSIDE runs start with default dates and a
  60-minute limit.
- 2026-11-04 (rev 2): Work split into six separately gated deliverables; WERC
  archive fix first; InSAR delete separate.
- 2026-11-04 (rev 2): Catalog marker namespaced `_svo.catalog`, merged not
  replaced, lifted and stripped on sync; target-side marker required.
- 2026-11-04 (rev 2): Backfill uses minimal JSON patch, manifest-role-based
  typing, full pre-images, one-dataset canary.

- 2026-11-04 (deliverable 3 implemented, dry-run + 9 tests green; live run
  pending): parameter matching uses the catalog parameter `label` because the
  EM maps `name: p.label || p.id` (graphql_adapter.ts), so parameter labels
  are the env keys (START_DATE, …) and the human label moved into the
  description. `AOI_GEOJSON_PATH` is not a parameter (fed by the aoi-geojson
  file input). Deviation from "nested create top-down": the hierarchy and
  parameters nest in one `models` POST, but dataset specs and presentations
  are created separately and linked with junction PUTs, as the MODFLOW script
  does, to avoid the API's I/O junction bug. Not registered in this pass:
  regions, constraints, parameter units, dataset-spec dimensionality.
  Hasura patches run even under `--legacy-api-schema` (the legacy mapper
  strips `tapis_app_*`); verified on dev that `tapis_app_id`,
  `tapis_app_version`, `has_component_location`, `has_software_image` are
  plain `String` columns and `same_as` is `_text`. `--reset` deletes by exact
  YAML-derived ids. PyYAML is an undeclared prerequisite of the script (present
  in the system python3). The H2I usage note about netrc was reworded to
  "credentials are platform-provided".

- 2026-11-04 (deliverable 4 implemented on branch
  `feat/svo-adapter-etl-catalog-marker`, 17 targeted tests green): the
  `catalog` marker lives on the `stac-publish` output contract (`c-stac-out`)
  on the piece side and as top-level `catalog` on `target_model_input_cataloged`
  in the fixtures; written to MINT as `schema_requirement_json._svo.catalog`,
  lifted and stripped on sync. Deviation: NO `format: geotiff` on the
  stac-publish output (the planner's `_apply_transform` would overwrite the
  product format and make the H2I cataloged target unreachable); the contract
  stays `{role: output, catalog: ckan+stac}`. WERC fixture has a single rate
  output (`mm/yr`); a cumulative-displacement output is not modelled there.
  m↔mm factors added to `task_code._FACTORS`; new fixture
  `subside_units_transforms.json` (55 pieces total). `ckan_sync.STDVAR_TO_SVO`
  gained `land_surface__displacement` and `land_surface__displacement_rate`.
  Decision: `_svo` in `schema_requirement_json` is the documented convention
  until MINT adds a column; revisit 2026-12.
- 2026-11-04 (deliverable 2 implemented on branch
  `feat/svo-adapter-earthdata-credential`, 18 tests green): endpoint order is
  404-if-unconfigured → 503-if-signals-unconfigured → signal token (401) →
  rate limit (429, shared bucket with `/signal`) → run active + armed (409);
  response carries `Cache-Control: no-store`; provenance payload
  `{"credential": "earthdata", "task_id": "model"}`. Task code strips
  `earthdata-netrc` file inputs and injects env vars into a deep copy used
  only for the submit call, retrying the credential GET 3× on 5xx/429.
  Deviations: no per-app check for FIXED `EARTHDATA_*` env entries (the job
  definition carries no app definition; enforce at registration instead) and
  "once per task attempt" is not enforced beyond the shared rate limit.
  `error_handling._SECRET_KEY` already redacted `password`.

- 2026-11-04 (deliverable 1 implemented on branch `feat/em-env-var-parameters`,
  39 adapter tests + tsc green): `getEnvVariables` added; `maxMinutes` =
  caller → app → 60, and the hardcoded `maxMinutes = 60` defaults in
  `TapisExecutionService.submitExecutions` / `buildCompositeWorkflowModelTask`
  were removed (they would have masked the app value on every path);
  `memoryMB` passed through from the app. Effect on MODFLOW verified against
  the live apps: all five declare maxMinutes 60 and memoryMB 1000, so their
  effective limits are unchanged (the request now states memoryMB explicitly).

- 2026-11-04 (deliverable 5 implemented on stac-platform branch
  `feat/svo-typing-of-resources`, 61 tests green; pipeline YAMLs edited in
  subside): correction to the spec — `subside_asset_role` is `data` for the
  H2I COG and both WERC GeoTIFFs alike, so the mapping keys on
  `subside_asset_key` (`cog`, `cumulative`, `velocity`; equal to
  `CogSpec.key`), not the role. Defaults live in the pipelines (H2I
  `{cog: [land_surface__displacement]}`, WERC `{cumulative:
  [land_surface__displacement], velocity: [land_surface__displacement_rate]}`,
  subside-publish all three); stacmap itself hardcodes nothing. The pipelines
  use their own in-YAML CKAN client, so the field travels via `resource_meta`
  rather than `publish_from_dir(role_variables=…)`. Backfill dry-run (live,
  read-only): 31 resources to set across 25 datasets (17 cog, 7 cumulative,
  7 velocity), 0 already present; the 26th dataset is the legacy
  collection-level `subsidence-rates` with no `stac_collection` extra and
  inconsistent keys, excluded by the filter (type it later with `--canary
  subsidence-rates` if wanted). Rollback clears the field with "" (CKAN has no
  unset).

- 2026-11-04 (docs): DSO-Architecture `docs/services/svo-adapter.md`,
  `docs/dev/environment-variables.md`, `docs/services/mint-platform.md`
  updated and committed locally (54f9226, not pushed: they describe unmerged
  behaviour). Adapter README updated on both adapter branches (same file,
  different sections; expect a trivial merge). `register_subside_to_mint.py`
  usage lives in its docstring; no DSO page documents the MODFLOW
  registration script either, so none was added. Deferred until the model is
  live on dev: the DYNAMO user-guide SUBSIDE example (AOI dataset
  requirement, publish-to-visible latency) and the dev values for
  `model_task_max_exec_seconds` (default 48 h) / keeper deadline (72 h), both
  already above 240 min plus queue wait.

- 2026-11-04 (QA/QC pass, no blockers; four should-fix items applied):
  (S1) both apps' run.sh now install the netrc cleanup trap unconditionally,
  sparing a pre-existing `$HOME/.netrc`, because the analysis writes its own
  netrc from the env vars; both app-cpu.json declare `EARTHDATA_USERNAME` /
  `EARTHDATA_PASSWORD` as INCLUDE_ON_DEMAND env inputs (branch
  `fix/werc-netrc-archive-exclude`). (S4) the credential URL is issued only
  when the job's `appId` is in `SVO_ADAPTER_EARTHDATA_APP_IDS` (default: the
  two SUBSIDE apps); MODFLOW runs never receive it; the task dies with
  `EARTHDATA_CREDENTIAL_UNAVAILABLE` if a credential is expected but no
  signal token was issued. (S2) the registration script sets
  `software_version.software_id` and `configuration.software_version_id`
  explicitly via Hasura after the nested POST. (S3) min/max accepted values
  are sent as scalars under `--legacy-api-schema` (`has_accepted_values`
  stays an array; column types verified on dev). Nits applied: pipeline
  `svo_role_variables` type guard; backfill tolerates CKAN `size` int/str
  flips and rolls back only resources still holding this run's value. Not
  applied (accepted): prettier reflow noise in the EM test file; the dead
  `earthdata` denylist entry; `maxMinutes` 0 passthrough (unreachable via
  the API). Still only testable live: Tapis accepting the injected env vars
  (now declared on the apps), the hosted REST mapper's handling of the nested
  create, Hasura patch mutations.

- 2026-11-04 (credential design superseded): the user chose an adapter-held
  secrets store with user and model-owner scopes over the pod-env credential
  (see `2026-11-04-svo-adapter-secrets-store.md`). Deliverable 2's injection
  path and signal-token-authorised credentials endpoint stay as the
  mechanism; the Earthdata-specific route, the `SVO_ADAPTER_EARTHDATA_*`
  settings and the app allow-list are replaced by that spec before deploy.
  Consequence for the gate list: "set two pod secrets on mintdevsvo" is
  dropped; the SUBSIDE admin Earthdata login becomes a `model_owner` secret.

- 2026-11-04 (from the secrets-store spec, rev 2): deliverable 3 gains two
  follow-ups before the live registration — set `owner_username` (the
  SUBSIDE admin) on both OPERA configurations, and declare one
  `parameter_type = "secret"` parameter `earthdata` per configuration with
  `has_accepted_values = ["username=EARTHDATA_USERNAME",
  "password=EARTHDATA_PASSWORD"]`. The `EARTHDATA_*` env inputs declared on
  the apps in deliverable 0 are what that map targets.

- 2026-11-04 (live on dev, approved as gate step 3): OPERA registered on the
  dev catalog (`register_subside_to_mint.py --legacy-api-schema
  --owner-username wmobley` as the service account; owner patched to
  wmobley). Read-back: software→version→2 configurations with both FKs set,
  app bindings and component locations, 3 typed outputs with units, one
  `earthdata` secret parameter per configuration (no default), `same_as` set.
  Two hosted-mapper fixes were needed and are on the PR branch: text[]
  columns (`has_accepted_values`) must be Postgres array literals, not JSON
  lists ("A string is expected for type: _text"), and the same for `same_as`
  in the forecast script, which also gained `--legacy-api-schema`. The
  forecast (`subside-forecast`) is registered and its 5 presentations are
  linked; dev lacked a canonical `land_surface__elevation` standard-variable
  row (only UUID/upper-case variants), so the canonical w3id row was created
  with `same_as` to the SVO IRI, matching the adapter's CKAN sync map. Units
  `mm`, `mm/yr`, `ft`, `ft/yr` now exist on dev. Not done: deleting the old
  InSAR entry (the agent session was denied the deletion; dry-run-by-default
  script saved for the user). All ten PRs opened (gate step 1).

- 2026-11-04 (live): CKAN backfill applied by the user (31 TIFF resources typed; legacy
  `subsidence-rates` dataset untouched); adapter sync-from-ckan for org
  `stac-datasets` upserted 31 data objects (`land_surface__displacement`,
  `land_surface__displacement_rate`). Pipelines: the service account could
  only PATCH params (`svo_role_variables` live on all three); the task-code
  changes need the owner's `--recreate-pipelines` (delete + create; drops the
  Workflows run history under those ids).

## User feedback / decisions

- 2026-11-04: User confirmed the latest DYNAMO MODFLOW runs worked and named
  "register all the pieces for SUBSIDE including the ETL pieces" as the next
  step.
- 2026-11-04: User answers to the first review: (1) the Earthdata credential
  must be stored somewhere the system can access, not omitted (later refined:
  per-user / per-model-owner store, not a platform-wide pod secret); (2) take the
  units from the original SUBSIDE notebooks; (3) unsure what the InSAR entry
  is; (4) register the forecast on dev too; (5) `stac-datasets` is the org to
  sync.
- 2026-11-04: User approved rev 2; confirmed deleting the old InSAR entry
  after OPERA lands; Earthdata account for the adapter = the SUBSIDE project
  admin account (the one the SUBSIDE API pod already uses), rotation owned by
  the SUBSIDE admin. (User's answer was "admin?" — interpretation recorded
  here; correct if wrong.)
- 2026-11-04: Reviews: architect "revise, direction sound"; skeptic "revise:
  a run would start without dates, AOI or credential"; security "not
  acceptable as written" (netrc cleanup nonexistent, WERC archives the
  credential). All folded into rev 2.
