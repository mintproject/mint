# A runner's own secrets for flow pieces

## Status

In Review

## Objective

Let a piece in a flow use a credential that belongs to the person running it (a model
server key, a data provider login) without that credential ever being typed into a run.

This is the "Secret settings" part of
[flows as models](2026-11-19-flows-as-models.md), which the user approved on 2026-11-19
and then narrowed: the secret is held by the adapter and fetched by the step with the
runner's own Tapis token, so nothing waits on the Tapis team.

## User need

- "can we use our jwt for all of this?" (2026-11-19), about how a secret reaches a step.
- The Narrative and Formulation draft flows call a model server and need its key. Today
  the key is a flow setting named `model_api_key`. From a thread it would be stored as a
  thread parameter and copied into the places listed under "Current system". Those two
  flows cannot safely be run from a thread until this is built.
- It must be general: SUBSIDE's displacement flow needs an Earthdata login and catalog
  logins in the same way.

## Current code/system summary

- **The adapter has an encrypted secret store** (`svo-adapter-service/app/secrets.py`,
  table `adapter.secret`). It is used for one case: a model's owner stores credentials for
  a model configuration through `PUT /admin/secrets`, which needs an operator secret. The
  table already allows `scope = 'user'`; no code writes that scope.
- **Values are sealed with Fernet**, with the row's identity inside the sealed text, so a
  ciphertext copied to another row is refused. Nothing returns a value except
  `GET /runs/{id}/credentials`, which the model task calls with a per-run signal token.
- **A function piece gets no secret today.** It is handed the run arguments it binds, and
  the runner's Tapis token as `TAPIS_TOKEN`.
- **A typed value is kept in many places** (phase 0 check 4 of the flows spec): thread
  parameters, the plan, the run record, hashes, logs, the Tapis pipeline's arguments.
- **Approval** of a piece covers its source, the function called, the arguments it is
  handed and the arguments it declares (mint #439).
- **A flow's author chooses settings** for the pieces. The runner must accept them before
  they are used, because a piece runs with the runner's token.

## Proposed design

### 1. A user stores a secret once

New adapter routes, called with the user's own Tapis token:

| Route | What it does |
|---|---|
| `PUT /secrets/{name}` | Store or replace the caller's secret `name`. Body: `{"fields": {"api_key": "...", "base_url": "..."}}`. Returns names and dates, never values. |
| `GET /secrets` | List the caller's secrets: name, field names, when stored. Never values. |
| `DELETE /secrets/{name}` | Delete the caller's secret. |

- The owner is the Tapis username the token resolves to (asked of Tapis, not read from the
  token). A user can only ever store, list or delete their own.
- Limits as today: name `[a-z0-9_-]{1,64}`, at most 16 fields, 4 kB in total.
- Stored with `scope = 'user'`, `configuration_id = ''`, sealed as owners' secrets are.
- There is no route that returns a stored value to a user.

### 2. A piece declares the secret it needs

A piece's catalog row gains, in `runtime_json`:

```json
"secrets": [{"name": "model_server",
             "env": {"MODEL_API_KEY": "api_key",
                     "CHAT_BASE_URL": "base_url",
                     "EMBEDDING_BASE_URL": "base_url"}}]
```

- `name` is the name the runner stores the secret under. `env` says which task input
  receives which field.
- **A secret carries its destination.** A model key is only safe if it goes to the server
  it belongs to. So the server address is a field of the secret, stored by the runner,
  and not a setting. A task input that a secret fills cannot also be bound to a run
  argument or be given by a flow: registration of such a flow is refused, and so is a
  plan.
- **Approval covers the declaration.** The approval hash gains `secrets`. Adding a secret
  to an approved piece withdraws its approval.
- A piece may not declare a run argument whose name reads as a credential (`key`, `token`,
  `secret`, `password`): a flow using such a piece is refused, with the advice to declare
  a secret. The adapter's own managed arguments are excepted.

### 3. Who may be handed a runner's secret

A runner's secret is handed only to a step that runs:

- built-in code (reviewed in this repository), or
- a piece an admin approved as it is now, or
- the runner's own piece.

Never to an unapproved piece the runner opted in to. And a run that binds any secret must
consist only of such steps, because every step holds the runner's Tapis token and could
otherwise ask for another step's secret.

### 4. Plan and submit

- `POST /plans/flow` adds `plan_json.secrets`: for each secret the flow's pieces need, its
  name, the steps that use it, the field names needed, and whether the caller has stored
  it. A flow whose secret the caller has not stored is **refused at plan time**
  (422 `FLOW_SECRET_MISSING`, naming each secret and its fields). The plan holds names
  only.
- `POST /workflows/submit` binds the submitter's secrets to the run: the run row's
  existing `bound_secrets` column records, per step, the secret's id, version, name and
  input map. No value. A `bound` event is recorded.
- Nothing about a secret travels in `args`. `FLOW_ARGUMENT_FIXED` already refuses
  arguments the plan fixed; the task inputs a secret fills are added to that list.

### 5. The step fetches its secret when it starts

The code the adapter wraps around a piece asks the adapter for the step's secrets before
calling the piece:

`GET /runs/{run_id}/steps/{step}/secrets`, with `Authorization: Bearer <the runner's token>`

The adapter answers `{"inputs": {"MODEL_API_KEY": "...", ...}}` only when all hold:

- the token's user is the run's submitter;
- the run is active (`submitting` or `running`);
- the step is in the run's `bound_secrets`;
- the step's piece still passes the rule in section 3, checked again now;
- the secret row still exists, belongs to the submitter, and still has the fields;
- the step has been issued its secrets fewer than three times, and the run is under the
  rate limit that the model task's fetch has.

The wrapper adds the answer to the inputs it passes to the piece. The value is in memory
in the task and in that one uncacheable response. An `issued` event is recorded with the
run, step and secret id.

The run id and the adapter's address reach the step as two more task inputs the adapter
manages (`SVO_RUN_ID`, `SVO_ADAPTER_URL`), neither secret.

### 6. From a thread, and from the MCP

- The Ensemble Manager passes the plan's `secrets` list through in its plan answer, so a
  screen can say "store your model server key first". It handles no value.
- The `dso-dynamo` MCP gets `list_my_secrets` and `delete_my_secret`. It gets **no** tool
  to store one: a value typed into a conversation is kept by the conversation.
- The page where a user stores a credential is part of phase C. Until then a secret is
  stored with one HTTP call.

### 7. The sensemaking pieces

- `discover-frames` and `draft-lexicon` are registered again declaring the secret
  `model_server` (fields `api_key`, `base_url`), and no longer take `model_api_key`,
  `chat_base_url` or `embedding_base_url` as arguments. The model names stay settings.
- The Narrative and Formulation draft flows are registered again on those pieces. A flow
  is never changed in place, so they get new ids and the present two are deleted.

### 8. Changes after review

A security review and a skeptic's review both asked for a revision. Where this section
differs from sections 1 to 7, this section stands.

- **The step fetch needs two things, not one.** The runner's token alone is not enough:
  every step of every run of that user holds it, so an unapproved piece in one run could
  ask for the secrets of another. Each step that is bound to a secret is also given a
  **fetch credential made by the adapter for that run and that step**, valid once and
  only while the run is active. The fetch needs both the runner's token and that
  credential. The credential is an argument of the pipeline, like the model task's signal
  token; it opens nothing without the runner's token.
- **Storing and deleting cannot be told apart from a step's call**, because both use the
  runner's token. A piece could replace a stored secret with its own server address and
  key. Bounded, not closed:
  - a secret cannot be stored, replaced or deleted while its owner has an active run;
  - a plan records the version of each secret it found; submit refuses if the version has
    changed since (`FLOW_SECRET_CHANGED`), so the user plans again knowingly;
  - every change is recorded with who and when, and the list of secrets shows the last
    change.
  See open question 4.
- **The destination rule is checked on what the step finally receives**, not on what the
  piece declared: every task input, compared without regard to case, at plan, at submit
  and at the fetch. The adapter's address and the run id are fixed inputs a flow cannot
  set.
- **A secret's fields are free**, so one secret can hold two addresses. The sensemaking
  secret `model_server` has `api_key`, `chat_base_url` and `embedding_base_url`. A piece
  may declare more than one secret.
- **Planning answers, it does not refuse.** A flow whose secret the caller has not stored
  is planned with `ready: false` and the list of what to store, so a screen can show it.
  Submit refuses (`FLOW_SECRET_MISSING`). This changes the parent spec's "refused at plan
  time".
- **Function pieces with an entrypoint only, for now.** A script-style piece has no
  wrapper to fetch for it, and an app piece runs elsewhere. A flow that needs a secret
  for either is refused (`SECRET_PIECE_UNSUPPORTED`).
- **The catalog sync drops `secrets` today** (it copies three named keys of
  `runtime_json`). It is added, with a test. If the catalog row declares a secret and the
  adapter's copy does not, the plan is refused: a piece must never run without the key it
  declared.
- **The wrapper never prints what it fetched.** A failed fetch fails the step with a code
  only. The fetch response is marked not to be stored.
- **The existing model-owner path is kept apart**: it never resolves a user's secret, and
  a model owner's secret with an empty configuration is refused. A test fails if anyone
  grants a role read access to the secret tables.
- **Left out of the first build:** the MCP tools, the check on credential-like argument
  names, app pieces.
- **Rollout order.** First a probe: a function task on dev calls the adapter's public
  address. Then build. The old Narrative and Formulation flows are deleted only after the
  new ones have run on dev with a stored secret.

## Files likely affected

| Where | What |
|---|---|
| `svo-adapter-service/app/secrets.py` | user scope: put, list, delete, resolve for a flow |
| `svo-adapter-service/app/main.py` | the three `/secrets` routes; the step fetch route; plan and submit |
| `svo-adapter-service/app/stored_source.py` | approval covers `secrets`; the wrapper's fetch |
| `svo-adapter-service/app/tapis.py`, `app_piece.py` | the two managed inputs; an app piece's fetch |
| `svo-adapter-service/app/flow_graph.py` | refuse a setting or link into an input a secret fills; refuse credential-named arguments |
| `svo-adapter-service/app/hasura.py`, `mint_sync.py` | queries; carry `secrets` from the catalog row |
| `graphql_engine/` | none expected: `adapter.secret` already allows the user scope. Checked in step 1. |
| `mint-ensemble-manager/.../flowExecution.ts` | pass `secrets` through in the plan answer |
| `mcp-suite/servers/dynamo` | `list_my_secrets`, `delete_my_secret` |
| docs | `svo-adapter-service/docs/api.md`, DSO-Architecture service page and environment variables |

## API/schema changes

- New: `PUT /secrets/{name}`, `GET /secrets`, `DELETE /secrets/{name}`,
  `GET /runs/{run_id}/steps/{step}/secrets`.
- `plan_json.secrets` on a flow plan; 422 `FLOW_SECRET_MISSING`.
- Piece `runtime_json.secrets`. The approval hash changes what it covers, so the seven
  approved sensemaking pieces must be approved again after this deploys.
- No table change expected.

## Data flow

1. The user stores `model_server` with the adapter (token, HTTPS). The adapter seals it.
2. The user plans a flow. The adapter reads the pieces' declarations and checks the user
   has each secret. The plan lists names.
3. The user submits. The adapter records which secret each step is bound to, by id.
4. Tapis starts a step. The wrapper asks the adapter for the step's secrets with the
   runner's token. The adapter checks and answers. The wrapper hands them to the piece.
5. The piece calls the model server at the address the secret carries.

The value is never in: the thread, the Ensemble Manager, the plan, the run record, a
hash, the Tapis pipeline or its arguments, a log line the adapter writes.

## Risks and tradeoffs

- **Any code that runs with your token can act as you.** Every step already holds the
  runner's Tapis token. Such code could replace or delete the runner's stored secrets,
  or start another run. It cannot read a stored value: only the step fetch returns one,
  and only to a step that passes section 3. This is why a run that binds a secret may
  hold no opted-in, unapproved piece.
- **An approved piece is trusted with the value.** Approval is a person reading the code.
  A piece that sends the key elsewhere would have to pass that reading. The destination
  rule in section 2 removes the easiest route (a flow's author choosing the address).
- **A piece could print the value.** Task output is readable by the run's submitter, and
  the Workflows group's members can read a run's executions. The adapter scrubs known
  values from its own logs, not from a task's output. Recorded as a limit.
- **The step fetch depends on the adapter being reachable from the task**, as the model
  task's fetch already does.
- **A long run** can outlast the runner's token; the fetch happens at the step's start, so
  a late step in a long run can be refused. The token keeper covers the model stage only.
- **The encryption key** must be configured on the pod. Without it the routes answer 503.

## Alternatives considered

- **Tapis Workflows secrets.** Tried in step 0 of the earlier spec: the engine failed to
  deliver a secret to a function task in nine forms. Needs the Tapis team.
- **Send the value with the submit and filter it out everywhere.** Rejected in phase 0
  check 4: the list of places is long and every later change could miss one.
- **One shared project key held by the adapter.** The user's earlier interim choice. It
  makes every runner spend one person's quota and cannot be withdrawn per user.
- **A per-step fetch credential issued by the adapter**, in place of the runner's token.
  Stronger against one step asking for another's secret, but it needs the run-signal
  secrets configured and puts one more credential in the pipeline's arguments. The rule
  in section 3 covers the same case. Open for the reviewers.

## Test plan

- Unit: a user can store, list and delete only their own; no route returns a value; a
  ciphertext moved to another user's row is refused.
- Unit: approval lapses when `secrets` changes; a flow that sets or links an input a
  secret fills is refused; a credential-named argument is refused.
- Unit: plan refused with `FLOW_SECRET_MISSING`; plan and run record hold no value (search
  the stored JSON for the test value).
- Unit: the step fetch refuses each of: another user's token, a finished run, a step with
  no bound secret, an unapproved opted-in piece, a fourth issue, a deleted secret.
- Unit: the wrapper passes fetched inputs to the piece and a failed fetch fails the step
  with a clear code, without printing the response.
- Live on dev: store the model server key; run Narrative from a thread; search the thread,
  the plan, the run record and the pipeline's arguments for the key; run as the second
  account without a stored secret (refused at plan).

## Documentation plan

- `svo-adapter-service/docs/api.md`: the routes, the declaration, the rules.
- DSO-Architecture: SVO adapter page, environment variables (the encryption key setting).
- A short "store your credential" section for users, with the one HTTP call.

## Rollout/rollback plan

1. Confirm the encryption key setting on `mintdevsvo`; set it by hand if absent (a deploy
   does not resend pod settings).
2. Merge one PR for the adapter and Ensemble Manager; one for the MCP.
3. Approve the seven pieces again (the hash changed). Register the two changed pieces and
   two flows; approve; delete the old two pieces and two flows.
4. Rollback: revert the PR. Stored secrets stay sealed in the table and are unused. The
   old `model_api_key` pieces are gone by then, so Narrative and Formulation would be
   unavailable until re-registered.

## Open questions

1. Answered by the review: the per-step fetch credential is required (section 8).
2. Should a user be able to share a secret with a named group (a lab's key)? Not in this
   design.
3. How long may a stored secret go unused before the adapter asks the user to confirm it?
4. Is "no changes to a secret while you have a run going, and plan again if it changed"
   enough against a piece replacing a stored secret? The stronger option is to store and
   delete secrets only through a route that needs a second factor a step does not hold.

## Decisions

- 2026-11-19: written from the approved "Secret settings" section of the flows spec and
  the user's direction that the runner's own token is used for the fetch.

- 2026-11-19: reviewed by the security reviewer and the skeptic; both said revise.
  Section 8 holds what changed. Not adopted: the reviewer's suggestion that the wrapper
  enforce which host a key is sent to (the wrapper cannot see the piece's network calls);
  recorded instead as a limit: an approved piece is trusted with the value.

## User feedback / decisions

- 2026-11-19: "approve", for never typing a secret into a run and storing it with the
  adapter.
- 2026-11-19: "can we use our jwt for all of this?", then "ok continue" to the
  recommendation that the step fetches with the runner's token.
