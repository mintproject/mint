# Public flows, usable through MINT

## Status

In Review

## Objective

Let any MINT user run a named flow of ETL pieces (first: the three Semantic-Sensemaking
flows) from the MINT web UI, on pieces that are public, without holding a model key and
without knowing how the planner works.

## User need

On 2026-11-19 the dictionary, narrative and formulation flows ran end to end on the dev
pods, but only for one user, driven from the MCP server's code. The user asked for the
pieces to be "allowed to be public and usable through MINT".

Four things stop a second person today:

1. The six pieces are private to their owner.
2. A corpus-to-report request can come back as the dictionary or the narrative flow,
   because two pieces fit the same step. Each narrative test needed one piece deleted and
   put back.
3. The narrative and formulation flows need a model key, pasted in as a run argument.
4. MINT has no screen that runs a chain of pieces unless the chain feeds a model.

## Current code/system summary

Checked against `develop` at `9682c18`.

**Planning** (`svo-adapter-service/app/main.py` `create_plan`, `app/planner.py` `find_path`)

- `POST /plans` takes a data object and a target (`PlanIn`). `find_path` runs a
  breadth-first search over every piece the caller may use and returns the first shortest
  chain. There is no way to name the pieces or the flow.
- Only a piece's first output is handed to the next step (`_apply_transform`,
  `outputs[0]`), and a step is matched on one input.
- After the first step the search reads a precomputed edge cache, which is deleted and
  rewritten in chunks during a catalog sync.

**Stored code** (`app/stored_source.py`)

- `decision()` returns `builtin`, `own`, `approved`, `opt_in` or `denied` for a piece and a
  caller. A shared or public piece runs for other users only when an admin has approved
  its current source (`PUT /admin/transform-spec-approval`, operator secret). The approval
  route has never been used on a live pod.
- `allowed_args()` hands stored code `tapis_token`, `source_uri` and the arguments the
  piece declares, and never another adapter-held secret.
- Stored-code execution is on by hand on the dev pod only
  (`SVO_ADAPTER_STORED_SOURCE_ENABLED`). `SVO_ADAPTER_REGISTRY_USER_SCOPED` is off.

**Catalog** (`graphql_engine/metadata/tables.yaml`)

- `modelcatalog_etl_process`: role `user` may insert (owner preset from the session), read
  public, shared and own rows, and delete own rows. There is no update. `visibility` is an
  insertable column.
- There is no per-user admin. Every Tapis user is role `user`.

**Arguments the adapter fills in** (`app/planner.py` `parameter_definitions`)

- A fixed table of managed arguments (`allocation`, `source_uri`, `ckan_url`, ...) is
  filled by the service and hidden from clients. There is no managed model key.

**MCP** (`mcp-suite/servers/dynamo`)

- `create_etl_function_piece` always registers a private piece.

**Web UI** (`ui-react/src`)

- `/etl` lists pieces. `/etl/register` registers one with a visibility choice, one input,
  one output and no run arguments.
- The modeling thread uses the adapter only to prepare a model's inputs
  (`lib/adapter-execution.ts`).
- The UI already calls the adapter from the browser (`getSvoAdapterApiUrl`).
- There is no screen for running a chain on its own, and no file upload to Tapis storage.

**Library** (`helpfultangent/Semantic-Sensemaking`, PR #2 open)

- A piece's stored script installs the library from GitHub at one pinned commit. The
  library's own dependencies are not pinned.
- Only `ingest_corpus` installs the PDF and Word readers.

## Proposed design

Five phases. Each is its own pull request (or pair, where two repositories are involved)
and each can be tested through the MCP before the next starts. Phase 4 is the only one
that needs the UI.

### Phase 1 — Named flows

A **flow** is a named, ordered list of pieces with default settings. It holds no code.

- **Catalog.** Two new tables, following the ETL process tables:
  - `modelcatalog_etl_flow` (`id`, `label`, `description`, `owner_username`, `visibility`,
    `handoff_json`, timestamps).
  - `modelcatalog_etl_flow_step` (`flow_id`, `position`, `etl_process_id`,
    `settings_json`). `etl_process_id` references the piece with `ON DELETE RESTRICT`, so
    a piece in use by a flow cannot be deleted from under it.
  - Permissions as for pieces: owner preset on insert, read public/shared/own, delete own,
    no update.
- **Adapter.** `PlanIn` gains two optional fields:
  - `piece_ids`: an ordered list of pieces. The planner does not search. It checks that
    each piece accepts what the previous one hands on and that the last one meets the
    target, and answers 422 with the first step that does not fit.
  - `flow_id`: read from the catalog with the caller's token and resolved to `piece_ids`
    plus the flow's default settings.
  - Every named piece still goes through `stored_source.decision()` for the caller. A
    public flow that names a piece the caller may not run is refused, naming the piece.
  - The plan records `flow_id`, so a run can be traced to its flow.
- **MCP.** `create_etl_flow`, `list_etl_flows`, `delete_etl_flow`; `create_adapter_plan`
  takes `flow_id` or `piece_ids`.
- **Handoff.** `handoff_json` says what a person does after the flow and what may follow,
  for example for "formulation: draft":
  `{"review": "lexicon", "next_flow": "<dictionary flow id>", "bind": {"lexicon_uri": "lexicon_uri"}}`.
  The adapter stores it and does nothing with it. Nothing continues automatically; the UI
  (Phase 4) uses it to offer the next step after a person has reviewed.

Named pieces do not use the edge cache, so a half-written cache cannot affect a flow.

### Phase 2 — Public pieces

- **MCP.** `create_etl_function_piece` takes `visibility` (`private` by default, `shared`,
  `public`). Because there is no update, publishing a piece means registering it under a
  new id and deleting the private one.
- **Approval.** An operator approves each public piece with the existing route after the
  catalog sync. This phase writes the runbook and uses the route live for the first time.
- **Pinned dependencies** (library). The library ships a constraints file with hashes at
  the pinned commit, and the stored script installs with it. Approval then covers a fixed
  set of code. Today it covers the library commit and whatever versions of its
  dependencies exist on the day of the run.
- **Backbone hand-on** (library). `map_and_project` binds `taxonomy_uri`, so the second
  half of formulation uses the drafted backbone.
- **Re-pin.** After PR #2 is merged, the six pieces are registered against the merged
  commit as public, approved, and the fork-pinned ones are deleted.
- **Two-user check.** With the second Tapis account: a private piece is invisible and
  cannot be planned; an unapproved public piece is refused unless opted in; an approved
  one runs; the second user cannot delete the first user's piece.

### Phase 3 — Adapter-held model key

The adapter holds one model key and hands it only to code that has been reviewed.

- **Settings.** `SVO_ADAPTER_MODEL_API_KEY`, `SVO_ADAPTER_MODEL_BASE_URL`,
  `SVO_ADAPTER_MODEL_MAX_CONCURRENT_RUNS`. With no key set, behaviour is unchanged.
- **Who gets the key.** A step may be handed the service key only when its decision is
  `builtin` or `approved`. A piece the caller owns, or one run by opt-in, never gets it:
  its author could otherwise write a piece that copies the key out.
- **One argument, many steps.** Pipeline arguments are shared by every step that binds
  them. The service key is therefore supplied only when every step that binds
  `model_api_key` qualifies. If any step does not, the caller must supply their own key,
  and the service key is not used for that run.
- **The server address is fixed with the key.** When the service key is supplied, the
  adapter also supplies `embedding_base_url` and `chat_base_url` from its own setting and
  refuses a caller's value for them. Otherwise a caller could point an approved piece at
  their own server and read the key from the request.
- **Rate.** The model server allows 100 calls a minute across all users. The adapter
  refuses a new model-using run with 429 when
  `SVO_ADAPTER_MODEL_MAX_CONCURRENT_RUNS` are already running.
- **Record.** The run's provenance records that the service key was supplied, never the
  value.
- **Delivery.** See open question 1: whether the key may travel as a pipeline argument, as
  the Tapis token does, or must be fetched by the step at run time.

### Phase 4 — Flows screen in MINT

Three routes in `ui-react`:

- **`/flows`** lists the flows the user may run, with each flow's steps.
- **`/flows/:id/run`** (signed in):
  1. Choose a corpus: an existing data object, or a Tapis location to register as one.
     Upload from the browser is included only if open question 2 allows it.
  2. Fill in settings, built from the plan's parameters: what must be supplied, optional
     settings, and the time period and area when the flow uses them. The output folder is
     filled in by default.
  3. Run.
- **`/flows/runs/:runId`** shows status, each step, and the output files with a preview
  for tables and Markdown. While the page is open it asks the adapter to refresh the
  status, so a viewer never sees a stale one.
- **Review step.** When the flow has a handoff, the page shows the item to review (for
  formulation, the draft lexicon as an editable table of groups and terms). Saving writes
  a reviewed copy beside the draft, with who reviewed it and when. Only then is "continue
  with the dictionary flow" offered, with the reviewed lexicon bound.

The screen is behind a runtime flag (`FLOWS_ENABLED`) until Phase 5.

### Phase 5 — Hardening and production

- A real corpus: size, PDF and Word documents, and the 600-second limit on a step.
- A background polling token on the adapter, so a run nobody is watching still finishes
  with the right status.
- Stored-code execution, the model key and the flows flag set through the deploy
  pipeline, not by hand.
- User documentation and the DSO architecture pages.

### Non-goals

- Figures. The pieces write data; where figures are drawn is a separate decision.
- Flows as models inside a modeling thread.
- Planning with pieces that need several inputs at once. Named flows do not need it.
- Automatic promotion of a drafted lexicon. A person reviews it.
- Any run on IRB-governed material. That waits for the answer to open question 7.

## Files likely affected

| Phase | Repository | Files |
|---|---|---|
| 1 | mint | `graphql_engine/migrations/<new>_etl_flow/`, `graphql_engine/metadata/tables.yaml`, `graphql_engine/tests/`, `svo-adapter-service/app/{models,main,planner,hasura}.py`, `svo-adapter-service/docs/api.md`, tests |
| 1 | mcp-suite | `servers/dynamo/src/dso_dynamo_mcp/tools/{author,configure}.py`, README, tests |
| 2 | mcp-suite | `tools/author.py`, README, tests |
| 2 | Semantic-Sensemaking | `pieces/catalog.py`, a constraints file, `pieces/README.md`, tests |
| 2 | mint | an approval runbook under `svo-adapter-service/docs/` |
| 3 | mint | `svo-adapter-service/app/{config,planner,tapis,stored_source,main}.py`, `deploy/tapis/register_mint_stack.py`, docs, tests |
| 4 | mint | `ui-react/src/pages/flows/`, `ui-react/src/lib/flows.ts`, `App.tsx`, navigation, tests |
| 5 | mint, DSO-Architecture | deploy configuration, `svo-adapter-service/app/poller.py` settings, docs |

## API/schema changes

- **New tables:** `modelcatalog_etl_flow`, `modelcatalog_etl_flow_step`.
- **`POST /plans`:** optional `flow_id`, optional `piece_ids`. Existing requests are
  unchanged. New 422 codes: `FLOW_NOT_FOUND`, `FLOW_STEP_DOES_NOT_FIT`,
  `FLOW_PIECE_NOT_PERMITTED`.
- **Plan JSON:** `flow_id`; a parameter may be marked as supplied by the service
  (`model_api_key`, and the two base URLs when the key is supplied).
- **`POST /workflows/submit`:** 429 `MODEL_RUNS_BUSY`; 422 `MODEL_BASE_URL_FIXED` when a
  caller sets a base URL on a run that uses the service key.
- **New settings:** the three `SVO_ADAPTER_MODEL_*` values; UI `FLOWS_ENABLED`.
- **MCP:** three flow tools; `visibility` on `create_etl_function_piece`; `flow_id` and
  `piece_ids` on `create_adapter_plan`.

## Data flow

1. An author registers pieces (public) and a flow that names them.
2. An operator syncs the catalog and approves each public piece.
3. A user opens the flow in MINT, chooses a corpus and settings, and runs.
4. The UI asks the adapter for a plan by `flow_id`. The adapter resolves the flow, checks
   each piece against this user, and stores the plan.
5. On submit the adapter re-checks the pieces, supplies the model key and server address
   when every step that needs them qualifies, and starts the pipeline with the user's
   Tapis token.
6. Each step reads and writes the user's Tapis storage.
7. The UI shows status and outputs. For a flow with a handoff, the user reviews, saves,
   and starts the next flow.

## Risks and tradeoffs

- **A public piece receives every runner's Tapis token.** Approval is the only control.
  Pinned dependencies make what is approved fixed; without them it is not.
- **The model key leaves the adapter.** The rules above keep it from unreviewed code and
  from a caller-chosen server. They do not protect it from an approved piece that is
  wrong, or from whoever can read a run's arguments (open question 1).
- **One key, one rate limit.** A large corpus from one user can use the whole allowance.
  The concurrency cap limits runs, not calls.
- **No update on pieces or flows.** Every change is a new id and a delete. This is
  deliberate (approval and plans are pinned to source) and it makes re-pinning a chore;
  flows soften it, because users name the flow and not the pieces. A new piece version
  still needs a new flow.
- **`ON DELETE RESTRICT`** means an author must delete or replace a flow before deleting
  a piece it names.
- **Two-run formulation.** The review step is real work for the user. It is the point of
  the design, not a defect.
- **Browser calls.** The screen calls the adapter and Tapis Files from the browser with
  the user's token, as the modeling pages already do for the adapter.

## Alternatives considered

- **Flows as models in a modeling thread.** Reuses every existing screen, but a model in
  MINT runs as a Tapis app with a queue of minutes to hours, and the review step would be
  two unrelated model runs. Rejected for now.
- **Built-in pieces inside the adapter.** No approval and no install step, but the
  library's code would be copied into the adapter repository and released with it.
  Rejected in favour of public, approved, pinned pieces, so the library stays the source.
- **Flows stored only in the adapter.** Simpler, but the catalog is where pieces live and
  where ownership is enforced. Rejected.
- **Let the planner disambiguate by cost or preference.** Still a guess. Naming the flow
  is what the user means.
- **Each user brings a model key.** Works today; rejected as the public path because the
  key sits in every run record and most users will not have one.
- **Extend the secrets store to pieces.** The right long-term home for per-owner keys,
  and larger than one shared key. Left for later.

## Test plan

- **Phase 1:** metadata tests for the two tables; planner tests for `piece_ids` (fits,
  first misfit named, target not met); `flow_id` resolution with the caller's token; a
  flow naming a piece the caller may not run; existing planning tests unchanged. Live: plan
  "narrative" and "dictionary" by name with both scoring pieces registered.
- **Phase 2:** MCP visibility tests; library test that the stored script installs with
  the constraints file; live two-user check as listed in the phase.
- **Phase 3:** the key is supplied only when every binding step is `builtin` or
  `approved`; never to `own` or `opt_in`; a caller's base URL is refused when the service
  key is used; the value appears in no response, log line or provenance event; the
  concurrency cap. Live: the second user runs the narrative flow with no key.
- **Phase 4:** component tests for the form built from plan parameters, the run page and
  the review editor; a live run of each flow from the browser by the second user.
- **Phase 5:** one real corpus through each flow.

## Documentation plan

- `svo-adapter-service/docs/api.md`: flows, the new plan fields, the model key rules.
- An operator runbook for sync and approval.
- `mcp-suite/servers/dynamo/README.md`: flow tools and visibility.
- `Semantic-Sensemaking/src/semantic_sensemaking/pieces/README.md`: pinned install,
  backbone hand-on.
- DSO-Architecture: `docs/services/svo-adapter.md`, `docs/dev/environment-variables.md`,
  and a short user page for the flows screen.

## Rollout/rollback plan

- Each phase merges and deploys to dev on its own.
- **Phase 1** adds tables and optional request fields; rollback is the down migration.
- **Phase 2** changes data only (new public rows). Rollback: withdraw approval, which
  stops other users at once, then delete the rows.
- **Phase 3** is inert until the key is set. Rollback: unset it.
- **Phase 4** is behind `FLOWS_ENABLED`.
- Production is Phase 5 and needs its own go-ahead.

## Open questions

1. **Who can read a run's arguments in the adapter's Tapis Workflows group?** If any
   member can, a model key passed as an argument is readable by them, and so is each
   runner's Tapis token today. The answer decides between passing the key as an argument
   and having the step fetch it at run time with a per-run credential, as the composite
   model task already fetches its token.
2. **Can the browser upload to Tapis Files?** If not, the first version takes a location
   and upload waits.
3. **Where do a new user's outputs go by default?** The tests wrote to one user's home on
   `cloud.data`. Not every user may have one.
4. **May any user publish a public flow?** Proposed: yes, because a flow holds no code
   and every piece in it is still checked for each runner.
5. **Turn on `SVO_ADAPTER_REGISTRY_USER_SCOPED`?** It decides whether private pieces are
   hidden from other users' listings as well as from their plans.
6. **Is 600 seconds per step enough for a real corpus?**
7. **May corpus text from IRB-governed material be sent to the model server?** Not a
   build question, and it gates that corpus.
8. **Whose key in production?** For now the adapter holds the user's own key as the
   project key.

## Decisions

- 2026-11-19: Flows are run from a dedicated screen, not as models in a thread. Proposed
  by the assistant; the user moved on to "how do we go about this" without objecting, which
  is read here as agreement and should be confirmed in review.
- 2026-11-19: Pieces are made public and approved, not built into the adapter, so the
  library stays the single source of the code.
- 2026-11-19: Planning with several inputs at once is dropped from this work. It was
  approved earlier as part of the planner fix; named flows remove the need.

## User feedback / decisions

- 2026-11-18: Six coarse pieces; figures are not part of the pieces, but all the data is.
- 2026-11-19: "The owner of the pieces SHOULD be able to delete them." Done (#426).
- 2026-11-19: "Ideally we want these to be allowed to be public and usable through MINT."
- 2026-11-19: The adapter's model key is the user's own, used as a project key from TACC
  "for now".
- 2026-11-19: A second Tapis account is available for the two-user checks.
