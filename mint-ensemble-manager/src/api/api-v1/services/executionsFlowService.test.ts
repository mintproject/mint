import executionsFlowService from "./executionsFlowService";
import { getThreadMock } from "@/classes/common/__tests__/mocks/getThreadMock";
import { getRegionMockTexas } from "@/classes/common/__tests__/mocks/getRegionMockTexas";
import {
    getExecution,
    getRegionDetails,
    incrementThreadModelSubmittedRuns,
    insertThreadModelExecutionSummary,
    setExecutions,
    setThreadModelExecutionIds,
    updateExecutionStatusResultsAndSummary
} from "@/classes/graphql/graphql_functions";
import { getThread } from "@/classes/graphql/graphql_functions_v2";

const mockFlowQuery = jest.fn();
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

describe("the thread's side of a flow run", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        (getThread as jest.Mock).mockResolvedValue(
            JSON.parse(JSON.stringify(getThreadMock.data.thread_by_pk))
        );
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

    describe("recording a run", () => {
        it("writes one execution the thread can find by the run's id, and counts it", async () => {
            const id = await executionsFlowService.startFlowExecution(THREAD, MODEL, "ue_parent-1");

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
