# Output-side publication as ETL pieces

Status: Implementing (2026-11-05; approved rev 3; adapter, EM and UI branches implemented, QA in progress)

## Objective

A DYNAMO run can ask, per run, for its model outputs to be published to one
or more catalogs. The bridge satisfies that request the way it satisfies
every other contract gap: by planning the registered ETL piece that closes
it (`catalog_register`) as a post-model task. Adding a new publisher means
registering a piece whose output contract names its catalog; configuring a
publication means setting that piece's parameters on the run, within
deployment allow-lists. No Tapis app changes.

Non-goals (this spec):

- Publishing non-raster outputs, or outputs of models other than the two
  SUBSIDE OPERA configurations. The mechanism is generic; only the SUBSIDE
  STAC piece is made runnable here.
- A republish or retry UI. A failed publication is visible and the model
  output stays usable; republishing is a new run or the `stacmap.publish`
  CLI until a later spec.
- Publishers that need stored API keys. They use the existing secrets store
  (`2026-11-04-svo-adapter-secrets-store.md`) unchanged.
- Changing SUBSIDE's own pipelines. They define their publish tasks inline in
  YAML and do not read the adapter registry.
- Server-side write ACLs in the STAC API (a stac-platform change; see Risks).

## User need

- **Primary user.** A DYNAMO user running a SUBSIDE OPERA configuration on a
  thread region, today the Waco runs `ue_1ccd35e5` and `ue_dd2e4dc9`.
- **Job to be done.** Have the run's displacement or velocity rasters appear
  in the SUBSIDE map and the DSO data portal, as that user's dataset, without
  a hand-run publish.
- **Current pain.** The outputs land on ls6 and in the adapter's data object
  only. No STAC Item, no CKAN dataset; the SUBSIDE map cannot show them. The
  user's words: "so publish and stac-publish should be etl pieces", and they
  want other publication processes and a configurable publication.
- **Definition of success.** A Waco WERC run submitted with `publish:
  ["ckan", "stac"]` ends with a STAC Item intersecting the Waco bbox in the
  chosen collection, a CKAN dataset owned by the submitting user, links on
  the run in DYNAMO, and, when the collection is `subsidence-rates` and the
  dataset is public, the raster visible in the SUBSIDE map.

## Current code/system summary

Verified against code on 2026-11-05 unless marked `[ASSUMPTION — confirm]`.

- **The pieces exist.** `svo-adapter-service/examples/subside_{h2i,werc}_transforms.json`
  register `ts-subside-{h2i,werc}-publish` (stage `publish`, type
  `manifest_emit`, geotiff → geotiff) and the shared `ts-subside-stac-publish`
  (stage `stac-publish`, type `catalog_register`, geotiff|netcdf|displacement-product
  → output contract `catalog: ckan+stac`, `env_from_args` for `stac_url`,
  `stac_collection`, `ckan_url`, `ckan_token`). They are hosted pieces
  upserted into `modelcatalog_etl_process` by `register_existing_etl_pieces.py`
  and synced into the adapter registry.
- **The catalog token already round-trips.** `register_existing_etl_pieces._schema_requirement`
  writes it as `schema_requirement_json["_svo"]["catalog"]`;
  `mint_sync._build_contracts` (~333-345) lifts it into
  `metadata_json["catalog"]` and strips `_svo`; `planner._contract_from_registry`
  (~207) reads `catalog` or `metadata_json.catalog`; `tests/test_etl_catalog_marker.py`
  covers it. Rev 1 and rev 2 of this spec wrongly claimed the token was lost.
- **The planner understands the gap, and finds the shortest path.**
  `_check_catalog` treats a target's `catalog` as a required token set
  (`ckan+stac` → `{ckan, stac}`), subset-matched, so `publish: ["stac"]` is
  satisfied by the `ckan+stac` piece. `_apply_transform` carries `catalog`
  through the BFS state. Because `ts-subside-stac-publish` accepts `geotiff`
  directly and `manifest_emit` is geotiff → geotiff, BFS plans
  `[catalog_register]` alone; it never selects the manifest piece (the
  example's own comment: "Plan = [run-werc, stac-publish]").
- **DYNAMO never asks for it.** For an input-only run the Ensemble Manager
  builds an identity deferred post-model plan whose target contract is the
  model output's own (`unifiedExecutionService.ts`, "Input-only composite").
  Both Waco plans decode to source = target = `{displacement, geotiff, m}`,
  so `/plans/deferred` planned zero steps.
- **The piece is not runnable from the adapter.** `task_code.get_code`
  has no builder for `catalog_register` (nor `manifest_emit`) and fails
  closed with exit 2. SUBSIDE runs the stage as an inline Workflows function
  task (`subside/tapis/workflows/pipelines/werc-opera.yaml`, `stac-publish`,
  ~420-560 and ~1100-1160): it locates the run manifest the `publish` task
  wrote, installs `stac-platform` from a GitHub archive and calls
  `stacmap.publish.publish_from_dir`, and no-ops when `CKAN_TOKEN`/`STAC_URL`
  are blank. `publish_from_dir` needs a manifest with the products, bbox
  and datetime; `stac_client.ensure_collection` creates a missing collection;
  `ckan.ensure_dataset` creates the per-run dataset **private to the
  organisation**.
- **Post-model dispatch and identity.** After the model job finishes the EM
  (`reconcilePostModel`) registers the output as an adapter data object,
  calls `POST /plans/deferred/{plan_id}/bind` (internal-secret gated, checks
  the data object belongs to the execution) and then `POST /workflows/submit`
  with the bound plan, `source_uri` and `execution_id`, **under the
  authorization of whichever caller's poll observed completion**. The
  adapter overwrites `tapis_token` with that caller's token (`main.py`
  ~2253) and records `submitted_by` from it. `unified_execution` has no owner
  column. So today a second user's poll would run the post-model stage as
  that user. `reconcilePostModel` also treats a failed post-model child as
  stale and resubmits it under a `:retry-` idempotency key (~783-841), and
  marks the legacy thread execution failed with no output when the record is
  `failed` (~806-829).
- **Tokens in tasks.** `tapis_token` is a managed parameter (never
  rendered), is in `_INPUT_SECRET_PARAMS`, reaches the model task's env as
  `TAPIS_TOKEN`, and hosted stages after the model take the token the model
  stage ends with (`tapis.py` ~967). The adapter's run token keeper is merged
  and live (`run_tokens.py`; the Waco runs carry `run.token.stored` with a
  3-day deadline). `stacmap` sends a JWT as `Authorization: Bearer` to CKAN
  and STAC; `stac_api/auth.py` lets any valid Tapis token write, and
  `upsert_item` is a PUT on `/collections/{c}/items/{i}`.
- **CKAN accepts the user's Tapis JWT** (confirmed 2026-11-05 with the user's
  token: `organization_list_for_user?permission=create_dataset` and
  `user_show` both 200). The 25 existing `subsidence-rates` datasets all live
  in organisation `stac-datasets`, are public, and were created by four
  different users. `tacc-water`, the default in the SUBSIDE YAML and in the
  registered piece, does not exist on this CKAN.
- `[ASSUMPTION — confirm]` An OWE function task can download the run's
  COGs from ls6 through the Files API, derive bbox and datetime, and upload
  them within its time, memory and disk limits.
- `[ASSUMPTION — confirm]` `MintRuns.tsx` renders post-model steps as ETL
  nodes; it reads `post_model_adapter` contracts, but no plan has yet had
  post-model steps.

## Proposed design

### 1. Request publication per run (Ensemble Manager)

`POST /plans` gains `publish: string[]`, a list of catalog tokens.

- Empty or absent: no change. Unknown token: 422 `PUBLISH_CATALOG_UNKNOWN`
  listing the tokens `GET /plans/publishers` offers for this model. The EM
  holds no token list; the adapter is the source of truth.
- Present: the post-model target contract gets `catalog: tokens.join("+")`.
  For the identity (input-only) plan this is the model output's own contract
  plus `catalog`; for an explicit `post_model_adapter` it is merged into the
  supplied `target_contract`.
- The identity-plan guard `INPUT_ONLY_PLAN_NOT_IDENTITY` is relaxed by an
  adapter-returned marker, not by transform-type names: `/plans/deferred`
  returns `steps[].publishes: true` for a step whose output contract sets
  `catalog`, and the EM accepts only steps so marked. New publisher types
  need no EM change.
- The plan response's `parameters` carry the piece's user-facing arguments
  (`stac_collection`, `ckan_org`, `public`) with defaults and
  `allowed_values`. Managed arguments (`stac_url`, `ckan_url`,
  `stac_item_id`, `tapis_token`) never surface.
- The encoded plan carries only the token list (within the 2400-byte budget;
  a test asserts the size with all parameters present).

`GET /plans/publishers?model_id=` proxies the adapter's `GET /publishers`
(see 2), forwarding the caller's bearer token as every adapter call does.

### 2. Make the piece runnable (adapter)

- **One step.** The chain is `[catalog_register]`. The `catalog_register`
  task inventories the bound output's archive directory itself (the work
  SUBSIDE's `publish` task does), writes `<execution_id>-manifest.json`
  beside the products, and publishes. The two `manifest_emit` pieces stay
  registered for SUBSIDE-registry fidelity but are not part of this path;
  retiring them is a follow-up. No generalised task-to-task chaining is
  needed in `tapis.py`.
- **Code builder.** `task_code.py` gains `_CATALOG_REGISTER_SNIPPET`, ported
  from the SUBSIDE `publish` + `stac-publish` bodies. Inputs: `SOURCE_URI`
  (the bound `source_uri`, a `tapis://` archive dir), `STAC_URL`, `CKAN_URL`,
  `STAC_COLLECTION`, `CKAN_ORG`, `PUBLIC`, `STAC_ITEM_ID`, `EXECUTION_ID`,
  and the token through the same path late-started tasks use
  (`TOKEN_URL`/token fetch; `[ASSUMPTION — confirm]` the fetch path applies
  to post-model tasks, else the pipeline arg). Behaviour:
  1. Fail (exit 2) before any request if the token, `STAC_URL` or
     `CKAN_URL` is empty or malformed.
  2. Inventory products by the piece's filename pattern (from its
     `parameters_schema_json`, delivered through `env_from_args`), download
     them, derive bbox and datetime the way SUBSIDE's manifest does, write
     the manifest, upload it back to the archive.
  3. `GET` the Item first; if it exists and `properties.published_by`
     differs from the token's username, exit 2 (best-effort guard; see
     Risks).
  4. `publish_from_dir` with `private = not PUBLIC`; stamp
     `properties.published_by` and `properties.execution_id` on the Item.
  5. Emit `result = {"catalog": "ckan+stac", "ckan_dataset": url,
     "stac_item": url, "public": bool}`.
  6. Catch every exception and print only the class, HTTP status and a
     short body; scrub any token-shaped string from output.
  `stac-platform` is installed at a pinned commit SHA (a wheel or vendoring
  is preferred if the spike shows the archive install is slow). Function
  tasks of this type get `max_exec_time` from the spike's measurement.
- **Managed and allow-listed arguments.** `stac_url`, `ckan_url` and
  `stac_item_id` (= `execution_id`) are managed: bound from adapter settings
  and the run, never from user args. `stac_collection` must be in
  `SVO_ADAPTER_PUBLISH_ALLOWED_COLLECTIONS` and `ckan_org` in
  `SVO_ADAPTER_PUBLISH_ALLOWED_ORGS`; both are validated at plan time and
  again at bound submit (plans are immutable, args are not). Dev settings:
  `subsidence-rates-dev` and `dso-internal`; production: `subsidence-rates`
  and `stac-datasets` (where the existing SUBSIDE datasets live). `public` is a boolean parameter, default false.
  `SVO_ADAPTER_PUBLISH_ENABLED=false` makes `get_code("catalog_register")`
  fail closed, a kill switch that needs no revert.
- **`GET /publishers?configuration_id=`.** For the configuration's output
  contract, every registered `catalog_register` piece reachable by
  `find_path`, each with `catalog_tokens`, user-facing parameters with
  `allowed_values`, and `can_publish: {ok, reason}`. The precheck calls the
  settings CKAN URL only (`organization_list_for_user`, caller's token,
  timeout, no redirects, percent-encoded org). It is advisory: STAC accepts
  any Tapis user, so the real authorization is the allow-lists and the
  identity rule in 3. The collection need not pre-exist
  (`ensure_collection`).
- **Published state.** One name: `publication`. The adapter derives it
  from the publish task's `result` at run-status time (no new write path),
  exposes it on `GET /runs/{id}`, sets the bound data object's
  `catalog = "ckan+stac"` and its published resource URIs, and records
  provenance `run.output.published` with the same fields and no `args`
  (the existing token filter applies). The EM copies it to
  `unified_execution.output_handoff.publication = {status: published |
  failed, error?, ckan_dataset?, stac_item?, public?}`.

### 3. Identity and credentials

The publication runs as the user who submitted the run, not as whoever
observed completion.

- The adapter enforces it at the bound submit: the parent composite run for
  the same `execution_id` has `submitted_by`; if the caller's token names a
  different user, 403 `RUN_OWNER_MISMATCH`. The EM surfaces that as
  `output_handoff.publication = {status: "awaiting_owner"}` and does not
  treat it as a failure or a stale child; the owner's next poll dispatches.
- The post-model run's token is seeded from the parent run's keeper entry
  rather than the request header when the caller is the owner
  (`[ASSUMPTION — confirm]` `run_tokens` can seed a child run; otherwise the
  owner's header token is used, which the ownership check has already
  validated).
- No stored CKAN key. `env_from_args` on `ts-subside-stac-publish` changes
  `ckan_token` → `tapis_token` and adds `STAC_TOKEN: tapis_token`; this
  touches the adapter registry only, since SUBSIDE's YAML pipelines do not
  read it.
- Security-reviewer sign-off is required on this section and on section 2's
  managed arguments before implementation.

Consequences: the CKAN dataset is owned by the user in the chosen
organisation (membership required; prechecked); the STAC Item carries
`published_by` and `execution_id` for audit and cleanup. A user with a raw
Tapis token can still bypass the client-side Item guard against the STAC
API; server-side ACLs are a stac-platform follow-up.

### 4. Failure semantics

Publication is an outcome of a completed run, not a run status. The unified
execution ends `completed` with `output_handoff.publication.status =
"failed"` and the step's error; the model output stays registered and
visible. `reconcilePostModel`'s stale-child retry predicate excludes a child
whose adapter run reports `publication.status == "failed"`, so a failed
publish is not re-dispatched (and never under a different identity), and
the legacy thread execution is marked completed with its output. This
reverses rev 2, which chose `failed` + `PUBLICATION_FAILED` and conflicted
with the EM's retry loop and legacy mirroring.

### 5. UI

The thread run form gets a "Publish outputs" section: a toggle, a catalog
choice from `GET /plans/publishers`, the collection and organisation from
their allowed values, and a "public" checkbox with a one-line explanation
that the SUBSIDE map needs public assets. The plan preview shows the
publication step after the output handoff. A finished run shows the links or
the publication error from `output_handoff.publication`.

### 6. Generality

Any catalog becomes available by registering one `catalog_register` piece
whose output contract carries its token and whose input contracts cover the
model output's format, with a code builder (or `python_source`) for its
type. The planner, the `publish` flag, `GET /publishers`, the `publishes`
marker and the UI control need no change.

## Files likely affected

- `svo-adapter-service/app/task_code.py` (`_CATALOG_REGISTER_SNIPPET`,
  `get_code` case, kill switch), `app/tapis.py` (per-type `max_exec_time`;
  managed publish args; token path for post-model tasks), `app/planner.py`
  (no code change expected; path test), `app/main.py` (`GET /publishers`,
  `publishes` marker on `/plans/deferred` steps, `RUN_OWNER_MISMATCH` at
  bound submit, allow-list validation, `publication` on runs, provenance),
  `app/config.py` (four settings), `examples/subside_*_transforms.json`
  (`env_from_args` token change; filename pattern; `allowed_values`), tests.
- `mint-ensemble-manager/src/api/api-v1/services/unifiedExecutionService.ts`
  (`publish` → target catalog; `publishes`-based guard; `awaiting_owner`;
  non-retry of failed publication; `output_handoff.publication`; legacy
  mirror), `paths/unifiedExecution.ts` (OpenAPI), tests.
- `ui-react/src/lib/ensemble-manager.ts`, `pages/modeling/thread/*`
  (publish control, links, publication state), tests.
- `stac-platform`: none (pinned by SHA). `subside`: none.
- Docs: DSO `docs/services/svo-adapter.md`, `docs/services/mint-platform.md`,
  `docs/dev/environment-variables.md`.

## API/schema changes

- EM `POST /plans`: optional `publish: string[]`; 422 `PUBLISH_CATALOG_UNKNOWN`.
  `GET /plans/publishers?model_id=`. `output_handoff.publication` (jsonb,
  no migration).
- Adapter `GET /publishers?configuration_id=`; `/plans/deferred` steps gain
  `publishes`; `GET /runs/{id}` gains `publication`; bound submit may return
  403 `RUN_OWNER_MISMATCH` or 422 `PUBLISH_VALUE_NOT_ALLOWED`.
- Settings: `SVO_ADAPTER_PUBLISH_ENABLED`, `SVO_ADAPTER_PUBLISH_ALLOWED_COLLECTIONS`,
  `SVO_ADAPTER_PUBLISH_ALLOWED_ORGS`, `SVO_ADAPTER_PUBLISH_DEFAULT_COLLECTION`.
- No database migration.

## Data flow

plan (`publish: [ckan, stac]`) → EM sets target `catalog: ckan+stac` →
adapter `/plans/deferred` → path `[catalog_register]` (`publishes: true`),
parameters surfaced with allowed values → submit → input ETL → model job →
output handoff registers the data object → bind → owner-checked bound submit
→ `catalog_register` task: inventory, manifest, publish as the owner →
`result` → `publication` on the run and `catalog` on the data object → EM
`output_handoff.publication` → UI links; the SUBSIDE map sees the Item when
the collection is `subsidence-rates` and the dataset is public.

## Risks and tradeoffs

- **Dev writes into production catalogs.** No dev CKAN or STAC exists.
  Controls: collection and organisation allow-lists per deployment (dev
  cannot name `subsidence-rates`), `public` default false, production writes
  behind an approval gate. Open question 1 covers a dev CKAN organisation.
- **Confused deputy.** Closed by the adapter's owner check and the EM's
  `awaiting_owner` state; a non-owner poll can never publish.
- **STAC overwrite.** `stac_item_id` managed, allow-listed collections, the
  `published_by` guard. Residual: a raw-token user bypassing the client
  guard; server-side ACLs are a stac-platform follow-up.
- **Token exposure.** Same transport as every adapter task; added exposure is
  two external hosts and third-party code at run time. Controls: managed
  URLs (no exfiltration target), SHA-pinned install, redaction and scrub in
  the snippet, token-free provenance. Logs in Workflows remain readable by
  pipeline members, as today.
- **Function-task runtime.** Unmeasured. A spike on the Waco archive is a
  prerequisite (Rollout step 0) and sets `max_exec_time`.
- **Duplicates.** Item id = execution id, dataset keyed by `stac_item_id`,
  `publish_from_dir` upserts; failed publications are not retried.
- **Published rows outlive a rollback.** `published_by` and `execution_id`
  make cleanup a query; dev-collection cleanup is a documented, approved
  `stacmap` command.
- **Two unused manifest pieces** stay in the registry until a follow-up
  retires them; they cannot be planned into a DYNAMO path.

## Alternatives considered

- **Declare publication on the model output in the catalog.** Rejected by
  the user: publishing is the user's decision per run.
- **Publish from the Ensemble Manager directly.** Rejected: duplicates
  `stacmap.publish` and bypasses the bridge.
- **Keep the two-step `manifest_emit` → `catalog_register` chain.** Rejected:
  the shortest-path planner never selects a geotiff → geotiff step; forcing
  it would need a synthetic manifest format and generalised task chaining
  for no functional gain.
- **A stored CKAN API key or service account.** Unnecessary and loses user
  ownership; kept for publishers that need keys.
- **Run `failed` + `PUBLICATION_FAILED`** (rev 2). Rejected: the EM retries
  failed post-model children and mirrors `failed` to the legacy thread
  without the output.
- **A `catalog` column on the ETL contract table.** Unnecessary; the `_svo`
  marker already round-trips.

## Test plan

Each bullet names its pass criterion.

- Planner: from the synced registry, `{geotiff}` → `{geotiff, catalog:
  ckan+stac}` plans exactly `[catalog_register]` with `publishes: true`;
  `publish: ["stac"]` resolves to the same; target `catalog: zenodo` →
  `NO_DEFERRED_TRANSFORM_PATH`; the synced `c-stac-out` has
  `catalog == "ckan+stac"` (regression on the existing marker test).
- Task code, against fake Tapis/CKAN/STAC: empty token → exit 2 and no HTTP
  call; existing Item with another `published_by` → exit 2 and no write;
  success issues one dataset create, N uploads, one Item upsert with
  `published_by`/`execution_id`; second run issues updates only; a fake
  server echoing the Authorization header leaves no token in stdout.
- Adapter: bound submit by a non-owner → 403 `RUN_OWNER_MISMATCH` and no run
  row; collection or org outside the allow-list → 422 at plan and at submit;
  `SVO_ADAPTER_PUBLISH_ENABLED=false` → the task fails closed.
- EM: `publish: ["ckan","stac"]` sets the target catalog and the plan lists
  `stac_collection`, `ckan_org`, `public` with allowed values; unknown token
  → 422; guard accepts `publishes: true` steps and rejects a `unit_convert`;
  a child with `publication.status == "failed"` is not re-dispatched and the
  execution is `completed` with the output in `output_handoff`; a 403 from
  the adapter yields `awaiting_owner`, not `failed`; the plan id with all
  parameters stays under 2400 bytes; an old identity plan (the Waco plans,
  decoded from fixtures) still dispatches zero post-model steps.
- `GET /publishers`: membership present → `can_publish.ok`; absent →
  `ok: false` with the CKAN reason.
- UI: control absent when the publishers list is empty; disabled with the
  reason when `can_publish` is false; collection, organisation and `public`
  appear in the submit body's `parameter_values`.
- Spike (step 0): one hand-built `catalog_register` task on the Waco WERC
  archive into `subsidence-rates-dev`, private: records wall time, peak
  memory and disk; a STAC Item intersecting the Waco bbox exists; a private
  CKAN dataset owned by the user holds the COGs.
- Live, gated: a Waco WERC run with `publish: ["ckan", "stac"]`,
  `subsidence-rates-dev`, public: the run ends `completed` with
  `publication.status == "published"` and both links. Then, with approval
  and the production allow-list, the same into `subsidence-rates`: the
  raster is visible in the SUBSIDE map.

## Documentation plan

- DSO `docs/services/svo-adapter.md`: "Output-side publication" section,
  `GET /publishers`, `publication` on runs, the owner rule.
  `docs/services/mint-platform.md`: the `publish` plan field and
  `output_handoff.publication`. `docs/dev/environment-variables.md`: the
  four settings.
- SUBSIDE README: DYNAMO runs can publish into the same collection.
- `2026-11-05-aoi-etl-piece.md` and `2026-11-05-app-input-binding.md`:
  pointer here under Decisions.

## Rollout/rollback plan

0. Prerequisites: the runtime spike (approved external write into
   `subsidence-rates-dev`, private); confirmation that CKAN accepts the
   user's Tapis JWT for dataset creation; security-reviewer sign-off on
   sections 2 and 3.
1. Adapter: builder, settings, managed args and allow-lists, owner check,
   `publishes` marker, `GET /publishers`, registration re-run and sync.
   Inert until a plan targets a catalog; `SVO_ADAPTER_PUBLISH_ENABLED`
   defaults to false until step 4.
2. EM: `publish` flag, guard, `awaiting_owner`, non-retry, `publication`.
3. UI: control, links, publication state.
4. Enable on dev; live test into `subsidence-rates-dev` (approval gate).
5. Production allow-list and live test into `subsidence-rates` (second
   approval gate).
Rollback: `SVO_ADAPTER_PUBLISH_ENABLED=false` stops new publications
without a revert; reverting the EM flag stops plans from targeting a
catalog. Published dev rows are removed by the documented `stacmap` command;
production rows stay unless the user asks.

## Open questions

1. (Decided 2026-11-05) Dev datasets go to the existing `dso-internal`
   organisation, private; production to `stac-datasets`, where the SUBSIDE
   pipelines already publish.
2. Should the SUBSIDE map show Items published by individual users, or only
   those from the SUBSIDE pipelines? Decides whether step 5 is wanted.
3. Production default for `public`: false (user opts in) or true for
   `subsidence-rates`? Recommendation: false everywhere; the UI explains.

## Decisions

- 2026-11-05: Request publication per run on the thread, not by declaring it
  on the model output. The user's words: "I like your recommendation."
- 2026-11-05: Publish as the submitting user with a Tapis token; no stored
  CKAN key. Reason: CKAN at TACC and the STAC API both accept a Tapis
  bearer; the STAC API allows any Tapis user to write; the adapter keeps a
  per-run token.
- 2026-11-05 (rev 2): dev default collection `subsidence-rates-dev`,
  production `subsidence-rates`.
- 2026-11-05 (rev 3, architect): single `catalog_register` step that builds
  the manifest itself; the two-step chain is unplannable under shortest-path
  search. Dropped the catalog round-trip work item: the `_svo.catalog`
  marker already exists (rev 1/2 premise was wrong).
- 2026-11-05 (rev 3, skeptic): publication is an outcome on a completed run
  (`output_handoff.publication`), not a `failed` status; the EM's stale-child
  retry excludes failed publications. Reverses rev 2. The collection need not
  pre-exist (`ensure_collection`); CKAN datasets are private by default, so
  `public` is an explicit parameter.
- 2026-11-05 (rev 3, security): owner check at bound submit
  (`RUN_OWNER_MISMATCH`, `awaiting_owner` in the EM); `stac_url`, `ckan_url`,
  `stac_item_id` managed; collection and organisation allow-lists validated
  at plan and submit; `published_by`/`execution_id` stamped; SHA-pinned
  install; redaction; `SVO_ADAPTER_PUBLISH_ENABLED` kill switch; runtime
  spike before building.
- 2026-11-05 (rev 3): the EM's identity guard keys on an adapter-returned
  `publishes` marker, not on transform-type names (architect).
- 2026-11-05: CKAN probe with the user's token confirmed the Tapis-JWT path
  and showed `tacc-water` does not exist; the existing collection's datasets
  are in `stac-datasets` and public. Defaults corrected: production org
  `stac-datasets`, dev org `dso-internal`. `public` stays default false
  even though the existing datasets are public, so the user opts in.

- 2026-11-05 (implementation deviations, adapter): the adapter data object
  has no `catalog` column, so the published catalog is recorded only in
  `publication` and the `run.output.published` event (a migration is a
  follow-up; `source_catalog` was not reused because `/datasets/find`
  filters on it). A separate `publish_ckan_url` setting was added because
  the existing `ckan_url` defaults to a local NTGAM instance. The Item guard
  runs before any download so a refused run writes nothing. `publication`
  on `GET /runs/{id}` is null until the publish task has finished. The shared
  STAC piece carries one product-pattern list covering both models.
  `DeferredPlanIn` gained optional `parameter_values` so the allow-list can
  be checked at plan time. `execution_id` is required on a publish submit
  (`PUBLISH_EXECUTION_ID_REQUIRED`). After security review the owner check
  applies to publish plans only and fails closed: no parent composite run →
  409 `PARENT_RUN_UNKNOWN`, ownerless parent or unidentifiable caller → 403;
  the parent lookup uses the adapter's own Hasura client. `tapis_base_url`
  is managed; the pinned ref must be a full 40-hex SHA (validated at
  startup); an existing CKAN dataset is touched only when its `stac_item_id`
  and `published_by` extras match the run and the caller. After QA the kill
  switch also governs `/publishers` (`can_publish.ok = false`) and
  `/plans/deferred` (422 `PUBLISH_DISABLED`); a publish run's `output_uri`
  is the bound model output, never a catalog URL; `can_publish` gained
  `orgs_ok`.
- 2026-11-05 (implementation deviations, EM): new 422
  `PUBLISH_REQUIRES_POST_MODEL` for a non-Tapis engine, `input_etl: false`
  or pre-model `adapter_steps`; `publish` builds the identity post-model
  plan even when no input steps are derived, so publication does not depend
  on input ETL. `awaiting_owner` needs no stale-child exclusion because the
  403 happens before a child exists, and is set only for plans with `publish`.
  After QA: a child with a publication outcome completes the run from
  `output_handoff` alone (no `register-output`, no legacy-output overwrite,
  no wait on the child's `output_uri`); submitted values are validated
  against `allowed_values` at submit (422 `PARAMETER_VALIDATION_FAILED`);
  top-level `parameter_values` and `adapter_parameter_values[plan]` are
  merged; the `compositeOutput` fallback applies only to runs with a
  publication outcome.
- 2026-11-05 (implementation deviations, UI): chosen publish values travel
  in the submit body's top-level `parameter_values` (the EM falls back to it
  when `adapter_parameter_values` is absent); one publisher is selected at a
  time; the publish graph node appears from `publishes` steps or from a
  recorded `publication`.
- 2026-11-05 (deviation, first live attempt): the first publish from DYNAMO
  failed with 422 NO_DEFERRED_TRANSFORM_PATH. Cause: with `publish` and no
  `model_output_key`, the EM planned the model's *first declared* output
  (H2I: the archive zip; WERC: the anchor JSON), whose format no publisher
  input accepts, while `GET /publishers` had matched a *later* output (the
  GeoTIFF). Fix: `GET /publishers` now evaluates every output contract and
  reports `output_formats` (verbatim catalog formats of the outputs that
  reach the catalog); the EM picks the first declared output whose format is
  listed, honours an explicit `model_output_key` only when it is listed, and
  refuses with 422 PUBLISH_OUTPUT_NOT_PUBLISHABLE (details `requested`,
  `publishable`) when nothing qualifies; the UI offers an Output choice when
  more than one output qualifies and sends `model_output_key`. Formats are
  compared by equality in the EM and UI because both strings come from the
  same catalog column; aliasing stays in the adapter planner. An adapter
  without `output_formats` keeps the previous first-output behaviour.
  Consequence noted: the subsidence forecast (json outputs) and MODFLOW
  (hds/cbc) models cannot publish through the stac-publish piece as its
  input contracts stand; that is a piece-contract decision, not a bug.

- 2026-11-05 (follow-up, per-user organisations and CKAN-only): the form's
  `ckan_org` dropdown showed the deployment allow-list, not the caller's CKAN
  memberships, and `can_publish` passed only members of the *default*
  organisation. Now `GET /publishers` narrows `ckan_org.allowed_values` to
  `orgs_ok` (the caller's `create_dataset` organisations intersected with the
  allow-list, which stays the authorization bound at plan and submit) and
  `can_publish.ok` is true for any such organisation; the default is the
  configured one when the caller belongs to it, else the first usable one.
  A user may also choose CKAN alone ("the user should be able to toggle CKAN
  and STAC or just CKAN"): `/publishers` lists `catalog_options`
  (`[["ckan","stac"],["ckan"]]`), the UI's Catalog select offers one entry per
  option and sends the chosen tokens as `publish`, the EM refuses a set the
  adapter does not offer (422 `PUBLISH_CATALOG_UNSUPPORTED`) and sorts the
  tokens, and the adapter binds a managed `catalogs` argument from the plan's
  target contract (a plan from before the choice binds `ckan+stac`). The
  generator wires `CATALOGS` into the `catalog_register` task itself, so the
  live piece needs no re-registration (the example specs declare it too).
  CKAN is never optional: STAC assets are CKAN resource URLs, so a target of
  `stac` alone is refused at plan time. A CKAN-only dataset carries no
  `stac_collection` extra, because the reconcile bridge adopts datasets by that
  extra and would otherwise publish it to STAC after all; it carries
  `catalogs=ckan` instead. `publication` counts a result with a CKAN link but
  no STAC Item as published. Skeptic review (revise → addressed): full no-op
  STAC client surface, explicit default for old plans, EM-side validation of
  token sets, spec JSON updated alongside the generator.

## User feedback / decisions

- 2026-11-05: "approve" on rev 3. Open questions 1 and 3 proceed on the
  recommendations (dev datasets private in `tacc-water`; `public` defaults to
  false everywhere) until the user says otherwise; question 2 stays open and
  gates rollout step 5.

- 2026-11-05: "so publish and stac-publish should be etl pieces" → confirmed
  they are registered pieces; the gap is that DYNAMO never targets the
  cataloged contract and the adapter has no code builder for them.
- 2026-11-05: "this way we can add other publication processes? ... are we
  able to configure the publication process?" → yes to both; captured as
  section 6 and the parameters with allowed values in sections 1 and 2.
