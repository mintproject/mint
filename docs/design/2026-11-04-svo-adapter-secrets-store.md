# SVO adapter secrets store: model-owner and user credentials for model runs

Status: Implemented on dev (Phase A merged via mint #380 #382 #384 #385 #386 and deployed 2026-11-04; migration applied; pod settings in place; SUBSIDE owner secret seeded for both OPERA configurations)

## Objective

Let the owner of a model configuration, and later each DYNAMO user, supply
the credentials a model run needs (an Earthdata login, an API key, a service
account) without the platform operator holding them in the adapter pod
environment, and without any credential being readable back through an API.
The model configuration declares which named secrets it needs and how they
map to its Tapis app's environment; the adapter stores secrets encrypted,
pins each to the exact app it was stored for, resolves them at submit time,
and injects them into the Tapis job through the signal-token-authorised path
built in `2026-11-04-subside-catalog-registration.md` (deliverable 2).

Delivered in three phases. **Phase A** (this approval) is model-owner scope
only, seeded by an admin script, and replaces the pod-env Earthdata
credential. **Phase B** adds user-scoped secrets with explicit per-model
grants and the DYNAMO Secrets page. **Phase C** is consent UX, secret
versioning and a Tapis Security Kernel backend for user scope.

Non-goals: secrets for ETL function tasks (only the model job); sharing
secrets between users other than through model ownership; hiding env values
from the submitting user's own Tapis job record (Tapis offers no mechanism;
see Risks).

## User need

A researcher who registers their own model in DYNAMO today has no way to give
it a credential except by baking it into a public Tapis app or asking an
operator to add an environment variable to the adapter pod. Neither scales
and both leak. A model owner (SUBSIDE for the OPERA analyses) should be able
to attach a project credential to their model once, revocably, and know that
only their app ever receives it. Later, a user should be able to run a shared
model with their own account instead of the owner's.

## Current code/system summary

- **Injection path (built, branch `feat/svo-adapter-earthdata-credential`)**:
  `GET /runs/{run_id}/credentials/earthdata` returns `{username, password}`
  to the model task, authorised by the run's signal token (`run_state.
  verify_signal_token`) and the `/signal` rate bucket, only while the run is
  active and armed, `Cache-Control: no-store`. The task (`app/tapis.py`
  `_submit_definition`) fetches it immediately before `POST /v3/jobs/submit`,
  appends `EARTHDATA_USERNAME` / `EARTHDATA_PASSWORD` to an in-memory copy of
  the job definition and strips any `earthdata-netrc` file input; a 404 means
  "continue without". `credentials_url` is issued only when the job's `appId`
  is in `SVO_ADAPTER_EARTHDATA_APP_IDS`; values come from pod env.
- **Encryption**: `app/run_tokens.py` wraps a `MultiFernet` ring
  (`SVO_ADAPTER_RUN_TOKEN_ENCRYPTION_KEYS`). Fernet has no associated-data
  parameter; the existing pattern embeds the run id inside the encrypted
  JSON and checks it after decrypt (`encrypt_run_token` / `decrypt_run_token`,
  lines 158-175). `keeper_configured()` also requires the keeper to be on.
  `looks_like_secret` detects only JWT/Fernet shapes, not plain passwords.
- **Identity**: `tapis.userinfo_username(token)` (verified by Tapis, not
  decoded locally). The composite `model_task` descriptor is accepted only
  with the Ensemble Manager's internal secret (`main.py` ~2214) and today
  carries `stage_id, output_uri, output_name, output_format, max_minutes,
  job_definition` (`unifiedExecutionService.ts:1853-1860`), not the
  configuration id. In `/workflows/submit` the run row is inserted
  (`main.py:2261-2277`) and the run token minted (`:2251`) before any
  secret logic could run.
- **Catalog**: `modelcatalog_parameter.parameter_type` is a free String
  (every row today is `model_param`); `has_accepted_values` is `text[]`;
  `has_default_value` String. `modelcatalog_configuration.owner_username` is
  nullable, pinned to the caller on insert (`tables.yaml:3012-3017`) and not
  updatable; on dev 194 of 198 configurations have an owner (almost all
  `wmobley`). `register_subside_to_mint.py` sets no owner.
- **Catalog integrity gap (pre-existing, verified 2026-11-04)**: Hasura role
  `user` may **update any configuration** (`modelcatalog_configuration`
  update permission `filter: {}`, `check: null`, `tables.yaml:3084-3105`)
  including `has_component_location` and `has_software_image`, and may
  insert/update/delete any `modelcatalog_parameter` and
  `modelcatalog_configuration_parameter` row (`:3221-3303`, `:3402-3432`).
  Any signed-in user can therefore repoint any model at their own app or
  rewrite its declared inputs. This is independent of secrets and is raised
  as its own issue (Prerequisites).
- **Parameter consumers** (every one would see a new parameter type):
  EM `graphql_adapter.ts:492-529` (`input_parameters`), `ExecutionCreation.ts:
  238-242` (throws on missing position), `:404`, `:429-439` (cartesian
  bindings), `graphql_functions.ts:375-387`, `tapis/helpers.ts:104-118`,
  `graphql_adapter.ts:714-729` (persists bound values in plain text to
  `thread_model_parameter`), `subTasksService.ts:442-455` (returns defaults),
  `TapisJobService.getAppArgs` (throws when an app arg has no seed value),
  `getEnvVariables`; UI `thread-execution.ts:236-238, 289-302`
  (`parametersComplete` blocks the thread on any valueless parameter),
  `MintRuns.tsx:931-933, 1108-1119, 1341`, model registration mutation
  (`model-catalog.graphql:114`); adapter `mint_sync._PARAM_CONVENTION`
  (warns on every unknown label) and `LIST_MINT_CONFIGURATIONS_QUERY` (does
  not select `parameter_type`); registration scripts.
- **UI ↔ adapter**: the UI talks to Hasura and the Ensemble Manager only; it
  has no adapter base URL (`ui-react/CLAUDE.md` runtime keys) and the adapter
  has no CORS for the UI origin.
- **EM error relay**: `unifiedExecutionService.ts:241-252` preserves a
  structured adapter `detail.{code,message}` and the route returns `code` and
  `details`; the UI's rendering of them is unverified.
- **Hasura exposure**: two adapter tables (`transform_spec`,
  `transform_contract`) have `anonymous`/`user` select; the rest are
  admin-only. The committed `backups/production-backup.sql` has no `adapter`
  schema yet.

## Prerequisites (separate PRs, tracked as their own issues)

P1. **Catalog write permissions.** Restrict `modelcatalog_configuration`
update to `owner_username = X-Hasura-User-Id`; restrict
`modelcatalog_parameter` and `modelcatalog_configuration_parameter`
insert/update/delete to rows reachable from a configuration the caller owns.
Shared-database metadata change; notify UI, EM and registration-script
owners; check that scripts using a user JWT still work. Phase A's app pinning
(below) closes the secret-exfiltration path even before P1 lands, but P1 is
required before Phase B and is a real gap today regardless.

P2. **`owner_username` on the OPERA configurations.** `register_subside_to_
mint.py` must set it (the SUBSIDE admin) so a model-owner secret can be
stored for them. Adds to deliverable 3 of the catalog spec.

## Proposed design

### Declaration in the catalog

A configuration declares a secret as a parameter row with
`parameter_type = "secret"`. It is a reserved sentinel:

- `label` = secret name, validated `[a-z0-9_-]{1,64}` by the adapter and the
  registration script (the label is load-bearing; documented as such).
- `has_accepted_values` = explicit field→env map, one entry per field,
  `"<field>=<ENV_KEY>"` (e.g. `["username=EARTHDATA_USERNAME",
  "password=EARTHDATA_PASSWORD"]`). No implicit `<NAME>_<FIELD>` convention:
  Tapis rejects env keys the app does not declare, and only an explicit map
  lets two apps spell the same secret differently.
- `has_default_value` must be null; `description` says what the credential
  is for; `position` is set (the EM throws on a missing position).
- `usage_notes` may carry `source=owner_only` (Phase A default and only
  value) or, from Phase B, `source=user_then_owner` / `user_only`.

Secret rows are removed from the parameter stream **once, at the Ensemble
Manager boundary**: `modelParameterFromCatalogGQL` / the `input_parameters`
builder (`graphql_adapter.ts:492-529`) moves rows with `parameter_type ===
"secret"` into a new `Model.required_secrets: [{name, env: {field: KEY},
source}]`. Every downstream EM consumer listed above then never sees them.
The UI filters `parameter_type === "secret"` in `thread-execution.ts` and
`MintRuns.tsx` and renders a readiness line instead; the model registration
form gains the `secret` type with no default allowed. `mint_sync` selects
`parameter_type` and skips `secret` rows. A fixture test proves a secret row
is invisible downstream of the EM boundary.

Alternative kept open: a configuration-level `_svo.secrets` JSON marker
(the `_svo.catalog` precedent) would touch zero parameter consumers, but the
configuration table has no JSON column and the parameter row gives the
registration UI a natural home. Revisit if the sentinel proves costly.

### Descriptor contract (EM → adapter)

`buildCompositeWorkflowModelTask` adds to `model_task`:
`configuration_id` and `required_secrets: [{name, env, source}]`. The EM
validates every env key against the app's declared non-FIXED
`envVariables` at descriptor-build time (it has the app loaded,
`TapisExecutionService.ts:185`) and refuses to build otherwise. The adapter
treats the EM list as a hint: it reads the configuration's `secret`
parameters itself by `configuration_id` and uses the catalog as the
authority (EM names must be a subset). Reserved env keys are removed from
the EM's ordinary `envVariables` so injection can never duplicate a key.

### Data model (migration `…36_adapter_secret`)

`adapter.secret`

| column | type | notes |
|---|---|---|
| id | uuid pk | |
| scope | text | `model_owner` (Phase A); `user` (Phase B) |
| owner_username | text | who stored it |
| name | text | secret name |
| configuration_id | text | FK `modelcatalog_configuration(id) ON DELETE CASCADE` for `model_owner`; `''` for `user` (never NULL, so uniqueness holds) |
| pinned_app_id, pinned_app_version | text | the configuration's Tapis app at store time |
| ciphertext | text | Fernet; the encrypted JSON embeds `{id, scope, owner, name, configuration_id, version}` and is checked after decrypt (the `encrypt_run_token` pattern; Fernet has no AAD) |
| fields | text[] | derived on write from the same dict; display only |
| version | int | incremented on replace |
| created_at, updated_at, last_used_at | timestamptz | `last_used_at` written at most once per run |

Partial unique indexes: `(scope, owner_username, name, configuration_id)`
for `model_owner`; `(scope, owner_username, name)` for `user`.

`adapter.secret_event` (no FK to `secret`, so deletion keeps the trail):
`secret_id, scope, owner_username, name, configuration_id, event
(created|replaced|deleted|bound|issued|mismatch), run_id, actor, actor_token_kind,
at`. Retained 13 months, insert-only.

Both tables are tracked in `tables.yaml` with **no** permission entries for
any role and no relationships from user-readable tables; a metadata test
asserts that. Both are excluded from the committed database dump
(`pg_dump --exclude-table-data`) with a CI guard that fails if `adapter.secret`
rows appear under `backups/`.

Storage interface `app/secrets.py`:

```
class SecretStore(Protocol):
    def put(ctx, scope, owner, name, configuration_id, fields) -> SecretRef
    def get(ctx, ref) -> dict[str, str]
    def delete(ctx, ref) -> None
```

Phase A backend: Fernet with its **own** ring
`SVO_ADAPTER_SECRETS_ENCRYPTION_KEYS` (fails closed with 503 when empty;
independent of the token keeper being enabled), a `rotate` admin command
that re-encrypts every row with `MultiFernet.rotate` (dry-run first, audit
event per row), and startup validation that every row still decrypts.
Tapis Security Kernel is a realistic backend for **user** scope only (it
needs the user's token at read time, which only the keeper's stored run
token could supply); `model_owner` scope stays Fernet.

### Resolution and binding (adapter, `/workflows/submit`)

Runs **after** plan/arg validation and **before** the run token is minted
and the run row inserted, so a rejection queues nothing and has no side
effects. Dry runs resolve names and report `missing` but never decrypt.

1. Load the configuration's `secret` declarations by `configuration_id`.
2. For each declaration resolve by `source`: Phase A `owner_only` → the
   `model_owner` secret for `(configuration_id, name)` whose
   `owner_username == configuration.owner_username` (explicit check; a
   `--reset` recreating the configuration drops the secret via the FK, which
   is intended and documented).
3. **App pinning**: require `job_definition.appId/appVersion ==
   pinned_app_id/pinned_app_version`, else 403 `SECRET_APP_MISMATCH` and a
   `mismatch` event. This is the control that makes a repointed
   configuration harmless even before P1.
4. Check the secret's `fields` cover the declared env map, else 422.
5. Unresolved → 422 `SECRET_REQUIRED` with structured
   `detail = {code, message, missing: [{name, source, fields}]}` (the EM
   relays structured detail; a UI test renders it).
6. Record `bound_secrets: [{id, version, name}]` on the run row (ids only),
   event `bound`; issue `credentials_url` only when at least one secret is
   bound. If the configuration declares secrets but signals are not
   configured, fail with 503 `SIGNALS_REQUIRED` rather than run without.

### Delivery (`GET /runs/{run_id}/credentials`, replaces `/credentials/earthdata`)

Same auth chain as today (signal token, active and armed), plus: its own
rate bucket (not `/signal`'s), a per-run issue cap of 3 (`credentials_issued`
counter; 409 after), `Cache-Control: no-store`, event `issued` (ids and
names only). Returns `{"env": {"EARTHDATA_USERNAME": …, …}}` built from the
bound secrets' **current** rows: if a bound row is gone → 409
`SECRET_REMOVED` and the task fails; if its `version` advanced the new value
is used and the event records `@vN` (newer credentials are the right ones
after a rotation). The task **replaces** any existing env entries with the
same keys and submits; a 404/empty response for a run that bound secrets is
a failure (`SECRET_UNAVAILABLE`), not "continue without".

### Management

Phase A: `scripts/seed_model_owner_secret.py` (admin secret + the owner's
Tapis token) and an admin-only `PUT /admin/secrets` behind the internal
service secret; the SUBSIDE admin stores the project Earthdata login for
both OPERA configurations. No user-facing API.

Phase B: `GET/PUT/DELETE /secrets/{name}` with a Tapis bearer that must be
an interactive user token (reject run/job token kinds by claim), per-user
rate limit and secret-count cap, `If-Match: version` on replace, field-name
validation `[a-z0-9_]{1,32}`, value cap 4 KiB total, no NUL/newline. A custom
`RequestValidationError` handler on these routes strips the echoed `input`.
User-scoped secrets carry `grants: [{configuration_id, app_id, app_version}]`
set explicitly by the user ("use my Earthdata login for this model"); a
user secret is never resolved by name alone. The UI calls the adapter
directly (new `ADAPTER_API` runtime key, CORS for the UI origin) and gets a
Settings → Secrets page plus the per-model grant action.

### Redaction and hygiene

Values exist in memory only inside put (to encrypt) and the credentials
endpoint (to decrypt and return). Redaction is **by value**: decrypted
values are registered in a request-scoped scrubber applied to log records
and error text, in addition to the key-name list (`_SECRET_KEY` gains
`token`, `secret`, `username`, `authorization`). A sentinel leak test across
logs, Hasura rows, provenance, API responses, pipeline definitions and the
422 body is a merge gate. `looks_like_secret` is not relied on.

### Files likely affected (Phase A)

- `graphql_engine/migrations/1771300000036_adapter_secret/{up,down}.sql`,
  `metadata/tables.yaml` (+ metadata test), `backups/` dump exclusion + CI guard
- `svo-adapter-service/app/secrets.py` (new), `app/main.py` (resolution before
  `INSERT_RUN`, generalised credentials endpoint, admin seed route,
  validation handler), `app/tapis.py` (generic replace-not-append injection,
  failure on missing), `app/config.py` (secrets ring; drop `earthdata_*` and
  the app allow-list), `app/error_handling.py`, `app/mint_sync.py` (skip
  `secret`), `scripts/seed_model_owner_secret.py`, `scripts/rotate_secrets.py`, tests
- `mint-ensemble-manager`: `graphql_adapter.ts` (boundary filter →
  `required_secrets`), `TapisExecutionService.ts` (descriptor:
  `configuration_id`, `required_secrets`, env-key validation),
  `TapisJobService.ts` (reserved keys never emitted), tests
- `ui-react`: filter `secret` parameters in `thread-execution.ts` /
  `MintRuns.tsx`, readiness line, render structured 422; registration form
  type (Phase A keeps the form change minimal)
- `modflow-executables/scripts/register_subside_to_mint.py` + OPERA YAML: one
  `secret` parameter `earthdata` per configuration with the env map; set
  `owner_username` (P2)
- Docs: DSO `docs/services/svo-adapter.md`, `docs/dev/environment-variables.md`,
  DYNAMO user guide; a runbook for rotation, revocation and incident response

## API/schema changes

- Tables `adapter.secret`, `adapter.secret_event`.
- `GET /runs/{id}/credentials` replaces `/runs/{id}/credentials/earthdata`;
  Phase A `PUT /admin/secrets`; Phase B `/secrets…`.
- Catalog convention: `parameter_type = "secret"` with the field map in
  `has_accepted_values`.
- `model_task.configuration_id`, `model_task.required_secrets`.
- Env: `SVO_ADAPTER_SECRETS_ENCRYPTION_KEYS` (new, required for the
  feature); `SVO_ADAPTER_EARTHDATA_USERNAME/PASSWORD/APP_IDS` removed. No
  platform-default secrets (dropped from rev 1: a silent platform fallback
  would hand an operator credential to any configuration naming it).

## Data flow

```
owner (Phase A: admin script) → PUT secret {model_owner, configuration, fields}
  → pinned to the configuration's app id/version → encrypted → adapter.secret

thread submit → EM: secret rows filtered out of parameters;
  model_task += configuration_id, required_secrets[{name, env}]
  → adapter: validate args → resolve declarations from the catalog
    → owner secret present? app pinned matches job appId/version? fields cover env?
    → no: 422/403, nothing queued      → yes: bind ids on the run, mint token, insert run
  → model task: GET /runs/{id}/credentials (signal token, cap 3)
    → {"env": {...}} → replace keys in the in-memory job definition → submit
  → Tapis job; analysis writes 0600 ~/.netrc; run.sh removes it on exit
```

## Risks and tradeoffs

- **The adapter becomes a secrets service**: ring, ciphertext and decrypted
  values share one trust domain. Controls: dedicated ring in a Kubernetes
  secret mounted only into the adapter, no read-back API, by-value
  redaction, audit events, admin-only tables, dump exclusion, rotation
  command. Compromise of the pod means every stored secret is exposed and
  every owner must replace theirs; the runbook says so.
- **Model-owner secrets are readable by every runner** in their own Tapis
  job record, and in job stdout if the app prints its environment. Tapis
  offers no way to hide job env. Policy: model-owner scope is for
  low-privilege, revocable project accounts; the owner acknowledges this at
  store time (`acknowledged_at`); only public/shared configurations may
  receive one when run by someone other than the owner.
- **Catalog integrity** (P1) is the real boundary. App pinning makes a
  repointed configuration fail closed rather than leak, but a stranger can
  still break a model's declared inputs today.
- **Parameter sentinel** must be filtered by every direct Hasura reader of
  parameters (the UI). Missing one shows a confusing field, not a leak,
  because the EM filter prevents values from ever being bound server-side.
  The plaintext `thread_model_parameter` path is closed by the UI filter plus
  EM refusing a binding for a `secret` row.
- **Submit-time rejection** changes behaviour: a run that would previously
  fail inside the job now fails before queueing. Intended.
- **Shared dev migration** needs a named applier and a ciphertext backup
  before any down-migration (down drops all stored secrets).

## Alternatives considered

- **Tapis Security Kernel as the store**: user-secret vault routes 404 on
  portals (probed 2026-11-04) and SK cannot serve `model_owner` scope
  (another user's run has no owner token). Kept as the Phase C backend for
  user scope behind `SecretStore`.
- **Pod-env credential per model** (rev 1 of the registration spec):
  operator bottleneck, no identity, rejected.
- **User-owned credential files bound as datasets**: netrc-only, clunky;
  escape hatch only.
- **Configuration-level `_svo.secrets` marker** instead of a parameter row:
  fewer consumers, but no JSON home on the configuration table; revisit.
- **EM-side resolution**: the EM has no key ring and the composite design
  keeps credentials out of the coordinator; rejected.
- **Name-only matching for user secrets** (rev 1): rejected, exfiltration
  by any model author.
- **Platform default secrets** (rev 1): rejected, silent operator-credential
  leakage.

## Test plan

- `secrets.py`: ciphertext bound to id/scope/owner/name/configuration/version
  (a copied ciphertext fails); dedicated ring; fail-closed 503 when empty;
  rotation re-encrypts and old key can be removed.
- Resolution: owner match, app pin match/mismatch (403), fields coverage,
  422 structure, dry run never decrypts, rejection leaves no run row and
  mints no token; signals-off with declared secrets → 503.
- Endpoint: separate rate bucket, cap 3 → 409, removed row → 409,
  version bump honoured and logged, `no-store`.
- Task code: replace-not-append; failure on 404/empty when secrets bound;
  executed once against a stubbed adapter + Tapis (not only compiled).
- Sentinel leak test (merge gate) incl. the validation-error path.
- EM: secret rows absent from `input_parameters` and every downstream
  consumer; `required_secrets` built with validated env keys; reserved keys
  never emitted; MODFLOW fixtures unchanged.
- UI: `parametersComplete` ignores `secret` rows; readiness line; 422 render.
- Metadata test: no permissions on the two tables; CI guard on the dump.
- End to end on dev: OPERA run without an owner secret → 422 before
  queueing; after the admin seeds it → job record shows the two env vars
  and the run completes.

## Documentation plan

DSO adapter page (endpoints, `SVO_ADAPTER_SECRETS_ENCRYPTION_KEYS`, the
`secret` parameter convention, the runner-visibility caveat), environment
variables page, DYNAMO guide ("make a model runnable" gains a credentials
step; Phase B adds the Secrets page), and a runbook: seed, rotate ring,
revoke a user's secrets, respond to a pod compromise.

## Rollout/rollback plan

Phase A on dev: apply migration (named applier; `pg_dump` of the `adapter`
schema first), deploy adapter + EM + UI filter together (the sentinel
parameter is harmless to the UI only once the filter is in), re-register
OPERA with the `secret` parameter and `owner_username`, seed the SUBSIDE
owner secret, run the end-to-end test. Rollback: unset the ring (fails
closed, injection stops, data intact); down-migration only after exporting
ciphertext. The `/credentials/earthdata` route and `SVO_ADAPTER_EARTHDATA_*`
never deploy.

## Open questions

None open for Phase A. P1 is to be filed as a GitHub issue on
mintproject/monorepo (the agent session was not permitted to create it; the
issue text is ready to paste) and assigned there.

## Decisions

- 2026-11-04: User chose the adapter-held secrets store over pod-env
  credentials, Tapis SK (unavailable) and credential files.
- 2026-11-04 (rev 2): Phased delivery; Phase A is model-owner scope only,
  admin-seeded, no user scope and no platform default.
- 2026-11-04 (rev 2): Secrets are pinned to the configuration's Tapis app
  id/version at store time and checked at submit and delivery.
- 2026-11-04 (rev 2): Declaration stays `parameter_type = "secret"` but is
  filtered once at the EM boundary into `required_secrets`; env mapping is
  explicit per field, no naming convention.
- 2026-11-04 (rev 2): Dedicated encryption ring, binding tuple inside the
  ciphertext (Fernet has no AAD), version column, rotation command, admin-only
  tracked tables, dump exclusion.
- 2026-11-04 (rev 2): Resolution runs before the run row and token exist;
  delivery fails closed when a bound secret is missing.
- 2026-11-04 (rev 2): Catalog write-permission gap raised as prerequisite P1,
  separate from this spec.

- 2026-11-04: User approved Phase A as scoped ("do it"), including opening
  the P1 issue; readiness wording for runners is "credentials provided by the
  model owner" (the secret name is not shown).

- 2026-11-04 (Phase A implementation, EM + UI + registration done; adapter in
  progress): `modelcatalog_parameter` has NO `usage_notes` column (it is on
  the configuration table), so `source` cannot live there. Phase A has a
  single value (`owner_only`), which is the default when the marker is
  absent; the registration script emits no `usage_notes`. Phase B must pick a
  home for `source` (a new column or a `source=` prefix in `description`).
  `configuration_id` in the descriptor is `Model.id`, which `modelFromGQL`
  sets from `modelcatalog_configuration.id` (not `model_configuration`, the
  parent id). `input_parameters` is built in exactly one place
  (`modelFromGQL`), so the single boundary filter covers every EM consumer;
  the EM's `useModelParameterService.ts` has its own parameter handling and
  is a follow-up check. UI: secret rows stay in `ThreadModel.input_parameters`
  (the readiness line needs them) and every consumer filters through one
  helper, including `MintThread.tsx` and `MintResults.tsx` which the spec
  had not listed; the configuration form previously had no parameter-type
  control at all, so the update mutation gained `$parameterType`.

- 2026-11-04 (Phase A adapter implemented, branch `feat/svo-adapter-secrets-store`,
  64 new tests + 4 metadata tests green; 296 passed overall with only the
  pre-existing develop failures): deviations — `bound_secrets` entries carry
  `app` (`appId@appVersion`) and `env` in addition to `{id, version, name}`
  so delivery can re-check the pin; additional error codes
  `SECRET_FIELDS_INCOMPLETE`, `SECRETS_NOT_CONFIGURED`, `SECRET_UNREADABLE`,
  `SECRET_DECLARATION_INVALID`, `SECRET_NOT_DECLARED`; `PUT /admin/secrets`
  also requires the name to be declared on the configuration and the fields
  to cover the env map; migration uses `uuid` ids (other adapter tables use
  TEXT) and models the FK as a nullable `configuration_ref` with a CHECK
  tying it to `configuration_id` for `model_owner` rows (Postgres has no
  partial FK); `secret_event.secret_version` added; `adapter.workflow_run`
  gained `bound_secrets` JSONB and `credentials_issued` int; the
  Earthdata-specific `/credentials/earthdata` route, settings and app
  allow-list are gone. A run whose `model_task` lacks `configuration_id`
  skips secret resolution (the EM always sends it after Phase A). Not done in
  Phase A: startup "every row still decrypts" check (rotate dry-run covers
  it), the 13-month `secret_event` retention job, old-key removal only unit
  tested.

- 2026-11-04 (Phase A QA pass; two blockers found and fixed): (B1) the EM
  built the descriptor correctly but its hand-written HTTP body dropped
  `configuration_id` and `required_secrets`; fixed, with a test on the exact
  body keys. (B2) the adapter's configuration query selected the nonexistent
  `usage_notes` column; fixed, with a test that checks every selected field
  against the migrations. Also fixed: adapter 503s and the EM's
  `SECRET_ENV_UNDECLARED` now reach the UI as coded failures instead of
  "unknown"; the credential issue cap counts only successful issues; distinct
  `SECRET_OWNER_UNSET` (422) for unowned configurations; env keys must be
  upper-case everywhere; admin secret routes require a dedicated
  `SVO_ADAPTER_SECRETS_ADMIN_SECRET` (header `X-Secrets-Admin-Secret`) with
  no fallback to the Hasura or Ensemble Manager secrets; PUT body values are
  registered with the log scrubber; compiled test files untracked; the EM
  validates declarations strictly (422 `SECRET_DECLARATION_INVALID`) instead
  of coercing; the UI maps every secret error code to a runner-facing
  message. Accepted as-is: eslint on the EM files is not clean because of
  pre-existing `no-explicit-any` errors; the task-code injection is
  string-asserted and compiled but not executed against a stub; the backups
  guard is a pytest check, not a `pg_dump` flag; a configuration run by a
  non-owner receives the owner secret whenever the configuration is
  submittable (no public/shared check in Phase A). Live-only checks remain:
  Hasura accepting the new queries/mutations (`fields` as a JSON list for
  `_text`, `_inc`, `by_pk(uuid)`), the migration on dev, the REST mapper's
  handling of `parameter_type`/`has_accepted_values`, and that the EM's job
  `appId/appVersion` string-match the configuration's pinned values.

- 2026-11-04 (live): first seeding attempt failed with Hasura "A string is
  expected for type: _text" on the `fields` text[] column (the risk QA marked
  live-only); fixed in mint #386 (array literal on write, `text_array()`
  normaliser on read). Seeded `earthdata` for `opera-disp-s1-h2i-lab` and
  `opera-disp-s1-werc` as `model_owner` (owner wmobley, pinned to each app at
  0.1.1, fields password+username, version 1); `created` events recorded.
  Admin secret regenerated by the user and kept in the local monorepo `.env`
  as well as the repository secret.

## User feedback / decisions

- 2026-11-04: "I like 1" (adapter secrets store).
- 2026-11-04: Reviews of rev 1: architect "revise" (app allow-list removal
  opened a harvest path; incomplete consumer inventory; explicit env map;
  resolution ordering); security "not acceptable as written" (catalog
  permissions let any user rewrite declarations; name-only user secrets;
  dedicated ring; dump exclusion; by-value redaction); skeptic "revise"
  (secret rows block the UI thread form; ship owner-only first; per-
  declaration source policy). All folded into rev 2.
