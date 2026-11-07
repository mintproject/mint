# Explicit output file binding for composite model runs

Status: Implemented (rev 2 approved 2026-11-07; live on dev 2026-11-07, PR mintproject/mint#404, modflow-executables#4)

Base: `origin/develop` at 67f8d35 (PR #400) plus #402/#403. Mirrors
[2026-11-05-app-input-binding.md](2026-11-05-app-input-binding.md), whose section 1
said "a mirror on `modelcatalog_configuration_output` can follow". This is that
follow-up.

## Objective

Record, in the catalog, which archived file each declared model output is, so the
bridge (SVO adapter) hands the right file to the ETL/publish chain. Stop deriving
the file from the output's label, which only works when the label is a file name
or an extension.

## User need

Run `ue_3a5901b2` (2026-11-06 01:14Z, WERC "Waco velocity" through the new
SUBSIDE-through-DYNAMO path) was the first OPERA job to finish on ls6. The adapter's
model task then failed closed:

```
[MODEL_OUTPUT_AMBIGUOUS] model output cumulative displacement geotiff was not
uniquely matched; archived_files=disp_displacement.tif, disp_overlay.png,
frames_info.geojson, opera_disp_s1_cumulative.tif, opera_disp_s1_velocity.tif,
OPERA_L3_DISP-S1.zip, preflight-manifest.json, run-manifest.json
```

The run produced the right files. The adapter could not tell which GeoTIFF was the
"Cumulative displacement GeoTIFF" because the catalog does not say. No composite run
on dev has ever reached `finished` with a label-named output; the only matcher paths
that work today are an exact file name (`head_output.tif`) or a label that is an
extension (`cbc`, `hds`), which is how the MODFLOW outputs are labelled in tests but
not in the live catalog ("Simulated heads (binary)").

## Current code/system summary

- **Catalog.** `modelcatalog_configuration_output` is the `sd:hasOutput` junction with
  only `configuration_id, output_id` (tables.yaml ~3356-3402: `user` insert+select,
  `anonymous` select, `user` delete, no update; semantic-search event trigger).
  `modelcatalog_dataset_specification` has `label, description, has_format,
  has_dimensionality, position`. File names appear only in `description` prose
  ("disp_displacement.tif — AOI-cropped …").
- **Catalog API.** `resource-registry.ts` `hasOutput` entries (three resource types,
  ~234/319/397) have no `junctionColumns`; `field-maps.ts` `outputs { output {…} }`
  selections at ~231 and ~642; `openapi.yaml` `hasOutput` items have no junction
  attribute (the `hasInput` items carry `isOptional`, `appInputName` at ~14229).
- **EM.** `model-info.graphql` selects `outputs { output { id label has_format position
  description } }` with no `order_by`; `modelIOFromCatalogGQL(row, 'output')` sets
  `name = label || id`, `format = has_format`, `position`, and `graphql_adapter.ts`
  ~553 keeps the rows in the order Hasura returned them (database row order). The
  "first declared output" that `createPlan` falls back to when no `model_output_key`
  is requested (`unifiedExecutionService.ts` ~2185) is therefore unstable: run
  `ue_63132569` (2026-11-05 23:50Z) got "Reference anchor JSON" (position 4), and
  `ue_3a5901b2`, after the outputs were re-registered, got "Cumulative displacement
  GeoTIFF" (position 1). `buildCompositeWorkflowModelTask` (TapisExecutionService
  ~180-209) picks the output by `model_output_key` (name or id), and sends the adapter
  `model_task.output_name = label`, `output_format`, and
  `output_uri = tapis://<archive>/mint-workflow-output/<run>/model/<label>`. That is a
  pre-run placeholder: the adapter's `get_output_uri` (tapis.py ~1680-1790), the
  poller's auto-bind and the EM tests carry the adapter-computed URI after the run;
  nothing parses the label suffix, and this spec leaves the placeholder alone.
- **Adapter.** `generate_tapis_workflow` embeds `output_name`/`output_format` into the
  model task code (`tapis.py` ~236, ~326). After the job finishes the task lists
  `/v3/jobs/{uuid}/output/list/` once, with no `limit`/`skip` (Tapis pages the
  listing; the default page is 100 entries), keeps `type != "dir"` entries (top
  level, `name` is the base name) and selects: exact
  lower-cased file name == `output_name`; else files ending in `.<output_name>`
  (`.cbc`/`.cbb` when the name or format says cbc); exactly one match or
  `MODEL_OUTPUT_AMBIGUOUS` (used for both zero and many) with the file list in
  `details.archived_files`. The selected file's `tapis://` URI becomes the stage
  result the ETL/publish chain consumes. `/workflows/submit` accepts `model_task` as a
  free dict (`models.py`); only `job_definition`, `configuration_id`,
  `required_secrets`, `max_minutes`, `input_sources` are read.
- **Registration.** `register_to_mint.py` (MODFLOW) `build_outputs` knows each output's
  `ext` (`hds`, `cbc`, `lst`, `csv`) and PUTs `hasOutput: [{id}]`.
  `register_subside_to_mint.py` PUTs `hasOutput: [{id}]` from the YAML; the YAML
  outputs have `label`, `description`, `hasFormat`, presentations. The WERC file names
  are the defaults of the parameters `cumulative_filename`
  (`opera_disp_s1_cumulative.tif`) and `velocity_filename`
  (`opera_disp_s1_velocity.tif`); H2I writes `disp_displacement.tif` fixed.
- **UI (ui-react).** `OutputFields` fragment selects the junction's two columns;
  `InsertConfigurationOutputJunction` exists but has no caller; outputs are created
  with `insert_modelcatalog_configuration_output_one` (nested `output.data`).

## Proposed design

### 1. Catalog: one new junction column

Migration `1771300000038_configuration_output_archived_file`:
`ALTER TABLE modelcatalog_configuration_output ADD COLUMN archived_file TEXT`
(nullable), with `down.sql` and a column comment: "File name, or fnmatch glob, of
this output in the job's archive directory for this configuration; NULL when the
output is not bound to a file." Per configuration, like `app_input_name`: two
configurations can share a dataset specification and write it to different files.

Permissions mirror `app_input_name`: added to the `user` insert/select anchor and the
`anonymous` select list. Same exposure as the input column; covered by the known
catalog permission gap (P1).

Catalog API: `junctionColumns: { archived_file: 'archivedFile' }` on the three
`hasOutput` entries; `archived_file` added to both `outputs {…}` selections in
`field-maps.ts`; `archivedFile` (string, nullable) on `hasOutput` items in
`openapi.yaml`; codegen regenerated. Reads return it; writes accept it. Nested
`hasOutput` writes are delete-then-insert, so every writer must carry it (section 2).

Value rules, checked by both registrars, by `/workflows/submit` and by the model
task itself (the catalog value is user-writable under the P1 gap, so no layer trusts
the previous one):

- a base name in the archive root: whitelist `^[A-Za-z0-9._\-*?\[\]{}:]{1,255}$`,
  no `/`, not `.` or `..`. Subdirectories are out of scope for this revision (no
  declared output needs one; adding them means a second listing call to specify and
  test).
- it is a glob only when it contains `*` or `?`; otherwise it is compared literally,
  so a literal name containing `[` works. Globs use `fnmatch.fnmatchcase` (ls6 file
  names are case-sensitive), so `*.cb[bc]` matches both MODFLOW budget extensions.
- a value that is, or would match, a Tapis job service file (`tapisjob*`) is rejected
  at write time, and those files are never candidates at match time.
- a parameter reference `{param:<parameter id>}` (the catalog parameter's id, full
  URI or last path segment) stands for that parameter's effective value for the run.
  The Ensemble Manager resolves it at submit (section 3); the adapter only ever sees
  a concrete name or glob.

### 2. Registration fills it

- **SUBSIDE YAML.** `archivedFile:` on the outputs whose file is known:
  H2I `disp_displacement.tif`, `run-manifest.json`, `disp_overlay.png`,
  `OPERA_L3_DISP-S1.zip`; WERC `{param:werc-param-displacement-geotiff-name}` and
  `{param:werc-param-velocity-geotiff-name}` (the parameters behind
  `DISPLACEMENT_GEOTIFF_NAME` / `VELOCITY_GEOTIFF_NAME`, YAML lines ~580-596, defaults
  `opera_disp_s1_cumulative.tif` / `opera_disp_s1_velocity.tif`). The WERC manifest
  stays unbound: the finished run `ue_3a5901b2` archived no
  `werc-run-manifest.json`, so binding it would fail every request for that output
  until the app's archive is confirmed. Outputs that are a directory or a
  set (cropped NetCDFs, anchors under `output/anchors/`, H2I artifacts) stay
  unbound; an unbound output keeps today's behaviour. The loader PUTs
  `hasOutput: [{id, archivedFile}]`, omitting the key when the YAML has none, checks
  the value rules, and rejects two outputs of one configuration bound to the same
  `archivedFile`. A new `--only-output-binding` re-PUTs the output junctions on an
  existing catalog, like `--only-input-typing` does for inputs.
- **MODFLOW.** `build_outputs` sets `archivedFile` to the glob `*.{ext}` from
  `models_metadata.json` (`cbc` → `*.cb[bc]`, since the archives carry `.cbb`), with
  the same duplicate check. The junction PUT carries it. Re-registration is not
  required for this fix; until then MODFLOW outputs are unbound and rule 2 in
  section 4 keeps today's behaviour for them.
- **Every writer of `hasOutput` must carry the column.** Nested `hasOutput` writes
  are delete-then-insert and the `user` role has no update permission on the
  junction, so a writer that omits `archivedFile` nulls it. Both registrars carry it
  from this change on. The ui-react writers (`InsertConfigurationOutputJunction`, no
  caller today; nested `output.data` inserts on output creation) do not, so until the
  UI follow-up ships, editing a configuration's outputs in the MINT UI wipes its
  bindings and the next run fails `MODEL_OUTPUT_MISSING`. Re-running
  `--only-output-binding` restores them.

### 3. EM passes the binding to the bridge

`model-info.graphql` selects `archived_file` on `outputs`; `ModelIO` gains
`archived_file?: string` (set for outputs by `modelIOFromCatalogGQL`).
`buildCompositeWorkflowModelTask` resolves the binding and returns it as
`output_file`:

- a `{param:<id>}` reference is looked up in `model.input_parameters` by id (full
  URI or last segment) and replaced by the seed execution's parameter value
  (`seedExecutions` → `getInputsParameters`, the same map the job's `parameterSet`
  is built from), else the parameter's default. No such parameter, or an empty value, or
  a resolved value that fails the value rules → the submit fails fast with 422
  `MODEL_OUTPUT_FILE_UNRESOLVED` before anything is queued on ls6.
- a plain value is passed through unchanged.

`unifiedExecutionService` adds `output_file` to the explicit `model_task` field list
it sends on `/workflows/submit` (~2549-2555); the return type in
`TapisExecutionService.ts`, the legacy interface in `executionsTapisService.ts` and
the type at `unifiedExecutionService.ts` ~733-743 gain `output_file?: string`.
`output_uri` is unchanged. `compositeModelContext.outputs` and the publisher list are
unchanged.

### 3b. Deterministic default output

`graphql_adapter.ts` sorts `output_files` (and `input_files`) by `position`
ascending, ties broken by `id`, when it builds the `Model`. Every "first output"
fallback in the EM (`createPlan` identity plan, `buildCompositeWorkflowModelTask`
without a requested name, `compositeModelContext.outputs`) then follows the catalog's
declared order. For WERC that is the cumulative GeoTIFF; for H2I the displacement
COG. SUBSIDE's scenario path sends no `model_output_key` and relies on this.

### 4. Bridge matches by binding, else as today

`/workflows/submit` reads `model_task.output_file` (optional string) and rejects a
value that breaks the value rules (including an unresolved `{param:…}`) with 422
`MODEL_OUTPUT_FILE_INVALID`. `generate_tapis_workflow` embeds it as
`__OUTPUT_FILE__` via `repr`, substituted after the other placeholders so a value
can never inject one.

The model task lists the archive root with `limit=1000` and `skip`, following pages
until a short page (at most 5 pages; a listing that still fills the last page is
recorded as `truncated: true` in any error details). It drops `type == "dir"` entries
and `tapisjob*` files, then selects:

1. **Binding.** `output_file` set: candidates are files whose `name` equals the value
   (literal) or matches it with `fnmatchcase` (glob). One → selected. Zero →
   `MODEL_OUTPUT_MISSING` (new code; today `MODEL_OUTPUT_AMBIGUOUS` covers zero too,
   and its only consumers are the emitter, its test and the golden pipeline JSON).
   Many → `MODEL_OUTPUT_AMBIGUOUS`. A bound output never falls through to rule 2, so
   a wrong binding fails loudly instead of silently selecting another file.
2. **Name.** No binding: unchanged from today (exact lower-cased file name ==
   `output_name`; else files ending in `.<output_name>`, with the `cbc`/`cbb` pair;
   exactly one or `MODEL_OUTPUT_AMBIGUOUS`).

No format-derived guessing: the reviewers showed it would silently pick
`preflight-manifest.json` for a JSON output or `frames_info.geojson` for a GeoJSON
one, in a step whose result gets published.

Error details carry `output_file`, `output_name`, `archived_files` (first 40),
`listed` (count) and `truncated`, plus for `MODEL_OUTPUT_MISSING` the `candidates`
with the same extension and the hint "re-register the configuration's output
binding". The result manifest records `output_file` and `selected_by`
(`binding` | `name`) beside `archived_name` so a selection is traceable.

### 5. Out of scope

ui-react round-trip (fragment selection, read-only "Archived file" on the output
row, carrying the column on re-insert) is a follow-up PR, as the input binding's UI
work was; its absence is the wipe window named in section 2. Subdirectory bindings
and a format-based fallback are not planned. The sync (`mint_sync`) does not need the column: the EM passes it at
submit, the same boundary that carries `output_name` today.

## Files likely affected

- `graphql_engine/migrations/1771300000038_configuration_output_archived_file/{up,down}.sql`,
  `graphql_engine/metadata/tables.yaml`,
  `graphql_engine/tests/test_configuration_output_archived_file.py`
- `model-catalog-api/src/mappers/resource-registry.ts`, `src/hasura/field-maps.ts`,
  `openapi.yaml`, generated types, tests (`response`, `nested-tree`, `mutation-compiler`)
- `mint-ensemble-manager/src/classes/graphql/queries/fragments/model-info.graphql`,
  `graphql_adapter.ts`, `mint-types.ts`, `classes/tapis/adapters/TapisExecutionService.ts`,
  `api/api-v1/services/executionsTapisService.ts`, `unifiedExecutionService.ts`, tests,
  regenerated `graphql/types.ts`
- `svo-adapter-service/app/main.py` (submit validation), `app/tapis.py` (task code),
  `tests/test_model_output_handoff_diagnostics.py`, golden pipeline JSON
- `modflow-executables/scripts/register_subside_to_mint.py`, `register_to_mint.py`, tests
- `subside/tapis/workflow_apps/opera-disp-s1.model-catalog.yaml`

## API/schema changes

- Column `modelcatalog_configuration_output.archived_file TEXT NULL`.
- REST: `hasOutput[].archivedFile` on configuration reads and writes.
- Adapter: `/workflows/submit` `model_task.output_file` (optional); new error code
  `MODEL_OUTPUT_MISSING`; 422 `MODEL_OUTPUT_FILE_INVALID`.
- EM: no request/response change; `model_task.output_file` on the adapter call; 422
  `MODEL_OUTPUT_FILE_UNRESOLVED` on an unresolvable parameter reference.

## Data flow

Register (YAML / `ext` → `archived_file`) → EM `buildCompositeWorkflowModelTask`
(output by `model_output_key`, `{param:…}` resolved → `output_file`) →
`/workflows/submit` (validate) → model task (job finishes → paged archive listing →
binding or name match → `tapis://` URI) → ETL/publish chain.

## Risks and tradeoffs

- **Fail-closed stays.** A bound output never falls back to name matching, so a
  typo in the YAML, or an app version that renames its file, fails every run of that
  configuration with `MODEL_OUTPUT_MISSING` until re-registered, and that failure
  shows only after the ls6 queue wait. That is the intended property (the input
  binding made the same call); the error names the binding, the listing and the
  near-miss candidates so the fix is one re-registration.
- **Parameter-driven names** are resolved at submit, so a caller who overrides
  `cumulative_filename` still gets a matching binding, and a reference the catalog
  cannot resolve fails before the job is queued. The resolution relies on the EM
  seeing the same effective parameter value the job receives; both come from the
  same seed execution.
- **Column exposure.** Same write exposure as `app_input_name` (P1 gap: the `user`
  role can write it on any configuration), but an output binding decides which
  archived file gets published, so the integrity stake is higher. The whitelist and
  the `tapisjob*` exclusion bound what a hostile value can select to files of the
  run's own archive; the adapter re-reading the binding from the catalog would not
  change that. Tracked under P1.
- **UI wipe window** until the ui-react follow-up (section 2).
- **Listing contract.** The task now pages the listing; behaviour on a Tapis
  listing error is unchanged (`_request_retry`).
- **Hasura migration on dev** is applied by the deploy pipeline the same way
  `1771300000037` was; the migration, the metadata, the API and the EM ship in one
  monorepo deploy, and the re-registration runs after that deploy.

## Alternatives considered

- **Token matching on the label** (split "Cumulative displacement GeoTIFF" and score
  file stems). Ties on the WERC archive (`disp_displacement` vs
  `opera_disp_s1_cumulative` both score one) and is heuristic in a fail-closed step.
  Rejected.
- **Column on `modelcatalog_dataset_specification`.** A specification can be shared
  by configurations that write different files; the junction is where
  `app_input_name` lives. Rejected.
- **Adapter reads the binding itself** from the catalog by `configuration_id` at
  submit (as it does for secret parameters). Would remove trust in the EM for this
  value, but the EM already chooses the output; one more field across the same
  boundary is simpler. Can change later without a schema change.
- **Name the column `app_output_name`** (the binding spec's wording). Tapis apps do
  not name outputs; what the catalog records is an archived file. `archived_file`.
- **Read the app's run-manifest.json.** App-specific; not every model writes one.
- **Format-derived fallback for unbound outputs** (rev 1 rule 3). Would silently
  select the wrong single file of a common format. Dropped in rev 2.
- **Bind the WERC defaults literally** (rev 1). Breaks on any parameter override and
  fails late. Replaced by the `{param:…}` reference.
- **Subdirectory bindings** (rev 1). Needs a second listing call and a basename vs
  path rule nobody needs yet. Dropped.

## Test plan

- graphql_engine: migration/permissions test mirroring
  `test_configuration_input_app_input_name.py` (column in the `&id008` insert/select
  anchor and in the separate anonymous select list).
- model-catalog-api: response hoists `archivedFile`; nested write carries it;
  mutation compiler emits it.
- EM: `buildCompositeWorkflowModelTask` returns `output_file` for a literal, a glob,
  and a `{param:…}` reference resolved from a bound value and from a default; 422
  `MODEL_OUTPUT_FILE_UNRESOLVED` for an unknown parameter and an empty value; the
  submit body carries `model_task.output_file`; `modelFromCatalogGQL` orders outputs
  by position regardless of row order (fixture with positions 4,1,2).
- Adapter: literal match among several `.tif`; glob match; literal with `[`; a bound
  output does not fall back; zero → `MODEL_OUTPUT_MISSING` with `candidates`; many →
  `MODEL_OUTPUT_AMBIGUOUS`; `tapisjob.out` excluded even when a glob matches it;
  paged listing (two pages) and `truncated` flag; unbound behaviour unchanged
  (existing tests); submit 422 on `a/b`, `..`, `/abs`, `tapisjob.out`, over-long,
  quotes/newlines (repr embedding); token never in payloads; `selected_by` in the
  manifest; `result_contract` accepts the new code; golden JSON regenerated.
- Registration: SUBSIDE loader PUT carries `archivedFile`, value rules and duplicate
  binding rejected, `--only-output-binding` touches only output junctions (dry run);
  MODFLOW `build_outputs` globs and duplicate check.

## Documentation plan

DSO docs `services/svo-adapter.md` (submit field, error codes) and
`services/mint-platform.md` (catalog column); SUBSIDE YAML comments; the binding
spec's section 1 note points here.

## Rollout/rollback plan

1. Merge monorepo PR (migration + API + EM + adapter) → dev deploy applies the
   migration.
2. Run `register_subside_to_mint.py --only-output-binding` against dev as the end
   user (dry run first).
3. Resubmit the WERC Waco scenario from the local SUBSIDE UI against dev; expect
   the model task to select `opera_disp_s1_cumulative.tif` (or the velocity file when
   that output is requested).
4. MODFLOW re-registration with globs when convenient.
Rollback: revert the metadata (`tables.yaml`) and the API/EM selections in the same
deploy as `down.sql`, or Hasura's metadata becomes inconsistent; the adapter and EM
treat a missing binding as unbound and behave as today.

## Open questions

- Should `/workflows/submit` also accept `output_file` for the non-composite
  `post_model_adapter` path? Not needed: that path receives a data object, not a
  job archive.

## Decisions

- 2026-11-07: spec drafted after `ue_3a5901b2` failed with `MODEL_OUTPUT_AMBIGUOUS`;
  column named `archived_file`; bound outputs never fall back; format fallback added
  for unbound outputs.
- 2026-11-07 (rev 2, after review): format fallback dropped (silent wrong file);
  subdirectory support dropped; listing paged with `limit=1000`; WERC bindings become
  `{param:…}` references resolved by the EM at submit (fail fast when unresolvable);
  whitelist validation at every layer and `tapisjob*` excluded; `output_uri` left
  alone (the "nothing reads it" claim was wrong: the adapter's `get_output_uri`, the
  poller and tests use the post-run value); `selected_by` recorded; UI wipe window
  documented; rollback includes the metadata revert.
- 2026-11-07: default-output ordering bug (`ue_63132569` picked position 4) folded
  into this spec as section 3b because it sits in the same EM code and the SUBSIDE
  scenario path depends on it.

- 2026-11-07 (QA should-fix items applied): a `{param:…}` reference must be the whole
  value in the registrar and the EM (a malformed or embedded reference is rejected
  where it is written, not at the adapter); the registrar uses `fullmatch`; the
  model task pages until an empty page rather than a short one (Tapis may cap
  `limit`), so `truncated` means five non-empty pages; `MODEL_OUTPUT_MISSING`
  `candidates` are computed for literal bindings only. Not applied: single-pass
  placeholder substitution (a `__OUTPUT_FILE__` literal inside a caller string would
  only break the generated source, and the whitelist excludes it from the one
  caller-controlled value).
- 2026-11-07 (implementation deviations, all four halves coded and tested):
  - EM raises `UnifiedExecutionError(422, …, "MODEL_OUTPUT_FILE_UNRESOLVED")`
    rather than a plain `Error` with `.code`: only that type fails the submit fast
    with a 4xx (the `SECRET_ENV_UNDECLARED` pattern); a plain error would be stored
    as an unknown-status run. The `{param:…}` lookup accepts the parameter's full id
    or its last `/`/`#` segment; two parameters sharing a last segment resolve to the
    first found.
  - The registrar's `{param:…}` accepts the bare parameter id only (the whitelist has
    no `/`); it must name a parameter of the same configuration.
  - MODFLOW: outputs that share an extension within a variant (MODFLOW-96 `.dat`
    heads/budget/drawdown) stay unbound rather than aborting registration;
    `cbc-mf2005` maps to `*.cb[bc]` like `cbc`.
  - Adapter: the generated task re-validates the embedded value and dies
    `MODEL_OUTPUT_FILE_INVALID`; an empty `output_file` is unbound; any `{param:`
    substring is rejected at submit; the paging query changed existing test
    responders from `endswith("/output/list/")` to a `split("?")` match.
  - Pre-existing failures left alone: 4 `test_demo_api.py` tests (adapter) and
    `test_hydraulic_head_inference_metadata.py::test_public_inference_relationships_are_readable_anonymously`
    (graphql_engine) fail identically on `origin/develop`.
  - SUBSIDE: `feat/runs-through-dynamo` had branched before the 12 commits that
    carry the AOI typing and `appInputName`; it was rebased onto `origin/main`
    (no overlapping files) before `archivedFile` was added, so one YAML now holds
    both bindings. EM GraphQL types were hand-edited (codegen needs a live Hasura).

- 2026-11-07 (live verification): merged as 384ebd4 and deployed to dev; six bindings
  re-registered with `--only-output-binding`; run `ue_c09de4f2` (WERC Waco, submitted
  through SUBSIDE-through-DYNAMO) finished on ls6, the model task selected
  `opera_disp_s1_cumulative.tif` and the publish step produced STAC item
  `subsidence-rates-dev/ue_c09de4f2-…` (asset `cumulative`) and CKAN dataset
  `subsidence-rates-dev--ue_c09de4f2-…` in `dso-internal`. Follow-ups seen on that
  run, outside this spec: the STAC item's start/end datetime is the publish date,
  not the analysis window; only the requested output is published (no velocity
  asset); the dataset came out public although the `public` parameter defaults to
  false (cause under investigation).

## User feedback / decisions

- 2026-11-07: user approved rev 2 ("approve"). Earlier ls6 failures were the user's own
  `scancel`; the 01:14Z WERC run is the one that matters.
