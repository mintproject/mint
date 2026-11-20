import { getExecution } from "@/classes/graphql/graphql_functions";
import { getConfiguration } from "@/classes/mint/mint-functions";
import { TapisExecutionService } from "@/classes/tapis/adapters/TapisExecutionService";
import { BadRequestError, HttpError, NotFoundError } from "@/classes/common/errors";
import type { Readable } from "stream";
import { createHasuraUnifiedExecutionStore } from "./unifiedExecutionStore";
import type { FlowPause } from "./flowExecution";
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

/** One result of an execution that points at Tapis storage. */
export interface ExecutionResultLocation {
    /** The name of the result, as the execution holds it. */
    name: string;
    /** The `tapis://` URI of the result. */
    url: string;
    /** Whether Tapis says the URI is a file or a folder. */
    kind: "file" | "folder";
}

export interface ExecutionFileListing {
    files: ExecutionFile[];
    results: ExecutionResultLocation[];
}

export interface ExecutionFileContent {
    stream: Readable;
    contentType: string | null;
    /** A base name that is safe in a `Content-Disposition` header. */
    filename: string;
}

export interface ExecutionFilesService {
    listFiles(executionId: string, authorizationHeader: string): Promise<ExecutionFile[]>;
    list(executionId: string, authorizationHeader: string): Promise<ExecutionFileListing>;
    openFile(
        executionId: string,
        authorizationHeader: string,
        path: string,
        systemId?: string
    ): Promise<ExecutionFileContent>;
}

const FILE_PATH_INVALID = "FILE_PATH_INVALID";
const FILE_NOT_IN_RESULTS = "FILE_NOT_IN_RESULTS";
const MAX_PATH_LENGTH = 4096;
const SYSTEM_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

const toExecutionFile = (file: { name?: string; path?: string; size?: number; url?: string }) => ({
    name: file.name ?? "",
    path: file.path ?? "",
    size: file.size ?? 0,
    url: file.url ?? ""
});

interface TapisLocation {
    systemId: string;
    /** The path with no leading or trailing slash. */
    path: string;
}

const parentOf = (path: string) => path.split("/").slice(0, -1).join("/");

const locationFromUri = (uri: unknown): TapisLocation | null => {
    if (typeof uri !== "string" || !uri.startsWith("tapis://")) {
        return null;
    }

    try {
        const parsed = new URL(uri);
        const segments = parsed.pathname.split("/").filter(Boolean).map(decodeURIComponent);
        if (!parsed.hostname || segments.length < 1) {
            return null;
        }
        return { systemId: parsed.hostname, path: segments.join("/") };
    } catch {
        return null;
    }
};

interface ExecutionResultUrl {
    name: string;
    url: string;
    location: TapisLocation;
}

/** One result of an execution: its resource, or a bare URL. */
interface ExecutionResultEntry {
    resource?: { url?: string; name?: string };
    url?: string;
}

/** What of an execution the file service reads. `results` is a list or keyed by output. */
interface ExecutionView {
    runid?: string;
    results?: ExecutionResultEntry[] | Record<string, ExecutionResultEntry>;
}

const executionResultUrls = (execution: ExecutionView): ExecutionResultUrl[] => {
    const found = new Map<string, ExecutionResultUrl>();
    Object.entries(execution.results ?? {}).forEach(([key, result]) => {
        for (const url of [result?.resource?.url, result?.url]) {
            const location = locationFromUri(url);
            if (location && !found.has(url)) {
                found.set(url, { name: result?.resource?.name || key, url, location });
            }
        }
    });
    return Array.from(found.values());
};

/**
 * Normalise a path the caller asks for. It refuses a path that could leave the
 * results: a `..` or `.` segment, an empty segment, a leading `//`, a backslash
 * and a control character.
 */
const normaliseRequestedPath = (raw: unknown): string => {
    const invalid = (message: string) => new HttpError(400, message, FILE_PATH_INVALID);
    if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_PATH_LENGTH) {
        throw invalid("The file path is missing or too long.");
    }
    if (CONTROL_CHARACTERS.test(raw) || raw.includes("\\") || raw.startsWith("//")) {
        throw invalid("The file path holds a character that is not allowed.");
    }
    const segments = (raw.startsWith("/") ? raw.slice(1) : raw).split("/");
    if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
        throw invalid("The file path holds an empty, '.' or '..' segment.");
    }
    return segments.join("/");
};

const safeFilename = (path: string) => {
    const base = path.split("/").pop() ?? "download";
    const cleaned = base.replace(/[^\x20-\x7e]|["\\;]/g, "_").trim();
    return cleaned && cleaned !== "." && cleaned !== ".." ? cleaned : "download";
};

/**
 * The one file a flow run stopped for an edit asks its user to download: the place
 * the run's own record names, while the run is waiting. It is not a result (nothing
 * is filed until the run ends), so the results rule below would refuse it. Only that
 * exact file, only while the run waits; Tapis still decides, with the user's token,
 * whether they may read it.
 */
const pausedFile = async (execution: ExecutionView): Promise<TapisLocation | null> => {
    const runId = execution?.runid;
    if (typeof runId !== "string" || !runId.startsWith("ue_")) {
        return null;
    }
    const record = await createHasuraUnifiedExecutionStore()
        .getById(runId.slice(3))
        .catch(() => null);
    if (!record || record.status !== "awaiting_edit") {
        return null;
    }
    const child = ((record.adapter_run_ids || []) as Array<{ pause?: FlowPause | null }>)[0];
    return locationFromUri(child?.pause?.file_location);
};

const executionFilesService: ExecutionFilesService = {
    /**
     * List the files that an execution archived.
     *
     * The service forwards the token of the user. The archive lives in the
     * `$WORK` directory of that user on `ls6`, and Tapis refuses a token of
     * another user.
     */
    async listFiles(executionId: string, authorizationHeader: string): Promise<ExecutionFile[]> {
        return (await this.list(executionId, authorizationHeader)).files;
    },

    /**
     * List the files that an execution archived, and say which results of the
     * execution are files and which are folders.
     *
     * Composite workflow executions have no legacy `runid`; their output is
     * listed from the Tapis location in the persisted `tapis://` result URI.
     * A result that is a folder lists that folder. A result that is a file lists
     * the folder it sits in. Tapis decides which, with the token of the user.
     * An execution that has neither source answers an empty list.
     */
    async list(executionId: string, authorizationHeader: string): Promise<ExecutionFileListing> {
        const { execution, tapis } = await loadExecution(executionId, authorizationHeader);
        const results = await resultKinds(execution, tapis);
        const resultOf = (): ExecutionResultLocation[] =>
            results.map(({ name, url, kind }) => ({ name, url, kind }));

        // A flow's execution carries its run's id ("ue_..."), not a Tapis job id:
        // it has no job, and its files are found from its results like a
        // composite run's.
        if (execution.runid && !execution.runid.startsWith("ue_")) {
            const files = await tapis.listJobFiles(execution.runid);
            return { files: files.map(toExecutionFile), results: resultOf() };
        }

        const directories: TapisLocation[] = [];
        for (const result of results) {
            const directory =
                result.kind === "folder"
                    ? result.location
                    : { systemId: result.location.systemId, path: parentOf(result.location.path) };
            if (
                directory.path &&
                !directories.some(
                    (known) =>
                        known.systemId === directory.systemId && known.path === directory.path
                )
            ) {
                directories.push(directory);
            }
        }

        const compositeFiles = await tapis.listCompositeWorkflowFiles(
            executionId,
            directories[0]?.path
        );
        if (compositeFiles) {
            return { files: compositeFiles.map(toExecutionFile), results: resultOf() };
        }

        const files = [];
        for (const directory of directories) {
            files.push(...(await tapis.listArchiveFiles(directory.systemId, directory.path)));
        }
        return { files: files.map(toExecutionFile), results: resultOf() };
    },

    /**
     * Open one file of an execution's results as a stream, with the token of the
     * user. The file must be a result file, lie inside a result folder, or sit in
     * the folder that the listing shows for a file result. The system must be one
     * of the systems in the result URIs.
     */
    async openFile(
        executionId: string,
        authorizationHeader: string,
        rawPath: string,
        rawSystemId?: string
    ): Promise<ExecutionFileContent> {
        const path = normaliseRequestedPath(rawPath);
        const { execution, tapis } = await loadExecution(executionId, authorizationHeader);
        const waiting = await pausedFile(execution);
        if (
            waiting &&
            waiting.path === path &&
            rawSystemId !== undefined &&
            waiting.systemId === rawSystemId
        ) {
            const { stream, contentType } = await tapis.openArchiveFile(waiting.systemId, path);
            return { stream, contentType, filename: safeFilename(path) };
        }
        const urls = executionResultUrls(execution);

        const systems = Array.from(new Set(urls.map((entry) => entry.location.systemId)));
        let systemId = rawSystemId;
        if (systemId === undefined || systemId === "") {
            if (systems.length !== 1) {
                throw new HttpError(400, "The system of the file is required.", FILE_PATH_INVALID);
            }
            systemId = systems[0];
        } else if (!SYSTEM_ID.test(systemId)) {
            throw new HttpError(400, "The system of the file is not valid.", FILE_PATH_INVALID);
        }
        const notInResults = () =>
            new HttpError(404, "That file is not one of this run's results.", FILE_NOT_IN_RESULTS);
        const candidates = urls.filter((entry) => entry.location.systemId === systemId);
        if (candidates.length === 0) {
            throw notInResults();
        }

        let allowed = candidates.some(
            ({ location }) => path === location.path || path.startsWith(`${location.path}/`)
        );
        if (!allowed) {
            // A sibling of a result counts only when that result is a file.
            for (const { location } of candidates) {
                if (parentOf(location.path) !== "" && parentOf(location.path) === parentOf(path)) {
                    if ((await resultKind(tapis, location)) === "file") {
                        allowed = true;
                        break;
                    }
                }
            }
        }
        if (!allowed) {
            throw notInResults();
        }

        const { stream, contentType } = await tapis.openArchiveFile(systemId, path);
        return { stream, contentType, filename: safeFilename(path) };
    }
};

const loadExecution = async (executionId: string, authorizationHeader: string) => {
    const access_token = getTokenFromAuthorizationHeader(authorizationHeader);
    const execution = await getExecution(executionId);
    if (!execution) {
        throw new NotFoundError("Execution not found");
    }

    const prefs = getConfiguration();
    if (prefs.execution_engine !== "tapis") {
        throw new BadRequestError(
            "Only a Tapis execution archives files. This instance runs " + prefs.execution_engine
        );
    }
    const tapis = new TapisExecutionService(access_token, prefs.tapis.basePath);
    return { execution, tapis };
};

/**
 * Ask Tapis whether a result location is a folder. When Tapis cannot say (the
 * path has no stat, or the user cannot read it), the location counts as a file,
 * which is what the listing assumed before it asked.
 */
const resultKind = async (
    tapis: TapisExecutionService,
    location: TapisLocation
): Promise<"file" | "folder"> => {
    try {
        return (await tapis.isArchiveDirectory(location.systemId, location.path))
            ? "folder"
            : "file";
    } catch {
        return "file";
    }
};

const resultKinds = async (execution: ExecutionView, tapis: TapisExecutionService) =>
    Promise.all(
        executionResultUrls(execution).map(async (entry) => ({
            ...entry,
            kind: await resultKind(tapis, entry.location)
        }))
    );

export default executionFilesService;
