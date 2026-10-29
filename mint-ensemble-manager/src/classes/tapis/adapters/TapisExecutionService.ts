import { Apps, Files, Jobs } from "@tapis/tapis-typescript";
import { Execution, Execution_Result, Model, Region } from "@/classes/mint/mint-types";
import { TapisComponent, TapisComponentSeed } from "@/classes/tapis/typing";
import { IExecutionService, ExecutionJob, SubmissionResult } from "@/interfaces/IExecutionService";
import apiGenerator from "@/classes/tapis/utils/apiGenerator";
import { getInputsParameters } from "@/classes/tapis/helpers";
import { getInputDatasets } from "@/classes/tapis/helpers";
import {
    TapisComponentContractError,
    TapisJobService
} from "@/classes/tapis/adapters/TapisJobService";
import errorDecoder from "@/classes/tapis/utils/errorDecoder";
import { TapisJobSubscriptionService } from "@/classes/tapis/adapters/TapisJobSubscriptionService";
import { BadRequestError, NoOutputsDeclaredError, NotFoundError } from "@/classes/common/errors";
import { ExecutionCreation } from "@/classes/common/ExecutionCreation";
import { applyExecutionInputOverrides } from "@/classes/common/execution-input-overrides";
import { threadFromGQL } from "@/classes/graphql/graphql_adapter";
import { getThread } from "@/classes/graphql/graphql_functions_v2";

interface SerializableError {
    message: string;
    stack?: string;
    name: string;
    code?: string;
    cause?: unknown;
}
import {
    getExecution,
    getModelOutputsByModelId,
    incrementThreadModelSuccessfulRuns,
    incrementThreadModelFailedRuns,
    updateExecutionStatus,
    updateExecutionStatusAndResultsv2,
    getThreadModelByThreadIdExecutionId,
    updateExecutionRunId,
    decrementThreadModelSubmittedRuns,
    handleFailedConnectionEnsemble
} from "@/classes/graphql/graphql_functions";
import { matchTapisOutputsToMintOutputs } from "@/classes/tapis/jobs";
import { Status } from "@/interfaces/IExecutionService";
import { getConfiguration } from "@/classes/mint/mint-functions";
import { TACC_CKAN_DataCatalog } from "@/classes/mint/data-catalog/TACC_CKAN_Datacatalog";

export class TapisExecutionService implements IExecutionService {
    private readonly LOG_PATH = "tapisjob.out";
    // The Tapis control files. They share one prefix: tapisjob.out and tapisjob.sh.
    private static readonly CONTROL_FILE_PREFIX = "tapisjob.";
    // How deep the adapter reads below the job output directory.
    private static readonly MAX_OUTPUT_DEPTH = 2;
    private appsClient: Apps.ApplicationsApi;
    private filesClient: Files.FileOperationsApi;
    private jobsClient: Jobs.JobsApi;
    private subscriptionsClient: Jobs.SubscriptionsApi;
    public seeds: TapisComponentSeed[];
    private jobService: TapisJobService;
    private jobSubscriptionService: TapisJobSubscriptionService;
    private jobShareClient: Jobs.ShareApi;
    constructor(
        private token: string,
        private baseUrl: string
    ) {
        this.jobsClient = apiGenerator<Jobs.JobsApi>(Jobs, Jobs.JobsApi, baseUrl, token);
        this.filesClient = apiGenerator<Files.FileOperationsApi>(
            Files,
            Files.FileOperationsApi,
            baseUrl,
            token
        );
        this.subscriptionsClient = apiGenerator<Jobs.SubscriptionsApi>(
            Jobs,
            Jobs.SubscriptionsApi,
            baseUrl,
            token
        );
        this.appsClient = apiGenerator<Apps.ApplicationsApi>(
            Apps,
            Apps.ApplicationsApi,
            baseUrl,
            token
        );
        this.jobShareClient = apiGenerator<Jobs.ShareApi>(Jobs, Jobs.ShareApi, baseUrl, token);
        this.jobService = new TapisJobService(
            this.jobsClient,
            this.subscriptionsClient,
            this.jobShareClient
        );
        this.jobSubscriptionService = new TapisJobSubscriptionService(this.subscriptionsClient);
    }

    async verifyComponent(component: TapisComponent): Promise<void> {
        await this.loadTapisApp(component);
    }

    async submitExecutions(
        executions: Execution[],
        model: Model,
        region: Region,
        component: TapisComponent,
        threadId: string,
        threadModelId: string,
        maxMinutes = 60,
        logicalQueue?: string
    ): Promise<SubmissionResult> {
        this.seeds = [];
        try {
            const app = await this.loadTapisApp(component);
            console.log("Submitting executions", executions);
            this.seeds = this.seedExecutions(executions, model, region, component);
            console.log("Seeds", JSON.stringify(this.seeds));

            const { submittedExecutions, failedExecutions } = await this.processExecutionSeeds(
                app,
                model,
                threadId,
                threadModelId,
                maxMinutes,
                logicalQueue
            );

            this.handleSubmissionResults(failedExecutions);
            return { submittedExecutions, failedExecutions };
        } catch (error) {
            await this.handleSubmissionFailure(threadId, threadModelId, error);
            throw error;
        }
    }

    /**
     * Build the model task consumed by the composite Tapis Workflows path.
     *
     * This reuses the same catalog/component/input binding code as the legacy
     * submitter, but stops before submitting a standalone job. The resulting
     * job definition contains no bearer token; the workflow service receives
     * the caller token only at the provider submission boundary.
     */
    async buildCompositeWorkflowModelTask(
        threadmodel: {
            thread_id: string;
            model_id?: string;
            output_name?: string;
            adapter_resource_overrides?: Parameters<typeof applyExecutionInputOverrides>[2];
        },
        workflowPath: string,
        maxMinutes = 60,
        logicalQueue?: string
    ): Promise<{
        execution_id: string;
        output_uri: string;
        output_name: string;
        output_format?: string;
        job_definition: Jobs.ReqSubmitJob;
    }> {
        if (!threadmodel.model_id) throw new NotFoundError("Model configuration not found");
        const threadResponse = await getThread(threadmodel.thread_id);
        const thread = threadFromGQL(threadResponse);
        if (!thread) throw new NotFoundError("Thread not found");
        applyExecutionInputOverrides(
            thread,
            threadmodel.model_id,
            threadmodel.adapter_resource_overrides || []
        );

        const executionCreation = new ExecutionCreation(
            thread,
            threadmodel.model_id,
            this,
            this.token
        );
        await executionCreation.prepareExecutions();
        if (executionCreation.executionToBeRun.length !== 1) {
            const error = new Error(
                "Composite workflow execution requires exactly one model execution"
            ) as Error & { code?: string };
            error.code = "MODEL_FANOUT_UNSUPPORTED";
            throw error;
        }
        if (!executionCreation.model.output_files?.length) {
            const error = new Error("Composite workflow model declares no outputs") as Error & {
                code?: string;
            };
            error.code = "NO_OUTPUTS_DECLARED";
            throw error;
        }

        const app = await this.loadTapisApp(executionCreation.component);
        const seed = this.seedExecutions(
            executionCreation.executionToBeRun,
            executionCreation.model,
            executionCreation.threadRegion,
            executionCreation.component
        )[0];
        const execution = executionCreation.executionToBeRun[0];
        const jobDefinition = this.jobService.createJobRequest(
            app,
            seed,
            executionCreation.model,
            `mint-workflow-model-${execution.id}`,
            `Composite workflow model execution ${execution.id}`,
            maxMinutes,
            logicalQueue
        );

        // A deterministic, run-owned archive path gives downstream workflow
        // tasks a durable handoff URI without exposing the provider job UUID.
        // Tapis Jobs accepts these fields when omitted, but Tapis Workflows
        // validates the embedded job definition strictly and rejects null
        // execution directories.
        jobDefinition.execSystemInputDir =
            jobDefinition.execSystemInputDir || "${JobWorkingDir}";
        jobDefinition.execSystemOutputDir =
            jobDefinition.execSystemOutputDir || "${JobWorkingDir}/output";
        const archivePath = `mint-workflow-output/${workflowPath}/model`;
        jobDefinition.archiveSystemDir = `HOST_EVAL($WORK)/${archivePath}`;
        const requestedOutputName = threadmodel.output_name?.trim();
        const output = requestedOutputName
            ? executionCreation.model.output_files.find(
                  (candidate) =>
                      candidate.name === requestedOutputName || candidate.id === requestedOutputName
              )
            : executionCreation.model.output_files[0];
        if (!output) {
            const error = new Error(
                `Composite workflow model does not declare output ${requestedOutputName}`
            ) as Error & { code?: string };
            error.code = "MODEL_OUTPUT_NOT_DECLARED";
            throw error;
        }
        const outputName = output.name || output.id;
        return {
            execution_id: execution.id,
            output_name: outputName,
            output_format: output.format || "",
            output_uri: `tapis://${jobDefinition.archiveSystemId}/${archivePath}/${outputName}`,
            job_definition: jobDefinition
        };
    }

    private async processExecutionSeeds(
        app: Apps.TapisApp,
        model: Model,
        threadId: string,
        threadModelId: string,
        maxMinutes: number,
        logicalQueue?: string
    ): Promise<{
        submittedExecutions: { execution: Execution; jobId: string }[];
        failedExecutions: { execution: Execution; error: Error }[];
    }> {
        const submittedExecutions: { execution: Execution; jobId: string }[] = [];
        const failedExecutions: { execution: Execution; error: SerializableError }[] = [];

        for (const seed of this.seeds) {
            console.log("Processing seed", JSON.stringify(seed));
            try {
                const jobId = await this.submitSingleExecution(
                    app,
                    seed,
                    model,
                    threadId,
                    maxMinutes,
                    logicalQueue
                );
                submittedExecutions.push({ execution: seed.execution, jobId });
            } catch (error) {
                console.error("Error submitting single execution:", error instanceof Error ? error.message : String(error));
                console.error("Full error details:", error);
                await this.handleSingleExecutionFailure(seed, error, threadModelId);

                const serializableError: SerializableError = {
                    message: error instanceof Error ? error.message : String(error),
                    stack: error instanceof Error ? error.stack : undefined,
                    name: error instanceof Error ? error.name : "Error",
                    code: (error as Error & { code?: string })?.code,
                    ...(error instanceof Error &&
                        (error as any).cause && { cause: (error as any).cause })
                };

                failedExecutions.push({ execution: seed.execution, error: serializableError });
            }
        }

        return { submittedExecutions, failedExecutions };
    }

    private async submitSingleExecution(
        app: Apps.TapisApp,
        seed: TapisComponentSeed,
        model: Model,
        threadId: string,
        maxMinutes: number,
        logicalQueue?: string
    ): Promise<string> {
        const name = this.generateValidJobName(app, seed.execution.id);
        const description = "Job for " + model.name + " execution " + seed.execution.id;
        const jobRequest = this.jobService.createJobRequest(
            app,
            seed,
            model,
            name,
            description,
            maxMinutes,
            logicalQueue
        );

        console.log("Job request", JSON.stringify(jobRequest));
        const jobId = await this.submitJob(jobRequest);

        try {
            await updateExecutionRunId(seed.execution.id, jobId);
        } catch (error) {
            console.error(
                `updateExecutionRunId failed for execution ${seed.execution.id} (jobId ${jobId}):`,
                error instanceof Error ? error.message : String(error)
            );
            throw error;
        }

        const subscription = TapisJobSubscriptionService.createRequest(seed.execution.id, threadId);
        await this.jobSubscriptionService.submit(jobId, subscription);

        return jobId;
    }

    private async handleSingleExecutionFailure(
        seed: TapisComponentSeed,
        error: Error,
        threadModelId: string
    ): Promise<void> {
        console.error(`Failed to submit job for execution ${seed.execution.id}:`, error);

        // Mark the individual execution as failed
        try {
            await TapisExecutionService.updateExecutionStatusOnGraphQl(
                seed.execution,
                "jobs.JOB_NEW_STATUS.FAILED",
                threadModelId
            );
        } catch (statusUpdateError) {
            console.error(
                `Failed to update execution status for ${seed.execution.id}:`,
                statusUpdateError
            );
            throw statusUpdateError;
        }

        await decrementThreadModelSubmittedRuns(threadModelId);
    }

    private handleSubmissionResults(
        failedExecutions: { execution: Execution; error: SerializableError }[]
    ): void {
        if (failedExecutions.length > 0) {
            if (failedExecutions.length === this.seeds.length) {
                const errorMessages: string[] = [];
                failedExecutions.forEach((fe) => {
                    const errorMsg = `Execution ${fe.execution.id} failed: ${fe.error.message}`;
                    console.error(errorMsg);
                    console.error("Full error details for execution", fe.execution.id, ":", fe.error);
                    errorMessages.push(fe.error.message);
                });
                const contractFailure = failedExecutions.find(
                    (failed) =>
                        failed.error instanceof TapisComponentContractError ||
                        failed.error.code === "COMPONENT_CONTRACT_MISMATCH"
                );
                if (contractFailure) {
                    throw contractFailure.error;
                }
                throw new Error("All jobs failed to submit - " + errorMessages.join("; "));
            } else {
                console.warn("Some jobs failed to submit:");
                failedExecutions.forEach((fe) => {
                    console.warn(`Execution ${fe.execution.id} failed: ${fe.error.message}`);
                    console.warn("Full error details for execution", fe.execution.id, ":", fe.error);
                });
            }
        }
    }

    private async handleSubmissionFailure(
        threadId: string,
        threadModelId: string,
        error: Error
    ): Promise<void> {
        try {
            console.log("Handling failed connection ensemble");
            await handleFailedConnectionEnsemble(
                threadId,
                {
                    event: "UPDATE",
                    userid: "SYSTEM",
                    timestamp: new Date(),
                    notes: "All jobs failed to submit",
                    thread_id: threadId
                },
                [
                    {
                        total_runs: this.seeds.length,
                        submitted_runs: 0,
                        failed_runs: this.seeds.length,
                        successful_runs: 0,
                        thread_model_id: threadModelId
                    }
                ]
            );
        } catch (cleanupError) {
            console.error("Error handling failed connection ensemble", cleanupError);
        }
        console.error("Error submitting executions", error);
    }

    async findExecution(executionId: string): Promise<Execution> {
        const execution = await getExecution(executionId);
        if (execution === null) {
            throw new NotFoundError("Execution not found");
        }
        if (execution.status !== Status.SUCCESS) {
            throw new BadRequestError("Execution is not successful");
        }
        return execution;
    }
    async registerExecutionOutputs(
        executionId: string,
        isPublic: boolean,
        datasetId: string
    ): Promise<Execution_Result[]> {
        const execution = await this.findExecution(executionId);
        // Unified workflow reconciliation records the model output directly.
        // There is no legacy Tapis job UUID to query again for these runs.
        if (execution.results && Object.keys(execution.results).length > 0) {
            return Object.values(execution.results) as Execution_Result[];
        }
        const results = await this.findExecutionResults(execution, isPublic);
        if (results.length > 0) {
            const prefs = getConfiguration();
            const ckan = new TACC_CKAN_DataCatalog(prefs);
            for (let i = 0; i < results.length; i++) {
                results[i].resource.name = results[i].resource.name + "-" + executionId;
                const idUrl = await ckan.registerResource(datasetId, results[i].resource);
                results[i].resource.id = idUrl.id;
                results[i].resource.url = idUrl.url;
            }
        }
        execution.results = results;
        return await this.updateExecutionResultsFromJob(execution);
    }

    async findExecutionResults(
        execution: Execution,
        isPublic: boolean
    ): Promise<Execution_Result[]> {
        return await this.getExecutionResultsFromJob(execution.runid, execution, isPublic);
    }

    static async updateExecution(
        thread_id: string,
        execution_id: string,
        status: string
    ): Promise<Execution> {
        const execution = await getExecution(execution_id);
        const model_ensembles = await getThreadModelByThreadIdExecutionId(thread_id, execution_id);
        if (model_ensembles.length !== 1) {
            throw new Error("Expected 1 model ensemble, got " + model_ensembles.length);
        }
        const model_ensemble_id = model_ensembles[0].id;
        await TapisExecutionService.updateExecutionStatusOnGraphQl(
            execution,
            status,
            model_ensemble_id
        );
        return execution;
    }

    async getLog(jobId: string): Promise<string> {
        const history = await this.getJobHistory(jobId);
        try {
            const file = await this.getJobOutputDownloadFile(jobId, this.LOG_PATH);
            return await file.text();
        } catch (error) {
            let log = "";
            for (const result of history.result) {
                log += `[${result.created} - ${result.event}] ${result.eventDetail}\n`;
            }
            return log;
        }
    }

    async getJobHistory(jobId: string): Promise<Jobs.RespJobHistory> {
        return await errorDecoder<Jobs.RespJobHistory>(() =>
            this.jobsClient.getJobHistory({ jobUuid: jobId })
        );
    }

    async getJobStatus(jobId: string): Promise<ExecutionJob> {
        const job = await errorDecoder<Jobs.RespGetJob>(() =>
            this.jobsClient.getJob({ jobUuid: jobId })
        );
        try {
            if (job.result?.status === Jobs.JobStatusEnum.Failed) {
                return {
                    id: job.result?.uuid,
                    status: Status.FAILURE,
                    error: job.result?.lastMessage
                };
            }
            return {
                id: job.result?.uuid,
                status: TapisExecutionService.mapJobStatusEnum(job.result?.status),
                result: job.result?.lastMessage
            };
        } catch (error) {
            console.error("Error getting job status");
            throw error;
        }
    }

    public static mapJobStatusEnum(tapisStatus: Jobs.JobStatusEnum): Status {
        switch (tapisStatus) {
            case Jobs.JobStatusEnum.Pending:
                return Status.WAITING;
            case Jobs.JobStatusEnum.ProcessingInputs:
                return Status.WAITING;
            case Jobs.JobStatusEnum.StagingInputs:
                return Status.WAITING;
            case Jobs.JobStatusEnum.StagingJob:
                return Status.WAITING;
            case Jobs.JobStatusEnum.SubmittingJob:
                return Status.WAITING;
            case Jobs.JobStatusEnum.Queued:
                return Status.WAITING;
            case Jobs.JobStatusEnum.Running:
                return Status.RUNNING;
            case Jobs.JobStatusEnum.Archiving:
                return Status.RUNNING;
            case Jobs.JobStatusEnum.Blocked:
                return Status.WAITING;
            case Jobs.JobStatusEnum.Paused:
                return Status.WAITING;
            case Jobs.JobStatusEnum.Finished:
                return Status.SUCCESS;
            case Jobs.JobStatusEnum.Cancelled:
                return Status.FAILURE;
            case Jobs.JobStatusEnum.Failed:
                return Status.FAILURE;
            default:
                throw new Error("Unrecognized Tapis status: " + tapisStatus);
        }
    }

    public static mapStatus(tapisStatus: string): Status {
        switch (tapisStatus) {
            case "jobs.JOB_NEW_STATUS.PENDING":
            case "jobs.JOB_NEW_STATUS.PROCESSING_INPUTS":
            case "jobs.JOB_NEW_STATUS.STAGING_INPUTS":
            case "jobs.JOB_NEW_STATUS.STAGING_JOB":
            case "jobs.JOB_NEW_STATUS.SUBMITTING_JOB":
            case "jobs.JOB_NEW_STATUS.QUEUED":
                return Status.WAITING;
            case "jobs.JOB_NEW_STATUS.RUNNING":
            case "jobs.JOB_NEW_STATUS.ARCHIVING":
                return Status.RUNNING;
            case "jobs.JOB_NEW_STATUS.FINISHED":
            case "jobs.JOB_NEW_STATUS.ARCHIVED":
            case "jobs.JOB_NEW_STATUS.SUCCESS":
                return Status.SUCCESS;
            case "jobs.JOB_NEW_STATUS.FAILED":
            case "jobs.JOB_NEW_STATUS.CANCELLED":
            case "jobs.JOB_NEW_STATUS.PAUSED":
                return Status.FAILURE;
            default:
                throw new Error("Unrecognized Tapis status: " + tapisStatus);
        }
    }

    /** Extra methods */

    async loadTapisApp(component: TapisComponent): Promise<Apps.TapisApp> {
        if (component === undefined) {
            throw new Error("Component is undefined");
        }
        const { result: app } = await this.appsClient.getApp({
            appId: component.id,
            appVersion: component.version
        });
        return app;
    }

    async submitJob(jobRequest: Jobs.ReqSubmitJob): Promise<string> {
        try {
            const { result: jobSubmission } = await errorDecoder<Jobs.RespSubmitJob>(() =>
                this.jobsClient.submitJob({ reqSubmitJob: jobRequest })
            );
            console.log(`Job submitted with id ${jobSubmission.uuid}`);
            return jobSubmission.uuid;
        } catch (error) {
            if (error.status === 400) {
                // Handle HTTP 400 Bad Request specifically
                const errorDetails = error.response?.data?.message || error.message;
                throw new Error(`Invalid job request: ${errorDetails}`);
            }
            throw new Error(`Failed to submit job: ${error.message}`);
        }
    }

    private seedExecutions(
        executions: Execution[],
        model: Model,
        region: Region,
        component: TapisComponent
    ) {
        console.log("seeding executions", executions);
        return executions.map((execution) => {
            const bindings = execution.bindings;
            const datasets = getInputDatasets(model, bindings);
            const { parameters, parameterTypes } = getInputsParameters(model, bindings, region);
            return {
                component: component,
                execution: execution,
                datasets: datasets,
                parameters: parameters,
                paramtypes: parameterTypes
            } as TapisComponentSeed;
        });
    }

    private static async updateExecutionStatusOnGraphQl(
        execution: Execution,
        status: string,
        model_ensemble_id: string
    ) {
        try {
            execution.status = TapisExecutionService.mapStatus(status);
            if (execution.status === Status.SUCCESS) {
                execution.run_progress = 1;
                await incrementThreadModelSuccessfulRuns(model_ensemble_id);
            } else if (execution.status === Status.FAILURE) {
                execution.run_progress = 0;
                await incrementThreadModelFailedRuns(model_ensemble_id);
            } else if (execution.status === Status.RUNNING) {
                execution.run_progress = 0.5;
            } else if (execution.status === Status.WAITING) {
                execution.run_progress = 0.05;
            }
            await updateExecutionStatus(execution);
        } catch (error) {
            console.error("Error updating execution status on GraphQL", error);
            throw error;
        }
    }

    /**
     * List the files that a Tapis job produced.
     *
     * Tapis resolves the job output directory itself. Before the job archives,
     * that directory is `execSystemOutputDir`. After the job archives, it is
     * `archiveSystemDir`. Every `outputPath` is relative to that directory, so
     * the root listing is already the answer of the application. The adapter
     * does not read `jobAttributes.execSystemOutputDir`: its value is an
     * absolute path on the execution system, and it holds an unresolved macro.
     *
     * A directory at the root is listed too, up to MAX_OUTPUT_DEPTH levels.
     * This replaces the earlier scan of 15 guessed folder names. On production
     * on 2026-09-12 every one of those 15 names answered 404, and the three
     * archived files sat at the root.
     *
     * The Tapis control files, `tapisjob.out` and `tapisjob.sh`, are not model
     * results. The method hides them unless the caller asks for them. A failed
     * execution needs `tapisjob.out`, so the flag stays.
     */
    async listJobFiles(
        jobUuid: string,
        options: { includeControlFiles?: boolean } = {}
    ): Promise<Jobs.FileInfo[]> {
        const files = await this.collectJobFiles(jobUuid, "", 0);
        if (options.includeControlFiles) {
            return files;
        }
        return files.filter((file) => !TapisExecutionService.isControlFile(file));
    }

    /**
     * List files in a durable Tapis archive directory.
     *
     * Composite workflow model tasks do not create a legacy MINT `run_id`.
     * Their output is archived by Tapis Jobs and referenced by a `tapis://`
     * result URI, so the Jobs output-list endpoint cannot locate it. The Files
     * API lists that archive directly.
     */
    async listArchiveFiles(systemId: string, path: string): Promise<Files.FileInfo[]> {
        const response = await errorDecoder<Files.FileListingResponse>(() =>
            this.filesClient.listFiles({ systemId, path, recurse: false })
        );
        return (response.result ?? []).filter(
            (file) => file.type !== Files.FileTypeEnum.Dir
        );
    }

    /**
     * Find the provider job created by a composite workflow and list its
     * archive. The workflow's logical `tapis://` URI does not include the
     * provider-resolved `$WORK` prefix, while the Jobs API already knows that
     * physical archive location.
     */
    async listCompositeWorkflowFiles(
        executionId: string,
        archivePath?: string
    ): Promise<Jobs.FileInfo[] | null> {
        const normalizedExecutionId = executionId.replace(/-/g, "").toLowerCase();
        const pageSize = 1000;
        const candidates: Jobs.JobListDTO[] = [];
        for (let skip = 0; ; skip += pageSize) {
            const jobs = await errorDecoder<Jobs.RespGetJobList>(() =>
                this.jobsClient.getJobList({
                    limit: pageSize,
                    skip,
                    listType: "MY_JOBS"
                })
            );
            candidates.push(
                ...(jobs.result ?? []).filter(
                    (candidate) =>
                        candidate.name?.toLowerCase().startsWith("mint-workflow-model-") &&
                        candidate.name
                            .replace(/-/g, "")
                            .toLowerCase()
                            .endsWith(normalizedExecutionId)
                )
            );
            if ((jobs.result ?? []).length < pageSize) break;
        }

        let fallbackJob: Jobs.JobListDTO | undefined;
        for (const candidate of candidates) {
            if (!candidate.uuid) continue;
            if (!archivePath) return this.listJobFiles(candidate.uuid);

            try {
                const response = await errorDecoder<Jobs.RespGetJob>(() =>
                    this.jobsClient.getJob({ jobUuid: candidate.uuid })
                );
                const resolvedArchivePath = response.result?.archiveSystemDir;
                if (!resolvedArchivePath) {
                    fallbackJob = fallbackJob || candidate;
                    continue;
                }
                if (resolvedArchivePath.replace(/\\/g, "/").endsWith(archivePath)) {
                    return this.listJobFiles(candidate.uuid);
                }
            } catch {
                // A stale job entry should not prevent trying the next retry.
            }
        }
        return fallbackJob?.uuid ? this.listJobFiles(fallbackJob.uuid) : null;
    }

    async resolveCompositeWorkflowOutput(
        executionId: string,
        archivePath: string,
        outputName: string
    ): Promise<string | null> {
        const files = await this.listCompositeWorkflowFiles(executionId, archivePath);
        const available = files || [];
        const exact = available.filter(
            (file) => file.name?.toLowerCase() === outputName.toLowerCase()
        );
        if (exact.length === 1) return exact[0].url || null;

        // MINT output keys are semantic labels (for example `cbb`), while
        // MODFLOW applications commonly archive the corresponding file as
        // `*.cbc`. Preserve the declared output key but resolve the provider's
        // actual archived filename when it is unambiguous.
        const suffixes =
            outputName.toLowerCase() === "cbb" || outputName.toLowerCase() === "cbc"
                ? [".cbc", ".cbb"]
                : [`.${outputName.toLowerCase()}`];
        const matches = available.filter((file) =>
            suffixes.some((suffix) => file.name?.toLowerCase().endsWith(suffix))
        );
        const match = matches.length === 1 ? matches[0] : undefined;
        return match?.url || null;
    }

    private static isDirectory(entry: Jobs.FileInfo): boolean {
        return entry.type === Jobs.FileInfoTypeEnum.Dir;
    }

    private static isControlFile(entry: Jobs.FileInfo): boolean {
        return (entry.name ?? "").startsWith(TapisExecutionService.CONTROL_FILE_PREFIX);
    }

    private async collectJobFiles(
        jobUuid: string,
        outputPath: string,
        depth: number
    ): Promise<Jobs.FileInfo[]> {
        let entries: Jobs.FileInfo[];
        try {
            const { result } = await this.getJobOutputList(jobUuid, outputPath);
            entries = result ?? [];
        } catch (error) {
            console.log(
                `Tapis listed no file in "${outputPath || "/"}" of job ${jobUuid}: ${error.message}`
            );
            return [];
        }

        const files = entries.filter((entry) => !TapisExecutionService.isDirectory(entry));
        if (depth >= TapisExecutionService.MAX_OUTPUT_DEPTH) {
            return files;
        }

        const directories = entries.filter((entry) => TapisExecutionService.isDirectory(entry));
        for (const directory of directories) {
            const childPath = `${outputPath}${directory.name}/`;
            files.push(...(await this.collectJobFiles(jobUuid, childPath, depth + 1)));
        }
        return files;
    }

    private async getExecutionResultsFromJob(
        jobUuid: string,
        execution: Execution,
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        _isPublic: boolean
    ): Promise<Execution_Result[]> {
        const files = await this.listJobFiles(jobUuid);

        console.log("The TAPIS files available to match to mint outputs", files);
        const mintOutputs = await getModelOutputsByModelId(execution.modelid);
        console.log("The MINT outputs available to match to TAPIS files", mintOutputs);
        // A model configuration that declares no output is incomplete, not missing.
        // The execution succeeded. Answer 422 with a code, so the client can offer
        // the promote action instead of a raw error.
        if (mintOutputs.length === 0) {
            throw new NoOutputsDeclaredError();
        }
        if (files.length === 0) {
            throw new NotFoundError("No files found for model " + execution.modelid);
        }
        return matchTapisOutputsToMintOutputs(files, mintOutputs);
    }

    private async updateExecutionResultsFromJob(execution: Execution): Promise<Execution_Result[]> {
        await updateExecutionStatusAndResultsv2(execution);
        return execution.results;
    }

    getJobOutputList = async (
        jobUuid: string,
        outputPath: string
    ): Promise<Jobs.RespGetJobOutputList> => {
        return await errorDecoder<Jobs.RespGetJobOutputList>(() =>
            this.jobsClient.getJobOutputList({ jobUuid: jobUuid, outputPath: outputPath })
        );
    };

    getJobOutputDownloadFile = async (jobUuid: string, outputPath: string): Promise<Blob> => {
        return await errorDecoder<Blob>(() =>
            this.jobsClient.getJobOutputDownload({ jobUuid: jobUuid, outputPath: outputPath })
        );
    };

    private generateValidJobName(app: Apps.TapisApp, executionId: string): string {
        const MAX_LENGTH = 64;
        const SEPARATOR = "-";

        // Start with the essential parts
        const name = `${app.id}${SEPARATOR}${app.version}${SEPARATOR}${executionId}`;

        // If we're under the limit, return as is
        if (name.length <= MAX_LENGTH) {
            return name;
        }

        // Calculate how much we need to trim
        const excess = name.length - MAX_LENGTH;

        // If executionId is long enough, trim it
        if (executionId.length > excess) {
            const trimmedExecutionId = executionId.slice(0, executionId.length - excess);
            return `${app.id}${SEPARATOR}${app.version}${SEPARATOR}${trimmedExecutionId}`;
        }

        // If we still need to trim, start trimming from the app.id
        const remainingExcess = excess - executionId.length;
        const trimmedAppId = app.id.slice(0, app.id.length - remainingExcess);
        return `${trimmedAppId}${SEPARATOR}${app.version}${SEPARATOR}${executionId}`;
    }
}
