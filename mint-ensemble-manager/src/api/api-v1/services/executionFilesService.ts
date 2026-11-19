import { getExecution } from "@/classes/graphql/graphql_functions";
import { getConfiguration } from "@/classes/mint/mint-functions";
import { TapisExecutionService } from "@/classes/tapis/adapters/TapisExecutionService";
import { BadRequestError, NotFoundError } from "@/classes/common/errors";
import { getTokenFromAuthorizationHeader } from "@/utils/authUtils";

/**
 * One file that an execution archived.
 *
 * MINT does not store this file. `execution_result` has the primary key
 * `(execution_id, model_io_id, resource_id)`, so it holds a typed result only.
 * A raw artifact stays in the Tapis archive, and this service lists it live.
 */
export interface ExecutionFile {
    /** The file name, without the folder. */
    name: string;
    /** The path on the archive system. It tells two files of the same name apart. */
    path: string;
    /** The size in bytes. */
    size: number;
    /** The `tapis://` URI. CKAN reads this URI as it is. */
    url: string;
}

export interface ExecutionFilesService {
    listFiles(executionId: string, authorizationHeader: string): Promise<ExecutionFile[]>;
}

const toExecutionFile = (file: { name?: string; path?: string; size?: number; url?: string }) => ({
    name: file.name ?? "",
    path: file.path ?? "",
    size: file.size ?? 0,
    url: file.url ?? ""
});

const archiveDirectoryFromUri = (uri: unknown): { systemId: string; path: string } | null => {
    if (typeof uri !== "string" || !uri.startsWith("tapis://")) {
        return null;
    }

    try {
        const parsed = new URL(uri);
        const segments = parsed.pathname.split("/").filter(Boolean);
        if (!parsed.hostname || segments.length < 2) {
            return null;
        }
        return {
            systemId: parsed.hostname,
            path: segments.slice(0, -1).join("/")
        };
    } catch {
        return null;
    }
};

const executionArchiveDirectories = (execution: any) => {
    const urls = new Set<string>();
    const addUrl = (value: unknown) => {
        if (typeof value === "string") urls.add(value);
    };

    Object.values(execution.results ?? {}).forEach((result: any) => {
        addUrl(result?.resource?.url);
        addUrl(result?.url);
    });

    return Array.from(urls)
        .map(archiveDirectoryFromUri)
        .filter((directory): directory is { systemId: string; path: string } => directory !== null);
};

const executionFilesService: ExecutionFilesService = {
    /**
     * List the files that an execution archived.
     *
     * The service forwards the token of the user. The archive lives in the
     * `$WORK` directory of that user on `ls6`, and Tapis refuses a token of
     * another user.
     *
     * Composite workflow executions have no legacy `runid`; their output is
     * listed from the archive directory encoded in the persisted `tapis://`
     * result URI. An execution that has neither source answers an empty list.
     */
    async listFiles(executionId: string, authorizationHeader: string): Promise<ExecutionFile[]> {
        const access_token = getTokenFromAuthorizationHeader(authorizationHeader);
        const execution = await getExecution(executionId);
        if (!execution) {
            throw new NotFoundError("Execution not found");
        }

        const prefs = getConfiguration();
        if (prefs.execution_engine !== "tapis") {
            throw new BadRequestError(
                "Only a Tapis execution archives files. This instance runs " +
                    prefs.execution_engine
            );
        }
        const tapisExecutionService = new TapisExecutionService(access_token, prefs.tapis.basePath);
        // A flow's execution carries its run's id ("ue_..."), not a Tapis job id:
        // it has no job, and its files are found from its results like a
        // composite run's.
        if (execution.runid && !execution.runid.startsWith("ue_")) {
            const files = await tapisExecutionService.listJobFiles(execution.runid);
            return files.map(toExecutionFile);
        }

        const archiveDirectories = executionArchiveDirectories(execution);
        const compositeFiles = await tapisExecutionService.listCompositeWorkflowFiles(
            executionId,
            archiveDirectories[0]?.path
        );
        if (compositeFiles) {
            return compositeFiles.map(toExecutionFile);
        }

        if (archiveDirectories.length === 0) {
            return [];
        }

        const files = [];
        for (const directory of archiveDirectories) {
            files.push(
                ...(await tapisExecutionService.listArchiveFiles(
                    directory.systemId,
                    directory.path
                ))
            );
        }
        return files.map(toExecutionFile);
    }
};

export default executionFilesService;
