# Flow pause for the user's edit (phase E)

## Status

Approved (2026-11-20). Implementing.
Phase B (a flow run from a thread) is checked on dev. Phases C and D are not started.

Checked against the `docs-phases` worktree. Paths below are relative to the monorepo root
of that worktree unless they start with a service directory that is a sibling. Nothing was
run. Items marked **[unverified]** were read from a document or not found in the checked trees.

## Objective

Let a flow stop after a step, let a person edit a file that step wrote, and continue the
flow on the edited copy. The first use is the Formulation flow: review and edit the draft
lexicon, then run the dictionary steps (score, map, report) on it. The mechanism must not be
specific to sensemaking.

## User need

- **Primary user:** a domain scientist on a modeling thread. Knows the subject and the file
  format at a reading level, does not write code. **[ASSUMPTION — confirm]:** no
  requirements-interviewer profile exists for this phase; this comes from the parent spec's
  decisions.
- **Secondary user:** the flow's author, who decides which step pauses and which file is
  editable (the admin or owner who registers the flow).
- **Job-to-be-done:** correct a generated lexicon (drop, rename, add terms) before it is used
  to count or map documents, so the results reflect the person's judgement.
- **Current pain:** the Formulation flow stops at a draft. The dictionary flow takes one input,
  a folder of documents (parent spec, phase A, "Each takes one input"), so it cannot take an
  edited lexicon. The user would have to run the steps by hand.
- **Definition of success:** the user downloads the draft, edits it, uploads the edit and
  resumes. The run's results say which lexicon was used, who edited it and when, and the
  edited terms appear in the counts.

## Current code/system summary

**Catalog and plan**

- `pause_after` is a boolean on `modelcatalog_configuration_step`, default false
  (`graphql_engine/migrations/1771300000041_modelcatalog_configuration_flow/up.sql`, line 40;
  `graphql_engine/metadata/tables.yaml` lines 5167–5175).
- `model-catalog-api/src/flows.ts` writes it (lines 130, 299). The adapter reads it in
  `_load_flow` (`svo-adapter-service/app/main.py` line 2056) and `POST /plans/flow` copies the
  paused positions into `plan_json.flow.pause_after` (main.py lines 2394–2395, 2480).
- Nothing else reads it. `svo-adapter-service/app/flow_graph.py` does not. The MCP reads it in
  `mcp-suite.worktrees/function-piece-arguments/servers/dynamo/src/dso_dynamo_mcp/tools/flows.py`
  line 40.
- **Nothing acts on the pause.** `POST /workflows/submit` builds one pipeline from the whole
  plan (main.py line 3575) and submits it (line 3715).
- A flow's declared outputs live in `outputs_json` on the flow row. Each output is a step and
  an output or value, and `POST /plans/flow` records each step's files for app pieces
  (`files`, main.py lines 2383–2393).

**One pipeline per run**

- A task's inputs come from the pipeline's arguments, from another task in the same pipeline
  (`task_output`), or from a gather task (`svo-adapter-service/app/tapis.py`, `_flow_inputs`,
  lines 999–1009). A link cannot point at a task in another pipeline. This is the main
  constraint behind the design below.
- `svo-adapter-service/app/tapis.py` `generate_tapis_workflow` (line 1117) builds the pipeline
  from the plan's steps. Gather tasks are built at line 944.

**Submit and tokens** (`svo-adapter-service/app/main.py`, `POST /workflows/submit`, lines
3339–3763)

- Managed flow arguments are refused if the caller sends them (`FLOW_ARGUMENT_FIXED`, lines
  3376–3381, `_fixed_flow_args` lines 2080–2097).
- A run id is chosen at submit and the flow's staging folder is
  `tapis://<exec system>/<scratch root>/dynamo-runs/<run id>` (lines 3543–3558, `_resolve_flow_staging`
  lines 3073–3082).
- A run row is written as `submitting` (line 3590). The caller's token is replaced by a
  per-run token minted with the caller's identity (`_with_run_token`, line 3581;
  `apply_run_token` in `svo-adapter-service/app/run_tokens.py` line 81).
- Token lifetime: default 43,200 s (12 h), clamped to 900 s to 172,800 s
  (`svo-adapter-service/app/config.py` lines 80–82).
- The token keeper and run signals apply only when a run has a model task (`signals_armed`,
  main.py lines 3662 and 3679). A flow run has no model task, so it has no keeper and no
  stall sweep.

**Run states** (`svo-adapter-service/app/run_state.py`)

- Active: `generated`, `submitting`, `running`, `cancelling`. Terminal: `completed`, `failed`,
  `cancelled` (lines 33–34).
- Cancel is allowed to the submitter and to cancel admins (`may_cancel`, lines 287–293).

**Poll and flow view**

- `POST /runs/{id}/poll` (main.py lines 3825–3918) reads Tapis with the caller's token and
  returns `flow` with the adapter's own run status (line 3893).
- `svo-adapter-service/app/flow_run.py` reads each step's status from Tapis and each output's
  value from the last line of the step's stdout that carries `svo_flow_outputs`. `location`
  is the value, or the `output_uri` of a summary value (lines 53–71, 74–131). Limits: 20,000
  characters for a value, 2,000 for a location (lines 20–21).
- The sensemaking pieces print one summary JSON per step, not a location. A summary holds the
  step's files as keys (for example `lexicon_uri`) and its folder as `output_uri`
  (parent spec, phase B, second dev check). The file locations therefore sit inside the value.

**Pieces** (`Semantic-Sensemaking/src/semantic_sensemaking/pieces/entrypoints.py`)

- A piece needs an output folder: `OUTPUT_URI`, or one carried from the previous piece
  (lines 67–69).
- An explicit `<NAME>_URI` input always wins over the value carried from the previous piece
  (module docstring line 15; `_Run.locate`, lines 74–75).
- `draft_lexicon` writes `lexicon_draft.json` and `taxonomy_draft.json` (lines 350–351).
  `score_lexicon` reads its lexicon through `LEXICON_URI` (lines 198–200, 240–259).
- Each piece writes `settings_<piece>.json` with the inputs it was given, minus secret-named
  ones (lines 98–109).
- The Formulation workflow is described in `src/semantic_sensemaking/workflows/formulation/README.md`.
  Its outputs are `lexicon_draft.json` (and csv), `taxonomy_draft.json`, and a run record. The
  README says the draft is for human review and names the file to edit.

**Ensemble Manager** (`mint-ensemble-manager/src/api/api-v1/services/flowExecution.ts`)

- `planFlow` (line 226) and `submitFlow` (line 362). `submitFlow` refuses a plan made by someone
  else (`FLOW_PLAN_NOT_YOURS`, lines 379–390) and refuses a second open run of the same flow
  on a thread (`FLOW_ALREADY_RUNNING`, lines 397–413). The check treats any status outside
  `completed` and `failed` as open (`TERMINAL`, line 155).
- `reconcileFlow` (line 499) closes the thread's execution when the adapter reports
  `completed` (lines 533–585) or `failed`/`cancelled` (lines 587–604). A paused run must not
  reach either branch.
- `flowStages` (line 610) gives one stage per step. A step with no status shows `pending`.
- The web app's flow panel has a `waiting` step state (`ui-react/src/pages/modeling/thread/FlowRunPanel.tsx`
  lines 23, 61–68), but no run-level paused status.

**Not verified**

- The EM route that serves a result's file (`GET /executions/{id}/files/content`) is named in
  the parent spec. I did not read it.
- `POST /uploads` and the `dynamo-uploads/` folder are on branch `feat/flow-uploads`, which is
  not in the checked trees. A search of the checked trees found neither.
- The column types of `adapter_workflow_run`, and whether `outputs_json` and `status` are
  free JSON or text (no enum). I did not read those migrations.
- `Semantic-Sensemaking/src/semantic_sensemaking/lexicon/io.py` (what `load_lexicon` rejects).
- Tapis Workflows' own run time and token limits. The only limits used here are the ones in
  `config.py`.

## Proposed design

### 1. Mechanism: run the flow as segments, not one waiting task

A paused flow runs as two or more Tapis pipelines, one per segment. Segment 1 runs the steps
up to and including the paused step, then ends. The person edits the file. Segment 2 is a new
pipeline for the steps after the pause. It starts from the edited file and from the values
segment 1 reported.

Why not one pipeline that waits for a signal:

- A pipeline cannot take a human input. A waiting task would hold one Tapis run open for as
  long as the person takes, which can be days.
- The run token in a waiting task would expire. The default lifetime is 12 h, and the keeper
  that renews it exists only for model tasks (config.py lines 80–82; main.py line 3679). The
  keeper would have to be extended to flows.
- Tapis Workflows has a known stall mode, where an engine wedges a run before it starts (memory
  note `tapis-workflows-engine-stall-root-cause`). A long waiting run would be exposed to it for
  the whole pause.

Why segments are safe:

- No Tapis run is open during the pause. Nothing is charged to the queue or the engine.
- Segment 2 gets a fresh token from `apply_run_token` at its own submit, minted for the person
  who resumes (main.py line 3581).
- The thread's one-open-run rule stays in the Ensemble Manager, where it already is.

The cost is that a link from segment 1 to segment 2 cannot be a task output. It becomes a
pipeline argument. Section 3 covers this.

**[ASSUMPTION — confirm]:** the parent spec says the Ensemble Manager "holds the pause and runs
the flow in segments". Here the Ensemble Manager holds the thread's state, but the adapter
builds each segment's pipeline. The Ensemble Manager has no pipeline builder, and the adapter
owns plan-to-pipeline. This is a change in wording. Confirm it is acceptable.

### 2. What is paused, what the person edits, and how it is checked

**Marking the file.** `pause_after` says where to stop. It does not say which file to edit. Add
an `editable` entry to the flow output that the person edits, inside the existing `outputs_json`
(no table change):

    {"step": 3, "output": "lexicon", "editable": {"file": "lexicon_draft.json"}}

- For a function piece, the file is `output_uri` plus `/` plus the file name. The sensemaking
  pieces write `lexicon_draft.json` into that folder (entrypoints.py line 350).
- For an app piece, the file is the archived file the plan already records (`files`, main.py
  lines 2388–2392).
- **Rule:** a paused step must have at least one editable file output. `POST /flows/check` and
  `POST /flows` refuse a pause without one. **[ASSUMPTION — confirm]:** this is the proposed
  rule; it is not in the code yet.
- **First cut:** one pause per run and one editable file per pause. Multiple pauses are a later
  phase.

**What the person does.**

1. Opens the paused run. The results show the paused file's location (it is inside the run's
   folder).
2. Downloads the file and edits it offline. The first cut has no in-browser editor. That is out
   of scope for phase E.
3. Uploads the edit. Two routes:
   - (a) The browser uploads directly to Tapis Files under `dynamo-runs/<run>/edits/`. The
     parent spec's phase 0 check 7 found that Tapis Files accepts this from the dev UI's
     origin.
   - (b) `POST /uploads` on `feat/flow-uploads`. **[unverified]:** not in the checked trees.
   **[ASSUMPTION — confirm]:** route (a) is proposed, because it needs no new route.
4. Resumes with the uploaded location.

**Validation at resume** (adapter, before anything is submitted):

- The location must be `tapis://<exec system>/…/dynamo-runs/<run id>/edits/…`. No `..`, at most
  2,000 characters. The Ensemble Manager already checks the same shape for results
  (`TAPIS_LOCATION` and `isResultLocation`, flowExecution.ts lines 170–185). The adapter's
  `gather_piece.check_url` is the model for the parse.
- The file is read with the resumer's token. Its size is capped and its bytes are hashed by the
  adapter, not by the browser. **[ASSUMPTION — confirm]:** cap of 5 MB.
- The file must be JSON. Its content is then checked by segment 2's first piece, through the
  library's own loader. **[unverified]:** I did not read `lexicon/io.py`, so I do not know what
  it rejects. A malformed file fails segment 2 with the piece's error message.
- No declared schema exists in what I read. Open question 8.

### 3. Continuation mechanics (adapter)

**Segment 1.** `POST /workflows/submit` gains `through_step` (a position) for a flow plan. The
adapter builds a pipeline from the steps up to that position, and their gather tasks. It stores
`paused_after_step` on the run row. **[unverified]:** this needs two new columns on
`adapter_workflow_run` (`paused_after_step`, `parent_run_id`) and their migration.

**Resume.** New route `POST /runs/{id}/resume`, body `{"replacements": {"<output key>": "<tapis location>"}}`.

Segment 2 is built from the steps after the pause. Its inputs come from three places:

- Links from segment 1 become pipeline arguments. A new source kind, `{"resume": "<key>"}`, is
  added to `_flow_inputs` (tapis.py lines 999–1009) and mapped to `{"args": ...}`. Segment 2
  never names a task of segment 1.
- The paused step's reported value (the summary JSON from `flow_run.view`, at most 20,000
  characters) is passed as the carried value. The replaced file's `<NAME>_URI` is set to the
  new location. An explicit `_URI` wins over the carried value (entrypoints.py lines 74–75), so
  the piece reads the edit.
- Settings the plan needs at run time (for example `output_uri`) are replayed from segment 1's
  non-secret arguments. Tokens and secrets are never stored. The token rule the adapter already
  follows holds (only the keeper's encrypted copy is kept, and only for model runs).

**Staging.** Segment 2 uses segment 1's staging folder, `dynamo-runs/<run 1 id>`, not a new
folder. Gather tasks' output is already there. The run id is chosen at submit (main.py lines
3543–3558), so a resume must take the folder from the parent run.

**Checks at resume.** The same checks as submit run again: the stored-source check
(`stored_source.check_plan`), the registry, `_validate_plan_args`, and the resumer's own
secrets (`_resolve_run_secrets`). `FLOW_ARGUMENT_FIXED` allows only the replacement names. Every
other managed argument is still refused.

**Provenance.** A `run.input.replaced` event on the run, with: the output key, the original
location, the new location, the byte count, the SHA-256, the caller's username, and the time.
The caller's username comes from `_caller_or_none` (main.py, used at line 3394). Each piece also
writes its inputs to `settings_<piece>.json` (entrypoints.py lines 98–109), so the edited
location is recorded in the results without the adapter's help.

**Pipeline ids.** Each segment is registered as its own pipeline. **[ASSUMPTION — confirm]:** the
id is the plan id plus the segment number, so a second registration does not replace the
first. `register_pipeline` takes a `recreate` flag (tapis.py line 1831), and an earlier segment
may still be running.

### 4. States

**Adapter.** Segment 1 ends as `completed` in Tapis terms, because the Tapis run did finish. The
flow view adds `awaiting_edit` for a segment that ended at its pause, and the adapter's run
status stays `completed`. `awaiting_edit` is not a Tapis state, so the active and terminal sets
in run_state.py do not change.

- Cancel while `awaiting_edit`: no Tapis run exists, so the route sets `cancelled` and makes no
  Tapis call. Cancel while segment 2 runs: the existing path.

**Ensemble Manager.** A new non-terminal status on the thread's execution: `awaiting_edit`.

- `TERMINAL` stays `completed` and `failed`, so the one-open-run rule (`FLOW_ALREADY_RUNNING`)
  holds for the whole pause.
- `reconcileFlow` gets a branch before the completion branch (flowExecution.ts line 533). On
  `awaiting_edit` it stores the outputs so far, does not call `finishFlowExecution` (lines
  571–579), and keeps the execution open.
- Stages: steps up to the pause are `completed`. Steps after it are `waiting`, which the web
  app already knows (FlowRunPanel.tsx lines 23, 61–68).
- A failed continuation (segment 2 fails because the edit is bad) goes back to `awaiting_edit`
  with the error, so the person can upload another edit. **[ASSUMPTION — confirm]:** this is
  proposed. The alternative is `failed`.

**Timeout.** A paused run with no resume after N days is cancelled by a sweep. **[ASSUMPTION —
confirm]:** N is not set. Open question 3.

**Scratch.** The run folder is kept until the run ends and then for N more days.
**[unverified]:** I did not find a cleanup of `dynamo-runs/`, so retention is not known today.

### 5. Who may resume, and the security of the continuation

- **Resume: the submitter only.** This matches cancel (`may_cancel`, run_state.py lines
  287–293) and the plan check (`FLOW_PLAN_NOT_YOURS`). Thread write access is also required,
  because the Ensemble Manager checks the thread on every flow write (flowExecution.ts lines
  379–382). **[ASSUMPTION — confirm]:** submitter only, not every thread writer.
- The continuation runs with the resumer's token. A replacement is accepted only for an
  editable output of the paused step.
- The edited file must be inside this run's `edits/` folder. Nothing outside the run's folder is
  read or written. This is the phase E test "never leaves the run folder".
- The original file is never overwritten. Edits go under `edits/<output key>/<upload>/`.
- Replacement content is untrusted. It is size-capped and parsed before a run starts (section
  2). The person who edits is the run's submitter, so the trust boundary is unchanged, but the
  file still reaches pieces that run with the resumer's token.
- **First cut refuses a pause in a flow that has secret settings.** **[ASSUMPTION — confirm]:**
  secrets are bound at each submit (phase B), and a resume re-binds them. Keeping secret flows
  out of phase E avoids a second path for secrets.

### 6. Generality

- The rule is per step: any step with an editable file output, whether a function piece or an app
  piece. Nothing names sensemaking.
- **SUBSIDE example:** review a parameter file before the model step. **[ASSUMPTION — confirm]:**
  such a file would be the output of a registered preparation piece. None is registered today.
  The SUBSIDE displacement steps are tasks in a pipeline file, not catalog pieces (parent spec,
  phase A, "not registered"). So the SUBSIDE example waits for phase A's piece registration.
- Until then, the generality test uses a stand-in flow with a non-sensemaking function piece.

### 7. The Formulation flow

- One new flow configuration: ingest, draft-lexicon, **pause after draft-lexicon** (editable
  `lexicon_draft.json`), score-lexicon, map, report. Its one flow input is the folder of
  documents.
- The dictionary steps take their lexicon from the draft, through the links. The combined flow
  no longer needs a lexicon input.
- A flow cannot be changed in place (parent spec, phase A decisions). So the combined flow is a
  new configuration. The existing "Formulation draft" flow stays until its owner deletes it.
- `taxonomy_draft.json` is not editable in the first cut. Open question 7.

## Files likely affected

| Where | Files |
|---|---|
| `svo-adapter-service` | `app/main.py` (submit `through_step`, resume route, cancel of an awaiting run, replacement checks, provenance); `app/flow_run.py` (`awaiting_edit`, `editable`); `app/tapis.py` (`_flow_inputs` resume source; segment builder; pipeline id); `app/models.py` (request bodies); `app/config.py` (a setting for the feature, and the edit size cap); `app/hasura.py` (run row columns); `docs/api.md`; tests under `tests/` |
| `graphql_engine` | a migration for two columns on `adapter_workflow_run` **[unverified]**; `metadata/tables.yaml` |
| `model-catalog-api` | `src/flows.ts` (validate a pause has an editable output); the OpenAPI document; tests |
| `mint-ensemble-manager` | `src/api/api-v1/services/flowExecution.ts` (status, reconcile branch, resume, cancel, timeout); the execution store if the status needs a change; `flowExecution.test.ts` |
| `ui-react` | `src/pages/modeling/thread/FlowRunPanel.tsx` (paused panel, download, upload, resume, cancel); tests |
| `Semantic-Sensemaking` | none in phase E. The formulation README is read, not changed |
| docs | `docs/design` (this file); DSO-Architecture pages for the adapter, the Ensemble Manager and the UI |

## API/schema changes

**Adapter (`svo-adapter-service`)**

- `POST /workflows/submit`: a flow plan accepts `through_step` (new). Without it, behaviour is
  unchanged.
- `POST /runs/{id}/resume` (new). Body: `replacements` map from output key to a Tapis location.
  Responses: 200 with the new run; 409 when the run is not `awaiting_edit`; 422 with codes
  `FLOW_REPLACEMENT_REFUSED`, `FLOW_REPLACEMENT_NOT_EDITABLE`, `FLOW_REPLACEMENT_UNREADABLE`.
- `POST /runs/{id}/cancel`: accepts an `awaiting_edit` run and makes no Tapis call.
- `POST /runs/{id}/poll` flow view: `status` may be `awaiting_edit`; each output carries
  `editable` when it is one.
- `_flow_inputs`: new source `{"resume": "<key>"}`. The piece task contract is unchanged.
- Run row: `paused_after_step`, `parent_run_id` **[unverified]** types and migration.
- Provenance events: `run.paused`, `run.resumed`, `run.input.replaced`.
- Setting: an enable flag, default off, and an edit size cap (proposed names).

**Model Catalog API**

- `outputs_json` gains `editable: {file}` on a declared output. No table change, **[unverified]**
  if `outputs_json` is not free JSON.
- `POST /flows/check` and `POST /flows` refuse a pause without an editable file output.

**Ensemble Manager**

- Execution status `awaiting_edit` (non-terminal). **[unverified]** the status column's type.
- `POST /v1/executions/{id}/resume` (new). Body: `replacements`. The Ensemble Manager checks the
  thread and the submitter, then calls the adapter's resume.
- Run responses: stages after a pause are `waiting`.
- A timeout sweep for `awaiting_edit` runs.

**UI**

- A paused panel in `FlowRunPanel.tsx`: the file's link, an upload control, "Resume with this
  edit", and "Cancel".

## Data flow

1. Plan (existing). `POST /plans/flow` records `pause_after` in the plan.
2. Submit segment 1. The Ensemble Manager calls `POST /workflows/submit` with `through_step`.
   The adapter builds the pipeline for the steps up to the pause and submits it with the
   submitter's token.
3. Segment 1 runs and ends. The adapter's poll reads each step's report. The paused step's
   file location is `output_uri` plus the file name, and it is shown as an editable output. The
   run is `awaiting_edit`. The Ensemble Manager keeps the thread's execution open and does not
   file any result yet.
4. The person downloads the file, edits it, and uploads the edit under `edits/`.
5. Resume. The Ensemble Manager checks the thread and the submitter, then calls
   `POST /runs/{id}/resume`. The adapter validates the location, reads and hashes the file, and
   records `run.input.replaced`.
6. Segment 2 is built from the steps after the pause. Its inputs are pipeline arguments: the
   reported value, the new `LEXICON_URI`, and the staging folder of segment 1. A new run token is
   minted for the resumer. The pipeline is submitted.
7. Segment 2 runs. The Ensemble Manager follows it as it follows any flow run. On completion it
   files the results of both segments. Each result carries its provenance.

## Risks and tradeoffs

- **Two pipelines per run.** Each segment is a separate Tapis run. Their pipeline ids must not
  collide (section 3). If they do, a second registration can replace the first while it is
  still running.
- **The report limit.** A step's reported value is capped at 20,000 characters (flow_run.py line
  20). A summary near that size could be lost, and segment 2 would then start without it.
  **[unverified]:** the size of the Formulation draft's summary.
- **Staging folder.** Segment 2 must use segment 1's folder. A resume that picks up a new run
  id's folder would find no gathered files.
- **Long pauses.** No Tapis run is open during a pause, so nothing runs or fails. The thread
  stays blocked for the whole pause (`FLOW_ALREADY_RUNNING`). That is intended, but a pause that
  is forgotten blocks the thread. The timeout (section 4) addresses it.
- **Token expiry in segment 2.** Segment 2 has a fresh token, so a resume is safe. A single
  segment that runs longer than its own token (12 h by default, config.py line 80) still fails,
  as it does today.
- **Rollback with paused runs.** If the feature is reverted while a run is `awaiting_edit`, the
  Ensemble Manager would not know the status. A revert must first cancel the awaiting runs.
- **Edited content is untrusted.** Size cap and parse first; the content is still read by the
  pieces (section 2).
- **Double close.** Phase B's review noted that two replicas could close one run at once. A timeout
  sweep adds another writer. It must use the same guarded update.
- **Replacing an upstream step's output.** The edit replaces the output of the paused step only.
  Steps before the pause are not re-run, which saves cost. A change to an upstream file cannot be
  made in phase E.
- **Trust boundary of the upload route (if (b) is chosen).** Route (a) avoids a new upload
  endpoint. Route (b) would need its own review.

## Alternatives considered

- **One pipeline with a waiting task that polls for a signal.** Rejected: the run would be open
  for days, the token would expire, the keeper covers model tasks only, and the engine's stall
  mode would apply for the whole pause.
- **The Ensemble Manager splits the pipeline itself.** Rejected: the Ensemble Manager has no
  pipeline builder. The adapter owns plan-to-pipeline.
- **Two separate flows, one run by hand after the other.** Rejected: the parent spec wants
  Formulation to be one flow with a pause.
- **A per-output `editable` boolean with no file name.** Rejected: the adapter cannot find the
  file from a boolean, because a summary holds the file under a key.
- **Replace the original file in place.** Rejected by the parent spec's decision (edited copy
  beside the original).
- **An in-browser JSON editor.** Not in phase E. Open question 4.
- **Reuse the paused run's token for segment 2.** Rejected: it may be expired, and the person
  who resumes is the one whose access the run must check.

## Test plan

**Adapter (`svo-adapter-service/tests`)**

- Segment 1 contains only the steps up to the pause and their gather tasks.
- Segment 2 contains only the steps after it. No task references a segment 1 task (assert on the
  generated pipeline).
- Replacement checks: outside the run folder, `..`, too long, not JSON, over the size cap,
  unreadable. Each returns its code.
- `FLOW_ARGUMENT_FIXED` allows only the replacement names.
- Resume by someone other than the submitter is refused. Cancel of an `awaiting_edit` run makes no
  Tapis call.
- No token or secret is stored on the run row or in provenance (reuse the existing
  `looks_like_secret` guard, run_tokens.py line 223).
- Provenance holds the SHA-256 and the caller.

**Ensemble Manager (`flowExecution.test.ts`)**

- `awaiting_edit` is not terminal. A second run of the flow is refused while it is paused.
- Reconcile on a paused run does not call `finishFlowExecution`.
- Resume, cancel and the timeout close the execution once.
- A failed continuation returns to `awaiting_edit`.

**Model Catalog API**

- A pause on a step with no editable file output is refused at `/flows/check` and `POST /flows`.

**UI (vitest)**

- The paused panel shows the file and the controls. Resume is shown only to the submitter.

**Live (dev)**

- The Formulation flow on the sample corpus (`--sample-corpus` in the formulation README):
  run to the pause, download, remove one group, upload, resume. Check that `settings_score_lexicon.json`
  records the edited location, that the results show the provenance, and that the counts drop the
  removed group.
- A second account cannot resume the run.
- A malformed edit fails and returns to `awaiting_edit`.
- Cancel while paused closes the thread's execution.

**Generality:** a stand-in flow with a non-sensemaking function piece, then the SUBSIDE example once
its pieces are registered.

## Documentation plan

- `svo-adapter-service/docs/api.md`: the new routes, the states, the provenance events.
- The Ensemble Manager API document: resume, `awaiting_edit`, the stage `waiting`.
- A user page: reviewing a step and continuing a flow.
- `mcp-suite/servers/dynamo/README.md`: the pause and how to resume (the MCP reads `pause_after`
  today).
- DSO-Architecture: the adapter and Ensemble Manager pages, and the run states.

## Rollout/rollback plan

Each part merges and is checked on dev on its own. Each has a rollback.

- **E1 Adapter segments and resume**, behind the enable flag (default off). Dev check: a
  two-segment run through the API with a hand-made edit. Rollback: turn the flag off. Reverting
  the code leaves `paused_after_step` columns, which are harmless if unused.
- **E2 Catalog check.** `editable` is refused without a file output. Dev check: a pause without an
  editable output is refused. Rollback: revert. No flow pauses yet, so nothing depends on it.
- **E3 Ensemble Manager.** `awaiting_edit`, the reconcile branch, resume, cancel and the timeout.
  Dev check: a paused run from E1, resumed through the thread. Rollback: cancel every
  `awaiting_edit` run first, then revert.
- **E4 UI.** The paused panel. Dev check: the second account sees resume only on its own run.
  Rollback: revert.
- **E5 Formulation combined flow.** Registered on dev as a new configuration. Dev check: the live
  run above. Rollback: its owner deletes the configuration (phase A allows deletion). The flow
  family stays.

Production needs its own go-ahead for each part.

## Open questions

1. **Mechanism deviation.** The adapter builds each segment's pipeline, and the Ensemble Manager
   holds the thread's state. Is this acceptable against the parent's wording?
2. **Who may resume.** Recommended: the submitter only. The alternative is any thread writer.
3. **Timeout and scratch retention.** How many days may a run stay paused before it is cancelled,
   and how long is the run folder kept after that? No default is set here.
4. **In-browser editing.** Confirm that phase E ships with download and upload only.
5. **Upload route.** Browser upload straight to Tapis Files (route a), or the `POST /uploads` on
   `feat/flow-uploads` (route b)? Please point to that branch if (b).
6. **Failed continuation.** Return to `awaiting_edit` (recommended), or mark the run `failed`?
7. **Taxonomy.** Is `taxonomy_draft.json` editable too, or only the lexicon in the first cut?
   Recommended: lexicon only.
8. **Content check.** Does the library's lexicon loader reject a malformed file? Is there a JSON
   schema the person's file must meet? (I did not read `lexicon/io.py`.)
9. **Formulation shape.** Confirm one new configuration: ingest, draft, pause, score, map, report.
10. **One pause per run, one file per pause** in the first cut. Confirm.
11. **Secret flows.** Confirm that a flow with secret settings cannot pause in the first cut.

## Decisions

- 2026-11-20, proposed by the assistant, not confirmed: segments, not a waiting task (section 1).
- 2026-11-20, proposed: an `editable` entry on the flow output, not a per-output boolean
  (section 2).
- 2026-11-20, proposed: a resume gives a fresh token to the resumer; no token is kept across the
  pause (section 3).
- 2026-11-20, proposed: resume by the submitter only (section 5).
- 2026-11-20, proposed: a failed continuation returns to `awaiting_edit` (section 4).
- Parent spec, 2026-11-19 (approved): the edited copy is written beside the original, inside the
  run's folder; the Ensemble Manager records who edited and when; Formulation is one flow with a
  pause after the draft; a submitted pipeline cannot itself be paused.

- 2026-11-20, open questions settled when the design was approved (my choices, recorded for
  the user to overturn; the design's recommendation where it gave one):
  1. Accepted: the adapter builds each segment's pipeline; the Ensemble Manager holds the
     thread's state.
  2. Only the submitter may resume.
  3. A paused run is cancelled after 14 days; its run folder is left to the scratch purge.
     (No recommendation was given; this is mine.)
  4. Download and upload only; no in-browser editor.
  5. **Changed by a later user decision:** the edited file is uploaded as a user upload, and
     user uploads go through CKAN ("User uploads should route through ckan", 2026-11-20): a
     private dataset in an organisation the user picks, read by the next segment's gather
     step as the runner. Neither route a nor route b of this draft.
  6. A failed continuation returns the run to `awaiting_edit`.
  7. Lexicon only in the first cut.
  8. To be checked in code: the library's lexicon loader; refuse a file it cannot load.
  9. Confirmed: one new configuration, ingest → draft → pause → score → map → report.
  10. Confirmed: one pause per run, one file per pause.
  11. **Against this draft:** a flow with secrets may pause. Each segment binds the secrets
      of its own steps when it is submitted. Without this the Formulation flow, whose draft
      step needs the model-server credential, could not pause at all.

## User feedback / decisions

None yet. This is the first Draft.
- 2026-11-20: "Three designs (authoring, pause, adapter behind the APIs) approved".
