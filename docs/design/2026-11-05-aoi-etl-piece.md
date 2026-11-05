# Input-side ETL in the model bridge, starting with area-of-interest files

Status: Implemented (rev 3, 2026-11-05) — code committed on local branches; push, deploy, dev registration and the live Waco run still pending approval

## Objective

Let a DYNAMO composite run (the "model bridge") run ETL pieces before the
model, in the same Tapis Workflows pipeline, and hand their output files to
the model job's file inputs. First use: a generic piece that turns an area
DYNAMO already knows (the thread region, a bounding box, a county/GCD/GMA
boundary) into the area-of-interest (AOI) GeoJSON a model expects. No model
app changes; nothing pre-published.

Non-goals: changing the SUBSIDE apps; raster AOIs or masks; a UI for choosing
input ETL by hand (the Ensemble Manager derives it; a UI can come later).

## User need

The first Waco test (2026-11-05) failed in seconds: the OPERA apps read
`config/aoi.geojson` whenever `AOI_GEOJSON_PATH` is set, and the DYNAMO run
supplied only frame ids. SUBSIDE's UI always stages an AOI file. Running
without an AOI would also process whole OPERA frames (about 200 by 200 km)
instead of the 40 by 30 km Waco box. User direction: keep the apps as they
are, solve file-structure mismatches with generalizable ETL, and do it
properly in the bridge rather than with a pre-publish workaround.

## Current code/system summary

- Bridge pipeline: `svo-adapter-service/app/tapis.py generate_tapis_workflow`
  emits the model function task first (`_model_execution_code`, which submits
  `job_definition` to Tapis Jobs), then each plan step as a task chained on
  the model's `result` output. There is no task ahead of the model.
- Secrets: delivered only on this composite path (credentials endpoint,
  `_submit_definition`).
- Ensemble Manager: `createPlan` accepts `post_model_adapter` (composite) or
  `adapter_steps` (separate before-model adapter workflows, non-composite) and
  rejects both together (`MIXED_ADAPTER_STAGES_UNSUPPORTED`). File inputs come
  only from bound catalog datasets (`TapisJobService.createJobFileInputsFromSeed`),
  and an optional input with no binding is skipped.
- Boundary ETL pieces exist (`examples/gma_dfc_transforms.json`): ArcGIS layer
  or zipped shapefile to GeoJSON polygon, one per boundary variable.
- The H2I and WERC "AOI GeoJSON" inputs declare no standard variable.
- SUBSIDE's own staging precedent (`subside/api/services/manager.py _stage`)
  writes per-run inputs to `tapis://cloud.data/home/<user>/...`.

## Proposed design

### 1. Standard variable

`area_of_interest__boundary` (w3id catalog id, `same_as` the SVO-style IRI):
"the polygon a model restricts its work to", GeoJSON, polygon, EPSG:4326.

### 2. Generic ETL piece `ts-aoi-from-boundary`

A `tapis_function` piece. Input: a polygon source, given as an inline GeoJSON
geometry, a `minx miny maxx maxy` box, or (by chaining) the output of an
existing boundary piece. Output: `area_of_interest__boundary`, one
`FeatureCollection` with one (Multi)Polygon feature in EPSG:4326, returned as
the task's `result` (the GeoJSON text itself, not a file). Optional
parameters `buffer_m` (0), `simplify_m` (0), `dissolve` (true), `bbox_only`
(false). Buffer, simplify and dissolve need shapely/pyproj, which function
tasks do not ship: the task code pip-installs them at start (the same
pattern the SUBSIDE forecast task uses); with all parameters at default it
runs on the stdlib only. Invalid geometry is repaired (`make_valid`);
non-polygons are rejected. **Area cap:** the piece hard-fails when the AOI's
bounding box exceeds `max_area_km2` (default 160 000, about 400 by 400 km)
with "region too large; bind an AOI dataset or choose a smaller region"; it
never silently degrades to a bounding box.

### 3. Staging a produced input in the submitter's `$SCRATCH`

Input tasks stay pure ETL: each chain's last task returns the produced file's
content (for the AOI, the GeoJSON text) as `result`. The model task, which
already holds the run token and runs immediately before the job submit,
writes each produced input to
`/scratch/<group>/<user>/dynamo-runs/<execution_id>/inputs/<name>.<ext>` on
the job's execution system through the Tapis Files API (mkdir + insert,
overwrite, so a retry writes identical bytes), then sets the job's file input
`{name: <app input>, sourceUrl: tapis://<execSystemId>/<that path>}`. Tapis
stages it to the app's declared `targetPath` (`config/aoi.geojson` for OPERA,
where SUBSIDE stages it).

`$SCRATCH` cannot be expanded by the Files API, so the adapter resolves the
submitter's scratch root at submit time: the `execSystemExecDir` of the
submitter's most recent job on that execution system (ls6's
`jobWorkingDir` is `HOST_EVAL($SCRATCH)/tapis/${JobUUID}`, root `/`), read
with the run token and cached per user and system. With no such job the
submit fails with 422 `INPUT_STAGING_UNRESOLVED` ("run any job on <system>
once, or bind a dataset to <input>"). The resolved directory is passed to the
model task as the `input_staging_dir` arg; the content's sha256 and the URI
are recorded in the run's provenance. ls6 purges scratch automatically; the
file only has to survive until staging. No cloud.data, no adapter-served
content.

### 4. Input-side tasks in the bridge (adapter)

- `model_task.input_steps: [{name, app_input_name, steps[], source, params}]`
  is request-local, like the rest of `model_task`.
- A new helper `_input_stage_tasks` emits each chain before the model task,
  with task ids namespaced `in<k>-step-<n>-<type>` and pipeline args
  namespaced `in<k>_<param>`; it never touches `prev_id`, so the first
  post-model step still reads the model result. Input tasks bind
  `TAPIS_TOKEN` from `args.tapis_token` and are excluded from the
  model-token rewrite (otherwise the DAG has a cycle); they get no
  `CREDENTIALS_URL`, `SIGNAL_*` or `TOKEN_FETCH_*` args; they have explicit
  `execution_profile` limits and are deterministic, so a retry yields the
  same bytes.
- The model task gains `INPUT_<k>` inputs bound to each chain's last
  `result`, `depends_on` those tasks, and in `_submit_definition` drops any
  existing `fileInputs` entry with that app input name before adding the
  produced one. If a bound dataset already supplied that name, the submit is
  rejected (`INPUT_CONFLICT`); bound data is never overridden.
- `_validate_plan_args` and `_composite_task_contains_secret` learn the
  namespaced input args. With `input_steps` empty the generated pipeline is
  byte-identical to today (golden test over a MODFLOW composite plan).
- New `POST /plans/input`: plans a chain from a pseudo-source contract
  (`{kind: region|bbox|geojson}` to `area_of_interest__boundary`) and returns
  the steps without writing a deferred plan row.

### 5. Ensemble Manager

- Derivation happens at `createPlan`, so the plan hash covers it and the user
  can see the AOI before running. Rule: after `createJobRequest`, an app file
  input that the job definition does not already fill, whose model input is
  typed `area_of_interest__boundary`, gets an input step sourced from the
  thread region's geometries (unioned; byte budget 32 KB, else simplified;
  recorded as `derivation: {method, vertices_in, bytes}`). v1 derives only
  when exactly one such input exists.
- Submit forwards `input_steps`; the submit idempotency key includes their
  hash.
- `createPlan` allows input steps together with `post_model_adapter`; a model
  with input steps but no post-model ETL uses an empty post-model plan.
  Separate-workflow `adapter_steps` plus `post_model_adapter` stays rejected.

### 6. Catalog

Type the H2I and WERC "AOI GeoJSON" inputs `area_of_interest__boundary`
(YAML + registration script); register `ts-aoi-from-boundary` in the ETL
catalog. The apps do not change.

### 7. Precedence with FRAME_IDS

The OPERA preflight uses `FRAME_IDS` for frame selection when set, and the
AOI for the bounding box and crop. Both are sent; this matches how SUBSIDE
runs with explicit frames.

## Files likely affected

- adapter: `app/task_code.py` (aoi function), `app/tapis.py` (input-side
  tasks, model fileInputs), `app/main.py` (accept `input_steps` on composite
  submit; validate), `examples/aoi_transforms.json`, tests
- Ensemble Manager: `TapisExecutionService.buildCompositeWorkflowModelTask`,
  `unifiedExecutionService.createPlan` / submit body, tests
- catalog: `opera-disp-s1.model-catalog.yaml`, `register_subside_to_mint.py`
- docs: DSO svo-adapter and mint-platform pages, DYNAMO guide (AOI inputs)

## Data flow

```
thread (region = Waco) → EM: AOI input unbound + typed area_of_interest__boundary
  → input step: source = region geometry → adapter plans [aoi-from-boundary]
  → pipeline: aoi task (returns the GeoJSON as its result)
              → model task (writes $SCRATCH/dynamo-runs/<exec>/inputs/aoi-geojson.geojson via
                Tapis Files, adds fileInputs aoi-geojson=tapis://ls6/scratch/..., fetches
                Earthdata, submits job)
              → post-model steps (unchanged)
  → Tapis stages config/aoi.geojson; app runs as under the SUBSIDE UI
```

## Risks and tradeoffs

- Large region geometries inline in a plan: bounded by switching to the
  bounding box above a vertex threshold; documented.
- Produced input files accumulate on cloud.data per run; same as SUBSIDE's
  staging today. Cleanup is a follow-up.
- A wrong derivation (e.g. a thread region that is all of Texas) silently
  enlarges the run; the plan records the AOI and the UI should show it.
- More tasks before the model means more engine round-trips; each is a small
  function task.

## Alternatives considered

- Change the apps to accept a bounding box (rejected by the user: apps stay).
- Pre-publish AOIs to CKAN and bind them (rejected: a workaround, not the
  mechanism).
- Separate before-model adapter workflow (exists, but loses the composite
  path and its secret delivery).

## Test plan

- Unit: aoi function for box, polygon, multipolygon (dissolve), buffer,
  simplify; rejects non-polygons. Generator: input tasks precede the model
  task, model depends on them, `INPUT_<n>` wired, `fileInputs` replaced not
  duplicated. EM: derivation when unbound + typed; bound dataset wins; no
  derivation for untyped inputs; MODFLOW plans unchanged.
- Spike (done 2026-11-05, passed): file written to the user's `$SCRATCH`
  with the user's token and staged by Tapis to the app's `targetPath`.
- Live: Waco H2I and WERC through DYNAMO (job stages `config/aoi.geojson`,
  runs, output registered). Then one SUBSIDE UI run with the unchanged apps.

## Open questions

None for v1.

## Decisions

- 2026-11-05: Do not change the apps; handle file-structure mismatches with
  generalizable ETL. App change drafted on `fix/apps-aoi-bbox` discarded
  uncommitted.
- 2026-11-05 (rev 3a): User chose `$SCRATCH` staging ("can we use $SCRATCH
  for staging?" … "ok do it"): produced inputs are written by the model task
  to the submitter's ls6 scratch, resolved from their job history; replaces
  the adapter-served HTTPS URL idea.
- 2026-11-05 (rev 3): No cloud.data or other shared storage (user: "we
  shouldn't be using cloud.data"); produced inputs are served by the adapter
  at a per-run signed HTTPS URL that Tapis stages from. Reviews folded in:
  input tasks outside the model-token rewrite, namespaced ids/args, area cap
  with hard fail, bound data never overridden, derivation at createPlan with
  an idempotency hash, `/plans/input` instead of `/plans/deferred`, pip-
  installed geo libraries only when needed.
- 2026-11-05 (rev 2): No pre-publish phase; build input-side ETL into the
  bridge directly. The EM derives AOI input steps from the thread region.

- 2026-11-05 (spike, live, user's token): a Tapis Files multipart insert to
  `ls6:/scratch/06659/wmobley/dynamo-runs/spike-20261105/inputs/aoi.geojson`
  succeeded and created the missing parent directories (a bare mkdir POST with
  no body returns 400 "Entity is empty", so none is used); an H2I job with
  `fileInputs [{name: aoi-geojson, sourceUrl: tapis://ls6/scratch/...}]` (no
  targetPath) was resolved to `config/aoi.geojson` and the file was present in
  the job's `config/` before QUEUED; the job was then cancelled. The scratch
  root comes from the job's `execSystemExecDir` (`/scratch/06659/wmobley/tapis/
  <uuid>`), ls6 `jobWorkingDir` `HOST_EVAL($SCRATCH)/tapis/${JobUUID}`, root `/`.
- 2026-11-05 (implementation): EM, adapter and catalog branches built in
  parallel; contract aligned on `/plans/input` {source_kind,
  target_standard_variable_uri, app_input_name} → {steps, parameters} and
  `input_steps[] {name, app_input_name, steps, source:{kind:geojson,geometry}|
  {kind:bbox,bbox}, params, derivation}` (optional `extension`, default
  geojson). Scratch root is read with the submitter's caller token (the run
  token is minted later). Input-only composites use an identity deferred plan.
- 2026-11-05 (QA, applied): derivation automatic for Tapis plans
  (`input_etl: false` opts out); input steps re-resolved from the adapter
  registry, allow-listed transform types, secret-bearing bindings refused;
  area cap enforced at plan time (422 AOI_REGION_TOO_LARGE); two AOI inputs →
  422; the AOI task no longer prints its GeoJSON. On the stdlib path
  `dissolve` collects polygons into one MultiPolygon (true union only when
  shapely is used).
- 2026-11-05 (deviation): `tapis_token` is refused as an input-step binding
  with no exception, since input steps are hosted function pieces that never
  need it. Also, EM auto-derivation steps aside when a plan already carries
  `adapter_steps`. Commits: adapter f2cd2b1 + 20d68dc, EM 7878877 + ac8dd7a,
  subside 54ef7e9, modflow-executables efb0386.

- 2026-11-05 (post-merge finding): the MINT→adapter sync rewrote every hosted
  ETL piece as `transform_type: etl_process` with no env bindings, and
  re-appended its contracts each run (dev rows carry 2x contracts; model-config
  rows up to 156). A synced `ts-aoi-from-boundary` would therefore fail the
  input-step allow-list. Fixed on `fix/svo-adapter-etl-sync-roundtrip`: the
  registration script records adapter_transform_type/stage/env_from_args/
  file_inputs in runtime_json, the sync restores them, and contracts are
  cleared before re-insert. This is also the root cause of the duplicate
  contract rows behind NO_DEFERRED_TRANSFORM_PATH. PR #387's adapter image was
  rebuilt by re-running its cancelled build (the #388 build only covered EM).

- 2026-11-05 (superseded in part): the Waco re-run under this design derived
  no AOI step: the EM pairs app file inputs with catalog inputs by exact label
  ("AOI GeoJSON" vs app input "aoi-geojson"), and the optional miss was silent.
  Section 5 (EM derivation) and the `input_steps` submit contract are superseded
  by `2026-11-05-app-input-binding.md`: an explicit `app_input_name` on the
  configuration-input junction, carried by the sync onto the bridge's input
  contracts, and input ETL planned by the bridge from `input_sources`.

- 2026-11-05 (QA fix): the first live submit with an input step failed with
  `INPUT_STAGING_UNRESOLVED`. `resolve_scratch_root` asked `GET /v3/jobs/list`
  for `execSystemExecDir`, but that endpoint takes neither search conditions
  nor `select` and returns a fixed summary without the directory, so the
  `$SCRATCH` root could never be read. Confirmed against the user's own jobs:
  `GET /v3/jobs/search?execSystemId.eq=ls6&select=uuid,execSystemExecDir`
  returns `/scratch/<alloc>/<user>/tapis/<uuid>` rows in one call. The resolver
  now uses the search endpoint, falls back to the summary listing filtered by
  `execSystemId`, and reads a row in full (up to three) when the directory is
  still missing. The path had no live coverage because every earlier run had
  no input step.

## User feedback / decisions

- 2026-11-05: "test that it runs through DYNAMO first then move to SUBSIDE";
  "don't change the app … ETL that is generalizable"; "we don't need a
  workaround we just need it done properly".
- 2026-11-05: User approved rev 2 ("do it").
