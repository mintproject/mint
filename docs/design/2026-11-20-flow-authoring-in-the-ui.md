# Flow authoring in the web UI (Phase D of flows as models)

## Status

Draft. Written 2026-11-20 as Phase D of `2026-11-19-flows-as-models.md` (Approved 2026-11-19).
Not yet reviewed by the user.

Parts D1 to D5 each merge and deploy to dev on their own (see Rollout/rollback).

## Objective

Let an author, in the web app and without the MCP:

1. register a ETL piece: its code is a repository at a pinned commit, never typed into the browser;
2. let an admin approve a public piece from the piece's page;
3. build a flow from pieces: inputs, steps, wires, settings, outputs and thread bindings, with the
   form proposing sources and next steps from the piece contracts;
4. save a flow only if the adapter's check passes.

The design must not be specific to the sensemaking flows. It must also fit a SUBSIDE-shaped flow
(an app piece, a publish step, a region input).

## User need

**Primary user:** a research-software author who knows the data (standard variables, units,
formats) and can write or maintain a small Python piece, but does not know the adapter's wire
syntax. Expertise: domain science and some Python. Not a Tapis operator.

**Secondary users**

- **Catalog admin** (a row in `modelcatalog_admin`): approves public pieces. Needs to see what the code
  does, where its data goes, and what it is allowed to set.
- **Runner** (any user who picks a flow in a thread): not affected by authoring, but relies on
  approval and on the check having passed.

**Job-to-be-done.** "Turn pieces I or my group have into a flow that runs, without writing JSON or
calling the MCP, and know that the flow fits its pieces before anyone runs it."

**Current pain**

- Pieces can be registered only through the MCP tool `create_etl_function_piece`
  (`mcp-suite/servers/dynamo/src/dso_dynamo_mcp/tools/author.py:450`). The `/etl/register` page
  (`ui-react/src/pages/RegisterPage.tsx`) registers a piece with no run arguments
  (parent spec, current code summary).
- A flow can be written only as JSON for `POST /flows` (`model-catalog-api/src/flows.ts`). A
  wrong wire fails only at check time, one problem at a time.
- Approval needs the adapter's operator secret (`X-Admin-Secret`), which a browser must not hold.
- The author does not know which pieces can feed which input. The graph search exists in the
  adapter but no screen uses it for flows.

**Definition of success**

- An author registers a piece from a repository commit in the page and sees its contracts and
  arguments before saving.
- An admin approves or withdraws a piece from its page, and the page shows who approved which
  source hash.
- An author builds a three-step flow in the form; every input shows the sources that fit it; a
  flow that does not check out cannot be saved.
- The author picks a wanted result and sees which pieces make it and what each still needs.

**[ASSUMPTION — confirm]:** the users above are the right set. The parent spec names the admin
role; the author role is inferred from who can already register pieces through the MCP.

## Current code/system summary

Checked in the `docs-phases` worktree, which is based on `develop`. **I could not run `git show`
against the branches the task names** (no shell in this session). Where a file exists only on
another branch, I say so.

**Pieces** (`modelcatalog_etl_process`)

- Insert permission for role `user` in `graphql_engine/metadata/tables.yaml` (monorepo, near
  line 4843). The owner is set from the token. A piece is `tapis_function` or `tapis_app`.
- The MCP tool writes `runtime_json` with `language`, `source.code`, `entrypoint`,
  `env_from_args` and `parameters_schema_json`. It creates pieces `private`, owned by the caller,
  insert-only (no update, no delete). Contract `position` values start at 0 (`author.py:501`).
- `env_from_args` may not bind `tapis_token`-like names except `tapis_token` and `source_uri`
  (`author.py:481`). Python source is at most 64 kB.
- The parent spec says nobody can edit a piece or its contracts; an admin can change the owner.

**Generator** (`Semantic-Sensemaking/src/semantic_sensemaking/pieces/flow_catalog.py`, on
`feat/flow-pieces` per the task; the branch was not checked, only the working copy was read)

- The stored source is generated from a template (`SOURCE`). It pins a library commit
  (`REF`), a SHA-256 of the GitHub archive of that commit (`ARCHIVE_SHA256`), and a hash-checked
  lock file (`flow_lock.txt`) installed with `pip --require-hashes`. It maps each input position
  to a library argument and each output position to a key in the library's result.
- Consequence used below: the approved source text contains `REF` and `ARCHIVE_SHA256`. If the
  commit changes, the source changes and the approval lapses.
- Gap: at run time the piece installs from `pypi.org` and downloads the archive from GitHub. So
  a run needs network access to both.

**Approval and who may run a piece**

- Approval is recorded as `approved_source_sha256` on the spec. Since mint #439 it is one hash
  (`approval_sha256`, `svo-adapter-service/app/stored_source.py`) over the source, the function
  called, `env_from_args` and the declared arguments; branch `feat/flow-step-secrets` adds the
  `secrets` and `sends_data_to` declarations to it. (Checked against `develop`; an earlier draft of
  this section read an older copy of the file and was wrong.)
- `PUT /admin/transform-spec-approval` (`svo-adapter-service/app/main.py`) sets or clears approval
  and writes a provenance event. It sits behind the `/admin/*` guard (`_is_operator_route`), which
  needs the `X-Admin-Secret` header.
- `modelcatalog_admin` is a table. Row-level permissions in `tables.yaml` test it as
  `{_exists: {_table: modelcatalog_admin, _where: {username: X-Hasura-User-Id}}}` (many tables).
  The adapter does not check that table itself today.
- `ADMIN_AUTH_REQUIRED` (403) and `ADMIN_ROUTES_NOT_CONFIGURED` (503) come from the guard.

**Flows** (`model-catalog-api/src/flows.ts`, docs-phases)

- `POST /flows` needs a bearer token. The username is read from the token without verification;
  the catalog verifies the token (`usernameFromBearer`).
- `planRegistration` maps flow input keys to dataset ids and builds the check body:
  `{inputs, steps, outputs, thread_bindings}`. Wires are sent as the author wrote them, except
  that `from.flow_input` keys are replaced with ids.
- `checkWithAdapter` calls `POST {SVO_ADAPTER_API_URL}/flows/check` with the caller's token.
  Unset, it answers 503 `FLOWS_NOT_CONFIGURED`. Not `ok`, it answers 422
  `FLOW_DOES_NOT_CHECK_OUT` with the problems.
- `buildRows` writes the configuration, its inputs (positions from 1), outputs, settings
  (one parameter per distinct name across steps, named `{configurationId}_setting_{name}`), and
  the flow row (`modelcatalog_configuration_flow`) with its steps. One mutation.
- The configuration gets type `sdm#Model` when its software is new.
- `thread_bindings` roles are `region`, `start_date`, `end_date`, each naming a flow input or a
  setting; `collections` lists inputs that take a collection (`flow_graph.py`, `_THREAD_ROLES`).

**Adapter: the check** (`svo-adapter-service/app/flow_graph.py`, docs-phases)

- Pure. `check(flow, refused_settings=...)` never raises; a problem is a `Problem` with a code
  (`FLOW_WIRE_SHAPE`, `FLOW_WIRE_SOURCE`, `FLOW_WIRE_FORWARD`, `FLOW_WIRE_TARGET`,
  `FLOW_WIRE_DOES_NOT_FIT`, `FLOW_INPUT_UNWIRED`, `FLOW_SETTING_REFUSED`, `FLOW_OUTPUT`,
  `FLOW_THREAD_BINDING`, `FLOW_EMPTY`, `FLOW_TOO_LONG`, and others), a step and a wire index.
- Link forms, from `_TO_SHAPES` and `_FROM_SHAPES`:
  - to: `{}` (runs after), `{"input": n}`, `{"setting": name}`;
  - from: `{"flow_input": k}`, `{"flow_parameter": name}`, `{"step": p}` (runs after only),
    `{"step": p, "output": n}`, `{"step": p, "value": name}`.
- A step reads only from lower positions (`FLOW_WIRE_FORWARD`). Limits: 24 steps, 64 links per
  step, 64 inputs or parameters, 64 outputs.
- A wire to an input fits when `planner.compatibility(source, target)` is `ready`. That function
  compares six dimensions (semantic, unit, spatial, temporal, format, accessibility) and a
  seventh catalog dimension (`planner.py:199`). A source with no `resource_uri` is given a stand-in
  (`flow://…`) for the check (`_addressable`).
- An output of a step is typed by `_through(output, base)`, where `base` is the first wired input
  (same rule as a planned chain).

**Adapter: the routes**

- `POST /flows/check` (`main.py:2244`): reads pieces with the caller's token
  (`_catalog_pieces`), builds `_piece_view`, returns `{ok, problems, depends_on, pieces}`.
  **`_catalog_pieces`, `_piece_view` and `_piece_summary` are not read in this spec**; the fields
  `flows.ts` uses from `pieces` (`settings`, `setting_details`, `output_contracts`) are an
  assumption until they are checked.
- `POST /plans/flow` (`main.py:2274`): plan by flow, one data object per input.
- There is no route that proposes pieces or sources for a flow.

**Adapter: graph search** (`planner.py`, `edges.py`)

- `compatibility(src, tgt)`: the six-dimension check above.
- `find_path(source, target, registry, max_depth=6, edge_map)`: BFS for a single chain of
  transforms, shortest first. Uses `_transform_accepts` and `_apply_transform`.
- `reachable_variables(source, registry)`: forward BFS over single-input transforms.
- `plan_model_run(...)`: for each input of a model, the shortest chain from any source.
- `edges.compute_edges(registry)`: precomputes compatible output-to-input pairs into
  `adapter_transform_edge`. It uses heuristics for pass-through formats (a `None` format
  adopts the target's). **Proposals for flows should not use the edge table**, because it adds
  those heuristics and reads the adapter's synced copy of the registry, not the catalog as the
  caller. (The flow check already reads the catalog as the caller, `main.py:2254`.)

**Semantic search** (`semantic-search-service/main.py`, docs-phases)

- `POST /problem-statements/recommendations` (`:876`) and
  `GET /problem-statements/{id}/recommendations` (`:883`). `POST /events/catalog` (`:296`) takes
  catalog events. Pieces are not indexed (parent spec, check 6).
- Phase 0 check 6 (parent spec, Decisions): standard variables ranked well (scores 0.5 to 0.7);
  model configurations ranked poorly (0.2 to 0.5); one word returned results at about 0.18. So
  any use of ranking needs a score floor.

**Web app** (`ui-react`, docs-phases)

- `src/components/modeling/WorkflowCanvas.tsx` exports a generic `WorkflowCanvas<T extends {id}>`
  with `WORKFLOW_CANVAS_WIDTH` and `WORKFLOW_NODE_WIDTH`. It is used by the modeling pages.
- `src/pages/RegisterPage.tsx` exports `RegisterPage`.
- On the `ui-find-flow` worktree (branch `feat/ui-find-a-flow`), `src/components/configuration/FlowStepsSection.tsx`
  and `src/lib/flow-graph-layout.ts` exist. **Their contents were not read.**
- The UI plan from phase C (`origin/docs/flows-in-the-ui`, `docs/design/2026-11-19-flows-in-the-ui.md`)
  and `feat/flow-step-secrets` were **not read**. Anything the spec says about them is an
  assumption.

## Proposed design

### 1. Pieces from the UI (part D1)

**What the author enters**

- Identity: label, description, version, process id (default: slug plus random suffix, as the MCP).
- Repository and pinned commit: `owner/repo` and a full commit SHA. **Never code.**
- Entrypoint and the library call: which function of the repository the piece calls, and how each
  input position and output key map to it. (This is the part of `flow_catalog.py` that changes
  per piece.)
- Contracts: inputs and outputs, each with a standard variable (picked from `/standardvariables`,
  not typed), format, unit, and the optional contract fields the MCP accepts.
- Run arguments: name, type, default, description, and whether it is a secret. A secret argument
  is not offered before `feat/flow-step-secrets` lands. **[ASSUMPTION — confirm]**
- `sends_data_to` declaration: same, after `feat/flow-step-secrets`.

**How the stored source is generated**

- A **general generator** in the adapter, not in the UI and not in the library. The template is
  the `SOURCE` text from `flow_catalog.py`, with the repository, commit, lock file and call
  parameterised. The browser never sees or edits source.
- At registration the adapter, not the browser, does three things: (a) fetches the commit's
  archive from GitHub; (b) computes its SHA-256 and writes it into the source; (c) takes the
  dependency lock from the repository at that commit, and checks that it exists and is hash-checked.
  If any step fails, nothing is written.
- **[ASSUMPTION — confirm]:** the adapter does the fetch and the hash, not the library. This keeps
  the approved hash honest, because the hash is never typed.
- Which repositories are allowed: **open question 2**.

**Who may register and visibility**

- Any signed-in user, as today through the MCP. The piece is `private` and owned by the caller.
- Making a piece `public` is the owner's choice and needs approval (D2) before anyone else can run
  its stored source (`decision()`). An unapproved public piece runs only for its owner.

### 2. Admin approval from the page (part D2)

**Route.** A new adapter route that accepts the caller's bearer token and checks that the caller
is in `modelcatalog_admin`: `PUT /transform-specs/{id}/approval`, body `{approved: bool}`. The
operator route `PUT /admin/transform-spec-approval` stays for scripts, with its secret.

- **How the adapter checks admin:** reads `modelcatalog_admin` with the caller's token through
  Hasura, filtered to the caller's username. **[ASSUMPTION — confirm]:** the caller's token can read
  that table; the row-level rules above suggest it is readable by its own username but this was not
  checked.
- Refused for non-admins with a 403 code, `ADMIN_REQUIRED`.
- The same hash rule as today: `approved_source_sha256` is the hash of the current source. A piece
  changed after approval lapses (`is_approved` is false).

**What the page shows** (before the admin clicks approve):

- the piece's label, owner, visibility and version;
- the full stored source, and its SHA-256;
- the repository and the commit, with a link;
- the declared run arguments, and which are secret (when D1 has them);
- what data leaves the platform (`sends_data_to`, when available), and any network host the code
  calls (the GitHub archive and pypi at run time, as above);
- the contracts;
- the approval history from `provenance` (who approved which hash, when).

**Recording.** The provenance event (`transform_spec_approval_set`, already written by the
operator route, `main.py:1228`) gets `approved_by` from the caller's token, and the hash.

**Withdrawal.** Set `approved: false`. The same provenance event is written with `null`.

**Gap, stated plainly.** Approval covers the source. It does not cover run arguments, settings
or `sends_data_to` unless those are written into the source or into a hash. The parent spec's
security review already accepted this for flows, where the submitter accepts flow defaults. For
pieces, D2 must decide whether the approved hash also covers the declared arguments. **Open
question 6.**

### 3. The flow editor (part D3)

**Canvas or form.** [ASSUMPTION — confirm: a form first, a graph view second.] The form is
the source of truth. Each step is a card with its piece, its input slots, its settings and its
outputs. The graph view uses `WorkflowCanvas` to show the wires read-only. Reason: a canvas that
edits wires is harder to make exact and to test, and the check's messages already name steps and
wires.

**What is edited**

- **Flow inputs:** key (plain name, unique), label, standard variable, format, optional. Each is
  one dataset input.
- **Steps:** an ordered list, positions from 1, at most 24. Adding a step appends it.
- **Piece picker:** only pieces the author can see. A piece not visible is shown as unavailable.
- **Input slots:** for each input of the piece, a source (see proposals) or "unwired".
- **Settings:** one value per declared argument, optional. A setting that a wire fills cannot also
  have a default (the check refuses it).
- **Outputs:** step, and one of output, value or record. A dataset output also gets a label.
- **Thread bindings:** region, start date and end date, each to a flow input or a setting;
  collections as a list of inputs.

**Saving.** Save is `POST /flows` (`flows.ts`) with the body above. The button stays off until the
live check (`POST /flows/check`) returns `ok`. Problems are shown against the step and wire they
name.

**Editing an existing flow.** `POST /flows` writes a new configuration; a flow cannot change in
place (parent spec, phase A: the trigger accepts a step only in the transaction that creates its
flow).

- **Recommendation [ASSUMPTION — confirm]:** "edit" copies the flow into a new configuration, under
  the same version, and the author then deletes the old configuration through the existing
  configuration route. Threads already running keep their plan, because plans are snapshots
  (parent spec).
- Deleting a configuration that a thread uses: **not verified**. Open question 3.

### 4. Proposals, exact, from the contracts (part D4)

A new route on the adapter: **`POST /flows/propose`**. Same auth as `/flows/check` (signed-in, caller's
token). It reads the pieces the caller can see, from the catalog, as the check does.

**Request**

```json
{
  "inputs": [{"id": "in1", "contract": {…}}],
  "steps": [{"position": 1, "etl_process_id": "…", "wires": [...]}],
  "purpose": {"step": 2, "input": 0} | {"step": 2, "output": 1} | {"contract": {…}} | null,
  "max_chain": 3,
  "max_results": 20
}
```

The request carries the flow as far as it is built. Three question kinds:

- **For an input** (`purpose.step`, `purpose.input`): every flow input and every output of an
  earlier step, through `_through`, that makes `compatibility(source, input)` ready. Result: the
  direct sources. If there are none, the shortest converter chains (below).
- **For an output** (`purpose.output`): every visible piece with an input that the output makes
  ready. Result: the next pieces, each with its input position.
- **For a wanted result** (`purpose.contract`): pieces whose output contract is ready for the
  wanted contract, and for each, what its inputs still need (direct sources, or a chain).

**Converter chains.** A chain is a sequence of single-input visible pieces. Each step: the state
is the current contract, `compatibility(state, piece_input)` must be ready, and the state becomes
the piece's output (as `_apply_transform` does, but over catalog pieces). A breadth-first search
gives the shortest chains first.

**Limits (proposed):** `max_chain` at most 3 (default 3); the search stops after 2000 expansions
[ASSUMPTION — confirm: these numbers are a starting point, not measured]; `max_results` at most 20.
A result that needs more is not shown, and the response says that it was cut.

**Ordering.** Shortest first; ties by a stable order on the piece id. This is exact: the order
is set by path length and id, and nothing else. Ranking by meaning is D5.

**Exactness and its limits.** "Exact" means "passes `compatibility()`", the same test the check
uses. So a proposal that the check would refuse cannot appear. But a contract a piece leaves blank
(for example a `None` format) is a wildcard for the target, so the proposal will offer it. Blank
contracts are the main source of over-offering; D4 shows them as a warning on the proposal.

**Response**

```json
{
  "purpose": {…},
  "direct": [{"source": {"kind": "flow_input", "id": "…"}, "fits": true}],
  "chains": [{"pieces": [{"id": "…", "position": 0}], "length": 2, "lossy": false}],
  "next": [{"piece": "…", "input": 0}],
  "cut": false,
  "warnings": [{"code": "BLANK_CONTRACT", "piece": "…"}]
}
```

Each piece in the response carries its approval state for the caller (`decision()` from
`stored_source.py`), so the author sees a piece the caller cannot run.

**Two inputs.** The current planner follows one input at a time. A piece with two inputs needs a
search per input (parent spec, phase D). D4 does the search per input and adds the piece's full
result only when every input has a source or a chain.

### 5. Ranking by meaning (part D5, later)

- Goal: an author writes what the flow is for. The semantic search orders the proposals, and an
  existing flow that already does the job is shown first with its evidence.
- Pieces are indexed. A catalog event on `modelcatalog_etl_process` updates the index through
  `POST /events/catalog` (which exists). **[ASSUMPTION — confirm]:** the event is a Hasura event
  trigger on that table, as for configurations; not verified.
- **Measurement first.** Phase 0 check 6 showed configurations rank poorly (0.2 to 0.5) and that
  the service does not decline on thin text. D5 starts only with a measurement on the pieces, with
  a score floor below which nothing is shown.
- Ranking never removes an exact proposal. It only orders them.

### 6. Generality check: a SUBSIDE-shaped flow

The SUBSIDE displacement flow (parent spec, phase 0 check 3) is three steps: `run` (a Tapis app,
data in, a result archive and a job id out), `publish` (archive in, a manifest value out) and
`stac-publish` (archive in, a catalog record out, runs after `publish`).

What the authoring design does with it:

- **Region input:** a flow input with a standard variable, bound as `thread_bindings.region`. The
  form offers it as a flow input.
- **Tapis app piece:** a `tapis_app` piece is **not** authorable in the UI in D (open question 5).
  It can be registered with the MCP and used in a flow, as phase A allows. The form shows it with
  its contracts.
- **Value output and "runs after":** the form has a value output (`{"step": p, "value": name}`)
  and a "runs after" link with no input. Both are in the check.
- **Published record output:** `outputs` with `record`. The form offers it.
- **Settings for queue and memory:** ordinary settings.
- **Secret settings** (Earthdata login, catalog logins): not authorable until
  `feat/flow-step-secrets`. The form shows them as "not yet" rather than hiding them.

A flow with no dataset input (settings and region only) is also valid in the check, so the form
must allow zero flow inputs.

## Files likely affected

| Part | Where | Files |
|---|---|---|
| D1 | `svo-adapter-service` | a generator module beside `app/stored_source.py` (new); `app/main.py` (a route to register a piece from a repository commit); tests |
| D1 | `ui-react` | `src/pages/RegisterPage.tsx` (the `/etl/register` form), a piece form component under `src/components/registration/`; tests |
| D2 | `svo-adapter-service` | `app/main.py` (approval route with a user token); `app/stored_source.py` (`approved_by` into provenance); tests |
| D2 | `ui-react` | piece detail page under `/etl`, an approval panel; tests |
| D3 | `ui-react` | a flow form (new), `src/components/modeling/WorkflowCanvas.tsx` (read-only use), a route for the form; `src/graphql/` queries for pieces; tests |
| D3 | `model-catalog-api` | none expected (`POST /flows` unchanged); openapi notes only |
| D4 | `svo-adapter-service` | `app/flow_graph.py` or a new `app/flow_propose.py` (pure, like `flow_graph.py`); `app/main.py` (`POST /flows/propose`); `docs/api.md`; tests |
| D4 | `ui-react` | suggestion list in the form; tests |
| D5 | `semantic-search-service` | `main.py` (index pieces, a suggestion route for pieces); tests |
| D5 | `svo-adapter-service` | `app/main.py` (ordering hook); tests |

**Not verified, so the list may change:** `ui-react` files on `feat/ui-find-a-flow`
(`FlowStepsSection.tsx`, `flow-graph-layout.ts`) may already do part of D3. They must be read
before D3.

## API/schema changes

**Adapter (new)**

- `POST /flows/propose` (D4). Request and response as above. Signed-in; the caller's token;
  reads pieces as the caller. No writes.
- `PUT /transform-specs/{id}/approval` (D2). Body `{approved: bool}`. Caller's token; admin
  required (`ADMIN_REQUIRED`, 403). Writes the hash and a provenance event.
- A piece registration route on the adapter (D1), `POST /pieces/from-repository`, body
  `{label, description, version, repository, commit, entrypoint, inputs, outputs, arguments,
  env_from_args, process_id, dry_run}`. Dry run first, as the MCP does. Writes the catalog row
  with the caller's token, so the catalog's rules apply. **[ASSUMPTION — confirm]:** the adapter
  writes pieces and not the model catalog API. The alternative is the catalog API, which owns
  registrations; see Alternatives.

**Schema.** No new tables are expected. Approval uses `approved_source_sha256` on the transform
spec (existing) and provenance (existing). Confirm when D1 and D2 are written.

**Model Catalog API.** `POST /flows` unchanged. `flows.ts` `planRegistration` is reused by the form.

**Semantic search (D5).** A route for pieces, shape to be set in D5.

## Data flow

1. **Register a piece (D1).** The author enters the repository, commit, contracts and arguments.
   The adapter dry-runs: fetches the archive, checks the lock, writes the source text. Live: the
   catalog row is inserted as the caller (`private`).
2. **Approve (D2).** An admin opens the piece, reads the source and hash, and approves. The adapter
   checks the caller is an admin, writes `approved_source_sha256`, and writes provenance.
3. **Build a flow (D3, D4).** The form calls `/flows/propose` for each open slot and `/flows/check`
   after each change. The form saves through `POST /flows` only when the check is `ok`.
4. **Run.** Unchanged: a thread plans with `POST /plans/flow`; the piece is checked for the runner
   (`decision()`), and the approval gates other users' runs.

## Risks and tradeoffs

- **Approval covers source, not arguments.** A piece's argument can point at storage the admin
  never saw. The flow security review (parent spec) already requires submitter acceptance of
  flow defaults; D2 must decide whether the approved hash also covers the declared arguments.
- **Hash mismatch between docstring and code.** `PUT /admin/transform-spec-approval` imports
  `approval_sha256`, which I did not find in the copy of `stored_source.py` I read. This must be
  settled before D2 touches approval.
- **Pieces install code at run time.** The generated source installs from `pypi.org` and fetches
  the GitHub archive when it runs. A run therefore needs both. A pinned commit does not stop a
  dependency's network call. Lock hashes cover installs, not network reads.
- **The browser must never hold an admin secret.** D2 needs a user-token route, and so does
  registration in D1. Both add authorization code that a reviewer must read.
- **Proposals over-offer on blank contracts.** A piece that declares no format accepts any format
  as a target, and so offers as a source. Warned, not removed.
- **Chain search cost.** The search is bounded (depth 3, 2000 expansions). A flow with many pieces
  may take longer to propose. Measure in D4.
- **Editing by copy.** Copy-and-delete leaves the old configuration for a moment. Threads that
  picked the old flow keep their plan. Unverified: what happens to a thread that points at a
  configuration that is deleted.
- **Ranking by meaning is unmeasured for pieces.** It waits for D5's measurement.
- **Form versus wire syntax.** A form can produce a flow the check refuses for a reason the form
  does not show. Every check problem names a step and wire index, so the form must map each one
  back to a control. This is the main UI work.

## Alternatives considered

- **Canvas editor first.** Drag wires on a graph. Looks direct, but makes exact validation and
  testing harder, and every wire problem still needs a text message. Not chosen for D3; the graph
  view is read-only.
- **Authoring through the catalog API, not the adapter.** Piece registration in
  `model-catalog-api`, which owns catalog writes. Keeps one owner for writes. Not chosen for D1
  because the source must be fetched and hashed by the adapter, and the adapter already holds the
  source rules (`stored_source.py`). [ASSUMPTION — confirm] Open question 4.
- **Proposals from the adapter's edge table** (`edges.py`). Already computed, and fast. Rejected:
  it reads the synced copy, not the catalog as the caller, and it applies heuristics for blank
  formats that would make proposals differ from the check.
- **Ranking first, exact later.** Rejected: phase 0 check 6 shows the ranking is weak for
  configurations, and an author needs the exact list before any ordering.
- **Let the browser type the code.** Rejected by the parent spec: code is never typed in the
  browser.
- **Approval through the MCP only.** Keeps the operator secret out of the browser, but leaves
  approval outside the app and requires a second tool. Rejected by the user's request for
  approval from the page.

## Test plan

**D1**

- A dry run shows the source and writes nothing; the source contains the commit SHA and the
  archive hash the adapter computed.
- A commit with no lock, or a lock without hashes, is refused and nothing is written.
- Argument names that bind refused variables (`tapis_token`-like except the two allowed, run-signal
  and token-fetch names) are refused, as in the MCP.
- A contract whose standard variable is not in the catalog is refused.
- A piece is created `private` and owned by the caller.
- Live: register one sensemaking piece from its pinned commit through the page and compare its
  contracts with `flow_catalog.py`'s `registration()` output.

**D2**

- A non-admin gets `ADMIN_REQUIRED`; an admin gets the approval and a provenance event with the
  approver's username.
- An approved piece is runnable by another user (`decision()` returns `approved`); after a change to
  its source the approval lapses (`is_approved` is false).
- Withdrawal makes the piece `denied` for others again.
- The operator route still works with its secret.
- Live: an admin approves a public piece from the page, a second account runs a flow with it.

**D3**

- The save button stays off while the check fails; each check problem appears against its step
  and wire.
- A flow with zero inputs saves.
- A setting that a wire fills cannot have a default in the form (the check refuses it; the form
  shows the same message).
- Edit by copy: the new configuration checks and saves; the old one is deleted; a thread that
  planned the old flow still has its plan.
- Live: build the three sensemaking flows in the form and check each saves the same rows as the
  JSON path (`POST /flows` from `flows.ts`).

**D4**

- For each input of the sensemaking flows, the proposals include the flow input that the check
  accepts, and no proposal the check refuses.
- A chain proposal, when applied, passes `POST /flows/check`.
- Blank-contract warnings appear; limits cut the result and say so.
- Decline with no candidates: an empty list, not an error.
- Live: propose for the SUBSIDE displacement flow's `publish` input after `run`.

**D5**

- Measurement recorded in this spec before any ordering is built.
- Ordering never removes an exact proposal.
- A score below the floor shows the unranked list.

**Generality check:** the SUBSIDE-shaped flow (region input, value output, "runs after", a record
output, a Tapis app piece registered by the MCP) passes D3 and D4 with no code path of its own.

## Documentation plan

- `svo-adapter-service/docs/api.md`: `/flows/propose`, `/transform-specs/{id}/approval`, the piece
  registration route, and the approval rule (source only, until D2 decides otherwise).
- A user page: registering a piece from a repository, and building a flow.
- An admin page: approving a piece, what the page shows, and withdrawal.
- `mcp-suite/servers/dynamo/README.md`: note that the page and the MCP write the same rows.
- DSO-Architecture: the new adapter routes and the page under `/etl`.

## Rollout/rollback plan

Each part merges and is checked on dev on its own. Production needs its own go-ahead.

- **D1, pieces from a repository.** Adds a route and a page. Rollback: revert. Check on dev: a
  real sensemaking commit registered through the page, compared with the MCP's rows.
- **D2, approval from the page.** Adds a user-token route with an admin check. Rollback: revert;
  the operator route is untouched. Check on dev: approve, withdraw, and a second account's run.
  Security review required before merge (the route grants approval on code that receives every
  runner's token).
- **D3, the flow form.** UI only, on top of `POST /flows`. Rollback: revert. Check on dev: save
  the three sensemaking flows from the form.
- **D4, proposals.** Adds one pure module and one route; reads only. Rollback: revert. Check on
  dev: proposals for the sensemaking and SUBSIDE flows.
- **D5, ranking.** Separate; starts only after the measurement. Rollback: revert, and the index
  can be dropped.

Dependencies: D3 needs D4 for the proposals to show; D3 can ship without them, showing only the
check. D1 and D2 do not depend on each other. Secret arguments wait on `feat/flow-step-secrets`.

## Open questions

1. **Who approves, and against what standard?** Only `modelcatalog_admin`? Is a written review
   standard needed before a public piece is approved? (Carried from the parent spec, question 4.)
2. **Which repositories may a piece come from?** Any public GitHub repository, or an allowlist?
   Private repositories?
3. **Editing a flow.** Copy into a new configuration and delete the old one? And what happens to a
   thread that picked the old one?
4. **Where does piece registration live?** The adapter (fetches and hashes the source) or the
   model catalog API (owns writes)?
5. **Tapis app pieces in the UI.** Leave them to the MCP for D, or author them too?
6. **Does the approved hash cover run arguments and `sends_data_to`?** Or only the source, as now?
7. **Canvas or form for editing?** The proposal here is a form, with a read-only graph view.
8. **Proposal limits.** Depth 3 and 2000 expansions are a starting point. Accept, or set others?
9. **Secret arguments and `sends_data_to` in D1.** Wait for `feat/flow-step-secrets`, or ship
   without them?

## Decisions

- 2026-11-20 (draft): authoring is split into five parts, D1 to D5, each mergeable and checked on
  dev. Ranking by meaning is last, after measurement. Proposed by the assistant; not confirmed.
- 2026-11-20 (draft): proposals use `compatibility()` and the catalog as the caller, not the edge
  table. Proposed; reason in Alternatives.
- 2026-11-20 (draft): the adapter fetches and hashes the source at registration; the browser never
  types code. Matches the parent spec; the "adapter does it" part is an assumption (open question
  4).
- 2026-11-20 (draft): the form is the source of truth and the canvas is read-only. Proposed; open
  question 7.

## User feedback / decisions

None yet. This draft is for the user's review. Open questions 1 to 9 need answers before D1 is built.
