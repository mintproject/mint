# SVO-owned composite model workflow

Status: Implemented

## Objective

Restore a single-workflow boundary for post-model adapter runs. The SVO adapter
must own model-job submission, model-job polling, output-file discovery, output
identity matching, and the downstream modular transform chain. Ensemble Manager
should submit and reconcile one SVO workflow without independently submitting or
discovering the model job.

## User need

The model output and every transformation are one reproducible data path. A
facilitator should not see a completed model followed by a second opaque
workflow, and operators should not have to correlate an Ensemble Manager job
name with a Tapis Jobs archive. Keeping the provider job and output handoff in
the adapter also makes the extraction and unit-conversion tasks reusable.

## Current code/system summary

The current post-model path submits the model through Ensemble Manager, then
uses a deferred SVO adapter workflow. An earlier composite implementation
submitted a Tapis Jobs task inside a workflow and attempted to discover its job
through workflow-run environment variables and archive-path guesses. Those
approaches failed when the workflow execution record or planned archive path
was not discoverable, and they moved model orchestration out of the adapter.

The existing adapter already supports named function-task outputs. The
`unit_convert` task can consume the preceding extraction task's `result`, but
the composite model stage still needs a reliable typed URI handoff.

## Proposed design

1. Ensemble Manager builds the server-owned model job descriptor, including the
   explicitly selected MINT output key, and submits one `/workflows/submit`
   request to SVO with that descriptor.
2. SVO adds a model function task to the generated workflow. That function
   submits the model job through Tapis Jobs using the runtime Tapis token,
   polls the exact returned job UUID, lists that job's output files, matches the
   declared output key, and emits one named `result` output containing the
   verified `tapis://` URI.
3. Each adapter transform remains a separate workflow task. The first task
   consumes the model task's named `result`; later scalar transforms consume
   the preceding task's named `result`. Task ordering is not used as an implicit
   data handoff.
4. Ensemble Manager polls the one SVO run and registers only the final adapter
   output. It does not submit a second deferred adapter run or perform model
   output discovery.

The model job definition is generated server-side and contains no bearer
token. The token is injected as a runtime workflow argument and is never
included in diagnostics, workflow definitions, or error messages.

## Files likely affected

- `mint-ensemble-manager/src/api/api-v1/services/unifiedExecutionService.ts`
- `mint-ensemble-manager/src/classes/tapis/adapters/TapisExecutionService.ts`
- `svo-adapter-service/app/main.py`
- `svo-adapter-service/app/tapis.py`
- `svo-adapter-service/tests/test_composite_tapis_workflow.py`
- focused Ensemble Manager orchestration tests

## API/schema changes

No database schema change is required. The existing internal
`SubmitWorkflowIn.model_task` field becomes supported for the Ensemble Manager
composite submission path. It remains restricted to the internal service
caller, is merged into a request-local plan snapshot, and is not persisted as
mutable user input.

## Data flow

```text
Ensemble Manager
  └─ submit one SVO workflow + server-generated model job descriptor
       └─ SVO model function
            ├─ Tapis Jobs submit → exact provider job UUID
            ├─ poll exact UUID
            ├─ list outputs and match declared cbb/cbc output
            └─ named result: verified tapis:// output URI
                 └─ CBC extraction task
                      └─ named scalar result
                           └─ unit conversion task
                                └─ final registered adapter output
```

## Risks and tradeoffs

- The model function is long-running and must have a workflow execution limit
  compatible with the model's configured maximum runtime.
- Direct Jobs API calls avoid unsupported workflow-task correlation APIs, but
  the adapter must carefully bound polling and redact credentials.
- A model output with no exact match or an ambiguous extension match fails the
  workflow explicitly rather than guessing.
- Existing non-composite and legacy model paths remain available during
  rollout, which means both orchestration modes must continue to be tested.

## Alternatives considered

- Keep model submission in Ensemble Manager and bind a deferred adapter:+  rejected because it splits one scientific workflow across services and made
  output discovery a coordinator concern.
- Keep a Tapis Workflows `tapis_job` task and infer its provider UUID from
  workflow environment variables: rejected because those variables are not a
  portable contract for generic workflows.
- Match a job by name or list all jobs: rejected because names are not a
  sufficient run identity and broad listing is unsafe and race-prone.

## Test plan

- Assert generated composite workflows contain one model function task and the
  separate transform tasks, with explicit `task_output` bindings.
- Assert the generated model function submits, polls, and lists outputs for the
  exact returned job UUID, and does not depend on workflow-run environment IDs.
- Assert the selected model output is explicit and that cbb/cbc matching fails
  on missing or ambiguous files.
- Assert Ensemble Manager makes one composite adapter submission and does not
  invoke standalone model submission or a second deferred adapter submission.
- Preserve existing tests for ordinary adapter workflows and deferred plans.

## Documentation plan

Document the internal composite submission contract and keep the existing
facilitator-view design linked as the UI consumer of the unified run state.

## Rollout/rollback plan

Validate through focused local tests and dry-run workflow generation first.
Keep the legacy path available for plans without `post_model_adapter`. Rollback
is a code/configuration rollback to the prior coordinator path; no provider or
database deletion is required.

## Open questions

- Confirm the live Tapis Workflows function execution limit for the longest
  supported model before production rollout.
- Confirm whether the model job's archive output entry always includes a
  `tapis://` URI or requires reconstruction from its archive system and path.

## Decisions

- 2026-09-28: The user approved restoring SVO ownership of the complete
  model-to-output-to-transform workflow.
- 2026-09-28: Architecture, skeptic, security, and tester reviews agreed that
  exact provider-job identity, bounded polling, explicit output matching, and
  redacted runtime credentials are required. The reviews disagreed with the
  prior deferred/coordinator-owned flow, so this implementation follows the
  user-approved SVO-owned boundary.
- 2026-09-28: CBC budget extraction keeps the drain/river transform modular and
  passes an ordered, managed candidate-label list to the geo actor. The actor
  performs bounded allowlisted exact matching against the file's available CBC
  records, reports the selected label, and preserves scalar `package` support
  for older callers and saved plans.
- 2026-09-29: Composite model tasks use the bearer token from the logged-in UI
  request for the complete hosted model stage. The unattended SVO poller skips
  composite runs so its `tasclient_dsso` service fallback cannot inspect a
  different user's Tapis job. Provider `NORMAL_COMPLETION` is terminal, and
  safe structured auth errors replace the Workflows `Task Failed: []` message.
- 2026-09-29: The generated composite pipeline explicitly overrides legacy
  `source_uri` parameter metadata to `required: false`, because the URI is
  produced by the model task's named output after submission. Composite
  submissions recreate the registered pipeline so Tapis cannot reuse an older
  definition that validates this internal handoff as a user argument.
- 2026-11-02: Reverses the 2026-09-29 poller skip. A coordinator-owned run that
  nobody was viewing stayed `running` in svo after Tapis had finished or failed
  it (the model task never submitted a job; the pipeline sat `ACTIVE`). The
  poller now syncs status for `execution_id` runs
  (`SVO_ADAPTER_POLL_COORDINATOR_RUNS`, default on), status only; output
  registration stays with Ensemble Manager. `tasclient_dsso` was added to the
  `adapter-ops` Workflows group as a non-admin member so it can read those runs
  (user-approved). Unreadable runs are left unchanged.

## User feedback / decisions

The user clarified that the goal is a modular SVO adapter, not a model run
managed by Ensemble Manager followed by a separate adapter handoff. CBC
extraction and unit conversion therefore remain separate reusable tasks.

Implementation note: the model stage is implemented as an SVO hosted function
task because that is the stable place to capture the exact Tapis Jobs UUID and
discover its output. The existing transform task types remain unchanged; the
current DFC smoke path receives the model URI through a named `task_output`
reference, and the adapter registers the final scalar workflow output once.

Implementation status: the CBC alias-selection change is implemented in the
adapter registry/task generator and geo actor. Focused syntax, JSON, generated
task, and diff checks pass; full pytest execution remains environment-blocked
in this checkout because the available Python lacks the project dependencies.
