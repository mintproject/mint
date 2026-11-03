# SVO adapter workflow token lifecycle

## Status

Implementing (rev 2, 2026-11-03: Phase 2 redesigned as a server-side token
keeper, reviewed and revised, code on branch `feat/svo-adapter-run-token-keeper`;
Phase 1 is Implemented and deployed on the develop pod)

## Rev 2 summary (2026-11-03)

Phase 1 shipped and is on `mintdevsvo` with a 4 h per-run TTL. On 2026-11-03
two composite runs failed with `MODEL_PROVIDER_AUTH_FAILED` (HTTP 401) on
their very first Tapis request: the Workflows engine had wedged them for
4.6 h and 29 h before the task code ran, so the per-run token was already
expired when the task started. The task's self-renewal (`_renew_if_due`,
which mints a successor with the live token) cannot help here, because it
only runs inside the task and needs a token that is still valid.

Two facts changed since the Phase 2 text below was written:

1. A live user access token can mint its own successor via
   `POST /v3/tokens` (verified live on `portals` 2026-11-03). Phase 2 does
   not need a refresh token or a login flow.
2. The run-signal channel (`docs/design/2026-11-02-run-signal-and-staleness.md`)
   gives every composite run a per-run HMAC credential the task already
   carries. That is the authenticator for a token-fetch endpoint; nothing new
   has to be distributed to the task.

Phase 2 (revised) therefore moves renewal from the task to the adapter, which
is always running: keep each run's token alive server-side and hand the
current one to the task when it starts late or gets a 401.

### Phase 2 (revised): server-side token keeper

Config, no code (do first): raise `SVO_ADAPTER_RUN_TOKEN_TTL_SECONDS` on the
develop pod from 14400 to 172800 (the server max and the model task's own
`max_exec_time`), and set it in the deploy workflow's SVO runtime step so a
redeploy keeps it. On its own this covers engine delays up to two days.

Code:

1. **Schema.** `adapter.workflow_run` gains `run_token_enc TEXT` (Fernet
   ciphertext of the current per-run token) and `run_token_expires_at
   TIMESTAMPTZ`. Both NULL when the keeper is off or the run is terminal.
2. **Keeper storage.** New settings `run_token_keeper_enabled` (default
   false) and `run_token_encryption_key` (Fernet key, env
   `SVO_ADAPTER_RUN_TOKEN_ENCRYPTION_KEY`). With the keeper on, `/workflows/submit`
   stores the minted token encrypted on the run row right after the row is
   inserted. Keeper on without a key fails closed at submit (502), matching
   the Phase 1 mint-failure behavior. The plaintext token never enters logs,
   provenance payloads, or API responses other than the endpoint in (4).
3. **Renewal sweep.** `poller.renew_run_tokens()` runs in the existing
   poller loop beside `sweep_stalled`. For every run in `running`/`submitting`
   whose `run_token_expires_at` is within `max(300, ttl // 4)` seconds, it
   decrypts the stored token, mints a successor with `mint_run_token(stored)`
   (same request shape as Phase 1), and stores the new ciphertext and expiry.
   A failed mint is logged without the token and retried next loop; a token
   that has already expired is cleared, and the run keeps whatever health the
   stall sweep assigns. The poller's terminal update clears both columns.
4. **Fetch endpoint.** `POST /runs/{run_id}/token` (POST so no intermediary caches it), authenticated exactly like
   `POST /runs/{run_id}/signal` (headers `X-Run-Signal-Token` and
   `X-Run-Signal-Expires`, constant-time check against every configured
   secret, same per-run rate limit, same 401 for bad token and unknown run).
   Returns `{"token": <jwt>, "expires_at": <iso>}` when the run is
   non-terminal and a token is stored; 404 `RUN_TOKEN_UNAVAILABLE` otherwise.
   Records provenance `run.token.fetched` with no token in the payload.
5. **Signal-token lifetime.** `run_state.signal_expiry` currently expires the
   HMAC credential `max_minutes` plus slack after dispatch. A task that starts
   after an engine delay longer than `max_minutes` could then neither signal
   nor fetch. Change it to `dispatch + max(max_minutes * 60,
   model_task_max_exec_seconds) + slack` so the credential outlives any run
   the engine can still legally start.
6. **Model task.** New pipeline param/input `token_url` → `TOKEN_URL`,
   injected at submit beside `signal_url`. The task gains `_fetch_token()`,
   which GETs `TOKEN_URL` with the signal headers (5 s timeout, 3 tries) and
   swaps `_auth["token"]` when a token comes back. It is called (a) before the
   first Tapis request when the baked-in token is expired or within the renew
   margin, and (b) once inside `_request` on 401/403 before `_die`, retrying
   the request a single time if the token changed. Existing self-renewal stays
   as the fast path while the task is running.
7. **Revocation** stays out of scope (Phase 1 decision). Clearing the columns
   on terminal status removes the adapter's copy only.

### Rev 2 review outcome (security-reviewer + skeptic, 2026-11-03)

Both returned "revise, do not reject". Changes adopted before implementation:

- **Separate credential.** The fetch endpoint authenticates with its own HMAC
  domain (`run-token:v1:`), delivered as `token_fetch_token`/`token_fetch_expires`
  beside the signal credential. A leaked signal token cannot fetch a Tapis
  token. Its expiry equals the keeper deadline, not `signal_expiry`.
- **Hard bounds on renewal.** `run_token_deadline_at = dispatch + 72 h`
  (configurable) stops serving and renewing regardless of status;
  `run_token_renewals` is capped (default 12). Columns are cleared on every
  terminal write, on cancel, on deadline, and on decrypt failure. The stored
  token is **revoked** (`POST /v3/tokens/revoke`, verified live 2026-11-03) when
  cleared, and each predecessor is revoked after its successor is stored, so at
  most two tokens per run are live at any time.
- **On-demand mint first, sweep optional.** The endpoint itself mints a
  successor when the stored token is within the renewal margin, so a task
  always gets a token with most of its TTL left. The background sweep is
  behind `run_token_keeper_sweep_enabled` (default off) and only matters for
  waits longer than one TTL.
- **401 only, no blind resubmit.** The task fetches on 401, never on 403. On a
  401 from `/v3/jobs/submit` it re-checks `_existing_job()` by name before
  submitting again, so a job Tapis accepted before the 401 surfaced is attached
  rather than duplicated. Fetches are capped at 20 per task.
- **Clear failure code.** A task whose baked token is expired and cannot fetch
  dies with `RUN_TOKEN_EXPIRED_BEFORE_START` instead of "the UI Tapis token was
  rejected".
- **Storage.** `MultiFernet` over a comma-separated key list for rotation;
  ciphertext wraps `{rid, tok}` so a row's ciphertext cannot be moved to another
  run. Keeper on without a usable key or without run signals fails at startup.
  The endpoint is POST with `Cache-Control: no-store`. `public_base_url` must
  be https when the keeper is on.
- **Leak surfaces.** `token_fetch_token` is stripped by `_public_workflow_args`;
  keeper provenance is screened for JWT/Fernet-shaped values before writing;
  `GET_RUN`/`LIST_RUNS` do not select the token columns (a dedicated
  `GET_RUN_TOKEN_STATE` query does). `adapter.workflow_run` has no non-admin
  Hasura role permissions, so the new columns are admin-only without a
  metadata change (checked `graphql_engine/metadata/tables.yaml`).
- **Verified live before coding:** the Workflows executor reaches the adapter
  pod (`GET /health` from a canary task, 0.11 s); `POST /v3/tokens` self-mint;
  `POST /v3/tokens/revoke`. The run row is `running` from dispatch, so the
  keeper's status filter covers the engine-wedge case.
- **QA pass (qaqc, 2026-11-03) fixes folded in:** a failed dispatch releases
  and clears the stored token; the terminal-write clear is gated on the
  keeper being configured (so a database without the migration keeps working
  with the keeper off); on a lost renewal CAS the endpoint serves the winner's
  token; the sweep and the endpoint also clear rows stuck in `cancelling`; a
  token with no `exp` is served as-is instead of re-minted; deploy values are
  applied only when the variable/secret is set, and a keeper switched on
  without a key is refused by the deploy script.
- **Signal credential lifetime (not in the original rev 2 text):** when the
  keeper arms a run, the `/signal` credential is re-issued to expire with the
  keeper deadline (72 h) if that is later than `signal_expiry`, so a task that
  starts after a long engine delay can still report `started`. It stays a
  separate domain and cannot fetch a token.
- **Not changed:** the interim 48 h TTL stays until the keeper has run live;
  then it should come back down (the keeper makes a short TTL safe).
  Revisiting the Phase 1 "keep TTL short" decision is recorded below.
- **Open:** the Ensemble Manager also builds the job definition
  (`mint-workflow-model-<execution>`); the task attaches by that name, so a late
  start never duplicates a job the EM already created. Which side owns the job
  for coordinator runs is documented in the unified execution design, not here.

### Rev 2 files

- `graphql_engine/migrations/<ts>_adapter_workflow_run_token_keeper/{up,down}.sql`
- `svo-adapter-service/app/run_tokens.py`: Fernet encrypt/decrypt helpers,
  `renew_margin_seconds()`, `token_expires_at(jwt)`.
- `svo-adapter-service/app/config.py`: keeper flag, encryption key.
- `svo-adapter-service/app/main.py`: store at submit, `token_url` arg,
  `POST /runs/{run_id}/token`.
- `svo-adapter-service/app/poller.py`: `renew_run_tokens`, column select,
  terminal clear.
- `svo-adapter-service/app/run_state.py`: fetch-credential HMAC domain,
  `token_url`, `token_fetch_expiry`, `clear_token_update` (signal lifetime is
  extended at submit in main.py, not in `signal_expiry`).
- `svo-adapter-service/app/tapis.py`: `token_url` param/input, task
  `_fetch_token`, 401 retry.
- `svo-adapter-service/app/store.py`: demo-store support for the new columns.
- `svo-adapter-service/requirements.txt`: `cryptography`.
- `.github/workflows/deploy-mint-dev-pods.yml` and
  `deploy/tapis/register_mint_stack.py`: pass the TTL, keeper flag and key.
- Tests (as built): `tests/test_run_token_keeper.py` (crypto round trip and
  rotation, margin, config fail-closed, credential domains, endpoint auth /
  404 / 429 / renew / cap, sweep, release, and the generated task executed
  against a stubbed urllib for late start, no-keeper failure code, and
  401-on-submit without a duplicate job); `tests/test_run_signal.py` (submit
  stores the token and arms the fetch credential; nothing stored when off);
  `tests/test_poller.py` (terminal write clears the keeper columns).

### Rev 2 risks

- At-rest storage of a user token, encrypted with a service-held key. The
  key is a new secret with the same handling as `SVO_ADAPTER_RUN_SIGNAL_SECRETS`.
  A compromised adapter host already holds every in-flight token in Postgres;
  the Phase 1 design already accepted that the token lives in Tapis run args
  visible to the run owner.
- The fetch endpoint turns the per-run HMAC credential into a bearer for a
  real Tapis token. The credential is bound to one run id, expires, and is
  only ever delivered to the Workflows executor through run args, so its
  exposure equals that of `tapis_token` today.
- Renewal depends on the stored token still being valid when the sweep runs.
  With a 48 h TTL and a sweep margin of 12 h, the adapter would have to be
  down for 12 h straight to miss a renewal.

## Objective

Stop adapter-submitted Tapis Workflows from failing when the caller's Tapis
access token expires while the workflow is still running, using the same
approach SUBSIDE adopted in
`subside/docs/design/2026-10-21-token-expiry-durability.md`.

## User need

A user who submits an adapter workflow (composite model run, ETL pipeline,
NTGAM forecast, remote QA/QC) should see it complete even if it outlives their
browser token. Today a long model stage fails with
`MODEL_PROVIDER_AUTH_FAILED` (HTTP 401/403) partway through.

## Current code/system summary

Verified by reading the code; nothing here has been run.

- `app/main.py` extracts the caller's bearer token (`_bearer`) and
  `_validate_plan_args` injects it into the workflow args as
  `tapis_token` (`main.py` ~L2093). `tapis.generate_tapis_workflow` wires
  that arg to the `TAPIS_TOKEN` input of function tasks
  (`tapis.py` ~L365, `task_code.py`).
- The composite model stage (`tapis.py` ~L142-175) polls a Tapis job using
  `TAPIS_TOKEN`, and on 401/403 calls `_die(... MODEL_PROVIDER_AUTH_FAILED)`.
  This is the long-running path that breaks on expiry.
- Other tasks pass the same token as `read_token` to the geo actor.
- The adapter is stateless about identity: it has no login endpoint, no token
  store, and no refresh-token handling. Persistence is Hasura/Postgres
  (`adapter.*` tables; `store.py` is demo-mode only).
- `SVO_ADAPTER_TAPIS_TOKEN` is a static service fallback used by the
  unattended poller (`poller.py`). Coordinator-owned runs (`execution_id`
  set) are deliberately not polled by it.
- ui-react uses Tapis implicit auth, which returns no refresh token
  (`docs/design/2026-10-02-ui-token-expiry-recovery.md`), so no refresh token
  exists for the adapter to hold today.

## Proposed design

Phase 1 is the required fix. It needs no refresh token and no token store.
Phase 2 is optional and gated on a refresh-token source existing; it is the
point at which a token store would be introduced.

### Phase 1: bounded per-run credential

At non-dry-run submission (`/workflows/submit`, NTGAM submit, remote QA/QC
submit):

1. Validate the caller token and derive the username from the Tapis identity.
2. Compute a bounded TTL from a per-pipeline walltime estimate plus a
   configurable buffer, clamped to server-side min/max. Never accept a
   client-supplied TTL.
3. Mint a separate user-associated token with `POST /v3/tokens`
   (`token_tenant_id`, `account_type`, `token_username`, `target_site_id`,
   `access_token_ttl`), authenticated with the caller token. This is the
   contract verified for SUBSIDE on the `portals` tenant; it must be
   re-verified for the adapter's tenant/site before enabling.
4. Pass only the per-run token as `tapis_token`; never the caller's token.
5. Do not persist the token. It lives only in the workflow args Tapis keeps
   for the run. It must not appear in logs, provenance payloads, API
   responses, or `_public_workflow_args`.
6. No revocation. The token expires on its own after its bounded TTL, which is
   the only cleanup. A run that is cancelled or fails early leaves a valid
   token until then, so the TTL is kept as short as the pipeline allows.

Failure behavior: if minting fails, do not submit and return 502; if the
feature is enabled but the TTL or caller identity cannot be determined, fail
closed and never fall back to the caller token for a long run. Submitting
happens with the caller's token (register + run); only the `tapis_token`
workflow arg is swapped for the run token.

Only the submit paths that put `tapis_token` in workflow args are affected:
`/workflows/submit` and `/transform-specs/{id}/test`. NTGAM and remote QA/QC
embed no token arg and are unchanged.

### Phase 2 (optional, separate gate): refresh broker

Only if a server-side refresh token becomes available (e.g. ui-react moves to
the authorization-code flow against a confidential client, or a password-grant
login endpoint is added for scripts). The adapter would store the refresh
token encrypted, issue an opaque lease-bound credential to the workflow, and
expose an internal broker endpoint that refreshes the user session and rotates
the per-run token, as in SUBSIDE
(`POST /api/subside/internal/run-token/{lease_id}`). Generated tasks would
call the broker on 401 instead of calling `_die`. This is not needed to cover
runs shorter than the bounded TTL.

### Credential separation

Do not assume the per-run token is valid for every downstream service. Verify
separately that it works for Tapis Files/Jobs/Workflows, the geo actor
(`read_token`), CKAN reads of private resources, and STAC. Keep CKAN/STAC
service credentials separate where they differ; do not widen the per-run token.

## Files likely affected

- `svo-adapter-service/app/run_tokens.py` (new): mint helper, TTL clamping,
  redaction-safe errors.
- `svo-adapter-service/app/main.py`: swap `tapis_token` in `/workflows/submit`
  and `/transform-specs/{id}/test`.
- `svo-adapter-service/app/config.py`: feature flag and TTL settings.
- `svo-adapter-service/tests/test_run_tokens.py` (new).
- `svo-adapter-service/docs/api.md`, README, and DSO-Architecture
  `docs/dev/environment-variables.md`.

## API/schema changes

- No schema change in Phase 1 (no token store).
- No change to public request/response shapes. Run responses must not include
  the token; dry-run output continues to strip `tapis_token`.
- New env vars under the `SVO_ADAPTER_` prefix: run-token enable flag, TTL
  seconds, TTL min/max, target-site prefix.
- Phase 2 only: broker endpoint and refresh-token storage, not part of this
  approval.

## Data flow

Caller token -> mint bounded run token -> run token passed as `tapis_token` ->
workflow tasks use it -> token expires naturally.

## Risks and tradeoffs

- No revocation: a leaked run token stays valid until its TTL ends, and a
  cancelled or failed run does not shorten that. Mitigated only by keeping the
  TTL bounded.
- A single configured TTL is a guess at walltime. Too short reintroduces the
  failure; too long widens exposure. Phase 2 addresses runs that outlive it.
- The minted-token contract is verified only for SUBSIDE's tenant; the
  adapter's tenant and target site must be confirmed.
- Coordinator-owned runs (`execution_id`) also pass through
  `/workflows/submit`, so they get a run token too; they are still polled with
  the caller token and are otherwise unchanged.
- Adding revocation or a broker later requires introducing a token store.

## Alternatives considered

- Static `SVO_ADAPTER_TAPIS_TOKEN` for workflows: rejected; the 2026-10-02
  design already rejects a shared service credential because it runs as the
  wrong user.
- Pass a refresh token into the workflow: rejected; it widens exposure.
- Ensemble Manager owns login/broker: deferred to a follow-up; larger
  cross-service change.
- Token store (Postgres or SQLite) with revoke-on-finish: deferred to Phase 2;
  the lean no-store version was chosen 2026-10-28 (user).

## Test plan

- Hermetic unit tests with mocked Tapis Tokens API: mint request shape, TTL
  clamping, username derivation, no token in errors/logs, fail-closed when
  enabled but mint fails.
- Test that the args reaching `submit_tapis_workflow` carry the run token, not
  the caller token, and that `_public_workflow_args` still strips it.
- Sandbox: mint, use for Files/Jobs/Workflows/geo actor, confirm the token
  works until its TTL. Live runs need explicit approval.

## Documentation plan

Update `svo-adapter-service/docs/api.md` and README, the new env vars, and the
DSO-Architecture adapter service page and environment-variables page.

## Rollout/rollback plan

Ship behind a flag, default off; with it off, behavior is unchanged. Enable in
the develop pod after sandbox verification. Roll back by clearing the flag;
outstanding tokens expire naturally.

## Open questions

1. Is the `portals` `POST /v3/tokens` mint contract valid for the adapter's
   tenant/target site and for the geo actor, CKAN, and STAC?
2. What walltime estimate per pipeline (model stage, ETL, NTGAM, QA/QC)?
3. (resolved: no key needed in Phase 1)
4. Does Phase 2 need to follow soon (is any run expected to exceed the max
   TTL), and is moving ui-react to authorization-code login acceptable?
5. When should coordinator-owned runs get their own handling (they pass through `/workflows/submit` and get a run token, but polling still uses the caller token)?

## Decisions

- 2026-10-28: Scope is adapter-submitted workflows only; coordinator-owned
  (`execution_id`) runs are a follow-up (user).
- 2026-10-28: Superseded the Postgres lease store. Phase 1 is lean with no
  token store and no revocation; natural expiry is the cleanup (user: "lets do your plan").
- 2026-10-28: The failure to fix is token expiry during the workflow, as in
  SUBSIDE; Phase 1 per-run token is the required fix and the refresh broker is
  optional Phase 2 (user).

- 2026-11-03: Phase 2 redesigned as a server-side token keeper (encrypted
  store, renewal sweep, HMAC-authenticated fetch endpoint) after two runs
  failed on an already-expired token following a multi-hour Workflows engine
  stall. Trigger: `POST /v3/tokens` self-mint verified live, so no refresh
  token is needed. Approved by user ("Approve full plan").
- 2026-11-03: TTL on the develop pod raised to 48 h as the immediate
  mitigation, independent of the code change.

## User feedback / decisions

2026-10-28: approved the lean no-store plan; implementing.
2026-11-03: approved rev 2 (config change now, keeper + endpoint + task
changes on a branch with security-reviewer and skeptic review before code).
