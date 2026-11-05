# Catalog registration on merge

Status: In Review (2026-11-05)

## Objective

Catalog rows that live as code are applied by CI on merge, not by a person running
a script with their own token. This covers the adapter's hosted ETL pieces, the
adapter's registry sync, and the SUBSIDE model catalog YAML. A merge followed by a
deploy leaves dev runnable with no manual step.

## User need

"Shouldn't this all build with the actions we have?" Today every catalog change is
a laptop run:

- `register_existing_etl_pieces.py --apply` needs the Hasura admin secret.
- `POST /admin/sync-from-mint` is a manual call.
- `register_subside_to_mint.py` needs the author's Tapis JWT as `MINT_API_TOKEN`.

So a merged change is not live until someone remembers the right command, and
writes are tied to one person's credentials.

## Current code/system summary

- **monorepo.** `build-mint-dev-images.yml` builds the changed services on push.
  `deploy-mint-dev-pods.yml` runs on its `workflow_run`. It uses the
  `TAPIS_USERNAME`/`TAPIS_PASSWORD` service-account secrets to update pod tags,
  apply Hasura migrations through `deploy/tapis/register_mint_stack.py` (when the
  schema changed), and restart pods. The repo already holds
  `HASURA_GRAPHQL_ADMIN_SECRET`. No step writes catalog rows or runs the adapter
  sync.
- **Adapter sync.** `POST /admin/sync-from-mint` has no caller check, and the
  adapter always writes with its admin secret. After #389, re-running it is safe:
  it is idempotent and contracts are replaced, not appended.
- **Hosted ETL pieces** live in `svo-adapter-service/examples/*_transforms.json`.
  The script upserts them into `modelcatalog_etl_process` by stable id.
- **SUBSIDE catalog.** The YAML lives in `wmobley/subside`
  (`tapis/workflow_apps/opera-disp-s1.model-catalog.yaml`). The loader lives in
  `wmobley/modflow-executables` (`scripts/register_subside_to_mint.py`). It creates
  rows through model-catalog-api REST, which forwards the caller's JWT, and patches
  links through Hasura with the admin secret. Neither repo has secrets or a
  registration workflow.

## Proposed design

1. **monorepo: a "Register catalog pieces" step in `deploy-mint-dev-pods.yml`.**
   It runs after the pods restart, and only when registered content changed.
   `deploy/mint_change_plan.py` gains an `etl_catalog_changed` output. It is
   true when the push touches `svo-adapter-service/examples/*_transforms.json`,
   `transform_spec_registration.json`, `scripts/register_existing_etl_pieces.py`
   or `app/mint_sync.py`. A manual `workflow_dispatch` can force the step. The
   writes are idempotent upserts, so an extra run is harmless; skipping
   unrelated deploys just avoids needless writes and failures. The step:
   - waits for `mintdevsvo` to report healthy;
   - runs `register_existing_etl_pieces.py --apply` against the dev Hasura URL,
     with `HASURA_GRAPHQL_ADMIN_SECRET` from repo secrets;
   - calls the adapter sync (item 3) and fails the job on any `warnings` that name
     a hosted piece;
   - verifies that no hosted piece has `transform_type = etl_process`, and that no
     spec has duplicate contracts. Otherwise the deploy goes red.
2. **SUBSIDE catalog: a Hasura-only apply mode, run from subside CI.**
   - `register_subside_to_mint.py` gains `--via-hasura`. It performs the same
     creates as GraphQL upserts with stable ids. It then runs the existing patch
     mutations, so the run is idempotent without the REST API or a user JWT.
     Ownership (`--owner-username`) stays an explicit value from the YAML. It is
     not inferred from a token.
   - A new `wmobley/subside` workflow, `register-catalog.yml`, runs on push to main
     when the catalog YAML changes, and on `workflow_dispatch`. It checks out
     modflow-executables at a pinned ref and runs the loader with `--via-hasura`.
     It needs two new repo secrets, `MINT_DEV_HASURA_URL` and
     `MINT_DEV_HASURA_ADMIN_SECRET`, held in a `mint-dev` GitHub environment.
   - A pull request runs `--dry-run` only and posts nothing.
3. **Close the open sync endpoint.** `POST /admin/sync-from-mint` requires
   `X-Internal-Service-Secret`, using the existing `_internal_service_authorized`
   helper. The deploy step sends it. The UI and docs that call the sync are
   checked and updated.

## Files likely affected

- `monorepo/.github/workflows/deploy-mint-dev-pods.yml`
- `monorepo/deploy/tapis/register_mint_stack.py` (health wait + sync call), or a
  small `deploy/register_catalog.py`, plus tests
- `monorepo/svo-adapter-service/app/main.py` (sync auth) + tests
- `modflow-executables/scripts/register_subside_to_mint.py` (`--via-hasura`) + tests
- `subside/.github/workflows/register-catalog.yml` (new)

## API/schema changes

- `POST /admin/sync-from-mint` returns 401 without `X-Internal-Service-Secret`.
- No schema change.

## Data flow

merge to develop → image build → pod deploy → register ETL pieces (Hasura) →
adapter sync → verify registry. Separately: merge to subside main (YAML) →
loader `--via-hasura` → catalog rows → the next adapter sync picks up model
contracts.

## Risks and tradeoffs

- **The admin secret in a second repo widens its exposure.** The mitigations are
  an environment-scoped secret, `main`-only runs, no runs for fork PRs, and a
  pinned loader ref. The alternative is a scoped Hasura role for catalog writes,
  which is better but is a larger change and is gated on the P1 catalog-permission
  work.
- **`--via-hasura` bypasses model-catalog-api validation.** The loader already
  writes link columns this way. Upserts use stable ids, and the dry-run output is
  reviewed on the PR.
- **A bad manifest can turn the deploy red.** That is intended, because a merged
  piece that cannot run should be visible.

## Alternatives considered

- **Keep manual runs.** Rejected: this is the problem.
- **Use a service-account JWT for the REST path.** This needs a catalog service
  user and token refresh in CI. Revisit after P1.
- **Have monorepo CI pull and apply the subside YAML.** This couples monorepo
  deploys to another repo's content. Rejected.

## Test plan

- Unit tests for `--via-hasura` mutation building, and an idempotent second run.
- A test that the sync endpoint rejects calls without the header.
- A deploy-step dry run on a branch (`workflow_dispatch`).
- The first live deploy repairs the 55 synced pieces. Read back: zero
  `etl_process` hosted pieces, contract counts per spec match the manifests.

## Documentation plan

- DSO-Architecture `docs/architecture/cicd.md` and the svo-adapter service page
  get the registration step and the sync auth.
- The subside README gets a short "catalog changes deploy on merge" note.

## Rollout/rollback plan

- Land the adapter sync-auth change and the deploy step together.
- Add the subside secrets, then the workflow.
- Rollback means reverting the workflow step. Rows already written are
  idempotent upserts and need no cleanup.

## Open questions

1. A scoped Hasura role vs the admin secret for the subside workflow. The
   recommendation is the admin secret now, the scoped role after P1.
2. Should a prod deploy get the same step later? This note is dev-only.

## Decisions

- 2026-11-05: drafted after the AOI typing needed a personal JWT and the ETL
  registration/sync needed manual runs (see `2026-11-05-aoi-etl-piece.md`).

## User feedback / decisions

- 2026-11-05: user noted registration need not run on every deploy. The
  monorepo step is now gated on changes to the registered files (or a manual
  dispatch); the subside workflow was already path-filtered to the YAML.

- 2026-11-05: user asked that catalog registration build through Actions rather
  than personal tokens.
