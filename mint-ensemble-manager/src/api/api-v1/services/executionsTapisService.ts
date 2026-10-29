import { ModelThread } from "@/classes/api";
import { TapisExecutionService } from "@/classes/tapis/adapters/TapisExecutionService";
import { ExecutionCreation } from "@/classes/common/ExecutionCreation";
import { getConfiguration } from "@/classes/mint/mint-functions";
import { getTokenFromAuthorizationHeader } from "@/utils/authUtils";
import { NotFoundError } from "@/classes/common/errors";
import { threadFromGQL } from "@/classes/graphql/graphql_adapter";
import { getThread } from "@/classes/graphql/graphql_functions_v2";
import {
    getExecution as getExecutionById,
    updateExecutionStatusResultsAndSummary
} from "@/classes/graphql/graphql_functions";
import { SubmissionResult } from "@/interfaces/IExecutionService";
import { applyExecutionInputOverrides } from "@/classes/common/execution-input-overrides";

type AdapterAwareModelThread = ModelThread & {
    adapter_resource_overrides?: Parameters<typeof applyExecutionInputOverrides>[2];
    max_minutes?: number;
    queue?: string;
    output_name?: string;
};

export interface ExecutionsTapisService {
    submitExecution(threadmodel: AdapterAwareModelThread, token: string): Promise<SubmissionResult>;
    buildCompositeWorkflowModelTask(
        threadmodel: AdapterAwareModelThread,
        workflowPath: string,
        authorization: string
    ): Promise<{
        execution_id: string;
        output_uri: string;
        output_name: string;
        output_format?: string;
        job_definition: unknown;
    }>;
    resolveCompositeWorkflowOutput(
        executionId: string,
        archivePath: string,
        outputName: string,
        authorization: string
    ): Promise<string | null>;
    updateCompositeWorkflowExecution(
        threadId: string,
        modelId: string,
        executionId: string,
        status: "completed" | "failed",
        output?: {
            model_io_id: string;
            resource_id: string;
            name: string;
            url: string;
        }
    ): Promise<void>;
    getExecution(executionId: string, token: string): Promise<any>;
    getJobStatus(jobId: string, token: string): Promise<any>;
}

const compositeFinalizationInFlight = new Map<string, Promise<void>>();

const executionsTapisService = {
    async updateCompositeWorkflowExecution(
        threadId: string,
        modelId: string,
        executionId: string,
        status: "completed" | "failed",
        output?: {
            model_io_id: string;
            resource_id: string;
            name: string;
            url: string;
        }
    ): Promise<void> {
        const inFlight = compositeFinalizationInFlight.get(executionId);
        if (inFlight) {
            await inFlight;
            return;
        }

        const finalization = (async () => {
            const execution = await getExecutionById(executionId);
            if (!execution) {
                throw new NotFoundError("Composite workflow execution not found");
            }

            const nextStatus = status === "completed" ? "SUCCESS" : "FAILURE";
            // Reconciliation can be triggered by both polling and history reads.
            // Never rewrite a terminal execution or increment its summary twice.
            if (execution.status === "SUCCESS" || execution.status === "FAILURE") return;

            execution.status = nextStatus;
            execution.run_progress = status === "completed" ? 1 : 0;
            execution.end_time = new Date();
            const threadResponse = await getThread(threadId);
            const threadModelId = threadResponse.thread_models.find(
                (threadModel) => threadModel.modelcatalog_configuration_id === modelId
            )?.id;
            if (!threadModelId) {
                throw new NotFoundError("Thread model not found");
            }
            await updateExecutionStatusResultsAndSummary(execution, threadModelId, output);
        })();
        compositeFinalizationInFlight.set(executionId, finalization);
        try {
            await finalization;
        } finally {
            if (compositeFinalizationInFlight.get(executionId) === finalization) {
                compositeFinalizationInFlight.delete(executionId);
            }
        }
    },
    async getExecution(executionId: string, _authorization: string): Promise<any> {
        const execution = await getExecutionById(executionId);
        if (!execution) throw new NotFoundError("Execution not found");
        return execution;
    },
    async getJobStatus(jobId: string, authorization: string): Promise<any> {
        const token = getTokenFromAuthorizationHeader(authorization);
        if (!token) throw new Error("Unauthorized");
        const prefs = getConfiguration();
        const tapisExecution = new TapisExecutionService(token, prefs.tapis.basePath);
        return tapisExecution.getJobStatus(jobId);
    },
    async resolveCompositeWorkflowOutput(
        executionId: string,
        archivePath: string,
        outputName: string,
        authorization: string
    ): Promise<string | null> {
        const token = getTokenFromAuthorizationHeader(authorization);
        if (!token) throw new Error("Unauthorized");
        const prefs = getConfiguration();
        const tapisExecution = new TapisExecutionService(token, prefs.tapis.basePath);
        return tapisExecution.resolveCompositeWorkflowOutput(executionId, archivePath, outputName);
    },
    async submitExecution(
        threadmodel: AdapterAwareModelThread,
        authorization: string
    ): Promise<SubmissionResult> {
        const token = getTokenFromAuthorizationHeader(authorization);
        if (!token) {
            throw new Error("Unauthorized");
        }
        const prefs = getConfiguration();
        const TapisExecution = new TapisExecutionService(token, prefs.tapis.basePath);
        const threadResponse = await getThread(threadmodel.thread_id);
        const thread = threadFromGQL(threadResponse);
        if (thread) {
            applyExecutionInputOverrides(
                thread,
                threadmodel.model_id,
                threadmodel.adapter_resource_overrides || []
            );
            const executionCreation = new ExecutionCreation(
                thread,
                threadmodel.model_id,
                TapisExecution,
                token
            );
            await executionCreation.prepareExecutions();
            // Find the thread model id for the given model id
            const threadModelId = threadResponse.thread_models.find(
                (thread_model) => thread_model.modelcatalog_configuration_id === threadmodel.model_id
            )?.id;
            if (!threadModelId) {
                throw new NotFoundError("Thread model not found");
            }
            if (executionCreation.executionToBeRun.length > 0) {
                console.log("Execution to be run", executionCreation.executionToBeRun.length);
                const submissionResult = await TapisExecution.submitExecutions(
                    executionCreation.executionToBeRun,
                    executionCreation.model,
                    executionCreation.threadRegion,
                    executionCreation.component,
                    thread.id,
                    threadModelId,
                    threadmodel.max_minutes,
                    threadmodel.queue
                );
                if (submissionResult.failedExecutions.length > 0) {
                    console.warn(
                        "Some executions failed to submit:",
                        submissionResult.failedExecutions
                    );
                }

                return submissionResult;
            } else {
                console.log("No executions to run");
                return {
                    submittedExecutions: [],
                    failedExecutions: []
                };
            }
        } else {
            throw new NotFoundError("Thread not found");
        }
    },
    async buildCompositeWorkflowModelTask(
        threadmodel: AdapterAwareModelThread,
        workflowPath: string,
        authorization: string
    ) {
        const token = getTokenFromAuthorizationHeader(authorization);
        if (!token) {
            throw new Error("Unauthorized");
        }
        const prefs = getConfiguration();
        const tapisExecution = new TapisExecutionService(token, prefs.tapis.basePath);
        return tapisExecution.buildCompositeWorkflowModelTask(
            threadmodel,
            workflowPath,
            threadmodel.max_minutes,
            threadmodel.queue
        );
    }
};

export default executionsTapisService;
