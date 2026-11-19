# Public flows, usable through MINT

## Status

In Review. Revised 2026-11-19 after security, architecture and skeptic reviews (see
Decisions). Not approved; nothing is implemented.

## Objective

Let any MINT user run a named flow of ETL pieces (first: the three Semantic-Sensemaking
flows) from the MINT web UI, on pieces that are public.

## User need

On 2026-11-19 the dictionary, narrative and formulation flows ran end to end on the dev
pods, but only for one user, on a five-document sample, driven from the MCP server's code.
The user asked for the pieces to be "allowed to be public and usable through MINT".

Four things stop a second person today:

1. The six pieces are private to their owner.
2. A corpus-to-report request can come back as the dictionary or the narrative flow,
   because two pieces fit the same step. Each narrative test needed one piece deleted and
   put back.
3. The narrative and formulation flows need a model key, pasted in as a run argument.
4. MINT has no screen that runs a chain of pieces unless the chain feeds a model.

A fifth is unknown: whether the flows work at all on a corpus of real size.

## Current code/system summary

Checked against `develop` at `9682c18`.

**Planning** (`svo-adapter-service/app/main.py` `create_plan`, `app/planner.py`)

- `POST /plans` takes a data object and a target (`PlanIn`). `find_path` runs a
  breadth-first search over the adapter's registry (`adapter_transform_spec`) and returns
  the first shortest chain. There is no way to name the pieces or the flow.
- The registry is a synced copy of the catalog. A registry row carries the catalog id as
  `mint_etl_process_id`; its own id is different.
- A step is accepted when any one of its inputs matches (`_transform_accepts`), and only
  its first output is handed on (`_apply_transform`, `outputs[0]`).
- `build_plan_json` takes an ordered list of registry rows. `_plan_with_parameters` then
  adds the parameter contract.

**Stored code** (`app/stored_source.py`, `app/tapis.py`)

- `decision()` returns `builtin`, `own`, `approved`, `opt_in` or `denied`. A shared or
  public piece runs for other users only when an admin approved its current source.
  `check_plan` repeats the check at submit.
- Approval pins the SHA-256 of the source only. It does not cover which arguments the
  piece binds (`env_from_args`, `parameters_schema_json`) or its entrypoint.
- `allowed_args()` lets a stored-code step bind `tapis_token`, `source_uri` and any
  argument the piece itself declares, minus the names in `_INPUT_SECRET_PARAMS`.
- An argument a step does not bind is not readable by its code. The probe for the earlier
  spec tested three routes (`2026-11-18-adapter-user-scoped-etl-pieces.md`, Phase 0).
- Pipeline arguments come from the caller's request. Every run's arguments, the user's
  Tapis token among them, are stored with the run in one Tapis Workflows group
  (`adapter-ops`).
- The approval route has never been used on a live pod. Stored-code execution is on by
  hand on the dev pod only. `SVO_ADAPTER_REGISTRY_USER_SCOPED` is off, so a caller's view
  of the registry is not limited to what the catalog would show them.

**Catalog** (`graphql_engine/metadata/tables.yaml`)

- `modelcatalog_etl_process`: role `user` may insert (owner preset from the session), read
  public, shared and own rows, and delete own rows. There is no update.
- There is no per-user admin. Every Tapis user is role `user`.

**Run-time credentials** (`app/main.py`)

- `GET /runs/{id}/credentials` and `POST /runs/{id}/token` already hand a running task a
  secret, authenticated by a per-run credential. Both are tied to the composite model task.

**MCP** (`mcp-suite/servers/dynamo`): `create_etl_function_piece` always registers a
private piece.

**Web UI** (`ui-react/src`)

- `/etl` lists pieces. `/etl/register` registers one, with no run arguments.
- The modeling thread uses the adapter only to prepare a model's inputs. Its helpers for
  building a form from a plan's parameters are in `lib/adapter-execution.ts`.
- Run history comes from the Ensemble Manager, which shows adapter runs only when they
  belong to one of its own executions.
- There is no screen for running a chain on its own, no listing of files in Tapis
  storage, and no upload.

**Library** (`helpfultangent/Semantic-Sensemaking`, PR #2 open)

- A piece's stored script installs the library from GitHub at one pinned commit. The
  library's own dependencies are not pinned.

## Proposed design

Seven steps, in this order. Each is its own pull request, or a pair where two
repositories are involved. The order puts the cheapest test of the biggest unknown first,
and the most security-sensitive work last.

| Step | What | A second person can |
|---|---|---|
| 0 | Real corpus and open questions | (nothing yet; this decides whether the rest stands) |
| 1 | Named pieces on a plan | — |
| 2 | Public, approved, pinned pieces | run the dictionary flow through the MCP |
| 3 | Flows in the catalog | ask for a flow by name |
| 4 | Flows screen: list, run, status, outputs | run a flow in the browser, with their own model key |
| 5 | Review step for formulation | run formulation in the browser |
| 6 | Adapter-held model key | run narrative and formulation with no key |
| 7 | Hardening and production | — |

### Step 0 — Real corpus and open questions (no code)

Run before anything is built, with what exists today.

- One corpus of real size, about 200 documents including PDF and Word, through all three
  flows. Record the time of every step against the 600-second limit, the number of model
  calls against the 100-a-minute limit, and the size of the result handed between steps.
- If a step does not fit, the fix is to split the work across parallel steps. That
  changes the pieces and the hand-on format, and this spec is revised before step 1.
- Answer open questions 1 to 3 on the live system, with the second account.
- Reproduce the two errors seen once each: a 500 when one plan is submitted twice in
  quick succession, and a 502 on a status check. A button in a browser will hit the first.
- Not IRB-governed material. See open question 7.

### Step 1 — Named pieces on a plan

- `PlanIn` gains `piece_ids`, an ordered list of **catalog** piece ids. `flow_id` (step 3)
  and `piece_ids` are alternatives; a request with both is refused.
- The adapter resolves each id to its registry row by `mint_etl_process_id`. A piece that
  is in the catalog but not yet in the registry is answered with its own code
  (`PIECE_NOT_SYNCED`), not "not found".
- A new `validate_path(source, target, specs)` in `planner.py` walks the list with the
  existing `_transform_accepts` and `_apply_transform` and ends with the existing target
  check. It does not search. The result goes to `build_plan_json` unchanged.
- Validation is on single-contract fit only: one matching input, first output handed on,
  as the search does today. The spec does not claim more.
- Permission is not re-implemented. The named pieces go through
  `stored_source.check_plan` for the caller, at plan time and again at submit, with the
  same opt-in handling as a searched plan.
- MCP: `create_adapter_plan` takes `piece_ids`.

Named pieces do not use the edge cache, so a half-written cache cannot affect them.

### Step 2 — Public, approved, pinned pieces

- **MCP.** `create_etl_function_piece` takes `visibility` (`private` by default,
  `shared`, `public`). Separate pull request from the library changes below.
- **Approval covers the bindings.** The approved hash is taken over the source, the
  entrypoint, `env_from_args` and the declared arguments, in a fixed order. Today it is
  the source alone, so an approved piece's bindings could change without losing approval.
- **Pinned install** (library). The stored script installs with:
  - a constraints file with hashes, at the pinned commit, and its own hash written into
    the script so that approval covers it;
  - `--require-hashes`, `--no-deps`, `--only-binary=:all:`, and the default index only;
  - the GitHub archive checked against a recorded SHA-256.
  The function runtime image (`python:3.11`) stays outside what approval covers; that is
  recorded as a limit, not solved.
- **Backbone hand-on** (library). `map_and_project` binds `taxonomy_uri`.
- **Registry scoping.** `SVO_ADAPTER_REGISTRY_USER_SCOPED` is turned on, so a private
  piece is hidden from other users' listings as well as from their plans. The check it
  was waiting for (the session user is the Tapis username) passed on 2026-11-18.
- **Approval runbook.** Sync, then approve each piece, then record who approved what.
  Withdrawing approval takes effect at the next submit, because submit re-checks.
- **Re-pin.** After PR #2 is merged, the six pieces are registered against the merged
  commit as public and approved, and the fork-pinned ones are deleted.
- **Two-user check**, with the second account: a private piece is invisible and cannot
  be planned; an unapproved public piece is refused unless opted in; an approved one
  runs; the second user cannot delete the first user's piece.

### Step 3 — Flows in the catalog

A **flow** is a named, ordered list of pieces with default settings. It holds no code.

- **Tables.** `modelcatalog_etl_flow` (`id`, `slug`, `label`, `description`,
  `owner_username`, `visibility`, timestamps) and `modelcatalog_etl_flow_step` (`flow_id`,
  `position`, `etl_process_id`, `settings_json`). Permissions as for pieces.
- **Deleting a piece never fails because of a flow.** The step's reference is
  `ON DELETE SET NULL`. A flow with an empty step is broken and is refused with
  `FLOW_BROKEN`, naming the position. A restrictive reference would let anyone block an
  owner's delete by publishing a flow that names the piece.
- **A flow may only name pieces its author can see**, checked on insert.
- **The adapter reads flows at plan time** with the caller's token. Flows are not synced
  into the registry: they hold no code, are not searched, and a copy would go stale.
- **`PlanIn.flow_id`** resolves to `piece_ids` and then follows step 1 exactly.
- **Default settings.** After the plan's parameter contract is built, a flow's
  `settings_json` is laid over the defaults of parameters that exist. An unknown name is
  refused. A setting for an adapter-managed or secret argument is refused. Order of
  precedence: the caller's value, then the flow's default, then the piece's default.
- The plan records `flow_id` and the settings applied.
- **MCP.** `create_etl_flow`, `list_etl_flows`, `delete_etl_flow`; `create_adapter_plan`
  takes `flow_id`.

### Step 4 — Flows screen: list, run, status, outputs

Routes in `ui-react`, behind a runtime flag (`FLOWS_ENABLED`):

- **`/flows`** lists the flows the user may run, with each flow's steps, its owner, and
  for each piece why this user may run it (built-in, own, approved).
- **`/flows/:id/run`** (signed in): choose a corpus (an existing data object, or a Tapis
  location to register as one), fill in settings, run.
  - The settings form reuses the helpers in `lib/adapter-execution.ts`.
  - The output folder is filled in by default (open question 3).
  - For now a user supplies their own model key for the flows that need one.
  - The run button is disabled after one click until the adapter answers.
- **`/flows/runs`** and **`/flows/runs/:runId`**: the user's flow runs, and one run's
  status, steps and output files with a preview.
  - This is a second list of runs beside the Ensemble Manager's history, which shows only
    runs that belong to its own executions. Merging them is left for later.
  - Markdown and table previews are rendered with sanitizing: no raw HTML, no script
    links. The files are produced from a corpus the viewer may not have written.
- **Background status** moves here from hardening. The adapter is given its polling
  token, so a run finishes with the right status when the tab is closed.
- **Upload** is included only if open question 2 allows it.

### Step 5 — Review step for formulation

- A flow may carry a small handoff record, with a version: what a person reviews after
  it, and the slug of the flow that may follow. It is added to the flow table in this
  step, not before, because this screen is its only reader. The adapter stores it and
  does nothing with it.
- The run page shows the item to review (for formulation, the draft lexicon as an
  editable table). Saving writes a reviewed copy beside the draft, never over it, inside
  the run's own output folder.
- The adapter records who reviewed and when, from the caller's token. The page does not
  assert it.
- Only then is the next flow offered, with the reviewed file bound and nothing else. The
  user confirms before it starts. Nothing continues on its own.

### Step 6 — Adapter-held model key

Last, because it is the only step that puts a shared secret near user-supplied code, and
because a user can bring their own key until then. Its design depends on open question 1.

- **Settings.** `SVO_ADAPTER_MODEL_API_KEY`, `SVO_ADAPTER_MODEL_BASE_URL`, and a limit on
  runs. With no key set, behaviour is unchanged.
- **The key and the server addresses become adapter secrets in code.** `model_api_key`,
  `embedding_base_url` and `chat_base_url` join `_INPUT_SECRET_PARAMS`. `allowed_args`
  grants them to a step only when its decision is `builtin` or `approved`. The rule is on
  the argument, whatever input name a piece binds it to.
- **Checked at submit, not only at plan.** The service key is used only when every step
  that binds the key qualifies. The check reads every place a binding can be declared
  (`env_from_args`, the declared arguments, file inputs).
- **Caller values are removed, not just refused.** When the service key is used, the
  adapter overwrites the key and both addresses in the pipeline arguments. A caller's own
  `model_api_key` is honoured only on a run that does not use the service key.
- **Delivery: fetched at run time.** The step asks the adapter for the key with a
  short-lived per-run credential, through an extension of the existing run-credentials
  route. The route answers only for a run whose stored plan passed the check above. The
  key then appears in no run record. Passing it as an argument is kept only if open
  question 1 shows arguments are not readable by other users.
- **Limits.** A per-user limit on concurrent model-using runs, answered with 429. This
  limits runs, not calls; one large corpus can still use the whole shared allowance.
- **Record.** Provenance records that the service key was supplied, never the value.
  The key and addresses are written to no log.
- **Rotation.** Unsetting the key stops new runs. A run in flight keeps what it fetched.

### Step 7 — Hardening and production

- Stored-code execution, registry scoping, the model key and the flows flag set through
  the deploy pipeline, not by hand.
- A run that outlives its user's Tapis token. The token keeper exists for the composite
  model task only.
- User documentation and the DSO architecture pages.
- Production needs its own go-ahead.

### Non-goals

- Figures. The pieces write data; where figures are drawn is a separate decision.
- Flows as models inside a modeling thread.
- Planning with pieces that need several inputs at once. Named pieces do not need it.
- Automatic promotion of a drafted lexicon.
- Merging flow runs into the Ensemble Manager's run history.
- Any run on IRB-governed material (open question 7).

## Files likely affected

| Step | Repository | Files |
|---|---|---|
| 1 | mint | `svo-adapter-service/app/{models,main,planner}.py`, `docs/api.md`, tests |
| 1 | mcp-suite | `servers/dynamo/src/dso_dynamo_mcp/tools/configure.py`, README, tests |
| 2 | mint | `svo-adapter-service/app/stored_source.py`, an approval runbook, deploy settings, tests |
| 2 | mcp-suite | `tools/author.py`, README, tests |
| 2 | Semantic-Sensemaking | `pieces/catalog.py`, a constraints file, `pieces/README.md`, tests |
| 3 | mint | `graphql_engine/migrations/<new>_etl_flow/`, `metadata/tables.yaml`, `graphql_engine/tests/`, `svo-adapter-service/app/{models,main,hasura}.py`, tests |
| 3 | mcp-suite | `tools/{author,configure}.py`, README, tests |
| 4, 5 | mint | `ui-react/src/pages/flows/`, `ui-react/src/lib/flows.ts`, `App.tsx`, navigation, tests; `svo-adapter-service/app/main.py` for the review record |
| 6 | mint | `svo-adapter-service/app/{config,planner,tapis,stored_source,main}.py`, `deploy/tapis/register_mint_stack.py`, docs, tests |
| 7 | mint, DSO-Architecture | deploy configuration, docs |

## API/schema changes

- **`POST /plans`:** optional `piece_ids` (step 1) and `flow_id` (step 3), mutually
  exclusive. Existing requests are unchanged. New 422 codes: `PIECE_NOT_SYNCED`,
  `PIECE_DOES_NOT_FIT`, `FLOW_NOT_FOUND`, `FLOW_BROKEN`, `FLOW_SETTING_REFUSED`.
- **Approval hash** changes what it covers (step 2). No piece is approved today, so
  nothing needs migrating.
- **New tables:** `modelcatalog_etl_flow`, `modelcatalog_etl_flow_step` (step 3); a
  handoff column (step 5).
- **Plan JSON:** `flow_id`, applied settings. Never a key value.
- **Run-credentials route:** extended to a model key for qualifying flow runs (step 6).
- **`POST /workflows/submit`:** 429 when the per-user limit is reached (step 6).
- **New settings:** `SVO_ADAPTER_MODEL_*`; UI `FLOWS_ENABLED`.
- **MCP:** `piece_ids` and `flow_id` on `create_adapter_plan`; `visibility` on
  `create_etl_function_piece`; three flow tools.

## Data flow

1. An author registers pieces (public) and a flow that names them.
2. An operator syncs the catalog and approves each public piece.
3. A user opens the flow in MINT, chooses a corpus and settings, and runs.
4. The UI asks the adapter for a plan by `flow_id`. The adapter reads the flow with the
   user's token, resolves each piece in its registry, checks each against this user, and
   stores the plan.
5. On submit the adapter repeats the check and starts the pipeline with the user's Tapis
   token.
6. Each step reads and writes the user's Tapis storage. From step 6, a qualifying step
   fetches the model key from the adapter.
7. The UI shows status and outputs. Where a review is called for, the user reviews,
   saves, confirms, and starts the next flow.

## Risks and tradeoffs

- **A real corpus may not fit.** Step 0 exists to find out before anything is built.
- **A public piece receives every runner's Tapis token.** Approval is the control, and
  there is no written standard for what an approver must check. Step 2's runbook has to
  state one.
- **Every run's arguments sit in one Workflows group.** If members can read them, each
  runner's Tapis token is exposed today, regardless of this work (open question 1).
- **One model key, one rate limit**, shared with the server's other users.
- **No update on pieces or flows.** Every new library commit means new pieces, a new
  approval of each, and a new flow. Nobody owns that cycle yet.
- **Operator work by hand.** Sync and approval are manual and need the operator secret.
- **A second run list** in the UI until flow runs are merged into run history.
- **The review step may go unused** if people only want the dictionary flow. It is its
  own step so that it can be dropped.

## Alternatives considered

- **Flows as models in a modeling thread.** Reuses every existing screen, but a model in
  MINT runs as a Tapis app with a queue of minutes to hours. Rejected for now.
- **Built-in pieces inside the adapter.** No approval and no install step, but the
  library's code would be copied into the adapter repository. Rejected so that the
  library stays the source.
- **Flows as a configuration file in the adapter**, as the skeptic review proposed.
  Smaller, but a flow could then be added only by a deploy, and the catalog is where
  ownership is already enforced. Kept as catalog tables, moved after public pieces, and
  stripped of the handoff until the screen needs it.
- **Flows synced into the adapter like pieces.** Rejected: a second copy to go stale.
- **A restrictive reference from flow step to piece.** Rejected: it lets one user block
  another's delete.
- **The model key as a pipeline argument.** Simplest, and how it was tested. Rejected as
  the default because the key would be in every run record.
- **Extend the secrets store to per-owner keys for pieces.** Left for later.

## Test plan

- **Step 0:** timings and counts recorded in this spec.
- **Step 1:** `validate_path` (fits, first misfit named, target not met, a piece with
  several outputs); catalog id to registry row; `PIECE_NOT_SYNCED`; both fields given;
  permission through `check_plan` for own, approved, opt-in and denied; existing planning
  tests unchanged. Live: plan dictionary and narrative by named pieces with both scoring
  pieces registered.
- **Step 2:** approval lost when a binding changes; the stored script's install line;
  MCP visibility; live two-user check.
- **Step 3:** metadata tests; a deleted piece breaks the flow and does not block the
  delete; a flow naming a piece its author cannot see is refused; settings precedence and
  refusal. Live: plan each flow by name as the second user.
- **Step 4:** the form built from plan parameters; sanitized previews; one click, one
  submit. Live: the second user runs each flow from the browser.
- **Step 5:** the reviewed copy never replaces the draft and never leaves the run folder;
  the reviewer is taken from the token.
- **Step 6:** the key never reaches an `own` or `opt_in` step by any binding; caller
  values are overwritten; the route refuses a run that did not pass; the value appears in
  no response, log or provenance event. Live: the second user runs narrative with no key.

## Documentation plan

- `svo-adapter-service/docs/api.md`: named pieces, flows, the model key rules.
- An operator runbook for sync and approval, with what an approver checks.
- `mcp-suite/servers/dynamo/README.md`.
- `Semantic-Sensemaking/src/semantic_sensemaking/pieces/README.md`.
- DSO-Architecture: `docs/services/svo-adapter.md`, `docs/dev/environment-variables.md`,
  and a user page for the flows screen.

## Rollout/rollback plan

- Each step merges and deploys to dev on its own.
- **Step 1** adds an optional request field. Rollback: revert.
- **Step 2** changes data and one hash. Rollback: withdraw approval, which stops other
  users at the next submit, then delete the rows.
- **Step 3** adds tables. Rollback: the down migration.
- **Steps 4 and 5** are behind `FLOWS_ENABLED`.
- **Step 6** is inert until the key is set. Rollback: unset it.

## Open questions

Questions 1 to 3 are answered in step 0. Question 8 is the user's.

1. **Who can read a run's arguments in the adapter's Tapis Workflows group?** Not
   answerable from the repository. Decides step 6's delivery, and whether the Tapis token
   needs the same treatment.
2. **Can the browser upload to Tapis Files?**
3. **Where do a new user's outputs go by default?** The tests wrote to one user's home on
   `cloud.data`.
4. **Does the adapter's run list show a caller only their own runs?** Not verified; the
   flows screen depends on it.
5. **Who does the re-pin when the library changes?**
6. **Is 600 seconds per step enough?** Step 0.
7. **May corpus text from IRB-governed material be sent to the model server?** A hard
   precondition for that corpus, not for the build.
8. **Is the user's own key acceptable as the shared key beyond dev?** For now, yes on
   dev, by the user's decision.

## Decisions

- 2026-11-19: Flows are run from a dedicated screen, not as models in a thread. Proposed
  by the assistant; the user moved on to "how do we go about this" without objecting. This
  is read as agreement and needs the user's confirmation.
- 2026-11-19: Pieces are public and approved, not built into the adapter.
- 2026-11-19: Planning with several inputs at once is dropped from this work.
- 2026-11-19, after review:
  - **A real corpus is tested first** (skeptic). It was last.
  - **The adapter-held key moves to the end and is fetched at run time** (all three
    reviews). As first written, the rule "only approved pieces get the key" could not be
    enforced: any piece may bind any argument it declares.
  - **Approval covers a piece's bindings**, not only its source (security).
  - **A flow's reference to a piece no longer blocks the piece's delete** (security). It
    contradicted the owner-delete decision of the same day.
  - **Named pieces ship before flow tables, and the handoff waits for the screen**
    (skeptic, architecture).
  - **Flow steps name catalog ids, resolved through the registry, with permission through
    the existing `check_plan`** (architecture).
  - **The flows screen is split** into run-and-view and the review step (architecture).
  - **Not taken:** flows as a configuration file (see Alternatives).

## User feedback / decisions

- 2026-11-18: Six coarse pieces; figures are not part of the pieces, but all the data is.
- 2026-11-19: "The owner of the pieces SHOULD be able to delete them." Done (#426).
- 2026-11-19: "Ideally we want these to be allowed to be public and usable through MINT."
- 2026-11-19: The adapter's model key is the user's own, used as a project key from TACC
  "for now".
- 2026-11-19: A second Tapis account is available for the two-user checks.
