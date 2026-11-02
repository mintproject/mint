# Run signals and staleness detection for composite workflows

Status: Implementing (revision 2 approved by user 2026-11-02)

## Objective

Make a composite model run's status in DYNAMO honest about one failure the
platform cannot see today — a Tapis Workflows pipeline that is dispatched but
whose model task never executes — within 15 minutes, with no Tapis credential
on the SVO adapter pod. Give users a way to cancel such a run from the UI, and
make the status that *is* reachable (through a logged-in user's token) refresh
while the Runs step is open.

Out of scope for this revision: propagating pipeline *completion* to the
adapter with nobody logged in. Signal-derived completion was reviewed and
rejected as a false-green risk (see Decisions); it is deferred to a follow-up
that depends on a Tapis Workflows capability we have not verified.

## User need

Primary user: a facilitator running a problem statement (e.g. Barton Springs,
`zv34psepmu74vtj8`) who opens the Runs step to decide whether to wait, cancel
or resubmit. Secondary: the developer debugging the dev instance.

Current pain (2026-11-02): a MODFLOW 6 run showed "Running" for eight hours.
The Tapis Workflows run (`7e52b200…`) was `ACTIVE`, its `model` task execution
said "Task is Active", and no Tapis job had ever been created. A second run
(`7c101f36…`) had been in the same state since 2026-10-28. Nothing in the UI
distinguished this from a normal queue wait, and there was no cancel.

Success: a run whose model task never starts is flagged in the UI within
15 minutes of dispatch with a message that says what is known ("no signal
received from the model task") and what to do; the user can cancel it from the
UI; a run that is legitimately queued for hours is never flagged; status for
an open Runs step is at most 60 s stale.

## Current code/system summary

Observed Tapis timings for `modflow6-simulation` jobs (9 jobs, 2026-10-28 →
2026-10-30, `portals` tenant): submit → `QUEUED` in 30–60 s every time;
`QUEUED` → `RUNNING` on ls6 between 20 min and 18.2 h; runtime ~3 min;
archive 0.3–2.5 min. A fixed "idle for N hours" rule is unusable.

Tapis Workflows exposes nothing mid-flight: an active task execution's
`last_modified` is frozen at its start time and `stdout` is empty until the
task completes. A healthy run logs `[TASK] … ACTIVE … model` in the pipeline
`logs` within ~3 s and a Tapis job exists within ~60 s; the two stalled runs
have neither. Neither the task nor the pipeline `max_exec_time` ended them.
That engine-side fault is reported to the Tapis team separately.

Adapter (`svo-adapter-service`, branch `develop`):

- `main.py` submit handler (~L2224–2250): generates the pipeline, **inserts
  the `adapter.workflow_run` row (L2239), sets status `generated`, then
  dispatches**. The run id therefore exists before `runPipeline`.
- `tapis.py:_model_execution_code` generates the model task (`function` type,
  Python we control). Inputs `TAPIS_BASE_URL`, `TAPIS_TOKEN` are bound from
  pipeline args. It POSTs `/v3/jobs/submit`, polls `/v3/jobs/{uuid}/status`
  every 5 s for `max_minutes × 12` polls, prints one JSON line at the end, and
  on error prints a structured payload with a `code` then raises.
  Since PR #372 (merged to `develop` 2026-11-02, before this work started)
  the task's `execution_profile` is `max_retries:
  settings.model_task_max_retries` (2) and `max_exec_time:
  settings.model_task_max_exec_seconds` (172800), it re-attaches by job name
  to a job an earlier attempt submitted (`_existing_job`), tolerates Tapis
  outages while polling, and renews a per-run token when that feature is on.
  The live stalled pipeline matches this. (Revision 2 of this spec claimed
  `max_retries: 0`; that was read from a stale local branch and is corrected
  here.) A retry therefore re-sends `started` and `job_submitted` (same uuid
  when it re-attaches); `apply_signal` treats both as liveness, not as new
  state.
- Transform steps are either `function` tasks wrapped by `task_code.py`, or
  `tapis_job` tasks (`execution_profile: {max_retries: 1}`, L391–395) that run
  no Python of ours. Task ids are `step-{n}-{transform_type}` (L383).
- `adapter.workflow_run`: `status TEXT` (no CHECK), `started_at` (never
  written), `created_at`, `error_message`, `execution_id`, `idempotency_key`.
  No column for the Tapis job uuid or the submitter.
  `adapter.provenance_event(workflow_run_id, event_type, payload_json)`.
- `poller.py`: 60 s loop started only when `SVO_ADAPTER_TAPIS_TOKEN` is set.
  The dev pod has no such variable (`register_mint_stack.py` never sets one);
  the loop has never run there. PR #374 is inert for the same reason.
- `POST /runs/{id}/poll` (L2334): reads Tapis with the caller's token; writes
  status **only** on a Tapis terminal status, or `submitting/generated →
  running` on any status. Non-terminal observations are otherwise discarded.
- No cancel endpoint. `config.py` has `internal_service_secret` (EM header)
  and the 2026-10-02 pattern for provisioning one random secret per
  environment via GitHub environment secret → `register_mint_stack.py`.

Ensemble Manager (`unifiedExecutionService.ts`): child adapter statuses pass
through into `workflowStages`; `reconcileParent` treats a non-`completed`
child as `adapter_running`. For the stuck run, `GET /v1/plans/runs/ue_2e54ba9a…`
returns `status: model_running`, `execution_mode: workflow_pipeline`,
`tapis_workflow: {workflow_id: aff02964…, run_id: 7e52b200…}` and stages
`[adapter-output-1 running, model running, output-handoff planned]`.

UI: `fetchUnifiedRun` → EM `/v1/plans/runs/{ue_id}` runs once per run id on
load and once on remount; no periodic refresh. `MintRuns` rendered "This
legacy model job has no recorded workflow stages" for this run although EM
reports `workflow_pipeline` — a rendering fall-through in `isPipeline`
(MintRuns.tsx:534), not a data gap.

## Proposed design

### 1. Model-task signals → adapter

Only the model task signals. It is the only task whose code we control on
every pipeline (`tapis_job` steps cannot), it is where the incident lives, and
its signals are the ones the staleness rule needs.

Endpoint `POST /runs/{run_id}/signal`, headers `X-Run-Signal-Token`,
`X-Run-Signal-Expires`. Token = `HMAC-SHA256(secret, "run-signal:v1:" +
run_id + ":" + expires)` hex; `expires` = `created_at + max_minutes + 24 h`
(unix seconds). The adapter accepts a **list** of secrets (current + previous)
so a rotation does not orphan in-flight pipelines (up to 48 h). Constant-time
compare; validate before any DB read; uniform 401 for bad token and unknown
run; body ≤ 4 KiB, `message` ≤ 2000 chars; per-run rate limit (e.g. 60/min);
`signal_url` is built from adapter config only, never from plan or user input.

Body: `{"schema": 1, "event": "started" | "job_submitted" | "finished",
"task_id": "model", "attempt": 1, "job_uuid"?: str, "job_status"?: str,
"condition"?: str, "code"?: str, "message"?: str}`. `sent_at` is not trusted;
the server stamps every event. `task_id` must be `model`; other values 400.
Dedupe key `(task_id, attempt, event)` — a repeat is recorded as provenance
and otherwise ignored. `attempt` is 1 today (`max_retries: 0`); it is carried
so a future retry policy has a place to live.

Effects (all through one pure function `apply_signal(run, event, now) →
update_set | None`, applied with a compare-and-set `UPDATE … WHERE status =
<previous>`; `/poll`, the sweep and cancel use the same module):

- any event: `last_signal_at = now`; clears `health = stalled`.
- `started`: `started_at = now` if null; `status` `generated/submitting →
  running`.
- `job_submitted`: stores `job_uuid` in `model_job_uuid` with
  `model_job_verified = false`. The adapter also knows the expected job name
  (`mint-workflow-model-<execution id>`, fixed at generation); `/poll` verifies
  the uuid against Tapis (`GET /v3/jobs/{uuid}` with the user's token, name
  must match) and sets `model_job_verified = true`. Cancel uses only a verified
  uuid.
- `finished` with `code`: `health = reported_failed`, `error_message` = safe
  message, provenance. **Status is not changed** — a signal is not Tapis. The
  UI shows "model task reported failure: <code> — awaiting confirmation";
  the next `/poll` (user token) confirms from Tapis and writes `failed`.
- `finished` without `code`: provenance only (`job_status`, `condition`
  recorded). No `completed` is derived from signals.
- Terminal statuses (`completed`, `failed`, `cancelled`) are sticky against
  signals. `cancelled` is sticky against everything including `/poll`.

Task side: a `_signal(event, **fields)` helper in the model task template.
Reads `SIGNAL_URL`, `SIGNAL_TOKEN`, `SIGNAL_EXPIRES` inputs (bound from
pipeline args like `tapis_token`). POST with a 5 s timeout; retries with
backoff for up to 60 s for `started` (so an adapter restart does not cost a
false stall), one retry for the others; swallows every error; never prints the
request, headers, token or exception repr to stdout. Absent inputs → no-op.
Calls: `started` first thing; `job_submitted` right after `/v3/jobs/submit`
returns; `finished` from the success path and from `_die`. Explicit timeouts
on the submit call itself (today only the poll loop is bounded).

Arming: at submit, when a signal secret is configured, the adapter sets
`dispatched_at = now` **after** `runPipeline` returns and inserts provenance
`run.signal.armed`. Only armed runs are swept.

### 2. Two-phase staleness (mark-only)

Poller loop runs whenever `demo_mode` is false and `poll_interval_seconds >
0`. Inside it, Tapis polling runs only with a service token (unchanged), and
`sweep_stalled()` runs only when a signal secret is configured and
`stall_after_seconds > 0` (kill switch).

- Phase 1 — dispatch → `started`. Rows with `run.signal.armed`,
  `status IN ('generated','submitting','running')`, `last_signal_at IS NULL`,
  `dispatched_at < now − stall_after_seconds` (default 900): set
  `health = stalled`, `error_message = "Dispatched to Tapis Workflows at
  <dispatched_at> UTC; no signal has been received from the model task in
  15 min. The task may not have started. Check the run in Tapis, or cancel
  and resubmit."`, provenance `run.stalled` with the decision inputs (age,
  last signal, armed).
- Phase 1b — `started` → `job_submitted`. `started_at` set, no
  `model_job_uuid`, `started_at < now − 300 s`: same `health = stalled` with
  a message naming the missing job submission.
- Phase 2 — after `job_submitted`. No cutoff; the bound is `max_minutes`,
  enforced by the task. UI shows "job `<uuid>` queued/running on ls6 since
  <started_at> (<elapsed>)".

`health` is a liveness verdict in its own column, not a lifecycle status;
`status` keeps its existing meaning so EM, UI and `/poll` need no special
case for it in lifecycle logic. `stalled` clears on any signal, and `/poll`
now also writes non-terminal observations: if Tapis shows a job for the run
(verified uuid) or the task execution active with a later `last_modified`,
`health → ok`. The sweep never cancels anything.

Multiple pod replicas: the compare-and-set update makes the sweep idempotent;
no advisory lock needed.

### 3. Cancel

`POST /runs/{run_id}/cancel`, bearer token required. The adapter resolves the
caller with Tapis (`GET /v3/oauth2/userinfo` using the bearer) and requires
`username == submitted_by` (stored at submit from the same lookup) or
membership in an allowlist setting (`cancel_admins`). Order: terminate the
Workflows run, then cancel the Tapis job if `model_job_verified`. Status moves
to `cancelling` first; `cancelled` + `error_message = "Cancelled by
<verified username>"` only when the calls that were attempted succeeded;
partial failure is returned to the caller and leaves `cancelling` with the
error recorded. Idempotent; no-op (200) on terminal runs. Provenance
`run.cancelled` with caller username and request IP. The UI confirms before
calling it. Resubmit from the UI is offered only after cancel succeeds.

### 4. Ensemble Manager and UI

- EM: `health = stalled` on a child → parent `failure_code:
  COMPOSITE_WORKFLOW_STALLED`, `error_message` passthrough, status unchanged
  (`adapter_running` / `model_running`). `health = reported_failed` → parent
  `failure_code: MODEL_FAILURE_REPORTED`. Cancel passthrough
  `POST /v1/plans/runs/{id}/cancel`.
- UI `MintRuns`: `stalled` shows the failure style, the adapter message and
  Cancel; `reported_failed` shows the warning style; `running` with
  `started_at` shows the job id and elapsed time. `message` is rendered as
  text only. Fix the `isPipeline` fall-through for `ue_…` runs whose EM
  snapshot says `workflow_pipeline`.
- UI `MintThread`: while the Runs step is open and any unified run is
  non-terminal, refresh from EM every 60 s with exponential backoff on
  failure; show the refresh error inline (an expired token must not look like
  a stale-but-fine run).

## Files likely affected

- `graphql_engine/migrations/1771300000034_adapter_workflow_run_signals`:
  `adapter.workflow_run` gains `dispatched_at`, `signals_armed` (bool, default
  false), `last_signal_at`, `health`, `model_job_uuid`, `model_job_name`,
  `model_job_verified` (bool, default false), `submitted_by`. No metadata
  change: adapter tables are admin-only in Hasura. Follows the 2026-09-22
  adapter schema-sync procedure.
- `svo-adapter-service/app/store.py` — demo-store handler for the
  compare-and-set `UpdateRunIf` mutation.
- `svo-adapter-service/app/config.py` — `run_signal_secrets` (list),
  `stall_after_seconds` (900), `stall_after_started_seconds` (300),
  `cancel_admins`.
- `svo-adapter-service/app/run_state.py` (new) — `apply_signal`, sweep
  predicates, status/health transition table, compare-and-set helper.
- `svo-adapter-service/app/main.py` — `/signal`, `/cancel`, arming at submit,
  `submitted_by`, `/poll` writes non-terminal observations and verifies the
  job uuid, lifespan loop gating.
- `svo-adapter-service/app/poller.py` — loop restructure, `sweep_stalled()`.
- `svo-adapter-service/app/tapis.py` — signal args/inputs on the model task,
  `_signal` in `_model_execution_code`, submit timeout, terminate + job-cancel
  helpers, `userinfo` lookup.
- Tests: `tests/test_run_state.py` (new), `tests/test_run_signal.py` (new),
  `tests/test_poller.py`, `tests/test_composite_tapis_workflow.py`
  (generated code has the inputs/calls and never prints a token).
- `svo-adapter-service/docs/api.md`.
- `deploy/tapis/register_mint_stack.py`, `.github/workflows/deploy-mint-dev-pods.yml`
  — `SVO_ADAPTER_RUN_SIGNAL_SECRETS` from the `Tapis Dev Deploy` environment.
- `mint-ensemble-manager/…/unifiedExecutionService.ts` (+ tests).
- `ui-react/src/pages/modeling/{MintThread.tsx,thread/MintRuns.tsx}`,
  `ui-react/src/lib/ensemble-manager.ts` (+ tests).
- `DSO-Architecture/docs/dev/environment-variables.md`,
  `docs/services/svo-adapter.md`.

## API/schema changes

Adapter HTTP: `POST /runs/{run_id}/signal` (HMAC headers),
`POST /runs/{run_id}/cancel` (bearer, owner or admin). `/poll` response gains
`health`, `last_signal_at`, `model_job_uuid`, `model_job_verified`.
Schema: six nullable columns above; `status` gains values `cancelling`,
`cancelled`. Provenance `event_type` namespace `run.signal.armed`,
`run.signal.started`, `run.signal.job_submitted`, `run.signal.finished`,
`run.signal.duplicate`, `run.stalled`, `run.unstalled`, `run.cancelled`.
Pipeline: args `signal_url`, `signal_token`, `signal_expires`; model-task
inputs `SIGNAL_URL`, `SIGNAL_TOKEN`, `SIGNAL_EXPIRES`. Composite submissions
already recreate the pipeline, so new runs pick these up; old pipelines keep
working with the no-op helper and are never armed.
EM: failure codes `COMPOSITE_WORKFLOW_STALLED`, `MODEL_FAILURE_REPORTED`;
cancel passthrough.

## Data flow

```
UI submit ─► EM ─► adapter /plans/model-run
                     │ userinfo(bearer) → submitted_by
                     │ INSERT workflow_run (id known)            ← main.py:2239
                     │ token = HMAC(secret, "run-signal:v1:"+id+":"+exp)
                     │ runPipeline(args: tapis_token, signal_url, signal_token, signal_expires)
                     │ dispatched_at = now; provenance run.signal.armed
                     ▼
              Tapis Workflows dispatches model task
   ┌──────────────────┴────────────────────────────────┐
   │ task runs                                         │ task never runs
   │ POST /signal started     → last_signal_at,        │ (engine stall)
   │                            started_at, running    │
   │ POST /v3/jobs/submit                              │ +15 min: sweep
   │ POST /signal job_submitted {job_uuid, unverified} │ health=stalled
   │ … Tapis job queued 20 min – 18 h …                │ UI: message + Cancel
   │ POST /signal finished {FINISHED|code}             │   (owner-checked,
   │   → provenance / health=reported_failed           │    terminate → job
   └───────────────────────────────────────────────────┘    cancel → cancelled)
UI (Runs step open) ─every 60 s─► EM getRun ─► adapter /poll (user token)
      verifies job uuid by name · writes Tapis terminal status (wins)
      · clears health=stalled when Tapis shows the task/job alive
```

## Risks and tradeoffs

- Signal token in pipeline args is visible to `adapter-ops` members. Accepted:
  per-run, status-only, expiring, and the same channel already carries the
  user's JWT, which is strictly stronger.
- A token holder can set `health` and write provenance for one run. They
  cannot change `status`, cannot make the UI show a wrong output (no signal
  derives `completed`), and cannot steer cancel (uuid must be verified by a
  Tapis read first). Rate limit and body caps bound DB growth.
- False stall when the adapter is unreachable during the task's first minute.
  Mitigated by the 60 s retry on `started`, by any later signal clearing it,
  by `/poll` clearing it when Tapis shows life, and by the sweep being
  mark-only. Residual: a user may cancel a healthy run that looks stalled; the
  cancel confirmation shows the last Tapis observation.
- Executor cold start / image pull > 15 min, or no egress from the Workflows
  executor to `*.pods.portals.tapis.io`: would flag every armed run. Gated by
  rollout step 0 (throwaway signal-only pipeline) and the kill switch.
- Unattended terminal propagation is **not** delivered by this revision. A
  pipeline that finishes with nobody logged in stays `running` until someone
  opens the Runs step (then ≤ 60 s). Deferred option: a generated tail
  `finalize` task that always runs and posts pipeline completion — requires a
  Workflows "run after failure" semantic we have not verified.
- `/poll` writing non-terminal observations is a behaviour change for an
  existing endpoint; covered by tests, and it only ever moves `health`, never
  `status`, outside the existing terminal rule.
- Six new columns is a migration on a table EM also reads through Hasura;
  all nullable, additive, and the schema-sync runbook exists.
- The re-attach branch (`fix/svo-adapter-model-job-reattach`) changes retry
  semantics and the model-task profile; it must land before or after this with
  `attempt` handling reviewed, not concurrently.

## Alternatives considered

- Credentialed background poller: rejected again (static credential, wrong
  user; cannot see a task that never started).
- Fixed idle timeout: rejected (18 h healthy waits).
- Signal-derived `completed` from "all tasks ok" (revision 1): rejected in
  review — mutable plan task list, `tapis_job` steps cannot signal, lost
  best-effort signals block completion, and a self-report is a false-green
  risk. Tapis remains the only source of `completed`.
- Transform-wrapper signals on every task (revision 1): dropped; largest blast
  radius for no detection benefit.
- `stalled` as a `status` value (revision 1): replaced by a `health` column so
  lifecycle consumers need no special case.
- Per-run token store for an owner-identity poller; Workflows notifications;
  continuous heartbeats: unchanged from revision 1 — deferred or unverified.

## Test plan

Adapter (pytest):
- `apply_signal` transition table: every (status, health, event) pair; sticky
  terminals; `cancelled` sticky against `/poll`; duplicates ignored; server
  timestamps only.
- `/signal` auth: valid token; wrong token, unknown run and expired token all
  401 with identical bodies; previous secret accepted during overlap; body and
  message caps; `task_id != model` → 400; rate limit.
- Sweep: Phase 1 flags only armed, silent, old rows; Phase 1b flags
  started-without-job; unarmed and pre-existing rows never flagged; kill
  switch; a later signal and a `/poll` showing life clear `stalled`.
- `/poll`: verifies `model_job_uuid` by name and sets `model_job_verified`;
  Tapis terminal still wins over `reported_failed`.
- Cancel: owner match via userinfo; admin allowlist; non-owner 403; order
  terminate → job cancel; partial failure leaves `cancelling`; no-op on
  terminal; unverified uuid is not cancelled.
- Generated code: contains the three inputs and three `_signal` calls; helper
  is a no-op without inputs; a failing POST never changes the task result;
  **the generated source never prints `SIGNAL_TOKEN` or `TAPIS_TOKEN`**.
- Lifespan: sweep runs without a Tapis token; Tapis polling does not.

EM (jest): health → failure-code mapping; cancel passthrough; existing
reconcile tests unchanged. UI (vitest): stalled/reported rendering; Cancel
confirm dialog; 60 s refresh starts/stops and backs off; refresh error shown.

Live, on `mintdevsvo` (pass criteria):
0. Signal-only throwaway pipeline: `run.signal.started` provenance within
   2 min of dispatch (proves executor egress and arg binding).
1. Resubmit Barton Springs: `started` and `job_submitted` within 2 min; UI
   shows job id and elapsed time; `health = ok` throughout the queue wait.
2. Induce a stall (pipeline with the model task's code replaced by `sleep
   1200`): `health = stalled` between 15 and 16 min; cancel from the UI as the
   submitter succeeds and the Workflows run reads `terminated`; a non-owner
   token gets 403.

## Documentation plan

`svo-adapter-service/docs/api.md` (signal, cancel, health semantics, secret
list and rotation); `DSO-Architecture/docs/dev/environment-variables.md`
(`SVO_ADAPTER_RUN_SIGNAL_SECRETS`, `SVO_ADAPTER_STALL_AFTER_SECONDS`,
`SVO_ADAPTER_STALL_AFTER_STARTED_SECONDS`, `SVO_ADAPTER_CANCEL_ADMINS`);
`docs/services/svo-adapter.md`. Update this spec's Status and Decisions on
implementation.

## Rollout/rollback plan

0. Before merging: run the signal-only throwaway pipeline against a branch
   deploy or locally against the dev adapter.
1. Migration via the schema-sync procedure. Generate the secret, store it in
   the `Tapis Dev Deploy` environment, extend `register_mint_stack.py`. With
   no secret configured the endpoint returns 503, tasks no-op, nothing is
   armed, the sweep is off.
2. Merge the adapter PR → dev redeploy; live checks 1–2.
3. Merge the EM/UI PR.
4. Rollback: unset the secrets (sweep off, endpoint 503, tasks no-op). Rows
   with `health = stalled` keep `status` intact and resolve on the next
   `/poll`. `cancelled` rows are final by design.

## Open questions

1. ~~Is `run_id` known before `runPipeline`?~~ Resolved: yes (main.py:2239
   precedes dispatch).
2. Executor egress to `*.pods.portals.tapis.io`: verified by rollout step 0.
3. ~~Merge order with `fix/svo-adapter-model-job-reattach`.~~ Resolved: it is
   PR #372, already on `develop`. The task template keeps `attempt: 1` (the
   task cannot see its retry count); a retry's `started`/`job_submitted`
   are liveness, and `finished ok` after `reported_failed` restores `ok`.
4. UI `isPipeline` fall-through: EM returns `execution_mode:
   workflow_pipeline` for the stuck run, so the fix is in `MintRuns.tsx`
   rendering; exact cause to be pinned during the UI PR.
5. Who at TACC receives the Workflows STAGING-stall report (runs
   `7e52b200…`, `7c101f36…`).
6. ~~Does the adapter already verify bearer JWTs anywhere?~~ Resolved: no.
   `main._bearer` only extracts the header; the one verified lookup is
   `tapis.validate_tapis` → `GET /v3/oauth2/userinfo` (tapis.py:909). Submit
   and cancel reuse that call to resolve the username; one extra Tapis
   request per submit.

## Decisions

- 2026-11-02: User chose signal + staleness over a credentialed poller.
- 2026-11-02: Two-phase staleness; Phase 1 15 min from `dispatched_at`,
  Phase 1b 5 min from `started`, Phase 2 unbounded (ls6 waits 20 min – 18 h).
- 2026-11-02 (revision 2, from review): model-task-only signals; no
  signal-derived `completed`; `health` column instead of a `stalled` status;
  sweep is mark-only; `/poll` gains non-terminal writes to `health`; HMAC
  with domain separation and expiry; secret list for rotation; cancel
  requires verified owner and a Tapis-verified job uuid; single
  `apply_signal` state machine with compare-and-set. Unattended completion
  propagation explicitly deferred.
- 2026-11-02: Only armed runs are swept; pre-existing rows never false-flag.
- 2026-11-02: PR #374 stays merged (inert without a service token).
  `tasclient_dsso` added to `adapter-ops`; unused by this design.
- 2026-11-02 (implementation, adapter PR): "armed" is a `signals_armed`
  column written with `dispatched_at` after `runPipeline` returns, and the
  sweep predicate reads it; the `run.signal.armed` provenance event is kept
  as the audit record. Tapis-side helpers (`userinfo_username`, `get_job`,
  `terminate_pipeline_run`, `cancel_job`) use the existing `_api` requests
  helper under the caller's token. The per-run signal rate limit is
  in-process (one adapter pod on dev). `register_mint_stack.py
  --sync-svo-runtime` now manages `SVO_ADAPTER_PUBLIC_URL` and
  `SVO_ADAPTER_RUN_SIGNAL_SECRETS` alongside the Geo actor id, so a rotation
  or an empty (disabling) value reaches the live pod without re-registration.

## User feedback / decisions

- "Tapis-side access for the poller … do this" (morning) — implemented as
  PR #374; superseded in effect once it was established that the dev pod
  carries no service token and a static JWT expires.
- "Do we just need to set up our own secrets to communicate between the
  workflow?" — yes: the per-run signal token authenticates our task code to
  our adapter. It does not replace a Tapis credential; Tapis-confirmed state
  still comes through the user's token.
- "do it" (afternoon) — spec written and revised after four reviews; awaiting
  approval of revision 2.
