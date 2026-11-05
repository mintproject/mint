import { TapisExecutionService } from "@/classes/tapis/adapters/TapisExecutionService";
import { Jobs } from "@tapis/tapis-typescript";

jest.mock("@/classes/mint/mint-functions", () => ({
    getConfiguration: jest.fn().mockReturnValue({})
}));

jest.mock("@/classes/graphql/graphql_functions", () => ({
    getExecution: jest.fn(),
    getModelOutputsByModelId: jest.fn(),
    incrementThreadModelSuccessfulRuns: jest.fn(),
    incrementThreadModelFailedRuns: jest.fn(),
    updateExecutionStatus: jest.fn(),
    updateExecutionStatusAndResultsv2: jest.fn(),
    getThreadModelByThreadIdExecutionId: jest.fn(),
    updateExecutionRunId: jest.fn(),
    decrementThreadModelSubmittedRuns: jest.fn(),
    handleFailedConnectionEnsemble: jest.fn()
}));

const JOB_UUID = "job-1";

const file = (name: string): Jobs.FileInfo => ({
    name,
    type: Jobs.FileInfoTypeEnum.File,
    url: `tapis://ls6/archive/${name}`
});

const directory = (name: string): Jobs.FileInfo => ({
    name,
    type: Jobs.FileInfoTypeEnum.Dir,
    url: `tapis://ls6/archive/${name}`
});

// Answer one listing per output path. An unknown path fails the way Tapis
// fails for a folder that is absent.
const serviceWithListing = (listing: Record<string, Jobs.FileInfo[]>) => {
    const service = new TapisExecutionService("test-token", "http://tapis.test");
    const getJobOutputList = jest.fn().mockImplementation(async (_jobUuid, outputPath) => {
        if (!(outputPath in listing)) {
            throw new Error(`FILES_NOT_FOUND path ${outputPath}`);
        }
        return { result: listing[outputPath] };
    });
    service.getJobOutputList = getJobOutputList;
    return { service, getJobOutputList };
};

describe("TapisExecutionService.listJobFiles", () => {
    afterEach(() => {
        jest.clearAllMocks();
    });

    it("reads the job output root once, and scans no guessed folder name", async () => {
        // The production archive of 2026-09-12 held these three entries.
        const { service, getJobOutputList } = serviceWithListing({
            "": [file("out.txt"), file("tapisjob.out"), file("tapisjob.sh")]
        });

        const files = await service.listJobFiles(JOB_UUID);

        expect(files.map((f) => f.name)).toEqual(["out.txt"]);
        expect(getJobOutputList).toHaveBeenCalledTimes(1);
        expect(getJobOutputList).toHaveBeenCalledWith(JOB_UUID, "");
    });

    it("hides the Tapis control files by default", async () => {
        const { service } = serviceWithListing({
            "": [file("tapisjob.out"), file("tapisjob.sh"), file("result.nc")]
        });

        const files = await service.listJobFiles(JOB_UUID);

        expect(files.map((f) => f.name)).toEqual(["result.nc"]);
    });

    it("returns the Tapis control files when the caller asks for them", async () => {
        const { service } = serviceWithListing({
            "": [file("tapisjob.out"), file("result.nc")]
        });

        const files = await service.listJobFiles(JOB_UUID, { includeControlFiles: true });

        expect(files.map((f) => f.name)).toEqual(["tapisjob.out", "result.nc"]);
    });

    it("drops the directory entries, and reads the files inside them", async () => {
        const { service, getJobOutputList } = serviceWithListing({
            "": [directory("output"), file("tapisjob.out")],
            "output/": [file("result.nc")]
        });

        const files = await service.listJobFiles(JOB_UUID);

        expect(files.map((f) => f.name)).toEqual(["result.nc"]);
        expect(getJobOutputList).toHaveBeenCalledTimes(2);
        expect(getJobOutputList).toHaveBeenCalledWith(JOB_UUID, "output/");
    });

    it("stops at the depth limit", async () => {
        const { service, getJobOutputList } = serviceWithListing({
            "": [directory("a")],
            "a/": [directory("b")],
            "a/b/": [directory("c"), file("deep.nc")],
            "a/b/c/": [file("too-deep.nc")]
        });

        const files = await service.listJobFiles(JOB_UUID);

        expect(files.map((f) => f.name)).toEqual(["deep.nc"]);
        expect(getJobOutputList).not.toHaveBeenCalledWith(JOB_UUID, "a/b/c/");
    });

    it("answers an empty list when Tapis fails on the root", async () => {
        const { service } = serviceWithListing({});

        const files = await service.listJobFiles(JOB_UUID);

        expect(files).toEqual([]);
    });
});

describe("TapisExecutionService.listCompositeWorkflowFiles", () => {
    afterEach(() => {
        jest.clearAllMocks();
    });

    it("resolves the composite model job by its logical execution id", async () => {
        const service = new TapisExecutionService("test-token", "http://tapis.test");
        const getJobList = jest.fn().mockResolvedValue({
            result: [
                {
                    name: "mint-workflow-model-9d3ef9bc-ca7b-42b5-ad8d-09cd4c68dd9d",
                    uuid: "provider-job-1"
                }
            ]
        });
        const getJob = jest.fn().mockResolvedValue({
            result: {
                archiveSystemDir: "/work/06659/wmobley/ls6/mint-workflow-output/run-1/model"
            }
        });
        const listJobFiles = jest.fn().mockResolvedValue([{ name: "mfsim.lst" }]);
        (service as any).jobsClient.getJobList = getJobList;
        (service as any).jobsClient.getJob = getJob;
        service.listJobFiles = listJobFiles;

        const files = await service.listCompositeWorkflowFiles(
            "9d3ef9bcca7b42b5ad8d09cd4c68dd9d",
            "mint-workflow-output/run-1/model"
        );

        expect(getJobList).toHaveBeenCalledWith({
            limit: 1000,
            skip: 0,
            listType: "MY_JOBS"
        });
        expect(getJob).toHaveBeenCalledWith({ jobUuid: "provider-job-1" });
        expect(listJobFiles).toHaveBeenCalledWith("provider-job-1");
        expect(files).toEqual([{ name: "mfsim.lst" }]);
    });

    it("resolves semantic cbb output keys to an unambiguous cbc archive file", async () => {
        const service = new TapisExecutionService("test-token", "http://tapis.test");
        service.listCompositeWorkflowFiles = jest
            .fn()
            .mockResolvedValue([
                { name: "BARTON_SPRINGS.cbc", url: "tapis://ls6/archive/BARTON_SPRINGS.cbc" }
            ] as any);

        await expect(
            service.resolveCompositeWorkflowOutput(
                "execution-1",
                "mint-workflow-output/run-1/model",
                "cbb"
            )
        ).resolves.toBe("tapis://ls6/archive/BARTON_SPRINGS.cbc");
    });
});
