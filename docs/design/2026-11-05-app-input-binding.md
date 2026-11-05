# Explicit app-input binding; input ETL planned by the bridge

Status: Approved (rev 2, 2026-11-05, after architect + skeptic review; user said
"ok do it") — Implementing

Base: `origin/develop` d0c275c, which includes the AOI piece (#387), the EM
derivation (#388) and the sync contract-replace fix (#389). Revises section 5
("EM derivation at createPlan") and the EM/adapter contract of
[2026-11-05-aoi-etl-piece.md](2026-11-05-aoi-etl-piece.md). That spec's piece,
`$SCRATCH` staging and catalog typing stand.

## Objective

Record, in the catalog, which Tapis file input each model input feeds. Use that
binding, together with the existing standard-variable typing, so the bridge (SVO
adapter) plans and stages every input-side ETL step itself. The Ensemble Manager
(EM) stops inferring the pairing from label text.

## User need

The Waco runs on 2026-11-05 (14:34Z) got no AOI step. The EM pairs an app file
input with a catalog input only when the input's label equals the file input's
name. The app says `aoi-geojson`; the catalog says "AOI GeoJSON". The input is
optional, so the miss was silent and the job would have failed on the missing
file, as the first attempt did. The user asked that the fix be the proper model
("explicit binding"), generalizable to other models, and that the bridge own the
ETL ("aren't we supposed to go through the bridge?").

## Current code/system summary

- **Catalog.** `modelcatalog_configuration_input` is the `sd:hasInput` junction
  and already carries `is_optional` (migration `1771200016000`). Nothing records
  the app file-input name; it appears only in `label` and `description` prose.
  `tapis_app_id` on the configuration identifies the app, whose definition
  lists file inputs by name. Hasura permissions are per-column lists
  (`tables.yaml` ~3305-3335): `user` insert + select, `anonymous` select, no
  update permission, `user` delete. The semantic-search event trigger fires on
  every junction insert/update/delete.
- **Catalog API.** `resource-registry.ts` maps junction columns per relation
  (`junctionColumns: { is_optional: 'isOptional' }` on `hasInput`, three
  resource types, lines ~232/317/395). `nested-tree.ts`, `mutation-compiler.ts`
  and `response.ts` read that map generically, but `response.ts` only hoists
  columns that were selected, and the selections live in
  `hasura/field-maps.ts` (lines ~220 and ~621). Nested `hasInput` writes are
  delete-then-insert.
- **UI (ui-react).** `ConfigurationForm` loads `is_optional` per input and, when
  it changes, replaces the junction row through `setInputOptional` (the `user`
  role cannot update the junction in place). `RegisterTapisAppDialog` creates
  inputs from a Tapis app's file inputs.
- **EM.** `TapisJobService.findModelInput` matches by exact label, with a
  hard-coded fuzzy fallback for MODFLOW names; `createJobFileInputsFromSeed`
  logs and skips an OPTIONAL app input with no match. `createPlan` derives AOI
  steps (`inputStepDerivation.ts`, `findUnboundInputsByStandardVariable`): it
  builds the job in memory, finds unfilled app inputs whose model input is typed
  `area_of_interest__boundary`, shapes the thread region, calls the adapter's
  `POST /plans/input`, and sends `model_task.input_steps` on submit.
- **Adapter.** `mint_sync._build_contracts` builds one `transform_contract` per
  (input, presentation) with role, standard variable, format and unit;
  `metadata_json` is empty for model contracts (ETL contracts already use it for
  the catalog marker, and `TRANSFORM_REGISTRY_QUERY` selects it). Since #389 the
  sync deletes a spec's contracts before re-inserting them. `/plans/input` finds
  a path from a polygon/GeoJSON source to a target standard variable.
  `/workflows/submit` re-resolves client `input_steps` from the registry
  (allow-list `INPUT_STEP_TRANSFORM_TYPES`), resolves `$SCRATCH` staging before
  the run row exists (422 `INPUT_STAGING_UNRESOLVED`), and `_input_stage_tasks`
  emits the hosted tasks whose output the model task stages into the job's
  `fileInputs` by app input name (task code refuses an already-filled name).
- **Registration.** `register_to_mint.py` (MODFLOW) derives catalog inputs from
  each app's `fileInputs`, so it knows every name but does not store it.
  `register_subside_to_mint.py` loads the SUBSIDE YAML; the junction PUT sends
  `{id, isOptional}`.

## Proposed design

Nothing in the algorithm below is AOI-specific. The AOI is the first source
kind; source validation is keyed on the source kind so others can slot in.

### 1. Catalog: one new junction column

Migration `1771300000037_configuration_input_app_input_name`:
`ALTER TABLE modelcatalog_configuration_input ADD COLUMN app_input_name TEXT`
(nullable), with a `down.sql`. It is the name of the Tapis app file input this
dataset specification feeds in this configuration. Per configuration, so two
configurations can share a dataset specification and bind it differently.
Outputs are out of scope; a mirror `app_output_name` on
`modelcatalog_configuration_output` can follow.

Permissions: the same as `is_optional` (added to the `user` insert/select
anchor and the `anonymous` select list). It is user-writable because the UI's
own paths create and replace junction rows as the `user` role; an admin-only
column could not be preserved by them. The exposure is the same as
`is_optional` and is covered by the known catalog permission gap (P1).

Catalog API: `app_input_name: 'appInputName'` in the three `hasInput`
`junctionColumns` maps; `app_input_name` added to both `inputs { is_optional … }`
selections in `field-maps.ts`; `appInputName` (string, nullable) beside
`isOptional` in `openapi.yaml`; codegen regenerated. Reads return it; writes
accept it.

Every writer that replaces junction rows must round-trip it: the UI's
`setInputOptional` re-insert carries the row's current `appInputName`;
`RegisterTapisAppDialog` sets it from the app's `fileInputs[].name` when it
creates inputs; both registration scripts always send it. `InputRow` shows it
read-only as "Tapis file input".

### 2. Registration fills it from the app definition

- MODFLOW: `build_inputs` iterates `app.jobAttributes.fileInputs`; each catalog
  input gets `appInputName = fileInput.name`. FIXED app inputs are never bound
  (they are not catalog inputs). The junction PUT carries `appInputName`.
- SUBSIDE: the YAML gains `appInputName: aoi-geojson` on both AOI inputs; the
  loader's junction PUT carries it, and the loader rejects two inputs in one
  configuration that bind the same name. `--only-input-typing` also re-PUTs the
  junctions so an existing catalog gets the binding without a full re-register.
- A registration-time coverage check (every non-FIXED app file input is bound
  or on an explicit ignore list such as `earthdata-netrc`) is deferred; the
  SUBSIDE loader does not read the app definition today.

### 3. Sync carries the binding onto the input contract

`LIST_MINT_CONFIGURATIONS_QUERY` selects `app_input_name`. `_build_contracts`
puts `metadata_json: {app_input_name, is_optional, dataset_specification_id}`
on each input contract (every presentation of one dataset specification yields
a contract with the same binding). The contract is where "which file input is
this staged to" belongs; `transform_spec.file_inputs` keeps its piece-only
job-shaping role, and `DataObjectContract` does not learn the key (it is not a
compatibility dimension). The sync warns when two dataset specifications in one
configuration bind the same `app_input_name`. `metadata_json` is not exposed to
the `anonymous`/`user` roles; the adapter reads with the admin secret
(`hasura.py get_client`), which this design relies on.

### 4. Bridge plans the input steps

New `POST /plans/model-inputs` (preview, no rows written) and the same function
inside `/workflows/submit`:

```
request:  { configuration_id, sources: [InputSource] (1..4), filled_app_inputs: [str] }
response: { input_steps: [InputStep], considered: [Considered], steps_digest,
            registry: "ok" | "missing", registry_synced_at }
InputSource = {kind:"geojson", geometry: Polygon|MultiPolygon, derivation?: {...}}
            | {kind:"bbox", bbox:[minx,miny,maxx,maxy], derivation?: {...}}
Considered  = {app_input_name, standard_variable_uri, optional, outcome, blocking}
outcome ∈ planned | filled | fixed | unbound | no_path
```

Algorithm:
1. Load the registry. The model's row is the spec with
   `mint_model_config_id == configuration_id`. If there is none (a model with
   no typed presentations is never synced), return `registry: "missing"`,
   no steps, no error; the EM surfaces it as a warning.
2. Group the row's input contracts by `metadata_json.app_input_name` (one group
   per bound app input; a spec with N presentations is one group). A name in
   `filled_app_inputs` → `filled`, skipped. Input contracts without a binding
   are reported once as `unbound` and skipped.
3. For each group, in request order over `sources`, and over the group's
   contracts, `find_path(source_contract, target_contract)` over the edge graph
   with the model's own row excluded as an intermediate. The shortest path wins;
   ties break on source order, then contract order. Exactly one step per group.
   No path: `no_path`, with `blocking: !optional`.
4. Each path becomes an `InputStep {name: app_input_name, app_input_name,
   steps: build_plan_json(path).steps, source, params, derivation, extension}`,
   the shape `_input_stage_tasks` consumes. `params` are plain parameter names
   defaulted from the pieces' `parameters_schema_json` (namespacing stays inside
   `_input_stage_tasks`). `extension` comes from the target contract's format
   (`geojson`→`geojson`, `json`, `csv`, `netcdf`→`nc`, `geotiff`→`tif`, else
   `dat`). `derivation` is the source's, completed by the adapter with
   `vertices_in`, `bytes`, `area_km2` and `method`.
5. Source validation lives here: geometry is a Polygon or MultiPolygon with
   finite coordinates and closed rings, at most 500 polygons and 50 000
   vertices, source JSON at most 200 000 characters (existing cap); bbox area
   ≤ `MAX_AOI_AREA_KM2` (160000, the piece's `max_area_km2` default) else 422
   `AOI_REGION_TOO_LARGE`. Bad geometry is 422 `INPUT_SOURCE_INVALID`.
6. `steps_digest` is the stable hash of the resulting `input_steps`.

`/workflows/submit` takes `model_task.input_sources`, optional
`model_task.filled_app_inputs` (the EM's list of bound and FIXED app inputs)
and optional `model_task.expected_steps_digest`. It derives the steps with
`filled_app_inputs ∪ names(job_definition.fileInputs)`, requires the registry
row's `tapis_app_id` to equal `job_definition.appId` (else 422
`MODEL_APP_MISMATCH`), fails a blocking `no_path` with 422
`NO_INPUT_TRANSFORM_PATH`, and returns 409 `INPUT_PLAN_CHANGED` when the digest
differs from `expected_steps_digest`. Staging is resolved before `INSERT_RUN`
as today. The run's `run.input.planned` provenance records the steps, the
`considered` rows and the digest, so a replay can be compared.

`model_task.input_steps` is removed from the submit contract. It shipped only
to dev (#387/#388) and both pods redeploy together; one path is simpler and
removes the client-supplied-steps surface that B2 had to guard. The allow-list
`INPUT_STEP_TRANSFORM_TYPES` stays as the guard on which registry pieces may
run as input steps.

### 5. EM sends sources, not steps

- `model-info.graphql` selects `inputs { is_optional app_input_name input {…} }`;
  `ModelIO` gains `app_input_name` (snake case, as `is_optional`).
- `findModelInput(fileInputName, model)` matches `app_input_name` first, then
  the exact label, then the MODFLOW fallback. The local variable now named
  `appInputName` is renamed. The fallback is removed once MODFLOW is
  re-registered with bindings (follow-up).
- `compositeModelContext(threadmodel)` replaces
  `findUnboundInputsByStandardVariable`: it builds the job in memory and returns
  `{configuration_id, region, filled_app_inputs (bound datasets + FIXED app
  inputs), outputs, unmatched_optional_inputs}`.
- `createPlan` for Tapis plans (unless `input_etl: false`): shape the thread
  region with `deriveRegionSource` (geometry, or bbox above the 32 KB inline
  budget; request-size shaping stays in the EM), call `/plans/model-inputs`,
  attach `input_steps` (display), `input_sources`, `filled_app_inputs`,
  `steps_digest` and `input_warnings` to the plan. `input_warnings` lists:
  `registry: "missing"`; each `unbound` or optional `no_path` row; each optional
  app file input with neither a binding nor a label match. A blocking `no_path`
  is 422 `NO_INPUT_TRANSFORM_PATH`. A 404 from the adapter is 502
  `ADAPTER_CAPABILITY_MISSING`, never "no steps". An opt-in
  `strict_inputs: true` turns warnings into 422 `INPUT_WARNINGS`. The identity
  deferred plan for input-only runs keys on a non-empty result, as now.
- Submit sends `model_task.input_sources`, `filled_app_inputs` and
  `expected_steps_digest`; the idempotency suffix hashes the digest.
- Removed: `findUnboundInputsByStandardVariable`, `AOI_STANDARD_VARIABLE_URI`,
  the EM-side area cap, `AOI_MULTIPLE_INPUTS_UNSUPPORTED`, `INPUT_CONFLICT`
  (derived steps exclude filled inputs by construction; the task-code guard
  stays as defence in depth), the `/plans/input` call.

## Files likely affected

- `graphql_engine/migrations/1771300000037_configuration_input_app_input_name/{up,down}.sql`,
  `graphql_engine/metadata/tables.yaml`, `graphql_engine/tests/test_configuration_input_app_input_name.py`
- `model-catalog-api/src/mappers/resource-registry.ts`, `src/hasura/field-maps.ts`,
  `openapi.yaml`, generated types, tests (`response`, `nested-tree`,
  `mutation-compiler`, e2e read shape)
- `ui-react/src/graphql/{fragments,queries,mutations}/model-catalog.graphql`,
  `src/components/configuration/{ConfigurationForm,InputRow}.tsx`,
  `src/components/registration/RegisterTapisAppDialog.tsx`, `src/schemas/configuration.ts`, tests
- `svo-adapter-service/app/hasura.py`, `app/mint_sync.py`, `app/main.py`,
  `app/models.py`, `app/tapis.py` (extension), tests
- `mint-ensemble-manager/src/classes/graphql/queries/fragments/model-info.graphql`,
  `graphql_adapter.ts`, `mint-types.ts`, `classes/tapis/adapters/TapisJobService.ts`,
  `TapisExecutionService.ts`, `api/api-v1/services/executionsTapisService.ts`,
  `inputStepDerivation.ts`, `unifiedExecutionService.ts`, `paths/unifiedExecution.ts`, tests
- `modflow-executables/scripts/register_to_mint.py`, `register_subside_to_mint.py`, tests
- `subside/tapis/workflow_apps/opera-disp-s1.model-catalog.yaml`

## API/schema changes

- Column `modelcatalog_configuration_input.app_input_name TEXT NULL`.
- REST: `hasInput[].appInputName` on configuration reads and writes.
- Adapter: new `POST /plans/model-inputs`; `/workflows/submit` takes
  `model_task.input_sources`, `filled_app_inputs`, `expected_steps_digest`;
  `model_task.input_steps` removed; `/plans/input` removed.
- EM: plan response adds `input_sources`, `filled_app_inputs`, `steps_digest`,
  `input_warnings`; `input_steps` stays as preview; request adds `strict_inputs`.
- Adapter transform contracts: `metadata_json.app_input_name` on model inputs.

## Data flow

Register (app definition → `app_input_name`) → sync (→ contract metadata) →
EM createPlan (thread region → source; `/plans/model-inputs` preview + digest)
→ submit (`input_sources` + digest) → adapter derives steps from registry +
bindings, checks digest → hosted input tasks → `$SCRATCH` → model task adds
`fileInputs[app_input_name]` → job.

## Risks and tradeoffs

- **Nullable column.** Models registered before this change have no binding
  and fall back to label matching, exactly as today. The new `input_warnings`
  make that visible per plan instead of a `console.info`.
- **Stale registry.** The binding reaches the bridge only through
  `sync-from-mint`. Until the sync runs after a re-register, the preview reports
  the input as `unbound` and the plan carries a warning. Not silent.
- **Preview vs submit.** The digest makes a registry change between preview and
  submit a 409, not a silent difference. A dataset bound between plan and submit
  drops the derived step by construction; the run's provenance records it.
- **Rolling deploy.** The EM and adapter are separate pods. New EM against old
  adapter is a hard 502 on plan creation; old EM against new adapter is 422 on
  submit (`input_steps` no longer accepted). Both visible; PR A deploys first.
- **Bridge trusts `configuration_id` from the EM.** It only selects the
  registry row; `MODEL_APP_MISMATCH` ties it to the job's app, steps come from
  the registry, secrets are re-read by the adapter from the catalog, and
  staging writes only to the caller's own `$SCRATCH`.
- **Junction rewrites.** Delete-then-insert writers (UI, scripts) that omit
  `appInputName` would null the binding. All known writers are updated; a
  regression test covers each.
- **Event trigger.** Re-PUTting the OPERA junctions fires the semantic-search
  webhook twice. Acceptable.

## Alternatives considered

- **Relabel the AOI inputs "aoi-geojson".** Data only, works today, keeps the
  pairing implicit in display text. Rejected by the user.
- **Binding only, derivation stays in the EM.** Smaller change; the EM keeps a
  copy of planning logic and the AOI constant. The user asked for the bridge to
  own it.
- **Store the binding on `transform_spec.file_inputs`.** Spec-level column for
  N inputs, and a second shape in one column. The contract is the natural home.
- **A typed `app_input_name` column on `transform_contract`.** Cleaner than
  JSONB, but a second migration for one key. Deferred.
- **Infer the pairing** (single unfilled input, position). Fails for WERC (two
  optional inputs) and is order-dependent.
- **Admin-only column.** Would stop the UI from preserving or setting it.

## Test plan

- graphql_engine: migration/metadata test (column in up/down, in both
  permission lists).
- Catalog API: `appInputName` hoisted on reads, omitted when null, carried on
  nested writes (`response`, `nested-tree`, `mutation-compiler`, e2e shape).
- UI: `setInputOptional` re-insert carries `appInputName`; the register dialog
  sets it from the app; `InputRow` shows it.
- Adapter: sync puts `metadata_json.app_input_name` on input contracts and
  warns on duplicates; re-sync twice leaves one binding per input;
  `/plans/model-inputs` plans one step for a bound, unfilled, reachable input
  (two presentations → one step); skips `filled`; reports `unbound`; optional
  `no_path` non-blocking, required blocking; `registry: "missing"`; bad
  geometry, oversize bbox, too many vertices → 422; submit with `input_sources`
  produces the same pipeline as the former `input_steps` golden case; digest
  mismatch → 409; `MODEL_APP_MISMATCH`; `input_steps` in a submit → 422.
- EM: `findModelInput` prefers `app_input_name`; `compositeModelContext`
  returns filled (bound + FIXED) and unmatched optional inputs; createPlan calls
  `/plans/model-inputs`, attaches steps/sources/digest/warnings; 404 → 502;
  blocking `no_path` → 422; `strict_inputs`; submit sends sources + digest;
  `input_etl:false` opts out.
- Registration: dry-run payloads carry `appInputName` (both scripts, FIXED
  skipped, duplicate name rejected); YAML test.
- Live: dev migration, re-run the SUBSIDE loader's input mode,
  `sync-from-mint`, read back contract metadata for WERC/H2I, submit Waco,
  confirm `config/aoi.geojson` is staged.

## Documentation plan

DSO-Architecture svo-adapter and ensemble-manager pages (new endpoint, submit
body, removed `input_steps`), catalog API page (`appInputName`); the AOI spec's
Decisions; this spec's Status.

## Rollout/rollback plan

1. monorepo PR A: migration + metadata (one PR, applied together), catalog
   API, ui-react, adapter. PR B (stacked): EM. Deploy order on dev: graphql,
   then api, then svo, then ensemble (the deploy workflow restarts the
   changed services; PR A merges and deploys before PR B).
2. modflow-executables PR, subside PR.
3. Dev: migration applies on deploy (`schema_changed`). Re-run the SUBSIDE
   loader's input mode, then `sync-from-mint`. Read back that the WERC/H2I
   input contracts carry `app_input_name`. Submit Waco.
4. Rollback: revert PRs in reverse order (EM first). The column is nullable
   and harmless if left; contract metadata is ignored by an older adapter.

## Open questions

None blocking. Deferred: outputs binding, registration-time coverage check,
typed contract column, MODFLOW fallback removal.

## Decisions

- 2026-11-05: supersedes section 5 of the AOI spec. Binding lives on the input
  junction (sd:hasInput reification), not on the ETL piece and not on the
  dataset specification.
- 2026-11-05 (review): architect and skeptic reviewed against a stale checkout
  (b1452e8, before #387-#389) and flagged the base as unverified; the base is
  d0c275c and the AOI code is on develop. Accepted from the reviews: group
  contracts per app input (one step each); `registry: "missing"` as a warning,
  not an error; `steps_digest` + 409 on mismatch; 404 → hard 502; FIXED inputs
  treated as filled; `MODEL_APP_MISMATCH`; geometry caps; `input_warnings` and
  `strict_inputs`; field-maps/OpenAPI/UI round-trip; deploy order; duplicate
  binding warning in the sync. Rejected: admin-only column (the UI must write
  it); keeping `input_steps` as a transition path (never released beyond dev).
- 2026-11-05: `input_steps` removed from the submit contract; `/plans/input`
  removed; the allow-list stays.

## User feedback / decisions

- 2026-11-05: "Explicit binding is this generalizable to other models?" → yes,
  per configuration, for any Tapis-backed model. "ok do it".
