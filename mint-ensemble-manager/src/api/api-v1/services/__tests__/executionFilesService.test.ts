import { HttpError } from "@/classes/common/errors";
import executionFilesService from "@/api/api-v1/services/executionFilesService";
import { getExecution } from "@/classes/graphql/graphql_functions";
import { getConfiguration } from "@/classes/mint/mint-functions";
import { TapisExecutionService } from "@/classes/tapis/adapters/TapisExecutionService";

jest.mock("@/classes/graphql/graphql_functions");
// The Keycloak adapter reads the configuration when it loads. It reaches this
// module through graphql_functions, so the mock answers an object from the start.
jest.mock("@/classes/mint/mint-functions", () => ({
    getConfiguration: jest.fn().mockReturnValue({})
}));
jest.mock("@/classes/tapis/adapters/TapisExecutionService");
// A flow run's record says whether it waits for an edit; no run does unless a test says so.
const mockRunRecord = jest.fn().mockResolvedValue(null);
jest.mock("@/api/api-v1/services/unifiedExecutionStore", () => ({
    createHasuraUnifiedExecutionStore: () => ({ getById: (id: string) => mockRunRecord(id) })
}));

const AUTH = "Bearer test-token";
const EXECUTION_ID = "execution-1";
const JOB_UUID = "job-1";

const TAPIS_CONFIG = {
    execution_engine: "tapis",
    tapis: { basePath: "https://portals.tapis.io" }
};

// Answer the files that Tapis holds for the job of the execution.
const tapisListsFiles = (files: unknown[]) => {
    const listJobFiles = jest.fn().mockResolvedValue(files);
    const listArchiveFiles = jest.fn().mockResolvedValue(files);
    const listCompositeWorkflowFiles = jest.fn().mockResolvedValue(null);
    // A path is a file unless a test says it is a folder.
    const isArchiveDirectory = jest.fn().mockResolvedValue(false);
    const openArchiveFile = jest.fn().mockResolvedValue({ stream: "stream", contentType: null });
    (TapisExecutionService as unknown as jest.Mock).mockImplementation(() => ({
        listJobFiles,
        listArchiveFiles,
        listCompositeWorkflowFiles,
        isArchiveDirectory,
        openArchiveFile
    }));
    return {
        listJobFiles,
        listArchiveFiles,
        listCompositeWorkflowFiles,
        isArchiveDirectory,
        openArchiveFile
    };
};

describe("executionFilesService.listFiles", () => {
    beforeEach(() => {
        (getConfiguration as jest.Mock).mockReturnValue(TAPIS_CONFIG);
        (getExecution as jest.Mock).mockResolvedValue({ id: EXECUTION_ID, runid: JOB_UUID });
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    it("answers the name, the path, the size and the tapis URI of every archived file", async () => {
        tapisListsFiles([
            {
                name: "output.nc",
                path: "/work/01234/user/ls6/archive/output.nc",
                size: 2048,
                url: "tapis://ls6/archive/output.nc",
                mimeType: "application/octet-stream"
            }
        ]);

        const files = await executionFilesService.listFiles(EXECUTION_ID, AUTH);

        expect(files).toEqual([
            {
                name: "output.nc",
                path: "/work/01234/user/ls6/archive/output.nc",
                size: 2048,
                url: "tapis://ls6/archive/output.nc"
            }
        ]);
    });

    it("answers an empty list when the archive holds no file", async () => {
        tapisListsFiles([]);

        const files = await executionFilesService.listFiles(EXECUTION_ID, AUTH);

        expect(files).toEqual([]);
    });

    it("answers an empty list when Tapis did not start the execution yet", async () => {
        const { listJobFiles, listArchiveFiles, listCompositeWorkflowFiles } = tapisListsFiles([]);
        (getExecution as jest.Mock).mockResolvedValue({ id: EXECUTION_ID, runid: null });

        const files = await executionFilesService.listFiles(EXECUTION_ID, AUTH);

        expect(files).toEqual([]);
        expect(listJobFiles).not.toHaveBeenCalled();
        expect(listArchiveFiles).not.toHaveBeenCalled();
        expect(listCompositeWorkflowFiles).toHaveBeenCalledWith(EXECUTION_ID, undefined);
    });

    it("never asks Tapis for a job when the execution carries a flow run's id", async () => {
        // A flow has no Tapis job: its execution holds the run's id in that place.
        const { listJobFiles } = tapisListsFiles([]);
        (getExecution as jest.Mock).mockResolvedValue({ id: EXECUTION_ID, runid: "ue_parent-1" });

        const files = await executionFilesService.listFiles(EXECUTION_ID, AUTH);

        expect(files).toEqual([]);
        expect(listJobFiles).not.toHaveBeenCalled();
    });

    it("lists the archive directory for a composite workflow result without a run id", async () => {
        const { listArchiveFiles, listCompositeWorkflowFiles } = tapisListsFiles([
            {
                name: "mfsim.lst",
                path: "mint-workflow-output/run-1/model/mfsim.lst",
                size: 12,
                url: "tapis://ls6/mint-workflow-output/run-1/model/mfsim.lst"
            }
        ]);
        (getExecution as jest.Mock).mockResolvedValue({
            id: EXECUTION_ID,
            runid: null,
            results: {
                output: {
                    resource: {
                        url: "tapis://ls6/mint-workflow-output/run-1/model/MODFLOW%206%20cell-by-cell%20budget"
                    }
                }
            }
        });
        listCompositeWorkflowFiles.mockResolvedValue(null);

        const files = await executionFilesService.listFiles(EXECUTION_ID, AUTH);

        expect(listCompositeWorkflowFiles).toHaveBeenCalledWith(
            EXECUTION_ID,
            "mint-workflow-output/run-1/model"
        );
        expect(listArchiveFiles).toHaveBeenCalledWith("ls6", "mint-workflow-output/run-1/model");
        expect(files).toEqual([
            {
                name: "mfsim.lst",
                path: "mint-workflow-output/run-1/model/mfsim.lst",
                size: 12,
                url: "tapis://ls6/mint-workflow-output/run-1/model/mfsim.lst"
            }
        ]);
    });

    it("forwards the token of the user to Tapis", async () => {
        tapisListsFiles([]);

        await executionFilesService.listFiles(EXECUTION_ID, AUTH);

        expect(TapisExecutionService).toHaveBeenCalledWith(
            "test-token",
            "https://portals.tapis.io"
        );
    });

    it("reads the files of the job of the execution", async () => {
        const { listJobFiles } = tapisListsFiles([]);

        await executionFilesService.listFiles(EXECUTION_ID, AUTH);

        expect(listJobFiles).toHaveBeenCalledWith(JOB_UUID);
    });

    it("fails with 404 when the execution does not exist", async () => {
        tapisListsFiles([]);
        (getExecution as jest.Mock).mockResolvedValue(null);

        await expect(executionFilesService.listFiles(EXECUTION_ID, AUTH)).rejects.toMatchObject({
            statusCode: 404
        });
    });

    it("fails with 401 when the authorization header is absent", async () => {
        tapisListsFiles([]);

        await expect(
            executionFilesService.listFiles(EXECUTION_ID, undefined)
        ).rejects.toMatchObject({ statusCode: 401 });
    });

    it("fails with 400 when the instance does not run Tapis", async () => {
        tapisListsFiles([]);
        (getConfiguration as jest.Mock).mockReturnValue({ execution_engine: "localex" });

        await expect(executionFilesService.listFiles(EXECUTION_ID, AUTH)).rejects.toMatchObject({
            statusCode: 400
        });
    });
});

describe("executionFilesService.listFiles for a flow run", () => {
    const flowExecution = (url: string) => ({
        id: EXECUTION_ID,
        runid: "ue_run-1",
        results: { out: { resource: { name: "out", url } } }
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    beforeEach(() => {
        (getConfiguration as jest.Mock).mockReturnValue(TAPIS_CONFIG);
    });

    it("lists the folder itself when the result is a folder", async () => {
        const { listArchiveFiles, isArchiveDirectory } = tapisListsFiles([]);
        isArchiveDirectory.mockResolvedValue(true);
        (getExecution as jest.Mock).mockResolvedValue(
            flowExecution("tapis://cloud.data/home/u/out.v2")
        );

        const listing = await executionFilesService.list(EXECUTION_ID, AUTH);

        expect(isArchiveDirectory).toHaveBeenCalledWith("cloud.data", "home/u/out.v2");
        expect(listArchiveFiles).toHaveBeenCalledTimes(1);
        expect(listArchiveFiles).toHaveBeenCalledWith("cloud.data", "home/u/out.v2");
        expect(listing.results).toEqual([
            { name: "out", url: "tapis://cloud.data/home/u/out.v2", kind: "folder" }
        ]);
    });

    it("lists the containing folder when the result is a file, even without an extension", async () => {
        const { listArchiveFiles } = tapisListsFiles([]);
        (getExecution as jest.Mock).mockResolvedValue(
            flowExecution("tapis://cloud.data/home/u/out/summary")
        );

        const listing = await executionFilesService.list(EXECUTION_ID, AUTH);

        expect(listArchiveFiles).toHaveBeenCalledWith("cloud.data", "home/u/out");
        expect(listing.results[0].kind).toBe("file");
    });

    it("lists each folder when results point at different folders", async () => {
        const { listArchiveFiles, isArchiveDirectory } = tapisListsFiles([]);
        isArchiveDirectory.mockImplementation(async (_s: string, p: string) => p === "a/dir");
        (getExecution as jest.Mock).mockResolvedValue({
            id: EXECUTION_ID,
            runid: "ue_run-1",
            results: {
                one: { resource: { name: "one", url: "tapis://s/a/dir" } },
                two: { resource: { name: "two", url: "tapis://s/b/file.txt" } }
            }
        });

        await executionFilesService.list(EXECUTION_ID, AUTH);

        expect(listArchiveFiles).toHaveBeenCalledWith("s", "a/dir");
        expect(listArchiveFiles).toHaveBeenCalledWith("s", "b");
    });

    it("treats a result as a file when Tapis cannot stat it", async () => {
        const { listArchiveFiles, isArchiveDirectory } = tapisListsFiles([]);
        isArchiveDirectory.mockRejectedValue(new Error("nope"));
        (getExecution as jest.Mock).mockResolvedValue(flowExecution("tapis://s/a/b/c"));

        await executionFilesService.list(EXECUTION_ID, AUTH);

        expect(listArchiveFiles).toHaveBeenCalledWith("s", "a/b");
    });
});

describe("executionFilesService.openFile", () => {
    const stream = { id: "stream" };

    beforeEach(() => {
        (getConfiguration as jest.Mock).mockReturnValue(TAPIS_CONFIG);
        (getExecution as jest.Mock).mockResolvedValue({
            id: EXECUTION_ID,
            runid: "ue_run-1",
            results: {
                file: {
                    resource: { name: "summary", url: "tapis://cloud.data/home/u/out/summary.md" }
                },
                folder: { resource: { name: "folder", url: "tapis://cloud.data/home/u/dir" } }
            }
        });
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    const setup = (dirs: string[] = ["home/u/dir"]) => {
        const mocks = tapisListsFiles([]);
        mocks.isArchiveDirectory.mockImplementation(async (_s: string, p: string) =>
            dirs.includes(p)
        );
        mocks.openArchiveFile.mockResolvedValue({ stream, contentType: "text/markdown" });
        return mocks;
    };

    const rejection = (promise: Promise<unknown>) =>
        promise.then(
            () => {
                throw new Error("expected a rejection");
            },
            (error) => error
        );

    it("streams a result file from Tapis with the token of the caller", async () => {
        const { openArchiveFile } = setup();

        const file = await executionFilesService.openFile(
            EXECUTION_ID,
            AUTH,
            "/home/u/out/summary.md"
        );

        expect(TapisExecutionService).toHaveBeenCalledWith(
            "test-token",
            "https://portals.tapis.io"
        );
        expect(openArchiveFile).toHaveBeenCalledWith("cloud.data", "home/u/out/summary.md");
        expect(file).toEqual({
            stream,
            contentType: "text/markdown",
            filename: "summary.md"
        });
    });

    it("streams a file inside a result folder, below sub folders too", async () => {
        const { openArchiveFile } = setup();

        await executionFilesService.openFile(
            EXECUTION_ID,
            AUTH,
            "home/u/dir/sub/a.nc",
            "cloud.data"
        );

        expect(openArchiveFile).toHaveBeenCalledWith("cloud.data", "home/u/dir/sub/a.nc");
    });

    it("streams a sibling of a file result, as the listing shows it", async () => {
        const { openArchiveFile } = setup();

        await executionFilesService.openFile(EXECUTION_ID, AUTH, "home/u/out/other.csv");

        expect(openArchiveFile).toHaveBeenCalledWith("cloud.data", "home/u/out/other.csv");
    });

    it("refuses a sibling of a folder result", async () => {
        setup();

        const error = await rejection(
            executionFilesService.openFile(EXECUTION_ID, AUTH, "home/u/other.csv")
        );

        expect(error).toMatchObject({ statusCode: 404, code: "FILE_NOT_IN_RESULTS" });
    });

    it.each([
        ["a traversal", "home/u/dir/../../secret"],
        ["a dot segment", "home/u/dir/./a"],
        ["an empty segment", "home/u/dir//a"],
        ["a leading double slash", "//home/u/dir/a"],
        ["a control character", "home/u/dir/a\u0000b"],
        ["a newline", "home/u/dir/a\nb"],
        ["a backslash", "home/u/dir\\a"],
        ["an empty path", ""]
    ])("refuses %s with FILE_PATH_INVALID", async (_label, path) => {
        const { openArchiveFile } = setup();

        const error = await rejection(executionFilesService.openFile(EXECUTION_ID, AUTH, path));

        expect(error).toMatchObject({ statusCode: 400, code: "FILE_PATH_INVALID" });
        expect(openArchiveFile).not.toHaveBeenCalled();
    });

    it("refuses a system that the results do not name", async () => {
        const { openArchiveFile } = setup();

        const error = await rejection(
            executionFilesService.openFile(EXECUTION_ID, AUTH, "home/u/dir/a", "other.system")
        );

        expect(error).toMatchObject({ statusCode: 404, code: "FILE_NOT_IN_RESULTS" });
        expect(openArchiveFile).not.toHaveBeenCalled();
    });

    it("refuses a malformed system id", async () => {
        setup();

        const error = await rejection(
            executionFilesService.openFile(EXECUTION_ID, AUTH, "home/u/dir/a", "a/b")
        );

        expect(error).toMatchObject({ statusCode: 400, code: "FILE_PATH_INVALID" });
    });

    it("refuses a file outside the results", async () => {
        const { openArchiveFile } = setup();

        const error = await rejection(
            executionFilesService.openFile(EXECUTION_ID, AUTH, "home/u/elsewhere/passwd")
        );

        expect(error).toMatchObject({ statusCode: 404, code: "FILE_NOT_IN_RESULTS" });
        expect(openArchiveFile).not.toHaveBeenCalled();
    });

    it("refuses a folder name that only shares a prefix with a result folder", async () => {
        setup();

        const error = await rejection(
            executionFilesService.openFile(EXECUTION_ID, AUTH, "home/u/dir2/a")
        );

        expect(error).toMatchObject({ statusCode: 404, code: "FILE_NOT_IN_RESULTS" });
    });

    it("passes through the 403, 404 and 502 that the Tapis adapter reports, without the token", async () => {
        const { openArchiveFile } = setup();
        for (const status of [403, 404, 502]) {
            openArchiveFile.mockRejectedValue(new HttpError(status, "Tapis said no"));
            const error = await rejection(
                executionFilesService.openFile(EXECUTION_ID, AUTH, "home/u/out/summary.md")
            );
            expect(error.statusCode).toBe(status);
            expect(error.message).not.toContain("test-token");
        }
    });

    it("fails with 401 without an authorization header", async () => {
        setup();

        const error = await rejection(
            executionFilesService.openFile(EXECUTION_ID, undefined, "home/u/out/summary.md")
        );

        expect(error).toMatchObject({ statusCode: 401 });
    });
});

describe("executionFilesService.openFile, for the file a flow run waits for an edit of", () => {
    const WAITING = "tapis://ls6/scratch/alice/out/lexicon_draft.json";
    const waitingRecord = (over: Record<string, unknown> = {}) => ({
        status: "awaiting_edit",
        adapter_run_ids: [{ pause: { file_location: WAITING } }],
        ...over
    });

    beforeEach(() => {
        (getConfiguration as jest.Mock).mockReturnValue(TAPIS_CONFIG);
        (getExecution as jest.Mock).mockResolvedValue({
            id: EXECUTION_ID,
            runid: "ue_run-1",
            results: {}
        });
        mockRunRecord.mockResolvedValue(waitingRecord());
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    const open = (path: string, system?: string) => {
        const mocks = tapisListsFiles([]);
        mocks.openArchiveFile.mockResolvedValue({ stream: "s", contentType: "application/json" });
        return {
            mocks,
            result: executionFilesService.openFile(EXECUTION_ID, AUTH, path, system)
        };
    };

    it("streams that file, as the caller, though nothing is filed as a result yet", async () => {
        const { mocks, result } = open("scratch/alice/out/lexicon_draft.json", "ls6");
        expect(await result).toMatchObject({
            filename: "lexicon_draft.json",
            contentType: "application/json"
        });
        expect(mocks.openArchiveFile).toHaveBeenCalledWith(
            "ls6",
            "scratch/alice/out/lexicon_draft.json"
        );
        expect(mockRunRecord).toHaveBeenCalledWith("run-1");
    });

    it.each([
        ["another file in that folder", "scratch/alice/out/other.json", "ls6"],
        ["the folder", "scratch/alice/out", "ls6"],
        ["the file on another system", "scratch/alice/out/lexicon_draft.json", "corral"],
        ["the file with no system given", "scratch/alice/out/lexicon_draft.json", undefined]
    ])("refuses %s", async (_name, path, system) => {
        const { mocks, result } = open(path, system);
        await expect(result).rejects.toMatchObject({ code: expect.stringMatching(/^FILE_/) });
        expect(mocks.openArchiveFile).not.toHaveBeenCalled();
    });

    it("serves nothing once the run is no longer waiting", async () => {
        mockRunRecord.mockResolvedValue(waitingRecord({ status: "adapter_running" }));
        const { mocks, result } = open("scratch/alice/out/lexicon_draft.json", "ls6");
        await expect(result).rejects.toMatchObject({ code: "FILE_NOT_IN_RESULTS" });
        expect(mocks.openArchiveFile).not.toHaveBeenCalled();
    });

    it("serves nothing when the run's record cannot be read, or names no file", async () => {
        mockRunRecord.mockRejectedValue(new Error("down"));
        let attempt = open("scratch/alice/out/lexicon_draft.json", "ls6");
        await expect(attempt.result).rejects.toBeTruthy();
        mockRunRecord.mockResolvedValue(waitingRecord({ adapter_run_ids: [{ pause: {} }] }));
        attempt = open("scratch/alice/out/lexicon_draft.json", "ls6");
        await expect(attempt.result).rejects.toBeTruthy();
        expect(attempt.mocks.openArchiveFile).not.toHaveBeenCalled();
    });
});
