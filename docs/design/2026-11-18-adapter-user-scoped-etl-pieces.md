# SVO adapter: user-scoped ETL pieces and safe execution of stored code

Status: Implementing (approved by user 2026-11-18). Phases 1–5 are merged and deployed to
dev (#416, #418, #419, #421, #422). Phase 6 is coded and tested in the `mcp-suite` working
tree but not committed. Phase 0's live checks are not all done.
Stored-source execution and user-scoped registry reads both ship switched off. See
"Implementation notes, Phases 2–6" under Decisions for deviations and what is still
unverified on a live pod.

Supersedes `mcp-suite/docs/design/2026-11-18-etl-function-piece-authoring.md`, whose two
reviews (security: no-go; skeptic: revise) are the reason for this rewrite. That spec's MCP
tool survives as Phase 6 here.

## Objective

Make the adapter act with the calling user's identity where it reads and plans ETL pieces,
so that a piece's owner and visibility are enforced. Only then let Python source stored in
the catalog run as a Tapis Workflows `function` task, and let the `dso-dynamo` MCP author
such pieces.

## User need

Tapis app jobs can wait hours in the HPC queue, so light ETL pieces should run as workflow
function tasks with inline code. The first consumers are the Semantic-Sensemaking / DNO
pieces. Registering a piece must not let one user's code run inside another user's run.

## Current code/system summary

Read on 2026-11-18, branch `fix/publish-submit-accepts-catalogs-on-old-plans`.

**Identity**

- The adapter's Hasura client attaches the admin secret whenever one is configured and then
  ignores the caller's bearer token (`svo-adapter-service/app/hasura.py:30-43`). A code
  comment gives the reason: the adapter tables have no user-level permissions.
- `_bearer()` (`app/main.py:281`) only strips the header. Most endpoints never validate the
  token. The cancel path does: it resolves the username with `tapis.userinfo_username(token)`
  (`app/tapis.py:1366`) and checks `run_state.may_cancel`.
- `_admin_secret_guard` (`app/main.py:3297`) protects only the secrets endpoints.
  `/admin/sync-from-mint` (`:960`) and `POST /transform-specs` (`:750`) have no guard; the
  second writes the registry directly.

**Catalog** (`graphql_engine/metadata/tables.yaml`, `modelcatalog_etl_process`)

- `user` may insert with `check: {}` and no preset; `owner_username` is an insertable column.
- `user` select is limited to public, shared, or own rows. No update or delete for `user`.
- The UI insert (`ui-react/src/pages/ETLProcessRegisterPage.tsx`) does not set `owner_username`.

**Registry** (`adapter.transform_spec`, migration `1771300000000_svo_adapter_schema`)

- No owner or visibility column. `user` and `anonymous` may select `id, name, description`
  of every row (`filter: {}`).
- The sync reads the catalog as admin, without `owner_username`, and keeps `visibility` only
  inside `parameters_schema_json.metadata` (`app/mint_sync.py:302-366`).
- Sync deletion is keyed on `mint_model_config_id`, which ETL-process rows do not have, so a
  process removed from the catalog stays in the registry.
- Every planning path reads the whole registry; the planner selects pieces by SVO contract
  match and never looks at owner or visibility.

**Execution** (`app/tapis.py`)

- A step without a Tapis app becomes a `function` task (`python:3.11`, `installer: pip`).
  Its code is `step.python_source` or a built-in from `task_code.get_code`.
- The planner reads source from `metadata.source.code` (`app/planner.py:418`, `:558`); the
  sync stores it at `metadata.runtime.source`. Source registered through the catalog
  therefore never reaches a task today.
- **Correction (2026-11-18, found while implementing Phase 1).** That defect is not the only
  barrier, as this spec first claimed. `POST /transform-specs` accepts `metadata.source.code`
  and `_spec_insert_obj` stores it at `parameters_schema_json.metadata.source`, exactly
  where the planner reads it. The route is unauthenticated, writes the shared registry with
  the admin secret, and accepts author-chosen `env_from_args`. The adapter's bundled console
  (`static/js/main.js`, "register piece") uses it. Stored code from any caller could therefore
  be planned into other users' runs. Verified locally by building the insert object; never
  exercised against a deployed pod. Phase 1 closed the route (see Decisions).
- Task inputs come only from the piece's `env_from_args`. Secret-bearing args
  (`_INPUT_SECRET_PARAMS`, `:727`: `tapis_token`, `ckan_token`, signal and token-fetch
  credentials, …) are refused for input steps (`:769`) but not for main steps (`:988`).
- The previous task's output is handed on only for `unit_convert` (`:1005`).
- `max_exec_time: 600` is set for input steps; the main function branch sets none.

**Not verified**

- That Hasura's auth hook sets `X-Hasura-User-Id` to the Tapis username.
- The shape of `adapter.transform_edge` and whether it can be filtered through its specs.
- Whether the Workflows runtime calls `entrypoint`, with what arguments, and what it must
  emit. The repo shows three conventions: `def transform()` (UI default), `def main(inputs)`
  (`tests/test_mint_etl_sync.py`), and module-level code calling `ctx.set_output` (built-ins).

## Proposed design

Six phases. Each is its own PR. Stored-source execution stays off until Phase 5, behind a
setting that defaults to off.

### Phase 0 — Probe the function runtime (no code change)

Submit one hand-written function task on dev to settle the three "not verified" execution
points: calling convention, output contract, and the time cap on a main step. Record the
result in this spec. Requires explicit approval (a live Tapis run).

Added after security re-review:

- Call Hasura on dev with a real Tapis token and confirm the session role and that
  `X-Hasura-User-Id` is the Tapis username. The auth webhook is an external image
  (`hasura-tapis-auth-webhook`), so this cannot be read from the repo.
- In the probe task, check whether code can read pipeline-wide args it was not bound to
  (the model task's `signal_*`, `credentials_url`, `token_fetch_*`), through the environment
  or the execution context. If it can, the Phase 4 refusal list is not a real control and
  those values must be kept out of pipelines that carry stored code.

**Results (2026-11-18, three runs of a two-task probe pipeline in group `subside-ops`, all
completed):**

- **`entrypoint` does nothing.** The engine stores the task with `entrypoint: null` whatever
  is sent, saves the code as `…/task/src/entrypoint.py` and runs that file as a script
  (`argv` is that path; `_OWE_ENTRYPOINT_FILE_PATH` names it). A function named by
  `entrypoint` is never called. Code written as `def transform(): …` defines the function,
  does nothing, and the task still reports success.
- **Inputs and chaining work through the execution context.** `ctx.get_input` returned the
  bound run argument and the previous task's `result` output; `ctx.set_output` is how a task
  hands a value on.
- **An unbound argument is not readable** by the three routes tested: `ctx.get_input` for
  it returned `None`, no environment variable held its value, and a scan of 2,085 files
  from `/` found it only in the probe's own source (where the probe embedded the marker).
  The Phase 4 allowlist is therefore a real control for these routes.
- **Default time cap is one hour.** A task with no `execution_profile` gets
  `max_exec_time: 3600`, `max_retries: 0`, flavor `c1med`. The adapter's main function
  steps run with that today.
- **Function tasks run in the Workflows cluster, not on an HPC system.** What task code can
  reach from there is to be confirmed with the Tapis team before stored code is enabled.
- **Hasura session user: inconclusive.** The check returned the same 50 public rows with
  and without a token, because the caller owns no private ETL process. It is settled in
  Phase 2 instead: with the owner preset in place, insert one private process on dev and
  read back its `owner_username`.

Consequences for later phases:

- Phase 5 cannot rely on `entrypoint`. Either stored code must be a top-level script that
  calls `ctx.set_output("result", …)`, or the adapter appends a call to the named function
  and sets the output from its return value. The second keeps the catalog UI's
  `def transform()` default working and is the proposed choice.
- The adapter should stop emitting the `entrypoint` key, which is silently dropped.
- Until Phase 5, a piece whose code only defines a function must be rejected at
  registration or plan time rather than left to succeed while doing nothing.

### Phase 1 — Caller identity and endpoint authentication

- One helper, `caller_username(token)`, built on the existing `userinfo_username`, with a
  short in-memory cache keyed by token hash. Missing or invalid token → 401.
- Every `/admin/*` route and `POST /transform-specs` require `_admin_secret_guard`. The
  re-review listed the unguarded ones: `reset`, `seed-*`, `recompute-edges`, `poll`,
  `validate-tapis`, `sync-from-mint`, `sync-from-ckan`. A test enumerates the app's routes
  and fails if any `/admin/` path lacks the guard.
- `/transform-specs/{id}/test` requires a valid caller and, once Phase 2 lands, that the
  caller may see the piece.

### Phase 2 — Ownership carried end to end

- Hasura: insert preset `owner_username: X-Hasura-User-Id` on `modelcatalog_etl_process`,
  and drop `owner_username` from the insertable columns. Fixes spoofing and the UI's
  ownerless private rows.
- Migration: add `owner_username`, `visibility` (default `public`), `mint_etl_process_id`
  and `approved_source_sha256` (default null) to `adapter.transform_spec`.
- Sync: read `owner_username`; copy owner and visibility to the new columns; set
  `mint_etl_process_id`; delete ETL-process rows no longer in the catalog. Pieces derived
  from ModelConfigurations and built-in pieces stay `public`, owner null. They carry no
  stored source, so the approval rules do not apply to them.
- Approval is recorded as `approved_source_sha256`, not a bare flag. A piece counts as
  approved only while the hash of its current source equals that value, so a source change,
  or a delete and re-insert, drops the approval. It is settable only through an admin route
  and is never copied from the catalog.
- The catalog insert default for `visibility` stays `private`.

### Phase 3 — Read the registry with the user's credentials

- Hasura `user` select on `transform_spec`, `transform_contract` and `transform_edge`
  becomes: public, or shared, or `owner_username = X-Hasura-User-Id`, with the columns the
  planner needs. Contracts inherit the rule through their spec.
- `transform_edge` has no spec column and no `user` select permission today (verified). It
  gets one whose filter requires both ends to be visible:
  `_and: [{source_contract: {transform_spec: VIS}}, {target_contract: {transform_spec: VIS}}]`.
  `_load_edge_map` (`app/main.py:874`) moves to the user client.
- A second client constructor, `get_user_client(token)`, sends only the bearer token and
  never the admin secret. Planning, readiness and registry-listing paths use it.
- Background work (sync, poller, edge recompute) keeps the admin client.
- Other adapter tables (plans, runs, provenance, data objects) are out of scope here; they
  keep the admin client and their existing ownership checks.

### Phase 4 — Execution-time controls

Reading with user credentials stops private pieces leaking. It does not stop a shared or
public piece written by someone else from being planned into a run. So, for a piece that
carries stored source:

- The planner may select it automatically only if the submitting user owns it, or it is
  `shared` or `public` and `approved`.
- An unapproved `shared` or `public` piece owned by someone else is runnable by other users
  (user decision, 2026-11-18), but never chosen for them. The submitting user must name the
  piece in the plan request, and the plan preview shows its owner and that it is unapproved
  code that will receive their Tapis token. (Guard confirmed by user, 2026-11-18.)
- A `private` piece is runnable only by its owner.
- It may bind `tapis_token`, because reading Tapis files needs it. This is safe only
  because of the rule above: the code is either the submitting user's own, or has been
  approved. The token it receives is always the submitting user's.
- Every other `_INPUT_SECRET_PARAMS` binding is refused for it, on main steps as well as
  input steps: the signal and token-fetch credentials (which could forge run signals or mint
  fresh tokens), `credentials_url`, `ckan_token` and `stac_token`.
- The plan records the piece id, owner and a sha256 of the source; the same goes into run
  provenance. A plan whose stored hash no longer matches is rejected at submit.
- A setting, `stored_source_enabled` (default `false`), disables all of this path.

Added after security re-review. Without these the rules above can be bypassed, so they are
conditions for turning the setting on:

- **Re-check at submit, against the submitter.** `/workflows/submit` loads a plan by id with
  no owner check (`app/main.py:2582`), so a plan made by the piece's author could be handed
  to another user and run with that user's token. Every stored-source piece in a plan is
  re-evaluated against the submitting user at submit time. The opt-in for an unapproved
  piece is recorded per plan and per submitter, and does not transfer.
- **Same check in `/transform-specs/{id}/test`**, which today submits any registry piece
  with the caller's token (`app/main.py:842`).
- **Ensemble Manager runs.** A bound plan submitted with the internal service secret is
  checked against the run's owner, with the same rules. Unverified whether such a plan can
  carry stored code today.
- **Allowlist, not denylist.** Stored code may bind `tapis_token`, `source_uri` and the run
  arguments the piece declares. Everything else is refused.
- Each stored-source run writes an audit event: piece id, owner, source hash, submitter.

Not adopted from the re-review: blocking users from setting `shared` or `public` on a piece
with stored code. That contradicts the decision that shared pieces are runnable by others.
The opt-in and the submit-time re-check are what protect the other user instead.

Built-in transform types are unaffected.

### Phase 5 — Make stored source runnable

- One helper resolves a step's source and entrypoint from `metadata.runtime`, accepting the
  UI's `{language, code}` shape and a plain string; used by both planner sites.
- Default input wiring for a generic piece: the previous task's `result` is passed as
  `SOURCE_RESULT`, as is done today for `unit_convert`. `env_from_args` from the catalog row
  adds named run arguments, subject to the Phase 4 refusal list.
- An explicit `max_exec_time` on main function steps.
- The calling convention enforced and documented is whatever Phase 0 establishes; the UI
  default and the existing test fixture are brought into line with it.

### Phase 6 — `create_etl_function_piece` in `dso-dynamo` (mcp-suite)

As designed in the superseded spec, with these changes: it sends `env_from_args`; it does
not send `owner_username`; visibility is restricted to `private` in the first release; the
default id carries a short random suffix; source size is checked before parsing.

## Files likely affected

- `svo-adapter-service/app/`: `hasura.py`, `main.py`, `mint_sync.py`, `planner.py`,
  `tapis.py`, `config.py`, plus tests
- `graphql_engine/`: one migration, `metadata/tables.yaml`
- `ui-react/src/pages/ETLProcessRegisterPage.tsx` (entrypoint default, Phase 5)
- `mcp-suite/servers/dynamo` (Phase 6)
- DSO-Architecture: adapter service page, auth page, environment variables

## API/schema changes

- New columns on `adapter.transform_spec`: `owner_username`, `visibility`,
  `mint_etl_process_id`, `approved_source_sha256`.
- Hasura: insert preset on `modelcatalog_etl_process`; new select filters on three adapter
  tables.
- `/admin/*` and `POST /transform-specs` start returning 401/403 without the admin secret.
  Callers that rely on them unauthenticated must be updated (the deploy pipeline and
  `dso-dynamo` do not call them; scripts and operators may).
- New adapter setting `stored_source_enabled`.
- New MCP tool and `DYNAMO_HASURA_URL` (Phase 6).

## Data flow

1. A user registers a piece (UI or MCP). Hasura stamps the owner from their session.
2. The sync (admin) copies it, with owner and visibility, into the registry.
3. A user plans a run. The adapter reads the registry with that user's token, so Hasura
   returns only pieces they may see.
4. The planner drops stored-source pieces the user neither owns nor has had approved.
5. The generated function task carries the source and its hash; the run executes under the
   submitting user's Tapis token, with no secret args bound to stored code.

## Risks and tradeoffs

- **Two clients, one easy mistake.** A planning path left on the admin client silently
  bypasses scoping. Mitigation: a test that fails if a planning route constructs the admin
  client, and Phase 4 as a second line that does not depend on Hasura.
- **Edge cache.** Edges are precomputed across all pieces. If they cannot be filtered
  through their specs, the planner must recheck every edge's pieces, or the cache must be
  rebuilt per visibility class.
- **Breaking operators.** Guarding `/admin/*` may break scripts that call them bare.
- **Approved public code sees the submitter's Tapis token.** Tapis has no narrower token to
  hand out, so approval is the control: whoever approves a public piece is vouching for
  code that will hold other users' tokens. Approval must therefore not be something the
  piece's author can grant to themselves.
- **Approval is manual.** Public stored-source pieces need an admin step; there is no review
  UI in this spec.
- **Scope.** Six PRs across three areas before the original goal is met.

## Alternatives considered

- **Built-in pieces only.** Add each transform to the adapter repo, reviewed by PR. No
  stored code and none of this work, but every new piece needs a deploy. Still the fastest
  route for the first Semantic-Sensemaking pieces and compatible with this spec.
- **Keep the admin client and filter in Python.** Smaller change, but the scoping rule
  would live in every query rather than in Hasura.
- **Move every adapter table to user credentials now.** The right end state, far larger,
  and not needed to close this exposure.
- **Fix only the source path.** Rejected: it enables cross-user code execution.

## Test plan

- Phase 1: 401 without a token; 403 on admin routes without the secret.
- Phase 2: sync copies owner and visibility; removed process is deleted; preset overrides a
  client-sent owner (Hasura metadata test).
- Phase 3: with two users, each sees only public, shared and own pieces through every
  planning route; guard test against the admin client on planning routes.
- Phase 4: another user's private or unapproved piece is never planned; secret bindings
  refused on main steps; hash mismatch rejected; everything inert when the setting is off.
- Phase 5: catalog row → sync → planner → task, asserting code, entrypoint, non-empty input
  and chaining to a second step.
- Run adapter tests in a clean `develop` worktree (five tests fail locally from `.env`).
- Live, each with explicit approval: the Phase 0 probe, and a two-user check on dev.

## Documentation plan

Adapter `docs/api.md` (auth on endpoints, piece visibility), DSO-Architecture adapter and
auth pages and environment variables, `dso-dynamo` README (Phase 6).

## Rollout/rollback plan

Phases merge to `develop` and deploy to dev in order. Phases 1–3 are behaviour-tightening
and independently revertible; the migration is additive. Phases 4–5 are inert until
`stored_source_enabled` is set on the pod. Rollback for stored code is to unset it. A bad
catalog row is removed by an admin delete followed by a sync (Phase 2 makes the sync
propagate it).

## Open questions

1. ~~Is a `shared` piece visible to every signed-in user?~~ Yes (user, 2026-11-18).
2. ~~Who approves stored-source pieces?~~ Admin only (user, 2026-11-18). A piece's author
   cannot approve it.
3. ~~Ship the first Semantic-Sensemaking pieces as built-ins in parallel?~~ Yes (user,
   2026-11-18). Tracked separately from this spec.
4. ~~How should stored code read Tapis files without the token?~~ It is given the token;
   see Phase 4.
5. ~~Should a `shared` piece with stored code be runnable by other users?~~ Yes (user,
   2026-11-18). Open: whether an unapproved one needs the explicit opt-in proposed in
   Phase 4, or may be auto-planned like an approved one.

## Decisions

- 2026-11-18: Light ETL pieces run as Workflows function tasks; Tapis apps are for heavy
  work only (user).
- 2026-11-18: The adapter must use the user's credentials for piece visibility (user).
- 2026-11-18: The source-path fix does not ship before owner scoping and execution controls
  (security and skeptic reviews of the superseded spec).

### Phase 1 implementation notes and deviations (2026-11-18)

- **A new credential, not `_admin_secret_guard`.** That guard is dedicated to
  `/admin/secrets` and says so. Operator routes use a new setting,
  `SVO_ADAPTER_ADMIN_ROUTE_SECRET`, sent as `X-Admin-Secret`. Unset → 503, wrong → 403.
- **A middleware, not per-route guards.** It covers every `/admin/*` path (except
  `/admin/secrets`) and `POST /transform-specs`, so a route added later is covered without
  anyone remembering. A test still enumerates the app's routes.
- **Demo mode is exempt.** Its store is in-memory, the test suite and the bundled console's
  seeding depend on the open routes, and the setting is documented as never for production.
- **`/transform-specs/{id}/test`** requires a Tapis-verified caller outside demo mode. No
  username cache yet; one call site does not need it. It arrives with Phase 3.
- **Deploy.** `deploy/tapis/register_mint_stack.py` passes the new variable through when it
  is set. Until it is set on a pod, that pod's operator routes answer 503.
- **Known regression on live pods.** The bundled console's "register piece", "Seed DFC" and
  "Sync CKAN" buttons call operator routes from the browser and will get 403. They become
  operator-only until a user-scoped path exists (Phases 2–4).
- Four `tests/test_demo_api.py` tests fail on an unmodified copy of `develop` as well.
- **Outcome.** Merged as #416 (`31dec05`) and deployed to `mintdevsvo` on 2026-11-18.
  Checked without credentials: `GET /admin/sync-status` and `POST /transform-specs` answer
  403, `POST /transform-specs/{id}/test` answers 401, `GET /transform-specs` still answers
  200. None of the 234 pieces then in the dev registry carried stored source. Not checked:
  an operator call with the correct secret. This spec was held out of #416 because the
  repository is public and the route was still open.

### Implementation notes, Phases 2–6 (2026-11-18)

**Phase 2 — ownership (#418, merged).** As designed. The contract insert permission was
also tightened: a contract can only be added to a process the session user owns. The sync
skips ETL deletion when the catalog lists no ETL process at all, mirroring the existing
rule for configurations, so an empty or failed listing cannot empty the registry.
Approval is set through `PUT /admin/transform-spec-approval` with the piece id in the body,
because piece ids are URIs.

**Phase 3 — user-scoped reads (#419, merged).** All 16 registry reads go through one helper.
Deviations:

- It is behind a setting, `SVO_ADAPTER_REGISTRY_USER_SCOPED`, off by default, because the
  Hasura session-user check is still outstanding.
- No Hasura permission was added on `adapter.transform_edge`. Edges are still read for
  every piece; `build_edge_map` keeps only edges leading into a piece in the caller's
  registry, which gives the same result with less to maintain. Tested.
- A caller with no token is anonymous and sees public pieces only. Planning does not
  require a token. (The user was asked and did not choose; this is the non-breaking option.)

**Phase 4 — execution controls (#421, merged).** As designed, with these limits:

- The opt-in for an unapproved shared or public piece exists on `POST /plans`
  (`allow_unapproved_piece_ids`) and on the piece test endpoint (`allow_unapproved`). The
  other planning endpoints (deferred, DFC fan-out, model-run, forecast) never choose an
  unapproved piece and offer no opt-in.
- Ensemble Manager runs get no special path. A submit whose plan carries stored source is
  checked against whoever the bearer token identifies; with no valid token nothing but an
  approved piece passes.
- A piece registered straight into the adapter by an operator has no owner, so its stored
  source runs only once approved.
- The username lookup is cached for 60 seconds per token.

**Phase 5 — runnable stored source (#422, merged).** As designed, using the wrapper option: when the
source defines its entrypoint, the adapter appends a call that passes the task inputs as
one dict and writes the return value to `result`. Deviations:

- The explicit time limit (600 s, no retries) is applied to main steps that run stored
  source only. Built-in main function steps keep the engine default of one hour, because
  shortening them could break existing long transforms.
- The hash recorded on a plan step is of the author's source, not of the wrapped code.
- The catalog UI's `def transform()` default now works unchanged, so the UI was not edited.

**Phase 6 — `create_etl_function_piece` (mcp-suite).** As revised: private only, no
`owner_username` sent, `env_from_args` supported, random id suffix, size checked before
parsing. `servers/dynamo` is not yet committed to the `mcp-suite` repository, so the tool
exists only in that working tree.

**Deploy incident.** The dev deploy for #418 failed: Hasura refused the metadata file
because #415 had declared the relationship `configuration_parameters` on
`modelcatalog_parameter` twice. Migrations had applied; metadata and every later deploy
step had not, so neither #415's owner-scoped writes nor #418's owner preset was live. #420
removed the duplicate and added a test that fails on any repeated relationship name. Its
deploy applied the metadata from #415 and #418 for the first time, without further error.

**Checked on dev after the deploys.** The adapter lists all 234 pieces, each with a
`visibility` (all `public`). An anonymous Hasura query can read the registry columns and
contracts of public pieces. Both settings remain unset on the pod.

**Not yet verified on a live pod**

- That Hasura's session user id is the Tapis username. #418 is now live, so: insert one
  private ETL process as a signed-in user and read back `owner_username`. Until it passes,
  leave `SVO_ADAPTER_REGISTRY_USER_SCOPED` unset.
- A stored-source piece running end to end. The wrapper is executed in tests against a
  stand-in for the Workflows execution context, not on Tapis.
- What task code can reach from inside the Workflows cluster. To be confirmed with the
  Tapis team before `SVO_ADAPTER_STORED_SOURCE_ENABLED` is set anywhere.

## User feedback / decisions

- 2026-11-18: "Apps can take hours to start up so if they aren't heavy pieces then a
  workflow task with code is preferred."
- 2026-11-18: "So we need to use a users credentials." Rewrite requested.
- 2026-11-18: Shared pieces are visible to every user. Approval by admin is fine ("or
  owner", meaning to be confirmed). Ship built-in Semantic-Sensemaking pieces in parallel.
  Stored code has to be given a token.
- 2026-11-18: Shared pieces are runnable by other users, not only visible.
- 2026-11-18: Approval is admin-only.
- 2026-11-18: "approve". Taken as approval of the opt-in guard and of the spec as it stood,
  given while the security re-review was still running. Status stays In Review until that
  review is in and any changes it requires have been shown to the user.
