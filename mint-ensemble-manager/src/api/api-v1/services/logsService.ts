import { getExecution } from "@/classes/graphql/graphql_functions";
import { Execution } from "@/classes/mint/mint-types";
import { fetchWingsRunLog } from "@/classes/wings/wings-functions";
import { fetchLocalRunLog } from "@/classes/localex/local-execution-functions";
import { fetchMintConfig } from "@/classes/mint/mint-functions";
import { getTokenFromAuthorizationHeader } from "@/utils/authUtils";
import { TapisExecutionService } from "@/classes/tapis/adapters/TapisExecutionService";
import { NotFoundError, UnauthorizedError } from "@/classes/common/errors";
import { createHasuraUnifiedExecutionStore } from "./unifiedExecutionStore";

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
        const prefs = await fetchMintConfig();
        const execution: Execution = await getExecution(execution_id);
        if (!execution) {
            throw new NotFoundError("Execution not found");
        }
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

interface WorkflowTaskLogPreferences {
    svo_adapter_api?: string;
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
            (child.execution_kind === "composite_workflow" || child.execution_kind === "workflow") &&
            typeof child.run_id === "string"
    );
    if (!workflow || typeof workflow.run_id !== "string") {
        return "This execution has no associated workflow run or task log.";
    }

    const baseUrl = (prefs.svo_adapter_api || process.env.SVO_ADAPTER_API || "").replace(/\/$/, "");
    if (!baseUrl) {
        return "The workflow task log service is not configured.";
    }
    const response = await fetch(
        `${baseUrl}/runs/${encodeURIComponent(workflow.run_id)}/poll`,
        {
            method: "POST",
            headers: {
                Authorization: `Bearer ${accessToken}`,
                "Content-Type": "application/json"
            }
        }
    );
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw new Error(
            body?.detail || body?.message || `Workflow task log request failed with HTTP ${response.status}`
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
    return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-` +
        `${value.slice(16, 20)}-${value.slice(20)}`;
}

export default logsService;
