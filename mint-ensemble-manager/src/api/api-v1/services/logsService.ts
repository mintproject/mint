import { getExecution } from "@/classes/graphql/graphql_functions";
import { Execution } from "@/classes/mint/mint-types";
import { fetchWingsRunLog } from "@/classes/wings/wings-functions";
import { fetchLocalRunLog } from "@/classes/localex/local-execution-functions";
import { fetchMintConfig } from "@/classes/mint/mint-functions";
import { getTokenFromAuthorizationHeader } from "@/utils/authUtils";
import { TapisExecutionService } from "@/classes/tapis/adapters/TapisExecutionService";
import { NotFoundError, UnauthorizedError, UnifiedExecutionError } from "@/classes/common/errors";
import { getExecutionThreadIds } from "@/classes/graphql/graphql_functions_v2";
import { assertThreadReadable } from "./unifiedExecutionService";
import { createHasuraUnifiedExecutionStore } from "./unifiedExecutionStore";
import { internalSecretFrom } from "./adapterConfig";

// ./api-v1/services/logsService.js
export interface LogsService {
    getAccessToken(authorizationHeader: string): string;
    fetchLog(execution_id: string, authorizationHeader: string): Promise<string>;
}

const logsService: LogsService = {
    getAccessToken(authorizationHeader: string): string {
        const access_token = getTokenFromAuthorizationHeader(authorizationHeader);
        if (!access_token) {
            throw new Error("Invalid authorization header");
        }
        return access_token;
    },
    async fetchLog(execution_id: string, authorizationHeader: string) {
        // Whatever the engine, the caller must hold a token and be able to read a thread
        // the execution belongs to: executions themselves are readable by id.
        if (!getTokenFromAuthorizationHeader(authorizationHeader)) {
            throw new UnauthorizedError("Invalid authorization header");
        }
        const prefs = await fetchMintConfig();
        const execution: Execution = await getExecution(execution_id);
        if (!execution) {
            throw new NotFoundError("Execution not found");
        }
        await assertExecutionReadable(execution_id, authorizationHeader);
        if (prefs.execution_engine === "wings") {
            return await fetchWingsRunLog(execution.runid, prefs);
        } else if (prefs.execution_engine === "localex") {
            return fetchLocalRunLog(execution_id, prefs);
        } else if (prefs.execution_engine === "tapis") {
            const access_token = getTokenFromAuthorizationHeader(authorizationHeader);
            if (!access_token) {
                throw new UnauthorizedError("Invalid authorization header");
            }
            // No Tapis job id: a composite run, or a flow, whose execution carries
            // its run's id ("ue_...") in that place.
            if (!execution.runid || execution.runid.startsWith("ue_")) {
                return await fetchWorkflowTaskLog(execution_id, access_token, prefs);
            }
            const tapisExecutionService = new TapisExecutionService(
                access_token,
                prefs.tapis.basePath
            );
            return await tapisExecutionService.getLog(execution.runid);
        }
        throw new Error(`Unsupported execution engine: ${prefs.execution_engine || "unknown"}`);
    }
};

/**
 * The caller may read an execution's logs only when they can read one of its threads
 * (the thread's row-level permissions decide, so a collaborator on a shared thread may).
 * An execution no thread owns, or a thread that is not theirs, is a 404, the same as a
 * missing execution.
 */
async function assertExecutionReadable(
    executionId: string,
    authorizationHeader: string
): Promise<void> {
    const threadIds = await getExecutionThreadIds(executionId);
    for (const threadId of threadIds) {
        try {
            await assertThreadReadable(threadId, authorizationHeader);
            return;
        } catch (error) {
            if (!(error instanceof UnifiedExecutionError) || error.statusCode !== 404) {
                throw error;
            }
        }
    }
    throw new NotFoundError("Execution not found");
}

interface WorkflowTaskLogPreferences {
    svo_adapter_api?: string;
    svo_adapter_internal_secret?: string;
}

async function fetchWorkflowTaskLog(
    executionId: string,
    accessToken: string,
    prefs: WorkflowTaskLogPreferences
): Promise<string> {
    const store = createHasuraUnifiedExecutionStore();
    const unified =
        (await store.getByModelChildId?.(executionId)) ||
        (await store.getByModelChildId?.(uuidWithDashes(executionId)));
    const children = (unified?.adapter_run_ids || []) as Array<Record<string, unknown>>;
    const workflow = children.find(
        (child) =>
            (child.execution_kind === "composite_workflow" ||
                child.execution_kind === "workflow") &&
            typeof child.run_id === "string"
    );
    if (!workflow || typeof workflow.run_id !== "string") {
        return "This execution has no associated workflow run or task log.";
    }

    const baseUrl = (prefs.svo_adapter_api || process.env.SVO_ADAPTER_API || "").replace(/\/$/, "");
    if (!baseUrl) {
        return "The workflow task log service is not configured.";
    }
    // The adapter's front door: the shared service secret says the call came through
    // the Ensemble Manager; the user's own token names who is asking. It is sent as
    // X-Front-Door-Secret, not X-Ensemble-Manager-Secret: this route takes an execution
    // id from the caller and the Ensemble Manager does not check the caller may read
    // that execution, so the adapter's owner check (the run's submitter) must decide.
    // The Ensemble Manager's own header would let any signed-in user read any run's log.
    const internalSecret = internalSecretFrom(prefs);
    const response = await fetch(`${baseUrl}/runs/${encodeURIComponent(workflow.run_id)}/poll`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
            ...(internalSecret ? { "X-Front-Door-Secret": internalSecret } : {})
        }
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw new Error(
            body?.detail ||
                body?.message ||
                `Workflow task log request failed with HTTP ${response.status}`
        );
    }

    const sections = (Array.isArray(body?.tasks) ? body.tasks : []).map(
        (task: Record<string, unknown>) => {
            const lines = [
                `Task ${task.task_id || "unknown"} (${task.status || "unknown"})`,
                task.last_message ? `message:\n${task.last_message}` : "",
                task.stdout ? `stdout:\n${task.stdout}` : "",
                task.stderr ? `stderr:\n${task.stderr}` : ""
            ].filter(Boolean);
            return lines.join("\n");
        }
    );
    if (sections.length) return sections.join("\n\n");
    if (body?.logs) return String(body.logs);
    if (body?.run_error || body?.tasks_error) {
        return [body.run_error, body.tasks_error].filter(Boolean).join("\n");
    }
    return "The workflow completed without task log output.";
}

function uuidWithDashes(value: string): string {
    if (!/^[0-9a-f]{32}$/i.test(value)) return value;
    return (
        `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-` +
        `${value.slice(16, 20)}-${value.slice(20)}`
    );
}

export default logsService;
