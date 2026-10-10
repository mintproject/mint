# How the ensemble manager runs a model today

Issue: [#334](https://github.com/mintproject/monorepo/issues/334), part of #330.
Source: `mint-ensemble-manager/` at commit `ccd11f51`. Wiki and `docs/` checked too.

In this file, `src/` means `mint-ensemble-manager/src/`.

## Answer

1. The ensemble manager runs a model as one Tapis job for each execution. It submits the job, subscribes a webhook, and reads status, logs and files back from Tapis.
2. A formal runner interface exists, but it is small. `IExecutionService` has two methods: `submitExecutions` and `verifyComponent` (`src/interfaces/IExecutionService.ts:29-39`). Status, logs, files and output registration are outside it.
3. A non-Tapis runner on Windows must do five things. It must accept a submit and return a job id. It must report status to the manager. It must serve a log by job id. It must list output files with URLs. It must read input files from URLs. The manager has no engine factory yet, so the manager code needs changes too (see "Gaps").

## The path of one run

| Step | What happens | Where |
|---|---|---|
| 1 | The UI posts `{thread_id, model_id}` to `POST /v1/executionEngines/tapis`. | `src/api/api-v1/paths/executionEngines/tapis.ts:52` |
| 2 | The service builds a `TapisExecutionService` with the user token. The class name is fixed in code. | `src/api/api-v1/services/executionsTapisService.ts:25` |
| 3 | `ExecutionCreation.prepareExecutions` checks the component, then makes one `Execution` for each input combination (cartesian product). | `src/classes/common/ExecutionCreation.ts:71-104`, `cartProd` at `:458` |
| 4 | It writes the executions to Hasura with status `WAITING`, and counts submitted runs. | `ExecutionCreation.ts:136-141`, `:198-219` |
| 5 | `submitExecutions` loads the Tapis app, builds a seed for each execution, and submits one job for each seed. | `src/classes/tapis/adapters/TapisExecutionService.ts:79-107`, `:121-141` |
| 6 | The adapter stores the Tapis job uuid as `execution.runid`. | `TapisExecutionService.ts:160` (GraphQL: `updateExecutionRunId`, `src/classes/graphql/graphql_functions.ts:1247`) |
| 7 | The adapter subscribes a webhook on the job. | `TapisExecutionService.ts:169-170` |
| 8 | Tapis posts each status change to the webhook. The manager maps it and writes it to Hasura. | `src/api/api-v1/paths/tapis/threads/index.ts:120`, `src/api/api-v1/services/tapis/jobsService.ts:27-37` |
| 9 | The user asks to register outputs. The manager lists job files, matches them to declared outputs, registers them in CKAN, and stores the results. | `src/api/api-v1/paths/problemStatements/tasks/subtasks/executions/index.ts:256`, `TapisExecutionService.ts:265-284` |

## Jobs

- Submit: `TapisExecutionService.submitJob` calls `jobsClient.submitJob` (`TapisExecutionService.ts:426-441`).
- The request comes from `TapisJobService.createJobRequest` (`src/classes/tapis/adapters/TapisJobService.ts:26-68`).
- Parameters: `getAppArgs` fills each app argument from the seed (`TapisJobService.ts:80-101`). It throws if a value is missing.
- Site values are hard-coded: allocation `PT2050-DataX`, system `ls6`, queue `development`, `maxMinutes: 60`, archive path under `$WORK` (`TapisJobService.ts:6-8`, `:56-59`). A Windows runner cannot use them.
- The job name is `appId-version-executionId`, cut to 64 characters (`TapisExecutionService.ts:599-624`).
- Failure at submit: one failed seed marks that execution failed and lowers the submitted count (`:175-198`). If all seeds fail, the whole call throws (`:200-212`).

## Input files

- `getInputDatasets` turns each bound resource into a `DataResource` with a `url` (`src/classes/tapis/helpers.ts:18-42`).
- `createJobFileInputsFromSeed` sends each URL to Tapis as `fileInputs[].sourceUrl` (`TapisJobService.ts:103-143`). Tapis downloads the file. The manager moves no bytes.
- It skips `FIXED` inputs and unbound optional inputs (`TapisJobService.ts:110-131`).
- Parameters are strings. A value `__region_geojson:<id>` becomes a GeoJSON string (`helpers.ts:111-115`, `:122-129`).

Rule for a new runner: it must fetch each `sourceUrl` itself. The URLs can be `http(s)`, `s3://` or `tapis://`.

## Status

The status type has four values: `WAITING`, `RUNNING`, `SUCCESS`, `FAILURE` (`src/interfaces/IExecutionService.ts:8-13`).

Two paths can change status:

- Webhook push. The body must have `event.type` (`jobsService.ts:35`). `mapStatus` converts `jobs.JOB_NEW_STATUS.*` strings (`TapisExecutionService.ts:388-411`). An unknown string throws.
- Pull. `getJobStatus` calls `getJob` and maps the enum (`:332-353`, map at `:355-386`). Only `GET /tapis/jobs/{id}` uses it (`src/api/api-v1/paths/tapis/jobs/index.ts:88`). The manager does not poll.

`updateExecutionStatusOnGraphQl` does the write (`TapisExecutionService.ts:464-487`):

| Status | `run_progress` | Counter change |
|---|---|---|
| `WAITING` | 0.05 | none |
| `RUNNING` | 0.5 | none |
| `SUCCESS` | 1 | `incrementThreadModelSuccessfulRuns` |
| `FAILURE` | 0 | `incrementThreadModelFailedRuns` |

Then it calls `updateExecutionStatus` (`graphql_functions.ts:615`).

Findings:

- A repeated `SUCCESS` or `FAILURE` webhook counts twice. There is no guard (`TapisExecutionService.ts:471-476`).
- `PAUSED` maps to `FAILURE` in `mapStatus` (`:406`) but to `WAITING` in `mapJobStatusEnum` (`:375`). The two maps disagree.
- The webhook handler reads no signature or secret (`threads/index.ts:120-140`). I did not check the global `validator` middleware (`src/server.ts:80`).
- `PUT /tapis/threads/{threadId}/executions/{executionId}/status` exists (`threads/index.ts:54`). It validates the status, then only adds one to the success counter and ignores the value (`src/api/api-v1/services/tapis/threads/executions/threadsExecutionsService.ts:20-32`). Do not use it as a runner callback.

Webhook URL: `${tapis_webhook_base_url or ensemble_manager_api + "/tapis"}/threads/{threadId}/executions/{executionId}/webhook` (`src/classes/tapis/adapters/TapisJobSubscriptionService.ts:47-52`). The override exists for dev clusters (`src/classes/mint/mint-types.ts:83-87`).

## Logs

- Route: `GET /v1/executions/{executionId}/logs` (`src/api/api-v1/paths/executions.ts`). It calls `logsService.fetchLog`.
- `fetchLog` switches on `execution_engine`: `wings`, `localex`, `tapis` (`src/api/api-v1/services/logsService.ts:30-44`).
- Tapis: `getLog(runid)` downloads `tapisjob.out`. If that fails, it builds text from the job history (`TapisExecutionService.ts:312-324`).
- Localex: it reads `<logdir>/<executionId>.log` (`src/classes/localex/local-execution-functions.ts:472-476`).

## Output files

- `listJobFiles(runid)` lists the job output directory, two levels deep, and hides `tapisjob.*` control files (`TapisExecutionService.ts:508-554`).
- Route `GET /v1/executions/{id}/files` returns `{name, path, size, url}` for each file (`src/api/api-v1/services/executionFilesService.ts:14-23`, `:48-69`). It rejects any engine except `tapis` (`:56-61`). It returns `[]` when `runid` is empty (`:62-64`).
- `url` is a `tapis://` URI. CKAN reads it as it is (`executionFilesService.ts:21`).
- Matching: `matchTapisOutputsToMintOutputs` pairs files to declared model outputs by fuzzy name (Fuse, threshold 0.5). One file goes to one output (`src/classes/tapis/jobs/index.ts:59-123`).
- Error codes: no declared outputs gives `NoOutputsDeclaredError` (HTTP 422). No files gives `NotFoundError` (`TapisExecutionService.ts:570-575`).
- `registerExecutionOutputs` requires status `SUCCESS` (`:260-262`). It renames each resource `name-executionId`, registers it in CKAN, then saves results with `updateExecutionStatusAndResultsv2` (`:265-284`, `graphql_functions.ts:575`).
- `POST .../subtasks/{id}/executions/publish` loops `registerOutputs` over all executions (`src/api/api-v1/paths/problemStatements/tasks/subtasks/index.ts:1050-1070`).

## What a non-Tapis runner must implement

This contract comes from what the code reads, not from one interface. Each row cites the reader.

| # | Duty | Data the manager needs | Reader |
|---|---|---|---|
| 1 | Verify the component | A component record with `id` and `version`. For Tapis it is a Tapis app. | `IExecutionService.ts:38`, `ExecutionCreation.ts:221-251` |
| 2 | Submit one run | A seed: `execution`, `datasets` (id to URL list), `parameters` (id to string), `paramtypes`. Returns a job id string. | `typing.ts:18-26`, `IExecutionService.ts:21-37` |
| 3 | Keep a stable job id | The id is saved as `execution.runid`. Logs and files use it. | `TapisExecutionService.ts:160`, `logsService.ts:43` |
| 4 | Report status | `WAITING`, `RUNNING`, `SUCCESS`, `FAILURE`. Send one final report for each run. | `TapisExecutionService.ts:464-487` |
| 5 | Serve a log | Plain text for a job id. | `TapisExecutionService.ts:312-324` |
| 6 | List output files | `name`, `path`, `size`, `url`. No control files. | `executionFilesService.ts:14-23` |
| 7 | Make file URLs readable by CKAN | CKAN fetches each `url`. For Tapis, the URI plus the viewer token works. | `executionFilesService.ts:21` |
| 8 | Fetch inputs from URLs | `http(s)`, `s3://`, `tapis://`. | `TapisJobService.ts:133-139` |
| 9 | Accept the user token | The manager passes the user Bearer token to Tapis. A new runner needs its own auth. | `executionsTapisService.ts:20-25` |

For rows 4 and 5 the runner can push (webhook) or the manager can pull. Today only push is wired for Tapis. The localex engine bypasses both: its worker writes the final status straight to Hasura (`src/classes/localex/seed-execution.ts:437-444`).

## Gaps that block a second runner

1. No engine factory. `executionsTapisService.ts:25` calls `new TapisExecutionService(...)`. The only submit route is `/executionEngines/tapis`.
2. `IExecutionService` is Tapis-shaped. It takes a `TapisComponent` (`IExecutionService.ts:34`, `:38`). The result type is generic.
3. The status, log, file and output methods are not on the interface. `registerExecutionOutputs`, `getLog`, `listJobFiles` and `mapStatus` are Tapis class members. `jobsService.ts:32` calls a static method.
4. CKAN registration lives inside the Tapis class (`TapisExecutionService.ts:273-281`). A new runner cannot reuse it without moving it.
5. `ExecutionCreation` reads `execution_engine` to pick how to load the component (`ExecutionCreation.ts:224-228`). It also stamps new executions with `"localex"` (`:206`), even for Tapis runs.
6. The old `localex` engine does not implement `IExecutionService`. It queues seeds in Bull and runs Docker or Kubernetes (`local-execution-functions.ts:36-41`, `:345-470`, `seed-execution.ts:220`, `:293`, `:316`). It uses `updateExecutionStatusAndResults`, not the v2 function. The worker bundle is built from `seed-execution.ts` (`mint-ensemble-manager/webpack.config.js:23`).
7. Engine config is one global value, `execution_engine: "wings" | "localex" | "tapis"` (`mint-types.ts:90`; set to `tapis` in `src/config/config.json:25`). One instance cannot run two engines.
8. A Windows runner behind a firewall cannot receive a call from the manager. It must call out to the manager. No endpoint takes a correct status callback today (see the `PUT .../status` finding).

## Not covered

- I did not run the code or a live Tapis job.
- I did not read the Wings path in detail. It is legacy (`src/classes/mint/mint-functions.ts:63-110`).
- `knowledge-base/wiki/` has no page on the execution layer. `mint-platform.md` names the ensemble execution manager only in passing. `docs/debug-tapis-execution.md` covers stuck-spinner recovery, not the runner contract.
