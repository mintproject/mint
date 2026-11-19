# Flows as models: catalog, thread runs and authoring

## Status

Approved by the user on 2026-11-19 ("1 approved"), as the second draft: revised after an
architecture review, a skeptic review, and the user's decision that a flow takes several
inputs and gives several outputs. Nothing is implemented yet. Replaces steps 3, 4 and 5 of `2026-11-19-public-flows-in-mint.md`. Steps 0 and 1
of that spec are done; its steps 2, 6 and 7 still stand and are referred to here by those
numbers.

## Objective

Make a flow of ETL pieces a first-class model in DYNAMO: described with the same metadata
as a model, found and run from a modeling thread like a model, and authored in the web
UI. Nothing in the design may be specific to one flow family.

## User need

The user's decisions on 2026-11-19, in order:

- "I think flows should have the same metadata structure as Models. Or something similar."
- Flows showing up in the model picker "is ideal".
- Flows being public as soon as they are registered "is fine".
- "Could we fully integrate the SVO adapter into the APIs of original DYNAMO?"
- "We have the ETL pieces and we should allow it through the UI as well."
- "All this must be more generalizable than the use case. It could be more SUBSIDE flows."
- Could the pieces of a new flow "be inferred and recommended from the graph similar to
  how our problem formulation works?"
- "We should allow for multiple inputs and outputs."

The first flows are the three Semantic-Sensemaking flows. The design is also checked
against a SUBSIDE flow, written out as pieces before anything is built (phase 0).

## Current code/system summary

Checked against `develop` at `1a22db1`.

**Catalog**

- Models are `modelcatalog_software` > `modelcatalog_software_version` >
  `modelcatalog_configuration`, with link tables for authors, categories, regions, inputs,
  outputs and parameters. Every row is readable by everyone.
- Since #429 these rows have an owner, only the owner or an admin (`modelcatalog_admin`)
  writes them, and anyone may add a row under another user's row.
- An input, output or parameter is its own row with a `position`; the link table to a
  configuration carries only `is_optional` and `app_input_name`. A configuration output
  can name the file it is in the job archive (`archived_file`).
- Pieces are `modelcatalog_etl_process` with input and output contracts
  (`modelcatalog_etl_process_contract`: role, position, standard variable, unit, format
  and more) and their run arguments in `runtime_json`. A piece is `tapis_function` or
  `tapis_app`. Nobody can edit a piece or its contracts; an admin can change its owner.
- Flow tables exist only on the unmerged branch `feat/etl-flows`.

**Thread run path** (`mint-ensemble-manager`, traced 2026-11-19)

- The UI calls `POST /v1/plans` then `POST /v1/plans/submit`
  (`api/api-v1/services/unifiedExecutionService.ts`).
- How a configuration runs is decided from the request and the deployment settings, never
  from the catalog row. Nothing marks a configuration as a flow.
- Every path assumes one Tapis job for the model. `ExecutionCreation.verifyComponents`,
  `previewExecutions` and `createExecutions` load the Tapis component of **every** model
  in the thread. A configuration with no component makes that fail, for the whole thread.
- The `adapter_steps` branch of `submit` already does most of what a flow run needs: it
  writes a `unified_execution` row, submits to the adapter with the user's token, stores
  the adapter run ids and follows them. The `executor: "svo_adapter"` branch creates no
  record.
- Plans are signed but readable (`encodePlan`), and `unified_execution.parameter_values`
  is stored and replayed on a rerun. There is no code that keeps a value out of them.

**Thread screens** (`ui-react`)

- The model picker walks Software > Version > Configuration and does not filter by type.
  It lists a configuration with no Tapis component.
- The dataset and parameter steps read the configuration's input, output and parameter
  rows, and match datasets to inputs through standard variables. A run cannot start until
  every required input is bound. A model may have several inputs.
- `/etl` lists pieces and `/etl/register` registers one, with no run arguments.

**Adapter** (`svo-adapter-service`)

- A plan's steps already carry `depends_on` lists, and the pipeline builder
  (`app/tapis.py`) turns them into task dependencies.
- Data moves one way only: a task receives one `SOURCE` and returns one `result`. The
  planner (`find_path`, `first_misfit`, `reachable_variables`) follows pieces with one
  input and hands on a piece's first output. `PlanIn.data_object_id` is required.
- The model path is the exception: several input chains feed one model task, each
  delivered as `INPUT_<k>`.
- `_named_path` resolves pieces through the adapter's synced copy of the catalog, and
  fails for a piece registered since the last sync.
- Any signed-in user can read any run (`list_runs`, `get_run`). Admin actions need an
  operator secret.

**Recommendations** (`semantic-search-service`)

- `POST /problem-statements/recommendations` ranks standard variables and model
  configurations against a problem statement's text by meaning, with evidence, and
  declines when there is too little text. Pieces are not indexed.

## Proposed design

### What a flow is

| Model level | Flow | Example 1 | Example 2 |
|---|---|---|---|
| Software | the flow family | Semantic Sensemaking | SUBSIDE displacement |
| Version | the pinned code version | library commit | pipeline release |
| Configuration | one graph of pieces | dictionary; narrative; formulation | one displacement flow |

**A flow is a graph, not a chain.**

- A flow has any number of inputs, including none. A flow driven only by settings, such
  as a region and a date range, is valid.
- A piece has any number of inputs and outputs, as its contracts already allow.
- Each input of each piece is wired to one source: a flow input, or an output of an
  earlier piece. Pieces with no path between them may run at the same time.
- Any output of any piece may be a flow output.
- A wire is valid when the source's contract fits the input's contract, by the same
  comparison the planner uses today. The graph may not contain a loop.

**Catalog shape**

- `modelcatalog_configuration_step`: `configuration_id`, `position`, `etl_process_id`
  (`ON DELETE SET NULL`), `settings_json`.
- `modelcatalog_configuration_step_wire`: for a step's input, either the flow input it
  reads or the earlier step and output it reads. Exactly one of the two.
- `modelcatalog_configuration_step_output`: which step and output a flow output row
  comes from.
- A configuration is a flow when it has steps. Readers ask one boolean, `is_flow`,
  computed from the steps table. It is not a stored second fact.
- A flow configuration has no Tapis component. It has ordinary input, output and
  parameter rows, written at registration from the pieces, so every existing screen can
  show it and bind to it:
  - one input row per flow input, with a position, a format and a standard variable;
  - one output row per flow output, labelled with the piece and the output so that two
    are never the same;
  - one parameter row per run argument a piece exposes. Two pieces with an argument of
    the same name get two parameters, named by step, unless the author joins them into
    one flow setting.
- A piece cannot be edited, so the copy cannot go stale. If pieces ever become editable,
  this design changes with it.
- Deleting a piece never fails because of a flow. The flow is then shown as unavailable.
- A flow is public like any model. Its pieces keep their own visibility and approval,
  checked for whoever runs it, at plan and again at submit.

### Phase 0 — Fix now, and find out before building

Fixes that do not wait for the rest:

1. **The adapter's run list.** A caller sees only their own runs. This is the exposure
   found in step 0 of the earlier spec.
2. **The Ensemble Manager skips flows when it loads Tapis components**, in
   `verifyComponents`, `previewExecutions` and `createExecutions`. Until this is live, no
   flow is registered in the Model tables, because picking one would fail every run in
   the thread.

Checks, each answerable without building the feature:

3. **A SUBSIDE flow on paper.** Write the displacement flow out as pieces, contracts and
   wires. Record which parts the catalog shape above cannot express.
4. **Where a secret value ends up today.** Mark a parameter secret, plan and submit, then
   look for the value in the plan id, `unified_execution.parameter_values` and
   `thread_model_parameter`.
5. **Every reader of a configuration's Tapis component**, listed, so that phase B's file
   list is complete.
6. **Suggestion quality.** Run the existing recommendations on the sensemaking
   descriptions and record how often it declines and what it ranks first.
7. **Uploading from the browser to Tapis Files.** Carried over from the earlier spec.

### Phase A — Flows in the catalog, and graphs in the adapter

- Migration for the three tables, with the configuration link-table rule (owner of the
  configuration, or an admin) and the author-can-see-the-piece check.
- `POST /flows` on the Model Catalog API registers a flow in **one write**: Software and
  Version if new, the Configuration, steps, wires, and the input, output and parameter
  rows. A half-written flow would look like an empty model.
- Before writing, the API asks the adapter to check the graph. The adapter route takes
  piece ids and wires only, reads the pieces from the catalog as the caller, and needs no
  data object. This also removes the dependency on the synced copy for this path.
- **Adapter, data movement.** A task receives one source per wired input and returns one
  named result per output. Position 0 keeps today's names (`SOURCE`, `result`), so
  existing pieces run unchanged. For a Tapis app piece, an output is found in the job
  archive by its file name, as model outputs are today.
- **Adapter, planning.** A plan for a flow is built from the stored graph, not searched
  for. A plan request names the flow and gives a data object for each flow input.
  `piece_ids` (a chain) stays as it is.
- Settings follow the rules built on `feat/etl-flows`: an unknown name is refused, and so
  is a value for an argument the adapter manages or for a secret.
- The flow tables on `feat/etl-flows` are dropped; its planning and settings code is
  kept. The MCP's flow tools move to the new API once phase B is live.

### Phase B — Running a flow from a thread

In the Ensemble Manager, built on the `adapter_steps` branch, not as a parallel path:

1. **Plan.** A plan for a flow configuration registers each bound dataset with the
   adapter and asks for a plan by flow. It does not default to a Tapis engine and does not
   derive input transforms.
2. **Submit.** One `unified_execution` row, the execution rows and the run counters,
   written without a Tapis component; then the adapter's submit with the user's token.
3. **Follow.** Poll the adapter, register each flow output as a thread result, finish the
   execution. No Tapis job is looked up for results, logs or files.
4. **Stages.** One stage per piece, no `model` stage, and a stage status for "waiting for
   the user" from the start, so that phase E needs no change to the model.
5. **Cancel** uses the adapter's run.

**Secret settings.** A parameter row marked secret is the general form of the model key.
Its value is accepted only in the submit request, passed to the adapter, and kept out of
the plan, `parameter_values`, its hash, and `thread_model_parameter` by an allow-list. A
rerun asks for it again. Phase 0 check 4 decides how much has to change. Step 6 of the
earlier spec (a key held for the user) builds on this.

### Phase C — Finding, running and watching a flow in the UI

- The model browser and the thread's picker show flows with a "Flow" badge and a filter.
  A flow whose piece was deleted, or that this user may not run, is shown as unavailable
  with the reason and cannot be picked.
- A flow's page is the model page plus its graph of pieces.
- The thread wizard is unchanged: pick the flow, bind each input, review the settings,
  run. A flow that does not use a region or a date range does not ask for one.
- The runs step shows the pieces as stages, side by side where they run together, with
  status and time, and cancel. A piece that is a Tapis app shows its queue wait.
- Results list every flow output and register each as a dataset.
- **Getting data in.** If phase 0 check 7 allows it, the dataset step can upload files to
  the user's Tapis storage and register them. If not, the page says where to put them.
- Before the first run of a flow that sends data to an outside service, the screen says
  so. A piece declares this in its metadata.

Step 2 of the earlier spec (public, approved, pinned pieces) must be live before a second
person can run someone else's flow. It proceeds alongside phases A and B.

### Phase D — Authoring in the UI

- **Pieces.** `/etl/register` gains the run arguments (name, type, default, secret or
  not), the contracts by standard variable, and where the code lives: a repository and a
  pinned commit. Code is never typed into the browser.
- **Flows are mapped with options inferred from the piece graph.** This is part of the
  form from the start, not an extra. At every point the form proposes, from the contracts:
  - for an input, the flow inputs and earlier outputs that fit it;
  - where nothing fits directly, the shortest chains of converter pieces that would make a
    source fit, to insert with one click;
  - for an output, the pieces that can take it next;
  - for a wanted result, the pieces that produce it and what each still needs.
  The author accepts or overrides each proposal. A flow that does not check out cannot be
  saved. These proposals are exact: they come from the contracts, not from a ranking.
- **Approval.** An admin approves a public piece from the piece's page. The adapter
  accepts a caller who is in `modelcatalog_admin`, in place of the operator secret. The
  page shows who approved which code version.
- **Ranking by meaning**, after phase 0 check 6 shows it is usable. The author describes
  the goal; the semantic search orders the graph's proposals against that description,
  puts an existing flow that already does the job first, and shows its evidence. Where
  two pieces fit the same place, this is what chooses between them. With too little to go
  on, the proposals are shown unranked.
- The graph search follows one input at a time today. Proposing a piece that needs two
  sources means searching for each of its inputs in turn, which this phase adds.
- Pieces are added to the semantic search index. Flow configurations are already indexed
  as configurations, so problem formulation recommends existing flows.

### Phase E — A pause for the user's edit

- A step may be marked as a pause. The Ensemble Manager runs the flow in segments: up to
  the pause, then, after the user confirms, from the pause on with the edited copy as the
  input. A submitted pipeline cannot itself be paused.
- The edited copy is written beside the original, inside the run's folder, never over it.
  The Ensemble Manager records who edited and when, from the caller's token.
- Formulation is then one flow with a pause after the draft.

### Phase F — The adapter behind DYNAMO's APIs

- First, a list of everything that calls the adapter directly: the MCP, the thread, the
  piece registration page, the adapter's own UI and the forecast tab.
- Those calls move to the Model Catalog API (pieces, flows) and the Ensemble Manager
  (plans, runs). A browser cannot hold a service credential, so each needs a route there.
- Then the adapter's routes require the service credential together with the user's
  token, behind a setting.
- The adapter reads pieces from the catalog and stops keeping its own copy of ownership.
- The adapter is not rewritten or merged into another service.

### Order and what each phase delivers

| Phase | A second person can |
|---|---|
| 0 | no longer read other people's runs |
| A | see flows in the catalog; plan one through the MCP |
| B, with step 2 | have a flow run tracked by a thread |
| C | run someone else's flow in the browser |
| D | register a piece and build a flow in the browser |
| E | run a flow that needs their edit part-way |
| F | — |

Phases 0, A, B and C, with step 2, are the first release. D, E and F follow and can be
reordered or dropped without undoing the first four.

### Non-goals

- Loops, and a piece that runs a varying number of times.
- Private flows.
- Drawing figures.
- Rewriting the adapter in the Ensemble Manager's language.
- Any run on IRB-governed material.

## Files likely affected

| Phase | Where | Files |
|---|---|---|
| 0 | `svo-adapter-service` | `app/main.py` (`list_runs`, `get_run`, provenance), tests |
| 0 | `mint-ensemble-manager` | `classes/common/ExecutionCreation.ts`, `classes/graphql/graphql_adapter.ts` and its queries, tests |
| A | `graphql_engine` | a migration, `metadata/tables.yaml`, tests |
| A | `model-catalog-api` | `src/custom-handlers.ts`, the OpenAPI document, tests |
| A | `svo-adapter-service` | `app/{main,models,planner,tapis,task_code,hasura}.py`, `docs/api.md`, tests |
| B | `mint-ensemble-manager` | `api/api-v1/services/{unifiedExecutionService,executionsTapisService,runHistoryService,logsService}.ts`, tests |
| C | `ui-react` | `pages/modeling/MintThread.tsx`, `pages/modeling/thread/{MintRuns,wizard/ModelsStep}.tsx`, `lib/thread-execution.ts`, the model browse pages, tests |
| D | `ui-react`, `semantic-search-service`, `svo-adapter-service` | the `/etl` pages and a flow form; `main.py` (index pieces, suggestions); admin check for approval |
| E | `mint-ensemble-manager`, `ui-react`, `svo-adapter-service` | segments, the edit screen, a plan for part of a flow |
| F | all three services, mcp-suite, deploy settings | routes and credentials |
| A, F | mcp-suite | `servers/dynamo/.../tools/{author,search,configure}.py`, README, tests |

## API/schema changes

- **New tables:** `modelcatalog_configuration_step`, `_step_wire`, `_step_output`; a
  computed `is_flow` on `modelcatalog_configuration`.
- **Model Catalog API:** `POST /flows`, `GET /flows`, `DELETE /flows/{id}`.
- **Ensemble Manager:** `POST /v1/plans` accepts a flow configuration; run responses carry
  one stage per piece and a waiting-for-user status; a resume route (phase E).
- **Adapter:** a graph check from piece ids and wires; a plan by flow with one data object
  per input; several sources and several named results per task; run reads limited to the
  submitter; approval accepts catalog admins (phase D); routes closed (phase F).
- **Piece task contract:** inputs beyond the first arrive as `SOURCE_<k>`, outputs beyond
  the first are returned by name. Existing pieces are unaffected.
- **Semantic search:** pieces indexed; a suggestion route.
- **Removed before release:** the two flow tables on `feat/etl-flows`.

## Data flow

1. An author registers pieces, then a flow, in the UI or through the MCP. The Model
   Catalog API has the adapter check the graph and writes the catalog rows as the author,
   in one write.
2. An admin approves each public piece.
3. A user picks the flow in a thread, binds a dataset to each input and reviews the
   settings.
4. The Ensemble Manager registers the datasets with the adapter and asks for a plan by
   flow. The adapter reads the graph as the user, checks every piece for this user, and
   stores the plan.
5. On submit the adapter repeats the check and starts one Tapis Workflows pipeline with
   the user's token. Secret settings travel only in this request.
6. The Ensemble Manager polls, shows a stage per piece, registers each flow output as a
   thread result, and finishes the execution. At a pause it waits for the user.

## Risks and tradeoffs

- **The adapter moves data one way today.** Several inputs and outputs per piece is new
  work in the pipeline builder and in what a piece's code receives. It is the largest
  addition this draft makes, and it is in phase A because the catalog shape depends on it.
- **The Ensemble Manager change is the next largest.** Most of its run code assumes one
  Tapis job. Building on the `adapter_steps` branch limits it.
- **A flow in the picker reaches every reader of a configuration**: recommendations, the
  scenario service, run history, the browse pages. Phase 0 check 5 lists them.
- **Flows are public at once.** A flow can advertise pieces nobody else may run. The page
  says so and the picker refuses it.
- **A thread expects a region and dates.** Some flows have neither.
- **Secret values.** Nothing in the Ensemble Manager keeps a value out of its records
  today. Until phase B's allow-list is proven by the test, no secret goes through a
  thread.
- **Approval from the browser** replaces an operator secret with a click by an admin.
  Approval is the control on code that receives every runner's token.
- **Suggestions may decline most of the time.** They are built only if phase 0 shows
  otherwise.
- **Flows inherit the Tapis Workflows engine's reliability.** A stalled pipeline is
  reported as a failed run, using the stall detection that exists.
- **Unmerged work is reshaped**: `feat/etl-flows` in mint and mcp-suite. The planning and
  settings code survives; the tables, the catalog tests and the three MCP tools are
  rewritten.

## Alternatives considered

- **A flow as a straight chain** (the first draft). Simpler, and what the adapter does
  today. Rejected by the user: flows take several inputs and give several outputs.
- **Chain now, graph later**, with a nullable input map on the step (the architecture
  review's suggestion). Rejected for the same reason; the wire table is the same idea made
  explicit.
- **Separate flow tables shaped like models.** Keeps private flows and avoids touching
  the Ensemble Manager. Rejected by the user.
- **A dedicated flows screen** (the earlier spec's step 4, approved 2026-11-19).
  Withdrawn for the same reason.
- **A new run kind beside `adapter_steps`.** More code for the same behaviour.
- **Read a flow's inputs and parameters from its pieces at display time.** No copy, but
  every model screen would need a second code path.
- **A stored flag or a Software type to mark a flow.** A second fact to keep in step.
- **Register flows in the Ensemble Manager or the adapter.** Catalog writes and their
  ownership rules are in the catalog API.
- **Each piece as its own Tapis job, submitted by the Ensemble Manager.** A queue wait
  per piece.

## Test plan

- **0:** a second user cannot read the first user's run by any adapter route; a thread
  holding a flow configuration and a Tapis model still runs the model; the checks' results
  are recorded in this spec.
- **A:** metadata tests; a failed registration leaves nothing behind; a wire that does not
  fit, a loop, an unwired required input and a piece the author cannot see are each
  refused; the written rows match the pieces; a piece with two inputs receives both and a
  piece with two outputs returns both; an existing one-input piece is unchanged. Live:
  register the three sensemaking flows and the SUBSIDE flow, and plan each.
- **B:** run counters and results with no Tapis job; several bound datasets; cancel; a
  secret value appears in no plan, record, hash or log; a rerun asks for it again. Live:
  the second account runs a flow from a thread through the API.
- **C:** the badge and filter; an unavailable flow cannot be picked; stages side by side;
  every output listed. Live: the second account runs a flow in the browser.
- **D:** the form cannot save a flow that does not check out; approval is refused for a
  non-admin; suggestions return fitting chains with evidence and decline on thin input.
- **E:** the edited copy never replaces the original and never leaves the run folder;
  nothing resumes without confirmation.
- **F:** the adapter refuses a user call without the service credential.
- **The generality check:** the SUBSIDE flow from phase 0 passes the phase A, B and C
  tests with no code path of its own, including a Tapis app piece, a flow with no dataset
  input, and a secret setting that is not a model key.

## Documentation plan

- `svo-adapter-service/docs/api.md`, the Model Catalog API and Ensemble Manager API
  documents, and what a piece's code receives and returns.
- A user page: finding, running and building a flow.
- An admin page: approving a piece.
- `mcp-suite/servers/dynamo/README.md`.
- DSO-Architecture: the adapter, Model Catalog API, Ensemble Manager and UI pages, and the
  integrations between them.

## Rollout/rollback plan

- Each phase merges and deploys to dev on its own.
- **0** is two small fixes. Rollback: revert.
- **A** adds tables and routes, and widens what a task receives without changing position
  0. Rollback: the down migration and a revert. No flow is registered on dev until phase
  0's Ensemble Manager fix is live.
- **B** adds a branch that only a flow configuration reaches. Rollback: revert.
- **C, D, E** are UI and additive routes. Rollback: revert.
- **F** is behind a setting and comes after the callers have moved.
- Production needs its own go-ahead.

## Open questions

1. **Does the catalog shape express the SUBSIDE displacement flow?** Phase 0 check 3.
2. **How does a function piece return several outputs**: one named result each, or one
   folder with a file per output? The proposal is named results, with the archive file
   name for app pieces.
3. **Should a user need a problem statement to run a flow?** A "run this flow" button
   that opens a thread is held back until this is answered.
4. **Who approves pieces beyond dev**, and against what written standard? Carried over.
5. **Can the browser upload to Tapis Files?** Phase 0 check 7.

## Decisions

- 2026-11-19: Flows are stored in the Model tables and appear in the model picker. The
  user's decision, reversing the earlier spec's "flows screen, not models".
- 2026-11-19: Flows are public on registration. Accepted by the user.
- 2026-11-19: Pieces and flows are authored in the UI as well as through the MCP. The
  user's decision.
- 2026-11-19: The design must be general, and is checked against a SUBSIDE flow. The
  user's requirement.
- 2026-11-19: A flow takes several inputs and gives several outputs. The user's decision,
  replacing the first draft's straight chain.
- 2026-11-19: A flow still runs as one Tapis Workflows pipeline. Confirmed to the user in
  answer to "B is still running a Tapis workflow?"; not objected to.
- 2026-11-19: The adapter is put behind DYNAMO's APIs and is not rewritten. Proposed by
  the assistant in answer to the user's question; not yet confirmed.
- 2026-11-19: Mapping a flow uses the piece graph to propose options at every step. The
  user: "mapping a flow will use the graph's inference, right? to propose options?" Made
  part of the form from the start. Ranking those options by meaning is added once it has
  been measured; that ordering is the assistant's proposal.
- 2026-11-19: The Software and Version owner gap was fixed first (#429), because flows
  now live in those tables.
- 2026-11-19, after review:
  - **The open run list is fixed now**, not in the last phase (both reviews).
  - **The Ensemble Manager guard ships before any flow is registered** (architecture). A
    public flow with no Tapis component would otherwise fail every run in any thread that
    picked it.
  - **Registration is one write, and the graph check needs no data object and reads the
    catalog directly** (architecture).
  - **The flow run builds on the `adapter_steps` branch** (architecture).
  - **"Never stored" became a mechanism and a test** (skeptic). The first draft asserted
    it; the Ensemble Manager stores and replays parameter values today.
  - **The SUBSIDE check is a named flow written out before building** (skeptic).
  - **Uploading has a phase** (skeptic).
  - **Ranking by meaning waits for a measurement; authoring, the pause and the adapter
    move sit outside the first release** (skeptic).
  - **The pause is held by the Ensemble Manager and run as segments** (architecture).
  - **Not taken:** keeping the chain with an optional input map. Superseded by the
    user's decision on several inputs and outputs.

## User feedback / decisions

See "User need" for the user's words.

- 2026-11-19: "1 approved", in answer to "Do you approve the revised spec?"
