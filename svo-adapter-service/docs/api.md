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

### Run parameters and framing

A stored plan lists its run parameters under `plan_json.parameters`. Each entry says
whether a run must supply it (`required`), whether the adapter fills it in itself
(`managed`), and, for the arguments that say what a run is *about*, a `framing` kind:

| Parameter | `framing` |
|---|---|
| `start_date`, `end_date` | `time_period` |
| `aoi_geojson_uri`, `lat`, `lon` | `area` |

Framing parameters are always listed. They are required only when a piece in the plan
reads them (`used_by_plan: true`); the generated pipeline marks the same ones required,
so a plan whose pieces need neither a period nor an area can be submitted without
inventing values. Framing a caller does supply is recorded in the run's
`workflow_submit_requested` provenance event under `framing`.

### Naming the pieces of a plan

`POST /plans` normally searches the registry for the shortest chain from the data object
to the target. When two pieces fit the same step, the search cannot tell them apart and
returns whichever it meets first.

Pass `piece_ids`, an ordered list of catalog piece ids, to plan exactly that chain. The
adapter does not search. It checks that the chain fits and stores the plan, which records
`piece_ids`.

- A piece is found by its catalog id or its registry id.
- Fit is the same rule the search uses: a step is accepted when one of its inputs matches
  what the previous step hands on, and a step hands on its first output only.
- The caller's right to run each piece is checked at plan time with the same rule as at
  submit, and again at submit. `allow_unapproved_piece_ids` applies as it does to a
  searched plan.

| Refusal | Status | `detail.code` |
|---|---|---|
| A named piece is not in the registry: it does not exist, is not visible to the caller, or was registered after the last catalog sync | 422 | `PIECE_NOT_IN_REGISTRY` (`piece_ids` lists them) |
| A step does not accept what the previous step hands on, or the last step does not meet the target | 422 | `PIECE_DOES_NOT_FIT` (`position`, `piece_id`; `position` equal to the number of pieces means the target was not met) |
| The caller may not run a named piece's stored code | 403 | `STORED_SOURCE_REFUSED` (`problems`) |

### Running a plan again

Every generated pipeline sets `execution_profile.duplicate_submission_policy` to `allow`.
Tapis Workflows' default is `terminate`: a second run of a pipeline ends the first. A plan
can therefore be submitted again while an earlier run of it is in flight, and both finish.
A pipeline registered before this change keeps the policy it was registered with.

To make a repeated request return the first run instead of starting another, send the same
`Idempotency-Key` header (or `idempotency_key`) on both.

### Flows

A flow is a graph of pieces stored on a model configuration (catalog tables
`modelcatalog_configuration_flow` and `modelcatalog_configuration_step`). It holds no
code and grants nothing: every piece is still checked for whoever plans and submits.

**Steps and links.** Steps are numbered from 1 in an order they can run in. A step
receives what its links say. A link is `{"to": ..., "from": ...}`:

| `to` | `from` | Meaning |
|---|---|---|
| `{"input": k}` | `{"flow_input": id}` | input `k` of the piece reads a dataset the flow takes |
| `{"input": k}` | `{"step": n, "output": j}` | it reads output `j` of step `n` |
| `{"setting": name}` | `{"step": n, "value": v}` | a setting reads a value step `n` returned |
| `{"setting": name}` | `{"step": n, "output": j}` | a setting is handed the location of that output |
| `{}` | `{"step": n}` | nothing is passed; the step runs after step `n` |

A step may read only from steps before it, so a flow cannot contain a loop. Every input
of a piece is linked exactly once.

**`POST /flows/check`** checks a flow before it is registered. The body names pieces by
catalog id, read with the caller's token:

```json
{"inputs": [{"id": "in:corpus", "contract": {"standard_variable_uri": "..."}}],
 "steps": [{"position": 1, "etl_process_id": "...", "settings": {}, "wires": [...]}],
 "outputs": [{"step": 1, "output": 1}], "thread_bindings": {}}
```

Both flow routes need a signed-in caller (401 `TAPIS_AUTH_REQUIRED` otherwise).

It returns `ok`, `problems` (each with `code`, `message`, and the `step` and `wire` it is
on), `depends_on`, and for each piece its input and output positions, the settings a flow
may give it, and the values it returns. Nothing is stored.

**`GET /flows/{configuration_id}/availability`** says whether the caller could run each
step of a stored flow, without planning it. It needs a signed-in caller, reads the flow and
the registry as `POST /plans/flow` does, and never plans or stores anything:

```json
{"flow_id": "...", "available": false,
 "steps": [{"position": 1, "runnable": true, "reason": null},
           {"position": 2, "runnable": false, "reason": "not_approved"}]}
```

`reason` is `piece_missing` (the piece was deleted, or is another user's private piece;
nothing else about it is reported), `not_approved` (a stored-code piece an admin has not
approved, and the caller does not own), or `stored_source_disabled` (the deployment does not
run stored code). Opting in to an unapproved piece is chosen when planning, so it is not
counted here. An unknown or non-flow configuration answers 422 `FLOW_NOT_FOUND`.

**`POST /plans/flow`** plans a stored flow: `{"flow_id": "<configuration id>", "inputs":
{"<flow input id>": "<data object id>"}}`. The response is a plan like any other, to
submit with `/workflows/submit`.

- Each flow input becomes a managed argument filled in from its data object: `source_uri`
  for the first input the steps read, `source_uri_2`, `source_uri_3` for the rest.
- `region` fills the input the flow marks as its region when no dataset is bound to it:
  `{"input": "<flow input id>", "source": {"kind": "geojson", "geometry": ...}}` or
  `{"kind": "bbox", "bbox": [minx, miny, maxx, maxy]}`, held to the limits a model's
  region input has. The piece receives it as GeoJSON text on that input, not as a
  location. 422 `FLOW_REGION_REFUSED` for any other input, or one with a dataset.
- A step's `settings` become the defaults of the plan's parameters. A value sent at
  submit still wins. Steps that declare the same setting name share it.
- The plan records the flow under `plan_json.flow`: the configuration, the bound inputs,
  the flow's outputs, its region and date bindings, and the steps to pause after.

| Code | Status | When |
|---|---|---|
| `FLOW_NOT_FOUND` | 422 | no such configuration, or it is a model and not a flow |
| `FLOW_INPUT_NOT_BOUND` | 422 | an input the flow reads has no data object |
| `DATA_OBJECT_NOT_FOUND` | 404 | a bound data object does not exist |
| `FLOW_DOES_NOT_CHECK_OUT` | 422 | the graph does not fit its pieces or the bound data; `problems` lists why |
| `FLOW_SETTING_CONFLICT` | 422 | two steps give different defaults for a setting they share |
| `FLOW_NOT_SUPPORTED` | 422 | the flow links a setting from a flow parameter, which is not built yet |
| `FLOW_DOES_NOT_BUILD` | 422 | the flow checks out but cannot be made into a pipeline, for example a linked setting the piece reads through no task input |
| `FLOW_COLLECTION_REFUSED` | 422 | a collection for an input the flow does not mark, that no step reads, that also has a data object, or that the thread's region fills; or too many resources. Names the `input` and the reason |
| `FLOW_COLLECTION_RESOURCE_REFUSED` | 422 | a resource link the gather task would not fetch. Names the resource `index` and the reason, never the link |
| `STORED_SOURCE_REFUSED` | 403 | the caller may not run one of the pieces |

**An input that takes a collection.** A flow's `thread_bindings` may carry
`"collections": ["<flow input id>", ...]`, the inputs that each take a collection of
files. `POST /flows/check` reports `FLOW_THREAD_BINDING` for an entry that is not an input
of the flow, or is repeated. `collections` is not a role like `region`.

For such an input `POST /plans/flow` takes the files in a new field instead of a data
object:

```json
{"flow_id": "...", "inputs": {},
 "collections": {"<flow input id>": {"label": "Documents",
   "resources": [{"name": "a.csv", "url": "https://host/a.csv"},
                 {"name": "b.txt", "url": "tapis://system/path/b.txt"}]}}}
```

- A collection is allowed only for an input the flow marks, that a step reads, and that
  is not also in `inputs` and is not the region input (422 `FLOW_COLLECTION_REFUSED`).
  A marked input may still be bound the ordinary way with one data object: there is then
  no gather task.
- `resources` holds 1 to `flow_collection_max_resources` entries (default 500; a
  `name` of at most 255 characters and a `url` of at most 2,000). A malformed body is a
  422. Each `url` is `https://host/path` (port 443 only) or `tapis://system/path`, with
  no user name or password, fragment, control character or `..` segment. `http://` is
  refused (422 `FLOW_COLLECTION_RESOURCE_REFUSED`). The address a name resolves to is
  checked when the task fetches it, not here.
- For the fit check the files are taken as what the first piece input linked to the
  marked input asks for, as the region is.
- The plan gets one gather task per collection, `gather-1`, `gather-2`, ... in the order
  the steps first read the inputs, recorded under `plan_json.flow.collections`:
  `[{"input": <flow input id>, "label", "gather": "gather-1", "resources": [{"name", "url"}]}]`.
  A step that reads the input is wired `{"gather": "gather-1"}` instead of `{"arg": ...}`;
  no `source_uri...` argument is filled for it. The plan also declares the managed
  parameter `flow_staging_uri` (`managed_source: "run_folder"`, not required).

**The gather task.** A Tapis Workflows function task written by the adapter
(`app/gather_piece.py`, rules in `app/gather_fetch.py`), standard library only. Its inputs
are `TAPIS_TOKEN`, `TAPIS_BASE_URL` and `STAGING_URI` (from `flow_staging_uri`). It copies
every resource into `<flow_staging_uri>/inputs/<gather id>/` through the Tapis Files API,
sets its `result` output to `tapis://<system>/<that folder>` and prints, last,
`{"status":"ok","svo_flow_outputs":{"result":"tapis://..."}}`. The steps that read the
input take `SOURCE_<k>` from that `result` and wait for the task.

- **A `tapis://` resource is refused unless its system is listed** in the setting
  `flow_collection_tapis_systems` (comma-separated; empty by default, so none). The files
  of a collection come from a thread that others may be able to edit, and the gather task
  reads with the runner's token: a Tapis location would let them have the runner's own
  files copied into a run. An `https` link is fetched with no credential at all.
- **The Tapis address is the adapter's own.** A submission that sends `tapis_base_url`
  for a flow is refused (`FLOW_ARGUMENT_FIXED`); the adapter sets it from its setting, and
  the gather task refuses to start if it was handed any other host.
- One file may take at most `flow_collection_resource_seconds` (default 1800) to arrive.
  A body shorter than the length the server declared is tried again.
- The Tapis token is sent only to the Tapis address (to read a `tapis://` resource and to
  store the files), never to an `https` resource, on any host or redirect.
- An `https` host is resolved and refused unless every address is public unicast (not
  private, loopback, link-local, multicast, reserved, unspecified, or such an address
  inside an IPv6 form). The connection is made to an address that was checked, with the
  host name kept for certificate verification, SNI and the `Host` header. Redirects are
  followed by hand, at most 5, `https` only, each target checked again.
- A collection totals at most `flow_collection_max_bytes` (default 5 GiB), counted as
  bytes arrive, not from `Content-Length`. Every request has a timeout; a download is
  tried up to 3 times on a 5xx, 408, 429 or network error, an upload once more only when
  no answer came back.
- A file is named for the resource's `name` if that is a plain base name, else the last
  path segment of its link, else `resource-<index>`; characters outside `A-Za-z0-9._-`
  become `_`, at most 200 characters, and repeats get `-2`, `-3` before the extension.
- Failures print one JSON line with `code`, a `message`, the resource `index` and `host`
  (never the query, the token or a response body): `GATHER_RESOURCE_NEEDS_LOGIN` (401 or
  403), `GATHER_RESOURCE_FAILED` (with `http_status` where there is one),
  `GATHER_ADDRESS_REFUSED`, `GATHER_TOO_LARGE`, `GATHER_STAGING_FAILED`.
- **The catalog is the one `https` host that gets the runner's token.** With the setting
  `flow_collection_catalog_host` (a host name such as `ckan.tacc.utexas.edu`; empty by
  default, so off), a request to exactly that host carries `Authorization: Bearer <the
  runner's token>`, so a private catalog file the runner may read can be gathered. The
  host is compared lower-cased and whole (not a suffix, not a path, not a host with a user
  name or another port, not `host.evil.example`); the port is always 443. The host is in the
  task's spec and the task never reads it from an input. Redirects are followed by hand and
  the header is decided again on every hop: a hop to any other host carries none, and a
  later hop back to the catalog host carries it again. Address vetting applies to the
  catalog host as to any other. Nothing printed holds the token.
- **An ordinary input bound to an `https` file is gathered too.** At `POST /plans/flow`, an
  input that is not a collection, not the region, and whose bound data object's
  `resource_uri` is an `https` link the task would fetch gets a gather task of one resource
  (`plan_json.flow.collections[]` entry with `"single": true`, label the input id). Its steps
  read the gather output, and no `source_uri...` argument is made for it. For such a task the
  `result` is the staged **file** (`tapis://<system>/<folder>/<file>`), not the folder; a
  collection's `result` stays its folder. Gathers are numbered `gather-1`, `gather-2`, ... in
  the order the steps first read the inputs, collections and single files together. A
  `tapis://` data object is read in place, with no gather, as before. The catalog-host token
  rule above applies to the single file as to any resource.
- A link that needs another login (Earthdata, a PTDataX project) fails; a login for the
  gather task is the secret store's job.

**The run's staging folder.** At `POST /workflows/submit` for a plan with a collection,
the adapter chooses the run's id first, finds the caller's scratch root on
`tapis_exec_system`, and passes `flow_staging_uri` =
`tapis://<exec system>/<scratch root>/dynamo-runs/<run id>`. If the scratch root cannot be
found: 422 `FLOW_STAGING_UNRESOLVED` ("could not find your scratch folder on <system>: run
any job there once"), and no run is recorded. A dry run does not look for it and says it
would (`flow_staging`). `flow_staging_uri` is never the caller's to send
(`FLOW_ARGUMENT_FIXED`). A required setting named exactly `output_uri` that has no flow
default is, in a plan with a collection, marked `required: false`,
`default_source: "run_folder"`, and defaults at submit to `<flow_staging_uri>/outputs`
when the caller sends none. Files in scratch are cleaned up by the system: publish a
result worth keeping.

**Following a run of a flow.** `POST /runs/{run_id}/poll` adds `flow` for a plan made
from a flow:

- `steps`: one entry per step with `step`, `name`, `task_id`, `depends_on`, `status`
  (`pending`, `running`, `completed`, `failed`, `cancelled`, `skipped`) and `message`.
  A gather task is listed first, before the flow's own steps, as `{"step": "gather-1",
  "name": "Gather <label>", "task_id": "gather-1", "depends_on": []}`; each step that
  reads the collection lists `"gather-1"` in `depends_on` ahead of its numbered ones.
- `outputs`: the flow's outputs as registered, each with `value` (what the step reported)
  and `location` (where the output is). Both are null until the step has finished, and
  for a published record. A piece written for a flow reports each output's location, and
  `location` is that. A piece written for a chain reports one JSON summary of everything
  it wrote; `location` is then the summary's `output_uri`, the folder it wrote to.

- `status`: the run's status in the adapter's words (`running`, `completed`, `failed`,
  `cancelled`). The top-level `status` of a poll is Tapis's own and is not mapped.

Tapis Workflows does not report a task's named outputs, so every flow step prints them as
its last line of output, `{"svo_flow_outputs": {...}}`, and the adapter reads that back.
A report line over 100,000 characters, or one that cannot be read as JSON, is skipped. A
reported value over 20,000 characters, or a location over 2,000, is not given.

**A piece that runs as a Tapis app.** A Tapis Workflows job task returns nothing a later
task can read. In a flow, an app piece therefore runs through a function that submits the
job, waits for it, and finds the piece's outputs in the job's archive on storage.

- An output contract names its file with `schema_requirement_json.archived_file`, a file
  name or a glob in the archive's top folder. It must match exactly one file. An output
  with no file name is the archive folder itself.
- A file input of the app is filled from a linked input: `{"name": ..., "from_input": k}`,
  or the piece's existing `{"from_arg": "source_uri"}`, which is the step's first linked
  input.
- A piece that declares the value `job_uuid` returns the job's id.
- The job is submitted once and never resubmitted. The step fails with `APP_PIECE_JOB_FAILED`,
  `APP_PIECE_OUTPUT_MISSING` or `APP_PIECE_OUTPUT_AMBIGUOUS`, each with the job id.
- **Limit:** the step uses the token the run was submitted with for its whole wait. A job
  that outlasts that token fails with `APP_PIECE_AUTH_FAILED`. The model stage renews its
  token; an app piece does not yet.
- In a chain, an app piece is still a plain job task, as before.

**Accepting a flow's settings.** A piece runs with the submitter's token, and approval
covers a piece's code, not the arguments it is given. So what a flow's author chose is
used only when the submitter says so.

- A parameter whose default came from the flow carries `"default_source": "flow"`.
  `plan_json.flow.linked_settings` lists the settings the flow links from earlier steps.
- `POST /workflows/submit` refuses a flow plan with 422 `FLOW_SETTINGS_NOT_ACCEPTED`,
  listing those `defaults` and `links`, unless the body has `"accept_flow_settings": true`.
- A value the submitter sends replaces the flow's default and needs no acceptance. A dry
  run needs none.
- `POST /workflows/submit` refuses a flow plan with 422 `FLOW_ARGUMENT_FIXED` when `args`
  names something the plan fixed: a dataset or region bound when the flow was planned,
  `execution_id`, `source_uri`, `flow_staging_uri` or `tapis_token`. Plan again to change a dataset.

**What a flow's author cannot do.**

- Set or link an argument the adapter manages or one that carries a credential, in any
  letter case.
- Link a setting the piece reads through no task input, or one whose task input is named
  `SOURCE_*` or `TAPIS_*`.
- Name a piece the caller cannot see: it is an empty step, and nothing about it is
  reported.

A flow's steps, links and settings are readable by everyone, signed in or not. Never put
a credential in a setting.

**What a piece receives and returns in a flow.**

- Each linked input `k` arrives as the task input `SOURCE_<k>`. The first one is also
  given under the names a chain uses: the input the piece bound to `source_uri`, and
  `SOURCE_RESULT` when it comes from an earlier step. A piece written for a chain runs in
  a flow unchanged.
- A step with no linked input is handed no dataset: the input it bound to `source_uri`
  is not set.
- A stored-code piece returns its first output as before. To return more, its entrypoint
  returns `{"svo_flow": {"outputs": {<position>: <value>}, "values": {<name>: <value>}}}`.
  A piece declares the values it returns in its runtime metadata as `value_outputs`.
  A value name is a plain identifier of at most 64 characters.

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
| The piece is shared or public and an admin approved it as it is now: its source, the function called, the run arguments it is handed and the arguments it declares (`PUT /admin/transform-spec-approval`) | Yes |
| The piece is shared or public and unapproved, and the caller named it (`allow_unapproved_piece_ids` on `POST /plans`, `allow_unapproved` on `POST /transform-specs/{id}/test`) | No |
| Anything else, including another user's private piece | Not runnable |

Each plan step that carries stored source records the piece id, owner and the SHA-256
of the source under `stored_source`. `POST /workflows/submit` checks every such step
again, against the submitter and against the piece as it is now, and answers 403
`STORED_SOURCE_REFUSED` with a `problems` list (`STORED_SOURCE_DISABLED`,
`STORED_SOURCE_PIECE_NOT_VISIBLE`, `STORED_SOURCE_CHANGED`,
`STORED_SOURCE_NOT_PERMITTED`). An opt-in belongs to the user who gave it and does not
carry over to another submitter. Each real run writes a `stored_source_run` provenance
event against the run, naming the submitter and each piece's owner and source hash. Stored code may bind only `tapis_token`, `source_uri` and the run arguments the
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
| POST | `/plans` | Find and persist an ETL plan that closes compatibility gaps. With `piece_ids`, plan exactly the named chain instead of searching (see "Naming the pieces of a plan"). |
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
| GET | `/runs/{run_id}` | Retrieve one run. See "Who can read a run" below. |
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

### Your own secrets

A credential that belongs to the person running a flow (a model server key, a data
provider login) is stored with the adapter once, with the runner's own Tapis token. The
adapter asks Tapis who the token belongs to; a user can only store, list or delete their
own. No route returns a stored value. The routes are tagged `Integrations`.

| Method | Path | Purpose |
|---|---|---|
| PUT | `/secrets/{name}` | Store or replace your secret `name`. Body `{"fields": {"<field>": "<value>", ...}}`; extra keys are refused and values must be strings. Answers `{name, fields, version, created_at, updated_at}`, field names only. |
| GET | `/secrets` | List your secrets, sorted by name: `[{name, fields, version, created_at, updated_at, last_used_at}]`. Never values. A secret a model's owner stored for a model is not listed. |
| DELETE | `/secrets/{name}` | Delete your secret. 404 `SECRET_NOT_FOUND` when you have none by that name. |

Limits: `name` matches `[a-z0-9_-]{1,64}`, field names `[a-z0-9_]{1,32}`, at most 16
fields, 4096 bytes in total (422 otherwise; the answer never repeats a value).

Refusals, on all three routes unless noted:

- 401 `TAPIS_AUTH_REQUIRED` when the token is missing or not valid.
- 503 `SECRETS_NOT_CONFIGURED` when the adapter has no encryption key
  (`SVO_ADAPTER_SECRETS_ENCRYPTION_KEYS`).
- `PUT` and `DELETE` only: 409 `SECRET_LOCKED_BY_RUN` while you have a run in progress
  (`submitting` or `running`). Every step of your run holds your token, so a stored secret
  cannot be changed until the run has finished. Listing is never locked.
- `PUT` and `DELETE` only: 429 `SECRET_RATE_LIMITED` beyond 20 changes per user in 10
  minutes.

Every change is recorded with who made it and when (`created`, `replaced`, `deleted`
events); `updated_at` in the list is the last change. Responses carry
`Cache-Control: no-store`.

Store a secret without typing the value into your shell history. Put it in an
environment variable first (for example with `read -rs MODEL_API_KEY`), then:

```bash
read -rs MODEL_API_KEY            # type the key; it is not echoed or recorded
jq -n --arg key "$MODEL_API_KEY" --arg url "https://models.example.org/v1" \
    '{fields: {api_key: $key, base_url: $url}}' |
  curl -sS -X PUT "$SVO_ADAPTER_URL/secrets/model_server" \
    -H "Authorization: Bearer $TAPIS_TOKEN" \
    -H "Content-Type: application/json" \
    --data-binary @-
unset MODEL_API_KEY
```

#### Using your secrets in a flow

A piece asks for the secrets it needs in its catalog row, in `runtime_json`:

```json
"secrets": [{"name": "model_server", "label": "Model server",
             "env": {"MODEL_API_KEY": "api_key", "CHAT_BASE_URL": "chat_base_url"}}],
"sends_data_to": [{"service": "The model server in your 'model_server' credential",
                   "what": "Passages of your documents, to embed and label them"}]
```

- `secrets` has 1 to 16 entries. `name` is the name the runner stored the secret under
  (`[a-z0-9_-]{1,64}`). `env` maps a **task input** (`[A-Z][A-Z0-9_]{0,63}`) to a **field**
  of the stored secret (`[a-z0-9_]{1,32}`). A piece may declare several secrets, but one
  task input is filled by one secret.
- `sends_data_to` is a plain statement shown to the runner before a run: `service` up to
  200 characters, `what` up to 300.
- An invalid declaration is refused where a plan reads it (422
  `SECRET_DECLARATION_INVALID`) and is not synced from the catalog.
- **Approval covers both.** Adding or changing either on an approved piece withdraws its
  approval (a piece that declares neither keeps an earlier approval).
- **The destination rule.** A task input a secret fills may not also be bound to a run
  argument (`env_from_args`), given a flow setting, linked by a flow wire, or be a
  `SOURCE_*`, `TAPIS_*` or `SVO_*` input. Names are compared without regard to case, on
  what the step finally receives, at `POST /flows/check` (a problem), at plan, at submit
  and at the fetch. Refusal: 422 `FLOW_SECRET_INPUT_TAKEN` (`step`, `input`). The secret
  carries its own destination (for example the server address), so a flow's author cannot
  choose where a key is sent.
- **Only a stored-source function piece with an entrypoint** can be given a secret. A
  built-in, a script-style piece (no entrypoint function) or a piece that runs as a Tapis
  app is refused: 422 `SECRET_PIECE_UNSUPPORTED` (`step`, `reason`).
- **The catalog sync.** The catalog's declarations travel in the piece's copied runtime
  (`parameters_schema_json.metadata.runtime`); a piece registered straight into the adapter
  sends top-level `secrets` and `sends_data_to`. If the catalog row declares something
  different from the adapter's copy, planning refuses: 409 `PIECE_REGISTRY_STALE`
  (`piece_id`). A piece never runs without the key it declared.

**Plan.** `POST /plans/flow` adds to `plan_json`:

| Field | Meaning |
|---|---|
| `secrets` | `[{name, label, fields, steps, stored}]`: each secret the flow needs, the sorted field names the steps need, the step positions, and whether the caller has stored it (with all those fields). |
| `secrets_ready` | `true` when every one is stored, or there are none. |
| `sends_data_to` | `[{step, piece, service, what}]`: what each step says it sends, and to whom. |
| `planned_by` | the Tapis username that made the plan (every flow plan). A run that binds a secret is submitted only by that user: anyone else gets 403 `FLOW_PLAN_NOT_YOURS`. |
| `secret_bindings` | the id and version of each stored row the plan found (for the check at submit). Ids and versions only. |

A flow whose secret is not stored is planned (200) with `secrets_ready: false`. No value is
in a plan.

**Submit.** `POST /workflows/submit` binds the submitter's secrets to the run (the run's
`bound_secrets`: per step the secret ids, versions, names and env map, never a value; a
`bound` event is recorded). Refusals:

| Refusal | Status | `detail.code` |
|---|---|---|
| A secret is not stored, or lacks a needed field | 422 | `FLOW_SECRET_MISSING` (`secrets`: `[{name, fields}]`) |
| The stored secret is not the one the plan found, or the plan found none (stored after planning) | 409 | `FLOW_SECRET_CHANGED` (`name`); plan again |
| The plan was made by another user | 403 | `FLOW_PLAN_NOT_YOURS` |
| The user has another active run that holds unissued secret credentials and this run has an untrusted step, or the reverse | 409 | `SECRET_RUN_CONFLICT` |
| A secret is declared by a piece that is not an entrypoint function piece | 422 | `SECRET_PIECE_UNSUPPORTED` (`step`, `reason`) |
| A run that binds a secret has a step whose piece is not built-in, approved as it is, or the runner's own (an opted-in unapproved piece counts) | 403 | `SECRET_PIECE_NOT_TRUSTED` (`step`) |
| The piece declares different secrets than when the plan was made | 409 | `STEP_SECRET_DECLARATION_CHANGED` (`step`) |
| No `SVO_ADAPTER_STEP_SECRET_KEY` of at least 32 bytes (shorter is logged at startup, never the key), `SVO_ADAPTER_PUBLIC_URL` or encryption key | 503 | `STEP_SECRETS_NOT_CONFIGURED` |

Nothing about a secret travels in `args`. `svo_run_id`, `svo_adapter_url` and
`step_secret_token_<position>` are managed by the adapter: sending any is 422
`FLOW_ARGUMENT_FIXED`. A dry run binds nothing and returns no credential.

**The per-step fetch credential.** For each bound step the adapter makes
`<expiry>.<hmac>`, an HMAC-SHA256 (key `SVO_ADAPTER_STEP_SECRET_KEY`) over the run id, the
step position, the sorted ids and versions of the secrets bound to the step, and the expiry
(the sum of the pipeline's task time limits, plus an hour). It is a pipeline argument,
`step_secret_token_<position>`, mapped to the step's task input `SVO_STEP_SECRET_TOKEN`; no
other step is given it. `SVO_RUN_ID` and `SVO_ADAPTER_URL` (from `SVO_ADAPTER_PUBLIC_URL`)
are the other adapter-managed task inputs. The credential opens nothing without the
runner's own token.

**`GET /runs/{run_id}/steps/{step}/secrets`** needs `Authorization: Bearer <runner token>`
(Tapis says whose it is; it must be the run's submitter) **and** `X-Step-Secret-Token`.
It answers `{"inputs": {"MODEL_API_KEY": "...", ...}}` with `Cache-Control: no-store` only
while all of this holds, and refuses otherwise with a code and nothing else:

| Check | Refusal |
|---|---|
| configuration present | 503 `STEP_SECRETS_NOT_CONFIGURED` |
| runner token valid and credential sent | 401 `STEP_SECRET_AUTH_REQUIRED` |
| run exists and is the caller's (same answer for both) | 403 `STEP_SECRET_REFUSED` |
| run is `submitting` or `running` | 409 `RUN_NOT_ACTIVE` |
| step is bound | 404 `STEP_SECRET_NOT_BOUND` |
| credential is for exactly this run and step, and not expired | 401 `STEP_SECRET_CREDENTIAL_REJECTED` |
| credential not used before (once, claimed atomically) | 409 `STEP_SECRET_ALREADY_ISSUED` |
| every piece of the run still passes the trust rule; the piece's declaration and the destination rule still hold | 403 `SECRET_PIECE_NOT_TRUSTED`, 409 `STEP_SECRET_DECLARATION_CHANGED`, 403/422 `FLOW_SECRET_INPUT_TAKEN` |
| each secret still exists, is the submitter's, at the bound version, with the fields | 409 `SECRET_REMOVED`, `FLOW_SECRET_CHANGED`, `SECRET_FIELDS_INCOMPLETE` |
| the user has no other active run holding an untrusted step | 409 `SECRET_RUN_CONFLICT` |
| rate limit per (caller, run), checked after the run is known to be the caller's | 429 `RUN_CREDENTIALS_RATE_LIMITED` |

An `issued` event records the run, step and secret id (no value). This route never reads a
model owner's secret, and `GET /runs/{id}/credentials` never returns a runner's own.

**Residual race.** Run arguments are taken to be readable by the run's owner, and an
untrusted (opted-in, unapproved) piece runs with the owner's token. The adapter therefore
refuses (`SECRET_RUN_CONFLICT`) to start an untrusted run while the user's other run holds
unissued credentials, to start a secret run while another active run holds an untrusted
step, and to serve a fetch while one does. Two runs submitted at the same moment can each
pass the check before the other exists; that window is not closed. An app step receives
the runner's token too, so it is held to the same rule (the runner's own, or a seeded
piece with no owner and no catalog author). A fetch whose response is lost has spent its
credential: the step fails, and submitting the flow again is the recovery. The `issued`
audit event is written before the credential is spent.

**For piece authors.** Declare the secret and read its values from the dict your entrypoint
receives (`inputs["MODEL_API_KEY"]`); do not take a key as a run argument. Before your
function is called, the wrapper fetches the values with the runner's token and the step's
credential, and fails the step with one line,
`{"status": "error", "code": "STEP_SECRET_FETCH_FAILED", "http_status": N}`, when it cannot.
As a best-effort guard, the wrapper replaces each fetched value found in what you print or
return with `***`; it cannot find a value you split or transform, so never print or return a
key. Approval is a person reading your code: send a key only to the address in the same
secret.

**Limits, plainly.** Any code running with the runner's token can act as the runner (store
or delete secrets, start runs), which is why a run that binds a secret may hold only
trusted pieces. Pipeline arguments, including the per-step credential and the runner's
token, are readable through the Workflows API by whoever Tapis lets read the run; the
credential alone opens nothing and is spent by the step's one fetch. A task's output is
readable by the run's submitter.

### Who can read a run

`GET /runs`, `GET /runs/{run_id}`, `GET /runs/{run_id}/provenance` and
`POST /runs/{run_id}/poll` answer only for a run the caller may read:

| Caller | Sees |
|---|---|
| A signed-in user (bearer token, resolved through Tapis `userinfo`) | the runs they submitted |
| A user in `SVO_ADAPTER_CANCEL_ADMINS` | every run |
| The Ensemble Manager (`X-Ensemble-Manager-Secret`) | every run |

- No token, or a token Tapis does not confirm, gets 401 `TAPIS_AUTH_REQUIRED`.
- Another user's run is answered with 404, the same as a run that does not exist.
- A run with no recorded submitter is readable only by an admin and the Ensemble Manager.
- In demo mode, with no token, every run is listed. Demo mode has no accounts.

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
| PUT | `/admin/transform-spec-approval` | Approve, or withdraw approval of, a piece that carries Python source (`{spec_id, approved}`). Records one SHA-256 over the source, the function called in it, the run arguments it is handed (`env_from_args`) and the arguments it declares, in `approved_source_sha256`. Approval lapses when any of them changes. An approval recorded over the source alone, as before 2026-11-19, no longer counts |
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
