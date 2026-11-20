import logsService from "@/api/api-v1/services/logsService";
import { getExecution } from "@/classes/graphql/graphql_functions";
import { getExecutionThreadIds, getThread } from "@/classes/graphql/graphql_functions_v2";
import { fetchWingsRunLog } from "@/classes/wings/wings-functions";
import { fetchLocalRunLog } from "@/classes/localex/local-execution-functions";
import { fetchMintConfig } from "@/classes/mint/mint-functions";
import { TapisExecutionService } from "@/classes/tapis/adapters/TapisExecutionService";
import { createHasuraUnifiedExecutionStore } from "../unifiedExecutionStore";

jest.mock("@/classes/graphql/graphql_functions_v2", () => ({
    getThread: jest.fn(),
    getExecutionThreadIds: jest.fn()
}));
jest.mock("@/classes/wings/wings-functions", () => ({ fetchWingsRunLog: jest.fn() }));
jest.mock("@/classes/localex/local-execution-functions", () => ({ fetchLocalRunLog: jest.fn() }));

jest.mock("@/classes/graphql/graphql_functions");
jest.mock("@/classes/mint/mint-functions", () => ({
    fetchMintConfig: jest.fn(),
    getConfiguration: jest.fn().mockReturnValue({})
}));
jest.mock("@/classes/tapis/adapters/TapisExecutionService");
jest.mock("../unifiedExecutionStore", () => ({
    createHasuraUnifiedExecutionStore: jest.fn()
}));

describe("logsService.fetchLog", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        // The caller owns thread-1, which holds the execution; no other thread is readable.
        (getExecutionThreadIds as jest.Mock).mockResolvedValue(["thread-1"]);
        (getThread as jest.Mock).mockImplementation(async (id: string) =>
            id === "thread-1" ? { id } : null
        );
        (fetchMintConfig as jest.Mock).mockResolvedValue({
            execution_engine: "tapis",
            tapis: { basePath: "https://portals.tapis.io" },
            svo_adapter_api: "http://adapter.local"
        });
        (getExecution as jest.Mock).mockResolvedValue({
            id: "execution-1",
            runid: null
        });
    });

    it("returns task stdout and stderr for workflow child executions", async () => {
        (createHasuraUnifiedExecutionStore as jest.Mock).mockReturnValue({
            getByModelChildId: jest.fn().mockResolvedValue({
                adapter_run_ids: [
                    {
                        execution_kind: "workflow",
                        run_id: "workflow-run-1"
                    }
                ]
            })
        });
        global.fetch = jest.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({
                tasks: [
                    {
                        task_id: "budget-extract",
                        status: "COMPLETED",
                        stdout: "output_uri=tapis://ls6/final.csv",
                        stderr: "",
                        last_message: "finished"
                    }
                ]
            })
        }) as jest.Mock;

        await expect(logsService.fetchLog("execution-1", "Bearer test-token")).resolves.toContain(
            "output_uri=tapis://ls6/final.csv"
        );
        expect((global.fetch as jest.Mock).mock.calls[0][0]).toBe(
            "http://adapter.local/runs/workflow-run-1/poll"
        );
        expect(TapisExecutionService).not.toHaveBeenCalled();
    });

    it("sends the shared service secret to the adapter, and none when it is not set", async () => {
        (createHasuraUnifiedExecutionStore as jest.Mock).mockReturnValue({
            getByModelChildId: jest.fn().mockResolvedValue({
                adapter_run_ids: [{ execution_kind: "workflow", run_id: "workflow-run-1" }]
            })
        });
        const answer = () =>
            jest
                .fn()
                .mockResolvedValue({ ok: true, status: 200, json: async () => ({ logs: "x" }) });
        delete process.env.SVO_ADAPTER_INTERNAL_SERVICE_SECRET;
        (fetchMintConfig as jest.Mock).mockResolvedValue({
            execution_engine: "tapis",
            svo_adapter_api: "http://adapter.local",
            svo_adapter_internal_secret: "service-only",
            graphql: { secret: "hasura-admin" }
        });
        global.fetch = answer() as jest.Mock;
        await logsService.fetchLog("execution-1", "Bearer test-token");
        const headers = (global.fetch as jest.Mock).mock.calls[0][1].headers;
        expect(headers["X-Front-Door-Secret"]).toBe("service-only");
        // Never the header that lets the adapter read any run.
        expect(headers).not.toHaveProperty("X-Ensemble-Manager-Secret");
        expect(headers.Authorization).toBe("Bearer test-token");

        (fetchMintConfig as jest.Mock).mockResolvedValue({
            execution_engine: "tapis",
            svo_adapter_api: "http://adapter.local",
            graphql: { secret: "hasura-admin" }
        });
        global.fetch = answer() as jest.Mock;
        await logsService.fetchLog("execution-1", "Bearer test-token");
        expect((global.fetch as jest.Mock).mock.calls[0][1].headers).not.toHaveProperty(
            "X-Front-Door-Secret"
        );
    });

    it("looks up unified workflow state when the UI strips UUID dashes", async () => {
        const getByModelChildId = jest
            .fn()
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({
                adapter_run_ids: [{ execution_kind: "workflow", run_id: "workflow-run-2" }]
            });
        (createHasuraUnifiedExecutionStore as jest.Mock).mockReturnValue({ getByModelChildId });
        global.fetch = jest.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({ tasks: [{ task_id: "task", status: "FAILED", stderr: "boom" }] })
        }) as jest.Mock;

        await expect(
            logsService.fetchLog("0123456789abcdef0123456789abcdef", "Bearer test-token")
        ).resolves.toContain("boom");
        expect(getByModelChildId).toHaveBeenNthCalledWith(
            2,
            "01234567-89ab-cdef-0123-456789abcdef"
        );
    });

    describe("the thread check", () => {
        const adapterStore = () =>
            (createHasuraUnifiedExecutionStore as jest.Mock).mockReturnValue({
                getByModelChildId: jest.fn().mockResolvedValue({
                    adapter_run_ids: [{ execution_kind: "workflow", run_id: "workflow-run-1" }]
                })
            });
        const engines = {
            wings: () => (fetchWingsRunLog as jest.Mock).mockResolvedValue("wings log"),
            localex: () => (fetchLocalRunLog as jest.Mock).mockReturnValue("local log"),
            tapis: () => {
                adapterStore();
                global.fetch = jest.fn().mockResolvedValue({
                    ok: true,
                    status: 200,
                    json: async () => ({ logs: "adapter log" })
                }) as jest.Mock;
            }
        };

        describe.each(Object.keys(engines) as Array<keyof typeof engines>)("%s", (engine) => {
            beforeEach(() => {
                (fetchMintConfig as jest.Mock).mockResolvedValue({
                    execution_engine: engine,
                    tapis: { basePath: "https://portals.tapis.io" },
                    svo_adapter_api: "http://adapter.local"
                });
                engines[engine]();
            });

            it("gives the owner the log", async () => {
                await expect(
                    logsService.fetchLog("execution-1", "Bearer owner-token")
                ).resolves.toContain("log");
                expect(getThread).toHaveBeenCalledWith("thread-1", "owner-token");
            });

            it("answers 404 for another user's execution, as for a missing one", async () => {
                (getExecutionThreadIds as jest.Mock).mockResolvedValue(["thread-2"]);
                await expect(
                    logsService.fetchLog("execution-1", "Bearer other-token")
                ).rejects.toMatchObject({ statusCode: 404 });
            });

            it("answers 404 when the thread read errors, and when no thread owns it", async () => {
                (getThread as jest.Mock).mockRejectedValue(new Error("hasura down"));
                await expect(
                    logsService.fetchLog("execution-1", "Bearer owner-token")
                ).rejects.toMatchObject({ statusCode: 404 });
                (getExecutionThreadIds as jest.Mock).mockResolvedValue([]);
                await expect(
                    logsService.fetchLog("execution-1", "Bearer owner-token")
                ).rejects.toMatchObject({ statusCode: 404 });
            });

            it("answers 401 with no token and reads nothing", async () => {
                await expect(logsService.fetchLog("execution-1", undefined)).rejects.toMatchObject({
                    statusCode: 401
                });
                await expect(
                    logsService.fetchLog("execution-1", "Basic abc")
                ).rejects.toMatchObject({ statusCode: 401 });
                expect(getExecution).not.toHaveBeenCalled();
                expect(fetchWingsRunLog).not.toHaveBeenCalled();
                expect(fetchLocalRunLog).not.toHaveBeenCalled();
            });
        });

        it("lets a reader of any of the execution's threads read it (a shared thread)", async () => {
            (getExecutionThreadIds as jest.Mock).mockResolvedValue(["thread-2", "thread-1"]);
            engines.wings();
            (fetchMintConfig as jest.Mock).mockResolvedValue({ execution_engine: "wings" });
            await expect(
                logsService.fetchLog("execution-1", "Bearer collaborator-token")
            ).resolves.toBe("wings log");
        });
    });
});
