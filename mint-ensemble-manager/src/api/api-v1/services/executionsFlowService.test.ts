import executionsFlowService from "./executionsFlowService";
import { getThreadMock } from "@/classes/common/__tests__/mocks/getThreadMock";
import { getRegionMockTexas } from "@/classes/common/__tests__/mocks/getRegionMockTexas";
import {
    addExecutionDataBinding,
    getExecution,
    getRegionDetails,
    incrementThreadModelSubmittedRuns,
    insertThreadModelExecutionSummary,
    setExecutions,
    setThreadModelExecutionIds,
    updateExecutionStatusResultsAndSummary
} from "@/classes/graphql/graphql_functions";
import { executionToGQL } from "@/classes/graphql/graphql_adapter";
import { getThread } from "@/classes/graphql/graphql_functions_v2";

import { usernameFromToken } from "@/utils/authUtils";

const mockFlowQuery = jest.fn();
jest.mock("@/utils/authUtils", () => ({
    getTokenFromAuthorizationHeader: (header: string) => header.split(" ")[1],
    usernameFromToken: jest.fn()
}));
jest.mock("@/classes/graphql/graphql_functions");
jest.mock("@/classes/graphql/graphql_functions_v2");
jest.mock("@/config/keycloak-adapter", () => ({ KeycloakAdapter: { getUser: jest.fn() } }));
jest.mock("@/config/graphql", () => ({
    GraphQL: { instance: () => ({ query: (...args: unknown[]) => mockFlowQuery(...args) }) }
}));

const THREAD = "thread-1";
const MODEL = "https://w3id.org/okn/i/mint/d2792424-fb9d-461c-9470-4bc87ca2f05f";
const asFlow = (bindings: unknown = {}) =>
    mockFlowQuery.mockResolvedValue({
        data: {
            modelcatalog_configuration_flow_by_pk: {
                configuration_id: MODEL,
                thread_bindings_json: bindings
            }
        }
    });

const CREATED_BY_ALICE = { event: "CREATE", userid: "alice" };
const threadFor = (over: Record<string, unknown>) => ({
    ...JSON.parse(JSON.stringify(getThreadMock.data.thread_by_pk)),
    events: [],
    permissions: [],
    ...over
});

describe("the thread's side of a flow run", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        (usernameFromToken as jest.Mock).mockResolvedValue("alice");
        (getThread as jest.Mock).mockResolvedValue(threadFor({ events: [CREATED_BY_ALICE] }));
        (getRegionDetails as jest.Mock).mockResolvedValue(getRegionMockTexas);
        (insertThreadModelExecutionSummary as jest.Mock).mockResolvedValue({});
    });

    describe("what the thread bound to the flow", () => {
        it("says a configuration with no flow row is a model, without loading the thread", async () => {
            mockFlowQuery.mockResolvedValue({
                data: { modelcatalog_configuration_flow_by_pk: null }
            });
            const context = await executionsFlowService.flowContext(
                { thread_id: THREAD, model_id: MODEL },
                "Bearer t"
            );
            expect(context.is_flow).toBe(false);
            expect(getThread).not.toHaveBeenCalled();
        });

        it("lists each input with the files of the dataset bound to it", async () => {
            asFlow({ region: { input: "x" } });
            const context = await executionsFlowService.flowContext(
                { thread_id: THREAD, model_id: MODEL },
                "Bearer t"
            );
            expect(context.is_flow).toBe(true);
            expect(context.thread_bindings).toEqual({ region: { input: "x" } });
            expect(context.inputs.length).toBeGreaterThan(0);
            for (const input of context.inputs) {
                expect(typeof input.model_io_id).toBe("string");
                for (const resource of input.resources) {
                    expect(resource.url).toEqual(expect.stringMatching(/^\w+:\/\//));
                }
            }
        });

        it("leaves out a bound file that has no location", async () => {
            asFlow();
            const thread = JSON.parse(JSON.stringify(getThreadMock.data.thread_by_pk));
            (getThread as jest.Mock).mockResolvedValue(thread);
            const context = await executionsFlowService.flowContext(
                { thread_id: THREAD, model_id: MODEL },
                "Bearer t"
            );
            const all = context.inputs.flatMap((input) => input.resources);
            expect(all.every((resource) => resource.url.length > 0)).toBe(true);
        });

        it("gives the thread's settings by name and its dates as plain days", async () => {
            asFlow();
            const context = await executionsFlowService.flowContext(
                { thread_id: THREAD, model_id: MODEL },
                "Bearer t"
            );
            for (const parameter of context.parameters) {
                expect(typeof parameter.name).toBe("string");
            }
            expect(context.dates?.start_date).toEqual(expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/));
            expect(context.outputs.every((output) => typeof output.model_io_id === "string")).toBe(
                true
            );
        });

        it("refuses a model that is not in the thread", async () => {
            asFlow();
            await expect(
                executionsFlowService.flowContext(
                    { thread_id: THREAD, model_id: "not-there" },
                    "Bearer t"
                )
            ).rejects.toThrow("Thread model not found");
        });
    });

    describe("who may read and run", () => {
        const ids = { thread_id: THREAD, model_id: MODEL };

        it("reads the thread as the caller, and says who that is", async () => {
            asFlow();
            const context = await executionsFlowService.flowContext(ids, "Bearer t");
            expect(getThread).toHaveBeenCalledWith(THREAD, "t");
            expect(context.caller).toBe("alice");
        });

        it("has no thread for a caller the database does not show it to", async () => {
            asFlow();
            (getThread as jest.Mock).mockResolvedValue(null);
            await expect(executionsFlowService.flowContext(ids, "Bearer t")).rejects.toThrow(
                "Thread not found"
            );
        });

        it("lets someone who can only read a thread plan in it, but not run", async () => {
            asFlow();
            (getThread as jest.Mock).mockResolvedValue(
                threadFor({
                    events: [{ event: "CREATE", userid: "bob" }],
                    permissions: [{ user_id: "*", read: true, write: false }]
                })
            );
            await expect(executionsFlowService.flowContext(ids, "Bearer t")).resolves.toMatchObject(
                { is_flow: true }
            );
            await expect(
                executionsFlowService.flowContext(ids, "Bearer t", "write")
            ).rejects.toThrow("You may not run models in this thread");
            await expect(
                executionsFlowService.startFlowExecution(THREAD, MODEL, "ue_x", "Bearer t")
            ).rejects.toThrow("You may not run models in this thread");
            expect(setExecutions).not.toHaveBeenCalled();
            expect(insertThreadModelExecutionSummary).not.toHaveBeenCalled();
        });

        it.each([
            [{ user_id: "alice", read: true, write: true }],
            [{ user_id: "*", read: true, write: true }]
        ])("lets someone the thread gives write access run: %o", async (permission) => {
            asFlow();
            (getThread as jest.Mock).mockResolvedValue(threadFor({ permissions: [permission] }));
            await expect(
                executionsFlowService.flowContext(ids, "Bearer t", "write")
            ).resolves.toMatchObject({ caller: "alice" });
        });
    });

    describe("recording a run", () => {
        it("writes one execution the thread can find by the run's id, and counts it", async () => {
            const id = await executionsFlowService.startFlowExecution(
                THREAD,
                MODEL,
                "ue_parent-1",
                "Bearer t"
            );

            const [[executions, threadModelId]] = (setExecutions as jest.Mock).mock.calls;
            expect(executions).toHaveLength(1);
            expect(executions[0]).toMatchObject({
                id,
                modelid: MODEL,
                runid: "ue_parent-1",
                status: "WAITING",
                execution_engine: "tapis"
            });
            expect(setThreadModelExecutionIds).toHaveBeenCalledWith(threadModelId, [id]);
            expect(incrementThreadModelSubmittedRuns).toHaveBeenCalledWith(threadModelId, 1);
            const [, summary] = (insertThreadModelExecutionSummary as jest.Mock).mock.calls[0];
            expect(summary.total_runs).toBe(1);
        });
    });

    describe("recording what a run read", () => {
        const PROVENANCE = {
            inputs: [
                {
                    model_io_id: "in-corpus",
                    resources: [
                        { id: "r1", name: "a.csv", url: "https://x/a.csv" },
                        { id: "r2", name: "b.csv", url: "https://x/b.csv" }
                    ]
                }
            ],
            parameters: [{ model_parameter_id: "par-top", name: "top_n", value: "9" }],
            settings: { top_n: "9" },
            unresolved: []
        };

        it("writes a collection input as one binding per resource, and the settings", async () => {
            (setExecutions as jest.Mock).mockResolvedValue({});
            await executionsFlowService.startFlowExecution(
                THREAD,
                MODEL,
                "ue_parent-1",
                "Bearer t",
                PROVENANCE
            );
            const [[executions]] = (setExecutions as jest.Mock).mock.calls;
            const written = executionToGQL(executions[0]);
            expect(written.data_bindings.data).toEqual([
                { model_io_id: "in-corpus", resource_id: "r1" },
                { model_io_id: "in-corpus", resource_id: "r2" }
            ]);
            expect(written.parameter_bindings.data).toEqual([
                { model_parameter_id: "par-top", parameter_value: "9" }
            ]);
        });

        it("records the run without its bindings when the catalog refuses them", async () => {
            (setExecutions as jest.Mock).mockResolvedValue(undefined);
            await executionsFlowService.startFlowExecution(
                THREAD,
                MODEL,
                "ue_parent-1",
                "Bearer t",
                PROVENANCE
            );
            expect(setExecutions).toHaveBeenCalledTimes(2);
            expect((setExecutions as jest.Mock).mock.calls[1][0][0].bindings).toEqual({});
            expect(setThreadModelExecutionIds).toHaveBeenCalled();
        });

        it("files an edited file as an input of the execution", async () => {
            await executionsFlowService.recordFlowEdit("exec-1", "out-lexicon", {
                name: "edited lexicon_draft.json",
                url: "https://ckan/x.json",
                dcid: "res-9"
            });
            expect(addExecutionDataBinding).toHaveBeenCalledWith("exec-1", "out-lexicon", {
                name: "edited lexicon_draft.json",
                url: "https://ckan/x.json",
                dcid: "res-9"
            });
        });
    });

    describe("closing a run", () => {
        const OUTPUTS = [
            { model_io_id: "out-1", name: "Report", url: "tapis://sys/out/report.md" },
            { model_io_id: "out-2", name: "Counts", url: "tapis://sys/out/counts.csv" }
        ];

        it("files one result per output and marks the execution done", async () => {
            (getExecution as jest.Mock).mockResolvedValue({
                id: "exec-1",
                status: "WAITING",
                results: []
            });
            await executionsFlowService.finishFlowExecution(
                THREAD,
                MODEL,
                "exec-1",
                "completed",
                OUTPUTS
            );

            const [[execution]] = (updateExecutionStatusResultsAndSummary as jest.Mock).mock.calls;
            expect(execution.status).toBe("SUCCESS");
            expect(execution.run_progress).toBe(1);
            expect(Object.keys(execution.results)).toEqual(["out-1", "out-2"]);
            expect(execution.results["out-1"]).toMatchObject({
                name: "Report",
                url: "tapis://sys/out/report.md"
            });
        });

        it("marks a failed run failed, with no results", async () => {
            (getExecution as jest.Mock).mockResolvedValue({
                id: "exec-1",
                status: "RUNNING",
                results: []
            });
            await executionsFlowService.finishFlowExecution(THREAD, MODEL, "exec-1", "failed", []);
            const [[execution]] = (updateExecutionStatusResultsAndSummary as jest.Mock).mock.calls;
            expect([execution.status, execution.results]).toEqual(["FAILURE", {}]);
        });

        it.each(["SUCCESS", "FAILURE"])(
            "never rewrites or recounts a run already %s",
            async (status) => {
                (getExecution as jest.Mock).mockResolvedValue({
                    id: "exec-1",
                    status,
                    results: []
                });
                await executionsFlowService.finishFlowExecution(
                    THREAD,
                    MODEL,
                    "exec-1",
                    "completed",
                    OUTPUTS
                );
                expect(updateExecutionStatusResultsAndSummary).not.toHaveBeenCalled();
            }
        );

        it("closes a run once when two callers follow it at the same time", async () => {
            (getExecution as jest.Mock).mockResolvedValue({
                id: "exec-2",
                status: "WAITING",
                results: []
            });
            await Promise.all([
                executionsFlowService.finishFlowExecution(
                    THREAD,
                    MODEL,
                    "exec-2",
                    "completed",
                    OUTPUTS
                ),
                executionsFlowService.finishFlowExecution(
                    THREAD,
                    MODEL,
                    "exec-2",
                    "completed",
                    OUTPUTS
                )
            ]);
            expect(updateExecutionStatusResultsAndSummary).toHaveBeenCalledTimes(1);
        });
    });
});
