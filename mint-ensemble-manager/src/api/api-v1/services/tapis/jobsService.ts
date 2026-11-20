import { Execution } from "@/classes/mint/mint-types";
import { TapisExecutionService } from "@/classes/tapis/adapters/TapisExecutionService";
import { getTokenFromAuthorizationHeader } from "@/utils/authUtils";
import { getConfiguration } from "@/classes/mint/mint-functions";
import { ExecutionJob } from "@/interfaces/IExecutionService";
import { Jobs } from "@tapis/tapis-typescript/dist";
/** The part of a Tapis job webhook the service reads. */
export interface TapisWebhookEvent {
    event: { type: string };
}

export interface JobsService {
    webhookJobStatusChange(
        webHookEvent: TapisWebhookEvent,
        executionId: string,
        thread_id: string
    ): Promise<Execution | undefined>;
    get(jobId: string, authorizationHeader: string): Promise<ExecutionJob>;
    submitJob(job: Jobs.ReqSubmitJob, authorizationHeader: string): Promise<string>;
    getLogs(jobId: string, authorizationHeader: string): Promise<string>;
}

const jobsService = {
    getAccessToken(authorizationHeader: string): string {
        const access_token = getTokenFromAuthorizationHeader(authorizationHeader);
        if (!access_token) {
            throw new Error("Invalid authorization header");
        }
        return access_token;
    },

    async webhookJobStatusChange(
        webHookEvent: TapisWebhookEvent,
        executionId: string,
        thread_id: string
    ): Promise<Execution | undefined> {
        return await TapisExecutionService.updateExecution(
            thread_id,
            executionId,
            webHookEvent.event.type
        );
    },

    async get(jobId: string, authorizationHeader: string): Promise<ExecutionJob> {
        const access_token = this.getAccessToken(authorizationHeader);
        const prefs = getConfiguration();
        const executionService = new TapisExecutionService(access_token, prefs.tapis.basePath);
        return await executionService.getJobStatus(jobId);
    },

    async submitJob(job: Jobs.ReqSubmitJob, authorizationHeader: string): Promise<string> {
        const access_token = this.getAccessToken(authorizationHeader);
        const prefs = getConfiguration();

        const executionService = new TapisExecutionService(access_token, prefs.tapis.basePath);
        return await executionService.submitJob(job);
    },

    async getLogs(jobId: string, authorizationHeader: string): Promise<string> {
        const access_token = this.getAccessToken(authorizationHeader);
        const prefs = getConfiguration();
        const executionService = new TapisExecutionService(access_token, prefs.tapis.basePath);
        return await executionService.getLog(jobId);
    }
};

export default jobsService;
