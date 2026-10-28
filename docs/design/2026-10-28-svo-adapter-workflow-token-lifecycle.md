# SVO adapter workflow token lifecycle

## Status

Implementing

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

## User feedback / decisions

2026-10-28: approved the lean no-store plan; implementing.
