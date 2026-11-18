# SVO Adapter API reference

The service is a FastAPI application. When running locally, the machine-readable
OpenAPI document is available at `/openapi.json` and the interactive reference at
`/docs` (ReDoc is at `/redoc`). The lists below are the maintained human index, with
endpoints grouped by scope.

Most endpoints accept an optional `Authorization: Bearer <tapis-token>` header. The
token is forwarded to Hasura/Tapis where the operation needs caller authorization.
Use the generated OpenAPI document for the exact Pydantic request and response
schemas.

With `SVO_ADAPTER_REGISTRY_USER_SCOPED=1`, every endpoint that reads the transform
registry (listing, readiness, planning, discovery) reads it as the caller: the bearer
token is sent to Hasura without the adapter's admin secret, and Hasura returns only
public pieces, shared pieces and the caller's own. A request with no token is anonymous
and sees public pieces only. The setting is off by default, in which case every caller
sees every piece.

### Pieces that carry stored Python source

A piece may carry its own Python source instead of running one of the adapter's
built-in transforms. Such code runs with the submitting user's Tapis token, so it is
controlled separately. `SVO_ADAPTER_STORED_SOURCE_ENABLED` is off by default; while it
is off these pieces are left out of planning and a plan that carries stored source is
refused at submit. Built-in pieces are unaffected.

With it on, a caller may run a stored-source piece when:

| Case | Chosen by the planner automatically? |
|---|---|
| The caller owns the piece | Yes |
| The piece is shared or public and an admin approved its current source (`PUT /admin/transform-spec-approval`) | Yes |
| The piece is shared or public and unapproved, and the caller named it (`allow_unapproved_piece_ids` on `POST /plans`, `allow_unapproved` on `POST /transform-specs/{id}/test`) | No |
| Anything else, including another user's private piece | Not runnable |

Each plan step that carries stored source records the piece id, owner and the SHA-256
of the source under `stored_source`. `POST /workflows/submit` checks every such step
again, against the submitter and against the piece as it is now, and answers 403
`STORED_SOURCE_REFUSED` with a `problems` list (`STORED_SOURCE_DISABLED`,
`STORED_SOURCE_PIECE_NOT_VISIBLE`, `STORED_SOURCE_CHANGED`,
`STORED_SOURCE_NOT_PERMITTED`). An opt-in belongs to the user who gave it and does not
carry over to another submitter. Each real run writes a `stored_source_run` provenance
event. Stored code may bind only `tapis_token`, `source_uri` and the run arguments the
piece declares.

**How stored code is called.** Tapis Workflows runs a function task's code as a script
and ignores a task-level `entrypoint`, so the adapter makes the call itself. Source can
take two forms:

- *A function.* If the piece names an entrypoint (`runtime_json.entrypoint`, or
  `source.entrypoint`) and the source defines a top-level function of that name, the
  adapter appends a call to it. The function receives one dict of its task inputs, keyed
  by input name, or nothing if it takes no parameters. Its return value becomes the
  task's `result` output: a string as is, anything else as JSON. Returning `None` sets no
  output. `async` functions are rejected.
- *A script.* Otherwise the source is run unchanged and must call
  `ctx.set_output("result", ...)` itself (`from owe_python_sdk.runtime import
  execution_context as ctx`).

Inputs are the pipeline arguments the piece maps in `env_from_args`, plus
`SOURCE_RESULT`, the previous function step's `result`, when there is one. A main step
that runs stored source is limited to `SVO_ADAPTER_STORED_SOURCE_MAX_EXEC_SECONDS`
(default 600) with no retries. The plan step records the hash of the author's source,
not of the code with the call appended.

Ensemble Manager-owned model-output handoffs additionally require the server-only
`X-Ensemble-Manager-Secret` header. Configure the same value as
`SVO_ADAPTER_INTERNAL_SERVICE_SECRET` on the adapter and
`SVO_ADAPTER_INTERNAL_SERVICE_SECRET` (or `svo_adapter_internal_secret`) on
Ensemble Manager. Do not expose this value to the browser.

Operator routes require the `X-Admin-Secret` header, matching
`SVO_ADAPTER_ADMIN_ROUTE_SECRET`. These are every `/admin/*` route except
`/admin/secrets` (which has its own `X-Secrets-Admin-Secret`), and
`POST /transform-specs`. They act on the registry shared by all users, with the
adapter's own Hasura credential, so a Tapis token does not open them. Without the
header they answer 403 `ADMIN_AUTH_REQUIRED`; when no secret is configured they answer
503 `ADMIN_ROUTES_NOT_CONFIGURED`. Demo mode (`SVO_ADAPTER_DEMO_MODE=1`) does not
enforce this. Do not expose the value to the browser.

## Core API — reusable across SVO Adapter deployments

Swagger UI splits the Core API into five task-oriented groups: Registry, Planning,
Workflows, Runs, and Catalog/objectives.

The OpenAPI document also groups integration and use-case routes under
`Integrations`, `DFC/GAM`, and `NTGAM forecast`. These tags match the route
organization shown in `/docs`; the fixture-backed DFC/objective routes are
read-only lookups except for plan-evaluation/fan-out operations, which persist
plans through the existing adapter workflow tables.

### Service and registry

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Service health. |
| POST | `/data-objects` | Register a data object and its variable contracts. |
| GET | `/data-objects` | List registered data objects. |
| GET | `/transform-specs` | List registered transform specs and contracts. |
| POST | `/transform-specs` | Register one transform spec and its contracts. Operator route (`X-Admin-Secret`). |
| POST | `/transform-specs/{id}/test` | Generate a one-piece Tapis workflow for dry-run inspection, or submit it when `dry_run` is false. Requires a valid Tapis bearer token (401 `TAPIS_AUTH_REQUIRED`), except in demo mode. |
| GET | `/standard-variables` | List standard variables known by the registry. |
| GET | `/reachable/{data_object_id}` | List SVO variables reachable from a registered source. |

### Readiness, planning, and discovery

| Method | Path | Purpose |
|---|---|---|
| POST | `/readiness/check` | Check a source data object against a model-input requirement. |
| POST | `/plans` | Find and persist an ETL plan that closes compatibility gaps. |
| POST | `/plans/deferred` | Create a server-owned adapter plan whose source contract will be supplied by a later model output. |
| POST | `/plans/deferred/{plan_id}/bind` | Bind one Ensemble Manager-owned model-output data object to a deferred plan and return an opaque bound plan token. |
| GET | `/plans/{plan_id}` | Retrieve a stored plan. |
| POST | `/plans/discover` | Discover reachable target variables from a source. |
| POST | `/plans/discover-sources` | Discover sources that can reach a target. |
| POST | `/plans/model-run` | Build a multi-input model-run plan. |

### Workflow execution and provenance

| Method | Path | Purpose |
|---|---|---|
| POST | `/workflows/generate` | Generate and persist a Tapis Workflows definition for a plan. |
| POST | `/workflows/submit` | Register/run a generated adapter workflow, or return a dry-run. Deferred plans require a coordinator-owned `execution_id` and a concrete, already-resolved `source_uri`; mismatches return `DEFERRED_EXECUTION_ID_MISMATCH`. Internal Ensemble Manager composite submissions may include a server-generated `model_task`; the adapter then submits/polls that model job, discovers the declared output, and hands its URI to the first transform task. Composite descriptors require Ensemble Manager authentication, an `execution_id`, and contain no bearer credentials. Tapis submission failures are persisted and returned with `TAPIS_WORKFLOW_SUBMISSION_FAILED` plus a run ID. Accepts `Idempotency-Key` (or the equivalent `idempotency_key` body field) for replay-safe submissions. |
| GET | `/runs` | List recent adapter workflow runs. |
| GET | `/runs/{run_id}` | Retrieve one run. |
| POST | `/runs/{run_id}/poll` | Poll Tapis and persist the run status transition. Also verifies a signalled model job uuid against Tapis (by job name) and clears a `stalled` health verdict when the job exists. Never reverts `cancelled`. |
| POST | `/runs/{run_id}/signal` | Liveness report from the composite model task (`started`, `job_submitted`, `finished`). Authenticated by `X-Run-Signal-Token` / `X-Run-Signal-Expires`, a per-run HMAC derived from `SVO_ADAPTER_RUN_SIGNAL_SECRETS`. Updates `health`, `started_at`, `last_signal_at` and the job identity; never moves `status` to a terminal value. 503 when signals are not configured; uniform 401 for a bad token or unknown run. |
| POST | `/runs/{run_id}/token` | Hand the composite model task the run's current per-run Tapis token (token keeper, `SVO_ADAPTER_RUN_TOKEN_KEEPER_ENABLED`). Authenticated by `X-Run-Token-Credential` / `X-Run-Token-Expires`, a per-run HMAC in its own domain derived from `SVO_ADAPTER_RUN_SIGNAL_SECRETS`; uniform 401 for a bad credential or unknown run; 404 `RUN_TOKEN_UNAVAILABLE` when the keeper is off, the run is not `running`/`submitting`, nothing is stored, or the keeper deadline has passed; 429 per-run rate limit. Mints and stores a successor when the stored token is within the renewal margin. Response is `no-store`; the token appears nowhere else. |
| POST | `/runs/{run_id}/cancel` | Terminate the Workflows run and, when the job uuid has been verified, cancel the Tapis job. Bearer token required; the caller (resolved through Tapis `userinfo`) must be the submitter or in `SVO_ADAPTER_CANCEL_ADMINS`. Moves `cancelling` → `cancelled`; a partial failure stays `cancelling` with the error recorded and returns 502. No-op on terminal runs. |
| GET | `/runs/{run_id}/provenance` | Retrieve provenance events for a run. |

#### Run health and staleness

`health` is a liveness verdict beside the lifecycle `status`: `ok`, `stalled`
or `reported_failed`. A background sweep (same loop as the Tapis poller, on
whenever `SVO_ADAPTER_RUN_SIGNAL_SECRETS` is set and
`SVO_ADAPTER_STALL_AFTER_SECONDS` > 0) marks an armed run `stalled` when no
signal has arrived `STALL_AFTER_SECONDS` (default 900) after dispatch, or when
`started` arrived but no `job_submitted` within `STALL_AFTER_STARTED_SECONDS`
(default 300). After `job_submitted` there is no cutoff: ls6 queue waits of
many hours are normal and the task itself enforces `max_minutes`. The sweep
never changes `status`; any later signal, or a `/poll` that sees the job in
Tapis, clears the verdict. `reported_failed` means the task said it failed;
`/poll` confirms it from Tapis before `status` becomes `failed`. Only runs
submitted while signals were configured are armed, so pre-existing rows are
never flagged. Provenance events use the `run.signal.*`, `run.stalled`,
`run.cancelled` namespace.
| POST | `/runs/{run_id}/register-output` | Register a workflow output as a data object. |

When a completed hosted function task emits a scalar JSON result instead of a
URL, `/runs/{run_id}/poll` exposes the Tapis Workflows archived `.stdout` file
as `output_uri` and exposes a bounded `result` object containing the numeric
`value` plus optional `unit`/`operation`, so Ensemble Manager can register the
result as a downstream data object while the facilitator view displays the
scalar answer separately from the artifact.

The background poller also moves Ensemble-Manager-owned runs (those with an
`execution_id`) to a terminal status, so a run no one is viewing does not stay
`running`. It reads them with the service token, which must belong to a member
of the Workflows group (`adapter-ops`); a run it cannot read is left unchanged.
For these runs it updates status only. Output registration stays with Ensemble
Manager. Set `SVO_ADAPTER_POLL_COORDINATOR_RUNS=0` to skip them.

If a task exits with a JSON payload whose `status` is `error`, the poller
marks the adapter run failed even when the workflow wrapper reports
`COMPLETED`; the response includes the bounded task error in `error_message`.

Hosted transforms remain modular: each function task declares a named `result`
output, and scalar consumers such as `unit_convert` bind their
`SOURCE_RESULT` from the preceding task with a Workflows `task_output` reference.
`depends_on` controls ordering only; it is not treated as a data handoff.

Terminal provider failures always populate `error_message`, including when
Tapis returns no failed-task details. Provider diagnostics are bounded and
sanitized before persistence; credentials and signed URL parameters are not
included.

### Generic catalog/objective helpers

| Method | Path | Purpose |
|---|---|---|
| GET | `/objectives` | List bundled objective definitions. |
| GET | `/objectives/{objective_id}` | Retrieve one objective definition. |
| GET | `/runtime-defaults` | Return runtime defaults used by the service. |
| GET | `/spatial/layers` | List backend-owned reusable spatial source layers, including the MINT region category used when a source is registered. |
| GET | `/etl/common-variables` | Canonical ETL/UI variable contract + legacy aliases. |
| POST | `/objectives/{objective_id}/evaluate-plan` | Evaluate an objective plan. |
| POST | `/datasets/find` | Find catalog datasets for a request. |
| POST | `/datasets/dataset_resources` | List resources for a catalog dataset. |

## Integration API — optional shared deployment plumbing

These endpoints support synchronizing or operating the shared adapter services. They
are not specific to one scientific use case, although the records they load may be.

| Method | Path | Purpose |
|---|---|---|
| POST | `/admin/sync-from-mint` | Dry-run or apply MINT model-configuration and ETL-process to transform-registry sync. An ETL process's owner and visibility are copied to the registry row, and rows for processes no longer in the catalog are deleted. |
| GET | `/admin/sync-status` | Report synchronization state, including unresolved Tapis apps. |
| PUT | `/admin/transform-spec-approval` | Approve, or withdraw approval of, the Python source stored with a piece (`{spec_id, approved}`). Records the SHA-256 of the current source, so approval lapses when the source changes. 400 `NO_STORED_SOURCE` for a piece that runs built-in code. |
| POST | `/admin/sync-from-ckan` | Dry-run or apply CKAN resource-to-data-object sync. |
| POST | `/admin/recompute-edges` | Rebuild the registry compatibility edge cache. |
| POST | `/admin/validate-tapis` | Probe Tapis authentication, Workflows, group, and registration access. |
| POST | `/admin/poll` | Trigger one background Tapis run-status polling pass. |

## Use case: DFC/GAM

This surface exists for the Texas GMA/GAM DFC workflow and should not be presented as
required for a general SVO Adapter installation.

| Method | Path | Purpose |
|---|---|---|
| GET | `/dfc-targets` | List adopted DFC target records/contracts. |
| POST | `/plans/dfc-fanout` | Build a DFC fan-out plan for multiple targets. |
| GET | `/qaqc/modflow6` | Produce the MODFLOW 6/NTGAM DFC QA/QC report. |
| POST | `/qaqc/modflow6/tapis` | Submit or dry-run the QA/QC report as a Tapis workflow. |
| GET | `/qaqc/modflow6/tapis/{run_uuid}` | Fetch QA/QC Tapis run details. |

## Use case: NTGAM forecast

These endpoints implement the NTGAM location-to-subsidence-forecast flow. They use
the shared registry/planner, but their scenario fields, spatial source selection, and
forecast execution are bespoke to NTGAM.

| Method | Path | Purpose |
|---|---|---|
| GET | `/forecast/ntgam/options` | Return NTGAM layers, extents, defaults, and available inputs. |
| POST | `/forecast/plan` | Resolve NTGAM forecast inputs and ETL branches for a location. |
| POST | `/forecast/scenario` | Assemble an NTGAM scenario from resolved registry branches. |
| POST | `/forecast/run-tapis` | Generate or submit the NTGAM forecast as a Tapis workflow. |
| GET | `/forecast/run-tapis/{run_uuid}` | Fetch NTGAM forecast Tapis run details. |

## Related implementation references

- Generic request models and contracts: `app/models.py`
- Generic planner: `app/planner.py`
- Workflow generation and submission: `app/tapis.py`
- MINT/CKAN synchronization: `app/mint_sync.py`, `app/ckan_sync.py`
- NTGAM profile: `app/ntgam.py`
- DFC/GAM and QA/QC profile: `app/qaqc.py` and the DFC sections in `app/main.py`

### Deferred model-output handoff

The deferred endpoints remain available for older coordinator-managed
post-model plans. New MINT post-model runs use the internal composite form of
`/workflows/submit`: Ensemble Manager supplies a server-generated model job
descriptor, and the adapter owns model submission, polling, exact output-file
matching, and the subsequent modular transform tasks in one workflow. The
adapter captures the provider UUID returned by Tapis Jobs and never correlates
the output by job name, guessed archive path, or a generic workflow environment
variable. The model task emits a named `result` URI, which hosted transforms
consume through a Workflows `task_output` reference.
