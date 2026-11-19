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
    (TapisExecutionService as unknown as jest.Mock).mockImplementation(() => ({
        listJobFiles,
        listArchiveFiles,
        listCompositeWorkflowFiles
    }));
    return { listJobFiles, listArchiveFiles, listCompositeWorkflowFiles };
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
        expect(listArchiveFiles).toHaveBeenCalledWith(
            "ls6",
            "mint-workflow-output/run-1/model"
        );
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
