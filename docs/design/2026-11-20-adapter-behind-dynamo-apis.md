# Phase F: the SVO adapter behind DYNAMO's APIs

## Status

Draft. Not yet reviewed. Phase F of `2026-11-19-flows-as-models.md`, expanded here.
The parent spec's line "the adapter is put behind DYNAMO's APIs" is recorded there as
proposed by the assistant and not yet confirmed by the user.

Paths below are relative to the `docs-phases` worktree root,
`/Users/wmobley/Documents/Github/modflow-suite/monorepo/.claude/worktrees/docs-phases/`,
unless absolute. Short names: **ADP** = `svo-adapter-service/`, **EM** = `mint-ensemble-manager/`,
**CAT** = `model-catalog-api/`, **UI** = `ui-react/`, **MCP** = `mcp-suite/servers/dynamo/`
(`/Users/wmobley/Documents/Github/modflow-suite/mcp-suite/servers/dynamo/`).

## Objective

Make the adapter an internal engine. People and clients use DYNAMO's public APIs: the
Ensemble Manager (EM, `/v1/...`) and the Model Catalog API (`/v2.0.0/...`). The browser and
the MCP stop calling the adapter directly. The adapter keeps its code and its database
tables, and is not merged into another service or rewritten.

## User need

**[ASSUMPTION — confirm]:** the users and jobs below are inferred from the parent spec and
the user's words, not from an interview. The end-user profile was not run.

- **Primary user:** a platform maintainer who registers pieces and flows and runs them from
  a modeling thread. Technical, comfortable with the API, not a Tapis expert.
- **Secondary users:** a modeler using the web app; an agent using the dso-dynamo MCP; the
  operator who deploys the pods.
- **Job-to-be-done:** a client calls one DYNAMO address for plans, runs, data, pieces and
  secrets, and the same auth rule applies to all of them.
- **Current pain:** the browser holds the adapter's address and calls it directly (for
  example `/spatial/layers`, and `/secrets` on the `ui-credentials` branch). The MCP calls
  about 15 adapter routes directly. Each new client has to learn the adapter's auth, and
  the adapter's public routes are open to anyone who finds them (see Current code).
- **Definition of success:** the user asks "could we fully integrate the adapter into the
  DYNAMO APIs?" and gets an answer in which every user-facing call goes through DYNAMO,
  the adapter refuses direct user calls, and no thread, run or secret stops working during
  the move.

## Current code/system summary

### What the adapter exposes (68 routes plus `GET /`)

`ADP/app/main.py`, grouped by the caller it serves today. Counts are routes.

| Group | Routes | Auth today |
|---|---|---|
| Service-only (EM calls them) | 4 | EM secret, where checked (see below) |
| Tapis-task callbacks | 3 | per-run HMAC (`X-Run-Signal-Token`, `X-Run-Token-Credential`) |
| Operator | 15 | `X-Admin-Secret` (14 `/admin/*` routes and `POST /transform-specs`); `/admin/secrets` uses `X-Secrets-Admin-Secret` |
| Public reference reads | 8 | none |
| User routes | 38 | Tapis token, EM secret, or none, depending on the route |

The 4 service-only routes: `POST /plans/deferred`, `POST /plans/deferred/{id}/bind`,
`POST /workflows/submit`, `POST /runs/{id}/register-output`.
The 3 callbacks: `POST /runs/{id}/signal`, `GET /runs/{id}/credentials`, `POST /runs/{id}/token`.
The 8 public reads: `GET /health`, `GET /objectives`, `GET /objectives/{id}`,
`GET /runtime-defaults`, `GET /spatial/layers`, `GET /etl/common-variables`,
`GET /dfc-targets`, `GET /forecast/ntgam/options`.

The 38 user routes are listed with their callers in the route table below.

### How auth works in the adapter (checked in code)

- **User identity from a token.** `_caller_or_none` (`ADP/app/main.py:356`) asks Tapis for
  the username of a bearer token (`tapis.userinfo_username`) and caches the answer for 60
  seconds. `_require_caller` (`:341`) and `_require_signed_in` (`:2203`) refuse without one.
  Some routes take the token optionally (`create_plan`, `:1934`), and whether they refuse
  an anonymous caller is **not verified** in this pass.
- **EM secret.** `_internal_service_authorized` (`:373`) compares `X-Ensemble-Manager-Secret`
  with `settings.internal_service_secret`, **or with `settings.hasura_admin_secret` when the
  first is unset** (`ADP/app/main.py:374`). The deploy scripts and `compose.yaml` do not set
  `SVO_ADAPTER_INTERNAL_SERVICE_SECRET` (`deploy/tapis/register_mint_stack.py`, adapter env
  at `:371-409`; `compose.yaml:427-447`). So on those deploys the EM secret **is** the Hasura
  admin secret. **[Live pod settings not checked.]**
- **EM secret reads every run.** `_run_reader` (`:382-391`) returns `_ANY_RUN` for the EM
  secret. `GET /runs` then has no owner filter (`:3784`).
- **Run ownership.** `_require_run_reader` (`:404`) answers 404 to anyone but the submitter
  (or an admin in `SVO_ADAPTER_CANCEL_ADMINS`, or the EM secret).
- **Operator routes.** `_operator_route_guard` (`:293-323`) checks `X-Admin-Secret` against
  `SVO_ADAPTER_ADMIN_ROUTE_SECRET`. It answers 503 when that setting is empty.
- **Hasura credential.** `HasuraClient._headers` (`ADP/app/hasura.py:44-58`) sends the
  **admin secret whenever it is configured**, whatever the caller's token. So a user's token
  never reaches Hasura for adapter tables. User isolation is enforced in the adapter code,
  not by Hasura. The one exception is `SVO_ADAPTER_REGISTRY_USER_SCOPED`
  (`ADP/app/config.py:47`, off by default), which reads the piece registry as the caller.
- **CORS.** `allow_origins=["*"]` is hard-coded (`ADP/app/main.py:329`). There is **no**
  `SVO_CORS_ORIGINS` setting in `ADP/app/config.py` or `ADP/app/main.py`. The name appears
  in `deploy/tapis/register_mint_stack.py`, `compose.yaml` and `docs/deploy/mint-dev-pods.md`
  for other services; it was not traced further. The DSO page for the adapter does not
  mention CORS.

### Findings from tracing the routes (found, not caused by this phase)

These are code-level findings. None was run against a live pod. Each needs its own fix,
and the first three may need to ship before Phase F.

1. **`POST /data-objects` writes with the admin secret and no caller check** when no owner
   field is sent (`ADP/app/main.py:704-731`). The owner check at `:710-719` applies only
   when `owner_execution_id`, `owner_model_child_id` or `owner_tenant` is sent. **[Confirm
   with a call on dev before acting.]**
2. **`POST /forecast/run` has no auth at all** (`ADP/app/main.py:4686-4696`). It calls
   `ntgam.run_forecast`, which runs the SUBSIDE screening model (`subside_python` in
   `config.py:278`). `ntgam.py` was not read.
3. **`GET /transform-specs` with no token returns the whole registry** (`:865-868`), since
   the read uses the admin secret (see above) and `_registry` does not filter by caller.
   Private pieces are visible to anyone who can reach the adapter.
4. **`GET /data-objects` lists every data object** with its location, for any signed-in
   user (already in the parent spec's known gaps). Data objects have no owner.
5. **Unverified:** whether `POST /workflows/submit` (`:3340`) and `POST /plans/deferred`
   (`:1534`) refuse a caller with no token and no EM secret. Read `:3340-3400` and
   `:1534-1560` before Step 2.

### The EM (current callers)

- All adapter calls go through one function, `adapterRequest`
  (`EM/src/api/api-v1/services/unifiedExecutionService.ts:270-293`). It sends
  `X-Ensemble-Manager-Secret` and forwards the caller's `Authorization` header.
- The secret is `SVO_ADAPTER_INTERNAL_SERVICE_SECRET`, else `svo_adapter_internal_secret`,
  else `graphql.secret` (`:184-195`). **The same fallback to the Hasura admin secret**
  appears again in `runHistoryService.ts:397-398`.
- The EM does **not** verify the user's token itself on `POST /v1/plans` or
  `POST /v1/plans/submit`. The route passes the header to the service
  (`EM/src/api/api-v1/paths/unifiedExecution.ts:447-449`, `:559-561`), and the service has
  no `verifyToken` call (grep of `unifiedExecutionService.ts`). The DSO platform page says
  the same: only `/regions`, `/plans/scenario` and `/plans/runs` verify the token
  (`DSO-Architecture/docs/services/mint-platform.md`, line 108). So the adapter is what
  checks the user, on every call the EM forwards.
- The EM calls the adapter from the flow path too: `flowExecution.ts:293` (`/data-objects`),
  `:318` (`/plans/flow`), `:447` (`/workflows/submit`), `:510` (`/runs/{id}/poll`).

### The Model Catalog API

- `POST /flows` checks a flow with the adapter (`CAT/src/flows.ts:307-326`,
  `checkWithAdapter`). It forwards the caller's `Authorization` to `POST /flows/check`, and
  reads the adapter's base URL from `SVO_ADAPTER_API_URL`. Unset, it answers 503 (phase A).
- The catalog itself verifies tokens through Hasura (`DSO-Architecture/docs/services/mint-platform.md`,
  lines 36-44).

### The browser and the MCP (direct callers)

- **Browser, `ui-react` on `develop`:** `getSvoAdapterApiUrl()` (`UI/src/lib/config.ts:66`)
  is used in `UI/src/pages/regions/RegionsEditor.tsx:604-607` and
  `UI/src/pages/modeling/thread/SpatialScopeMap.tsx:101,155-157`, each for
  `GET /spatial/layers` only.
- **Browser, `ui-credentials` branch (not on develop):** `UI/src/lib/user-secrets.ts:71-106`
  calls `GET/PUT/DELETE /secrets` on the adapter from the browser.
- **Browser, `uploads` branch:** not checked in this pass.
- **MCP** (`MCP/src/dso_dynamo_mcp/`): `client.py:6` maps `svo` to the adapter. Its tools call
  the adapter directly: `tools/search.py:10-16,136,149,178`, `tools/monitor.py:48,75-106,124-125`,
  `tools/configure.py:6-8,68,94-101`, `tools/author.py:11,433-440`. It also calls the EM for
  plans, submit, scenario, runs and publishers (`tools/run.py:61,102,135,173`,
  `tools/monitor.py:51,82`). The MCP sends the user's Tapis token as a bearer.
- **Adapter's own console** (`/ui/`, served by the adapter): calls the operator routes from
  the browser (`DSO-Architecture/docs/services/svo-adapter.md:71-72`). Its other calls were
  **not traced**.

### Data (Hasura)

- The adapter's tables are in schema `adapter` (`graphql_engine/metadata/tables.yaml`,
  from line 5188). The piece registry is `adapter.transform_spec` with its contracts. Its
  Hasura select permissions (`:5245-5255`) apply only when `registry_user_scoped` is on.
- **The piece registry is a copy.** `ADP/app/mint_sync.py` reads `modelcatalog_configuration`,
  `modelcatalog_configuration_flow` and `modelcatalog_etl_process` **directly from Hasura**
  (`:97`, `:117`, `:132`), not through the catalog API, and writes `adapter.transform_spec`
  (`sync_mint_to_adapter`, `:411`). It runs at startup or on `POST /admin/sync-from-mint`.
  It skips flow configurations (`:117`).
- The adapter also keeps its own tables for data objects (no owner), plans, runs, the
  secrets store and run tokens.

### Deployment and network

- Each pod has a public hostname: `mintdevsvo.pods.portals.tapis.io` for the adapter
  (`docs/deploy/mint-dev-pods.md`, lines 7-16). The same is true of the EM, the catalog API
  and Hasura.
- `deploy/tapis/register_mint_stack.py` sets the adapter's env at `:371-409`. Its
  `sync_svo_runtime` (`:1118-1172`) re-applies only a fixed list of **managed** keys
  (`:1128-1142`) and leaves the rest of the pod spec alone. A key outside that list is not
  resent by a runtime sync. `SVO_ADAPTER_INTERNAL_SERVICE_SECRET` is in neither list.
- `compose.yaml:427-447` runs the adapter on port 8090, with the Hasura admin secret and
  no EM secret.
- The Helm chart (`charts/mint/`) does not reference the adapter's settings
  (`SVO_ADAPTER` appears only in the Hasura template, for semantic search).

### What I could not verify

- Whether **Tapis Pods** can restrict which callers or paths reach a pod. The repo shows
  only public hostnames. Tapis Pods documentation was not checked.
- Whether the adapter's live pod (`mintdevsvo`) has `SVO_ADAPTER_INTERNAL_SERVICE_SECRET`
  or `SVO_ADAPTER_ADMIN_ROUTE_SECRET` set.
- The adapter's bundled console, the `uploads` branch, and `scripts/`. Callers in those were
  not listed.
- The DSO page `DSO-Architecture/docs/services/svo-adapter.md` is out of date: it gives the
  dev port as 8000 (compose uses 8090), a repo path under `monorepo/svo-adapter-service/`
  (this worktree has it at the root), and no EM secret. It should be corrected in the docs
  step, not trusted here.

## Proposed design

### 1. What "behind DYNAMO's APIs" means

- **Public surface.** People and clients use two DYNAMO APIs: the EM at `/v1/...` and the
  Model Catalog API at `/v2.0.0/...`.
- **Browser and MCP stop calling the adapter.** Each of their calls gets a route on the EM
  or the catalog. The route table below says which.
- **Adapter-internal routes** stay on the adapter, and are not front-door routes:
  - callbacks from Tapis tasks (3 routes, HMAC): they must stay reachable from Tapis
    Workflows, and they do not use the EM secret;
  - service-only routes the EM calls (4 routes): reachable with the EM secret;
  - operator routes (15): operator secrets only, never fronted.
- **Public reference reads** (8): proposal, move to the EM or catalog, or keep as they are.
  Open question 6.

### Route table (user routes, 38)

**[PROPOSAL]** Front-door names are proposals. "exists" means the route is already on the
EM or catalog and reaches the adapter today. "new" means a route to add.

| Adapter route | Called by today | Front route | Auth change |
|---|---|---|---|
| `POST /data-objects` | EM `flowExecution.ts:293`, `unifiedExecutionService.ts:1442,2041`; MCP `author.py:440` | EM `POST /v1/data-objects` (new) | EM forwards user token; adapter requires a token (finding 1) |
| `GET /data-objects` | MCP `search.py:178` | EM `GET /v1/data-objects` (new) | user token; owner filter once data objects have owners |
| `GET /data-objects/{id}` | EM `unifiedExecutionService.ts:1666` | EM `GET /v1/data-objects/{id}` (new) | user token |
| `GET /transform-specs` | MCP `search.py:16` | EM `GET /v1/etl-pieces` (new) | user token; registry filter for the caller (finding 3) |
| `POST /transform-specs/{id}/test` | none found in the four repos | EM `POST /v1/etl-pieces/{id}/test` (new), or keep adapter-internal | user token |
| `POST /objectives/{id}/evaluate-plan` | none found | open question 5 | — |
| `POST /plans/dfc-fanout` | none found | open question 5 | — |
| `GET /qaqc/modflow6`, `POST /qaqc/modflow6/tapis`, `GET /qaqc/modflow6/tapis/{run_uuid}` | none found | open question 5 | — |
| `POST /plans` | EM `unifiedExecutionService.ts:2055`; MCP `configure.py:101` | EM `POST /v1/plans` (exists) | EM forwards token; adapter requires one (see Step 2) |
| `GET /plans/{id}` | EM `unifiedExecutionService.ts:2381` | EM `GET /v1/plans/{id}` (exists) | user token |
| `POST /plans/model-inputs` | EM `unifiedExecutionService.ts:1789` | EM `POST /v1/plans/model-inputs` (new) | user token |
| `GET /publishers` | EM `unifiedExecutionService.ts:1942,2005`; MCP `run.py:61` calls EM `/plans/publishers` | EM `GET /v1/plans/publishers` (exists) | user token |
| `POST /readiness/check` | MCP `configure.py:68` | EM `POST /v1/plans/readiness` (new) | user token |
| `POST /plans/discover` | MCP `search.py:136` | EM `POST /v1/plans/discover` (new) | user token |
| `POST /plans/discover-sources` | MCP `search.py:149` | EM `POST /v1/plans/discover-sources` (new) | user token |
| `GET /reachable/{data_object_id}` | MCP `search.py:11` | EM `GET /v1/plans/reachable/{id}` (new) | user token |
| `POST /datasets/find` | MCP `search.py:14` | EM `POST /v1/datasets/find` (new) | user token |
| `POST /datasets/dataset_resources` | none found | EM `POST /v1/datasets/resources` (new) | user token |
| `GET /standard-variables` | MCP `search.py:10` | EM `GET /v1/standard-variables` (new), or catalog if it holds the table (**not verified**) | user token |
| `POST /plans/model-run` | MCP `configure.py:68` | EM `POST /v1/plans/model-run` (new) | user token |
| `POST /workflows/generate` | none found | open question 5 | — |
| `POST /workflows/submit` | EM `unifiedExecutionService.ts:1512,2531,2639,2797`; `flowExecution.ts:447` | service-only (see A) | EM secret plus forwarded token |
| `GET /runs` | MCP `monitor.py:48` | EM `GET /v1/plans/runs` (exists, scenario-gated at `unifiedExecution.ts:479`) | user token; EM secret reads all runs today |
| `GET /runs/{id}` | EM `unifiedExecutionService.ts:1597,2429,2484`; MCP `monitor.py:76` | EM `GET /v1/plans/runs/{id}` (exists, `unifiedExecution.ts:489`) | submitter only |
| `POST /runs/{id}/poll` | EM `flowExecution.ts:510`, `unifiedExecutionService.ts:1024,1156,1592`; MCP `monitor.py:75` | EM `POST /v1/plans/runs/{id}/poll` (new) | submitter only |
| `GET /runs/{id}/provenance` | MCP `monitor.py:106` | EM `GET /v1/plans/runs/{id}/provenance` (new) | submitter only |
| `POST /runs/{id}/cancel` | EM `unifiedExecutionService.ts:2451,2480`; MCP `monitor.py:125` | EM `POST /v1/plans/runs/{id}/cancel` (exists, `unifiedExecution.ts:541`) | submitter or cancel admin |
| `GET /secrets`, `PUT /secrets/{name}`, `DELETE /secrets/{name}` | browser on `ui-credentials` (`user-secrets.ts`) | EM `GET/PUT/DELETE /v1/secrets` (new) | user token; the EM forwards it |
| `POST /flows/check` | Catalog `flows.ts:314` | Catalog `POST /v2.0.0/flows/check` (new, thin) | user token |
| `POST /plans/flow` | EM `flowExecution.ts:318` | EM `POST /v1/plans` with a flow configuration (exists) | user token |
| `POST /forecast/scenario`, `POST /forecast/plan`, `POST /forecast/run-tapis`, `GET /forecast/run-tapis/{run_uuid}` | the forecast tab (adapter console, **not traced**) | open question 4 | — |
| `POST /forecast/run` | not traced | open question 4; **add auth first (finding 2)** | — |

Service-only and callbacks (not fronted):

| Adapter route | Caller | Stays | Auth |
|---|---|---|---|
| `POST /plans/deferred` | EM | adapter, EM secret | verify (see finding 5) |
| `POST /plans/deferred/{id}/bind` | EM `unifiedExecutionService.ts:1498` | adapter, EM secret | EM secret, `:1649` |
| `POST /workflows/submit` | EM | adapter, EM secret plus token | EM secret only for `bound_plan_id` (`:3361`); verify the rest |
| `POST /runs/{id}/register-output` | EM `unifiedExecutionService.ts:1070,1235` | adapter, EM secret | guard not read; verify |
| `POST /runs/{id}/signal` | Tapis model task | adapter, public | HMAC |
| `GET /runs/{id}/credentials` | Tapis model task | adapter, public | run signal token |
| `POST /runs/{id}/token` | Tapis model task | adapter, public | per-run HMAC |

Operator (15, unchanged): all `/admin/*` routes except `/admin/secrets`, `POST /transform-specs`
(`X-Admin-Secret`); `PUT` and `DELETE /admin/secrets` (`X-Secrets-Admin-Secret`).

Public reads (8): `/health`, `/objectives`, `/objectives/{id}`, `/runtime-defaults`,
`/spatial/layers`, `/etl/common-variables`, `/dfc-targets`, `/forecast/ntgam/options`.
The browser calls `/spatial/layers` today, so this is the first route to move (Step 1).

Counts: 38 user routes move to a front route (most are new EM routes; a few already exist).
4 are service-only and 3 are callbacks; both stay on the adapter. 15 are operator and 8 are
public reads.

### 2. Identity and authorization

**What the adapter must check itself (whatever the front door says):**

- The **username comes only from the verified token**, through Tapis (`_caller_or_none`).
  The adapter never takes a username from a body or a header. The code paths read
  (`:1934`, `:1953`, `:3394`) use the token. A full search for body-supplied usernames was
  **not** done; do it in Step 2.
- A **user route refuses a call with no user token**, even when it carries the EM secret.
  Today the EM secret alone is enough on `POST /workflows/submit` for a run with no
  `bound_plan_id`, if the submit path does not refuse it (finding 5).
- A **run read or write is checked against the submitter** (`_require_run_reader`). The
  EM secret is the only way to read all runs. Limit it to the routes the EM needs to
  reconcile, and log its use.

**How the adapter trusts a forwarded call:**

- The EM forwards the user's `Authorization` and adds its service secret. The adapter
  checks both: the secret proves the caller is the EM, and the token proves who the user
  is.
- Proposed new setting `SVO_ADAPTER_REQUIRE_FRONT_DOOR` (default off). When on, user routes
  refuse a call with no EM secret, and refuse a browser origin. Off keeps today's behaviour.

**Service-to-service secret.**

- Today the EM secret falls back to the Hasura admin secret on both sides (finding noted in
  Current code). So rotating the EM secret means rotating Hasura's admin secret.
- Proposal: give the EM and the adapter a dedicated `SVO_ADAPTER_INTERNAL_SERVICE_SECRET`
  first (Step 0), so the fallback is never used. Then rotate it with two accepted values for
  one window, as the run-signal secrets already do (`config.py:139-145`, comma-separated).
  **[ASSUMPTION — confirm]:** the rotation window is one deploy, not a separate change.
- The secret is set on the pods by hand or by a deploy. `sync_svo_runtime` does not resend
  it today, so it must be added to the managed list (`register_mint_stack.py:1128-1142`).

### 3. Data ownership

- **Piece registry.** Keep the synced copy for now. Reasons: the planner walks the
  adapter's edge tables, `registry_user_scoped` needs the Hasura permissions on
  `adapter.transform_spec`, and a live read of the catalog on every plan would change plan
  latency and failure modes. The flow check already reads the catalog directly
  (`ADP/app/main.py:2017-2035`, `_catalog_pieces`). **[ASSUMPTION — confirm]:** no change to
  the sync in this phase. Open question 2.
- **Data objects.** Add `owner_username` to `adapter.data_object`, set from the verified
  token on `POST /data-objects`. `GET /data-objects` returns the caller's own, plus shared
  ones if a shared flag is added. Rows that exist before the migration have no owner;
  **[ASSUMPTION — confirm]:** they are visible to operators only. Open question 3.
- **Runs.** Keep the submitter as the only reader. The EM reads on behalf of a user with
  the EM secret; the EM must pass the user's identity so the adapter can log it. Today the
  EM secret reads everything.

### 4. Network and CORS

- **What can be verified:** each pod has a public `*.pods.portals.tapis.io` hostname
  (`docs/deploy/mint-dev-pods.md`). The adapter's own code allows every origin
  (`main.py:329`) and does not restrict paths.
- **What cannot be verified here:** whether Tapis Pods can restrict source address, path or
  header for a pod. Not checked. Open question 1. If Tapis Pods cannot restrict paths, the
  only enforceable control is the adapter's own check (the EM secret plus a user token), and
  "not publicly reachable" is not available.
- **Proposal:** the adapter keeps its public hostname because Tapis Workflows calls the
  callback routes from inside Tapis. Enforce "front door only" in the adapter's code with
  `SVO_ADAPTER_REQUIRE_FRONT_DOOR`. Remove browser CORS from user routes once the browser has
  moved (Step 5): set `allow_origins` to the empty list for user routes, and keep `*` only
  where a browser needs it (none expected). **[ASSUMPTION — confirm]:** the callbacks are
  not called from a browser.

### 5. Migration order

Each step deploys alone. Each step lists its rollback.

- **Step 0. Close the findings and set the secret.** Add a token check to `POST /data-objects`
  (finding 1). Add auth to `POST /forecast/run` (finding 2). Filter `GET /transform-specs`
  for an anonymous caller (finding 3). Set `SVO_ADAPTER_INTERNAL_SERVICE_SECRET` on the
  adapter and the EM, separate from the Hasura secret. Add it to the managed list.
  Verify the two open checks (finding 5). Rollback: revert the code; unset the new secret
  (the fallback returns).
- **Step 1. Browser reads move first.** Add EM `GET /v1/spatial/layers` (proxy to
  `/spatial/layers`). Point `RegionsEditor.tsx` and `SpatialScopeMap.tsx` at the EM. Rollback:
  point the UI back at the adapter (the adapter route is unchanged).
- **Step 2. The MCP moves to EM routes.** Add the "new" EM routes in the table, one group per
  PR (plans and discovery; runs and provenance; data objects and pieces). The MCP's tools
  switch from `client.get("svo", ...)` to the EM. Rollback: revert the MCP release; the
  adapter routes are unchanged.
- **Step 3. Secrets and flows.** Add EM `/v1/secrets` (needed by the `ui-credentials`
  branch before it merges), and the catalog `POST /v2.0.0/flows/check`. Rollback: revert;
  the browser on that branch is not yet deployed.
- **Step 4. Data ownership.** Migration adds `owner_username` (nullable); the adapter sets it
  on insert; reads filter on it. Backfill decision in open question 3. Rollback: the down
  migration; the filter is behind a setting until the backfill is checked.
- **Step 5. The adapter refuses direct user calls.** Turn on `SVO_ADAPTER_REQUIRE_FRONT_DOOR`
  on dev. Confirm no caller in the Current code list still reaches a user route directly
  (check the adapter's own logs for user routes with no EM secret for one week). Then remove
  browser CORS on user routes. Rollback: turn the setting off; CORS back to `*`. This step is
  a setting, not a code change, so rollback is one redeploy.
- **Step 6. Operator and public reads.** Decide the eight public reads and the DFC routes
  (open questions 5 and 6). Rollback per route.

Production needs its own go-ahead at each step, as the parent spec says.

### Not in this phase

- Merging the adapter's code into the EM, or rewriting the adapter in TypeScript.
- Changing the piece-registry sync (open question 2).
- Tapis Pods network controls, unless open question 1 shows a way that is cheap.
- Per-user secrets beyond the store the `ui-credentials` branch already uses
  (parent spec, phase B).
- Stored-source pieces and `SVO_ADAPTER_STORED_SOURCE_ENABLED` (separate decision in
  `svo-adapter.md`).
- The adapter's own console. It is a caller until Step 5 and is then the same as the browser.

## Files likely affected

| Area | Files |
|---|---|
| Adapter | `svo-adapter-service/app/main.py` (routes, CORS, `_internal_service_authorized`, `_run_reader`, `POST /data-objects`, `GET /transform-specs`, `POST /forecast/run`); `app/config.py` (`SVO_ADAPTER_REQUIRE_FRONT_DOOR`, drop the Hasura fallback); `app/hasura.py` (no change expected); `app/mint_sync.py` (no change in this phase); `docs/api.md`; tests under `svo-adapter-service/tests/` |
| EM | `mint-ensemble-manager/src/api/api-v1/paths/` (new routes: data objects, pieces, discovery, readiness, model-run, model-inputs, secrets, spatial layers, provenance, poll); `services/unifiedExecutionService.ts` (`adapterRequest`, secret fallback at `:184-195`); `services/runHistoryService.ts` (secret fallback at `:397`); `services/flowExecution.ts`; tests |
| Catalog | `model-catalog-api/src/flows.ts` (`checkWithAdapter`); new `POST /flows/check` route in `src/custom-handlers.ts`; OpenAPI document; tests |
| UI | `ui-react/src/lib/config.ts`; `pages/regions/RegionsEditor.tsx`; `pages/modeling/thread/SpatialScopeMap.tsx`; and on the `ui-credentials` branch `lib/user-secrets.ts` |
| MCP | `mcp-suite/servers/dynamo/src/dso_dynamo_mcp/client.py` (add an `em` mapping for each new route); `tools/search.py`, `tools/monitor.py`, `tools/configure.py`, `tools/author.py`; README; tests |
| Deploy | `deploy/tapis/register_mint_stack.py` (managed list `:1128-1142`, adapter env `:371-409`, EM env with the new secret); `compose.yaml` (adapter `:427-447`, EM and catalog env); `charts/mint/` only if the Helm chart needs the secret (a chart version bump, owned by release-please) |
| DSO docs | `DSO-Architecture/docs/services/svo-adapter.md`, `mint-platform.md`, `repo-map.md`, `docs/dev/port-reference.md`, `docs/auth/tapis-oauth2.md` (read-only in this spec; change only in the docs step) |

## API/schema changes

- **Adapter (new):** `SVO_ADAPTER_REQUIRE_FRONT_DOOR` (default off); `SVO_ADAPTER_INTERNAL_SERVICE_SECRET` used with no fallback to the Hasura secret, once Step 0 is done.
- **Adapter (changed):** `POST /data-objects` requires a token; `GET /transform-specs` filters for the caller; `POST /forecast/run` requires a token; `GET /runs` and data-object reads filter on owner (Step 4).
- **Adapter (schema):** `adapter.data_object.owner_username` (nullable, index), Step 4.
- **EM (new):** `GET /v1/spatial/layers`; `GET/POST /v1/data-objects`, `GET /v1/data-objects/{id}`; `GET /v1/etl-pieces`, `POST /v1/etl-pieces/{id}/test`; `POST /v1/plans/model-inputs`, `/readiness`, `/discover`, `/discover-sources`, `/model-run`; `GET /v1/plans/reachable/{id}`; `POST /v1/datasets/find`, `/datasets/resources`; `GET /v1/standard-variables`; `POST /v1/plans/runs/{id}/poll`; `GET /v1/plans/runs/{id}/provenance`; `GET/PUT/DELETE /v1/secrets`. The request and response shapes are the adapter's, passed through, unless a later review changes them.
- **Catalog (new):** `POST /v2.0.0/flows/check`.
- **Unchanged:** every adapter route's path and body. The adapter keeps its routes; the change is who may call them and what they check.

## Data flow

Today (browser and MCP direct):

```
browser ----------------------> adapter (GET /spatial/layers; /secrets on a branch)
MCP -- user token -----------> adapter (/plans/discover, /runs, /data-objects ...)
MCP -- user token -----------> EM (/v1/plans, /v1/plans/submit ...)
EM -- EM secret + user token -> adapter (/plans, /workflows/submit, /runs/{id}/poll ...)
catalog -- user token -------> adapter (/flows/check)
Tapis task -- HMAC ----------> adapter (/runs/{id}/signal, credentials, token)
```

After Step 5:

```
browser -> EM (/v1/...) --- EM secret + user token ---> adapter (user routes)
MCP     -> EM (/v1/...) --- EM secret + user token ---> adapter
browser/MCP -> catalog (/v2.0.0/flows/check) --- user token ---> adapter
EM -> adapter service-only routes (EM secret + token)
Tapis task -> adapter callbacks (HMAC), unchanged
operators -> adapter operator routes (operator secrets), unchanged
```

A user's request, end to end: the browser sends its token to the EM. The EM passes the token
and its secret to the adapter. The adapter asks Tapis who the token belongs to, checks the
run or piece against that user, and does the work with its admin Hasura credential. The
result goes back up the same path.

## Risks and tradeoffs

- **The EM secret is a read-everything key today.** Anyone holding it reads all runs
  (`_run_reader`). Making the EM secret dedicated (Step 0) limits the damage of a leak
  to the EM's own path; it does not remove the power the EM has. A tighter model would give
  the EM a per-user token exchange, which is not proposed here.
- **The fallback to the Hasura admin secret** means a leak of the EM secret is a Hasura
  admin leak. Step 0 removes this, but only where the secret is set on both pods.
- **Moving the MCP and browser is most of the work.** About 15 MCP tool calls and 2
  browser calls change, plus about 20 new EM routes. The EM gets larger; that is a cost.
- **Tapis Pods may not restrict paths.** If so, "adapter refuses direct calls" is enforced
  by the adapter's own check, not by the network. A caller with a user token can still reach
  the adapter directly. The check is the same either way, so the gain is in the EM and
  catalog (one place for rules and logs), not in the network.
- **The EM does not verify tokens itself.** It passes them on. A bad token is refused only at
  the adapter. Adding a Tapis check in the EM would cost one extra Tapis call per request (the
  adapter caches for 60 seconds; the EM would need the same cache).
- **Owner backfill is a judgement.** Rows with no owner are either hidden or shared. Either
  choice can hide something a user needs.
- **Breaking the MCP in the middle.** Step 2 changes the MCP's routes. A mismatch between
  the MCP release and the EM deploy would break its tools. Each step deploys alone, and the
  adapter routes stay in place until Step 5.
- **The adapter's registry is a copy.** Two sources for pieces can disagree between syncs.
  Kept on purpose for now (see Data ownership).

## Alternatives considered

- **Merge the adapter's code into the EM.** Rejected for this phase. The adapter is a
  Python service with its own pipeline builder, Tapis Workflows integration, secrets store,
  run-token keeper, and about 70 routes. The EM is TypeScript. Moving the code would be a
  rewrite of the largest part of both and would not change who may call what. It also
  would not remove the need for the same EM secret between the EM and the engine. The
  decision to keep two services is the parent spec's ("not rewritten or merged").
- **Rewrite the adapter in TypeScript.** Same reasons, and more.
- **Put an API gateway in front of the adapter.** Would give network-level control, but the
  pods are Tapis Pods with public hostnames, and no gateway is part of the DYNAMO stack in
  the repo (not checked further). Revisit if open question 1 says Tapis Pods cannot restrict
  paths and a gateway exists.
- **Leave the browser and MCP calling the adapter, and only add the EM secret.** Smaller
  change. Rejected because the browser cannot hold a secret, so the adapter could never
  refuse direct calls.
- **Make the catalog the piece registry.** Would remove the sync. Not proposed now: the
  planner's edge tables and the Hasura permissions on `adapter.transform_spec` depend on the
  copy. Revisit after Step 5.

## Test plan

- **Step 0:** a call to `POST /data-objects` with no token is refused; with a token, the row
  has the caller's owner once Step 4 lands. `POST /forecast/run` with no token is refused.
  An anonymous `GET /transform-specs` does not show a private piece. The EM and adapter
  both start with a dedicated secret and no fallback; a call with the Hasura secret in the
  EM header is refused. Tests in the adapter's test suite, with the four existing failures
  noted as pre-existing (`docs/` notes from earlier phases).
- **Step 1:** the two UI screens load their layers from the EM; with the EM down, they show
  the existing empty state.
- **Step 2:** each MCP tool that moves has a test against the EM route; a dry run lists the
  EM path.
- **Step 3:** secrets: one user cannot read or change another user's secret through the EM
  (the adapter's check still applies). Flow check through the catalog returns the same
  problems as the adapter's own check, for the same flow.
- **Step 4:** a data object registered by one user is not listed for another; rows from
  before the migration follow the chosen rule.
- **Step 5:** with `SVO_ADAPTER_REQUIRE_FRONT_DOOR` on, a user call with a token and no EM
  secret is refused; a callback with its HMAC still works; a run started through the EM
  completes (Tapis Workflows callbacks included); cancel works through the EM.
- **Live:** dev only, as the second account and the owner account: a plan, a submit, a poll
  and a cancel through the EM; a second account is refused on the first account's run.
- **Regression:** the dictionary flow from the parent spec runs end to end through the EM
  after each step (its check is in `2026-11-19-flows-as-models.md`, phase B).

## Documentation plan

- `svo-adapter-service/docs/api.md`: mark each user route as adapter-internal and name its
  front route; state the new setting and the secret rule.
- `DSO-Architecture/docs/services/svo-adapter.md`: correct the port (8090 in compose), the
  repo path, the auth list (EM secret, operator secrets, HMAC callbacks); add the front-door
  table; fix the CORS line once it is known.
- `DSO-Architecture/docs/services/mint-platform.md`: the EM and catalog routes that front the
  adapter; the token rule (the EM forwards, the adapter verifies).
- `DSO-Architecture/docs/claude-context/repo-map.md` and `docs/dev/port-reference.md`: no
  new port; add the EM secret to `docs/dev/environment-variables.md` and the service pages.
- `DSO-Architecture/docs/auth/tapis-oauth2.md`: the adapter's token check, if it differs.
- `mcp-suite/servers/dynamo/README.md`: the tools' new routes.
- Documentation changes follow the DSO rule: commit and push only with approval, from
  `DSO-Architecture/`.

## Rollout/rollback plan

Steps are in "Migration order". Summary:

| Step | Ships | Rollback |
|---|---|---|
| 0 | adapter guards, dedicated EM secret | revert; unset the secret (fallback returns) |
| 1 | EM spatial-layers route; browser moves | point the browser back to the adapter |
| 2 | new EM routes; MCP moves | revert the MCP release |
| 3 | EM secrets route; catalog flow-check route | revert both |
| 4 | owner column and filters | down migration; setting off |
| 5 | front-door setting on; browser CORS removed | setting off; redeploy |
| 6 | public reads and DFC decisions | per route |

- Each step is a separate PR and a separate deploy. Dev first. Production needs its own
  go-ahead.
- **Pods are not redeployed by a normal image swap.** The EM and adapter pods need their
  settings set by hand or by the deploy script; the parent spec records that the catalog pod
  needed `SVO_ADAPTER_API_URL` set by hand. Each step lists the settings it needs.
- **Settings not resent by a runtime sync:** any new key must go in the managed list at
  `register_mint_stack.py:1128-1142`, or it is not applied.
- **Step 5 is a setting.** Rollback is the setting, not a revert, so it can be turned off
  without a release.

## Open questions

1. **Can Tapis Pods restrict callers, paths or headers for a pod?** Not checked. This decides
   whether "not publicly reachable" is possible or only "refused by the adapter's own check".
   Recommended default: assume no, and build the adapter check.
2. **Keep the piece-registry copy, or read the catalog directly?** Recommended default: keep the
   copy for now; revisit after Step 5.
3. **Owner of existing data objects.** Hidden from users (recommended default), or shared?
4. **The NTGAM forecast tab and `POST /forecast/run`.** Who owns them: the adapter's console,
   or a DYNAMO route? Recommended default: DYNAMO route in the EM, after finding 2 is fixed.
5. **Bespoke routes with no caller found in the four repos:** the DFC/GAM routes
   (`/objectives*`, `/plans/dfc-fanout`, `/qaqc/modflow6*`, `/dfc-targets`) and
   `/workflows/generate`, `/transform-specs/{id}/test`, `/datasets/dataset_resources`. Keep, move, or
   remove? Recommended default: keep on the adapter behind the operator or front-door check
   until a caller is confirmed.
6. **The eight public reads.** Move to the EM, or leave as they are?
   Recommended default: move `/spatial/layers` (Step 1); leave the rest.
7. **Is `SVO_ADAPTER_INTERNAL_SERVICE_SECRET` already set on `mintdevsvo` and the EM pod?**
   Needs a settings check on the live pods. It decides whether Step 0 is a one-time set or a
   removal of an existing fallback.
8. **Who approves Step 5 on dev and production?** Recommended default: the user.
9. **Is finding 1 (`POST /data-objects` with no token) live?** Needs one call on dev, as a
   confirmation, before anything else.

## Decisions

- 2026-11-19: The adapter is put behind DYNAMO's APIs and is not rewritten. Proposed by the
  assistant in answer to the user's question; not yet confirmed (parent spec, Decisions).
- 2026-11-20 (this draft): Keep two services. Merging into the EM is not proposed (see
  Alternatives). **[PROPOSAL — not confirmed.]**
- 2026-11-20 (this draft): Keep the piece-registry copy for this phase. **[PROPOSAL — not
  confirmed.]**
- 2026-11-20 (this draft): Callbacks stay on the adapter's public hostname with HMAC; they
  are not fronted. **[PROPOSAL — not confirmed.]**

## User feedback / decisions

None yet. Open questions 1 to 9 are for the user's review.
