/**
 * Running a model again after a failed run: for each kind of plan, planning
 * again after the failed run gives a new plan id and so a new run record, while
 * submitting one plan twice still returns its one run. The adapter is made to
 * answer with the same ids every time, so a new run never depends on it varying.
 */
import { createUnifiedExecutionService, ParentRunResponse } from "./unifiedExecutionService";
import {
    UnifiedExecutionRecord,
    UnifiedExecutionStep,
    UnifiedExecutionStore
} from "./unifiedExecutionStore";
import { FlowThreadContext } from "./flowExecution";

jest.mock("@/classes/graphql/graphql_functions_v2", () => ({
    getThread: jest.fn().mockResolvedValue({ id: "thread-1" })
}));

jest.mock("@/classes/mint/mint-functions", () => ({
    getConfiguration: jest.fn().mockReturnValue({
        execution_engine: "tapis",
        svo_adapter_api: "http://adapter.local",
        unified_plan_secret: "test-secret"
    })
}));

const AUTH = "Bearer user-token";
type LegacyServices = Parameters<typeof createUnifiedExecutionService>[0];
const asParent = (response: unknown) => response as ParentRunResponse;

describe("running a model again after a failed run", () => {
    const legacy = {
        local: { submitExecution: jest.fn() },
        wings: { submitExecution: jest.fn() },
        tapis: {
            submitExecution: jest.fn(),
            buildCompositeWorkflowModelTask: jest.fn(),
            compositeModelContext: jest.fn(),
            getExecution: jest.fn(),
            getJobStatus: jest.fn(),
            updateCompositeWorkflowExecution: jest.fn()
        }
    };
    const flows = {
        flowContext: jest.fn(),
        startFlowExecution: jest.fn(),
        recordFlowEdit: jest.fn(),
        finishFlowExecution: jest.fn()
    };
    let records: Map<string, UnifiedExecutionRecord>;
    let fetchMock: jest.Mock;
    let planCalls: number;

    function store(): UnifiedExecutionStore {
        const steps = new Map<string, UnifiedExecutionStep>();
        return {
            async getByPlanId(planId) {
                return [...records.values()].find((r) => r.plan_id === planId) || null;
            },
            async getById(id) {
                return records.get(id) || null;
            },
            async listByThread(threadId, modelId) {
                return [...records.values()].filter(
                    (r) => r.thread_id === threadId && r.model_id === modelId
                );
            },
            async listSteps(executionId) {
                return [...steps.values()].filter((s) => s.execution_id === executionId);
            },
            async upsertStep(input) {
                const step = { id: `step-${input.step_key}`, ...input } as UnifiedExecutionStep;
                steps.set(step.step_key, step);
                return step;
            },
            async insert(input) {
                const record = {
                    id: `parent-${records.size + 1}`,
                    ...input
                } as UnifiedExecutionRecord;
                records.set(record.id, record);
                return record;
            },
            async update(id, set) {
                const record = records.get(id);
                if (!record) return null;
                Object.assign(record, set);
                return record;
            },
            async compareAndSet(id, _expected, set) {
                const record = records.get(id);
                if (!record) return null;
                Object.assign(record, set);
                return record;
            }
        } as UnifiedExecutionStore;
    }

    const submitsToAdapter = () =>
        fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/workflows/submit")).length;

    /** Fail the run that exists, as a finished run that did not succeed. */
    function failAll() {
        for (const record of records.values()) {
            Object.assign(record, {
                status: "failed",
                failure_code: "MODEL_FAILED",
                error_message: "job failed"
            });
        }
    }

    beforeEach(() => {
        jest.clearAllMocks();
        records = new Map();
        planCalls = 0;
        fetchMock = jest.fn(async (url: string, init?: { method?: string }) => {
            const path = String(url).replace("http://adapter.local", "");
            const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
            if (path.startsWith("/workflows/submit")) {
                return ok({
                    run_id: "adapter-run-1",
                    status: "running",
                    tapis_workflow_id: "wf-1",
                    tapis_run_id: "tr-1"
                });
            }
            if (path.startsWith("/plans/flow")) {
                planCalls += 1;
                // The same adapter plan id every time: it never varies.
                return ok({
                    plan_id: "adapter-plan-1",
                    plan_json: { steps: [{ step: 1, name: "ingest", depends_on: [] }] }
                });
            }
            if (path.startsWith("/plans")) {
                // A POST plans; a GET of /plans/<id> reads the stored one.
                if (init?.method === "POST") planCalls += 1;
                return ok({
                    status: "deferred",
                    plan_id: "deferred-plan-1",
                    plan_hash: "same-hash",
                    plan_json: { parameters: [] }
                });
            }
            if (path.startsWith("/data-objects")) return ok({ id: "do-1" });
            throw new Error(`unexpected adapter call ${path}`);
        });
        global.fetch = fetchMock as unknown as typeof fetch;
        legacy.tapis.compositeModelContext.mockResolvedValue({
            configuration_id: "model-1",
            region: null,
            has_bound_inputs: false,
            filled_app_inputs: [],
            outputs: [],
            unmatched_optional_inputs: []
        });
        legacy.tapis.buildCompositeWorkflowModelTask.mockResolvedValue({
            execution_id: "model-child-1",
            output_uri: "tapis://ls6/out/ue_parent-1/model/cbb",
            output_name: "cbb",
            output_format: "cbc",
            job_definition: { name: "job", appId: "modflow6", appVersion: "0.0.1" }
        });
        legacy.tapis.submitExecution.mockResolvedValue({ submittedExecutions: ["exec-1"] });
        flows.startFlowExecution.mockResolvedValue("exec-1");
        flows.finishFlowExecution.mockResolvedValue(undefined);
    });

    const service = (withFlows = false) =>
        createUnifiedExecutionService(legacy as unknown as LegacyServices, {
            store: store(),
            ...(withFlows ? { flows } : {})
        });

    const BASE = {
        executor: "ensemble_manager",
        thread_id: "thread-1",
        model_id: "model-1",
        execution_engine: "tapis"
    };

    describe("pre-model adapter steps", () => {
        const request = {
            ...BASE,
            adapter_steps: [
                {
                    adapter_plan_id: "adapter-plan-1",
                    model_io_id: "input-1",
                    source_resource_id: "source-1"
                }
            ]
        };

        it("gives a failed run and a re-plan a new record, and one plan twice one record", async () => {
            const svc = service();
            const first = (await svc.createPlan(request)) as { plan_id: string };
            const run1 = asParent(await svc.submit({ plan_id: first.plan_id }, AUTH));
            failAll();

            // The same plan again: still the failed record, nothing sent.
            const sent = submitsToAdapter();
            expect(asParent(await svc.submit({ plan_id: first.plan_id }, AUTH)).run_id).toBe(
                run1.run_id
            );
            expect(submitsToAdapter()).toBe(sent);

            const second = (await svc.createPlan(request)) as { plan_id: string };
            expect(second.plan_id).not.toBe(first.plan_id);
            const run2 = asParent(await svc.submit({ plan_id: second.plan_id }, AUTH));
            expect(run2.run_id).not.toBe(run1.run_id);
            expect(records.size).toBe(2);
            expect(submitsToAdapter()).toBe(sent + 1);
            expect(asParent(await svc.submit({ plan_id: second.plan_id }, AUTH)).run_id).toBe(
                run2.run_id
            );
            expect(records.size).toBe(2);
        });
    });

    describe("post-model adapter", () => {
        const request = {
            ...BASE,
            post_model_adapter: {
                model_io_id: "cbc-output",
                model_output_key: "cbb",
                source_contract: { standard_variable_uri: "mint:cbc", format: "cbc" },
                target_contract: { standard_variable_uri: "mint:springflow" }
            }
        };
        const submitBody = (planId: string) => ({
            plan_id: planId,
            adapter_parameter_values: { "deferred-plan-1": {} }
        });

        it("gives a failed run and a re-plan a new record even when the adapter repeats its plan id", async () => {
            const svc = service();
            const first = (await svc.createPlan(request)) as { plan_id: string };
            const run1 = asParent(await svc.submit(submitBody(first.plan_id), AUTH));
            failAll();

            const second = (await svc.createPlan(request)) as { plan_id: string };
            expect(planCalls).toBe(2);
            expect(second.plan_id).not.toBe(first.plan_id);
            const run2 = asParent(await svc.submit(submitBody(second.plan_id), AUTH));
            expect(run2.run_id).not.toBe(run1.run_id);
            expect(records.size).toBe(2);

            const again = asParent(await svc.submit(submitBody(second.plan_id), AUTH));
            expect(again.run_id).toBe(run2.run_id);
            expect(records.size).toBe(2);
        });
    });

    describe("flow", () => {
        const context: FlowThreadContext = {
            is_flow: true,
            caller: "alice",
            thread_bindings: {},
            inputs: [],
            parameters: [],
            outputs: [{ model_io_id: "out-1", name: "report" }],
            dates: {}
        } as unknown as FlowThreadContext;
        const request = { ...BASE, model_id: "cfg-flow" };

        beforeEach(() => flows.flowContext.mockResolvedValue(context));

        it("gives a failed run and a re-plan a new record even when the adapter repeats its plan id", async () => {
            const svc = service(true);
            const first = (await svc.createPlan(request, AUTH)) as { plan_id: string };
            const run1 = asParent(await svc.submit({ plan_id: first.plan_id }, AUTH));
            failAll();

            const second = (await svc.createPlan(request, AUTH)) as { plan_id: string };
            expect(planCalls).toBe(2);
            expect(second.plan_id).not.toBe(first.plan_id);
            const run2 = asParent(await svc.submit({ plan_id: second.plan_id }, AUTH));
            expect(run2.run_id).not.toBe(run1.run_id);
            expect(records.size).toBe(2);
            expect(flows.startFlowExecution).toHaveBeenCalledTimes(2);

            expect(asParent(await svc.submit({ plan_id: second.plan_id }, AUTH)).run_id).toBe(
                run2.run_id
            );
            expect(records.size).toBe(2);
            expect(flows.startFlowExecution).toHaveBeenCalledTimes(2);
        });

        it("still refuses a second run while one is open", async () => {
            const svc = service(true);
            const first = (await svc.createPlan(request, AUTH)) as { plan_id: string };
            await svc.submit({ plan_id: first.plan_id }, AUTH);
            const second = (await svc.createPlan(request, AUTH)) as { plan_id: string };
            await expect(svc.submit({ plan_id: second.plan_id }, AUTH)).rejects.toMatchObject({
                code: "FLOW_ALREADY_RUNNING"
            });
        });
    });

    describe("plain model job", () => {
        it("keeps no run record, so every submit sends the job again", async () => {
            const svc = service();
            const first = (await svc.createPlan(BASE)) as { plan_id: string };
            await svc.submit({ plan_id: first.plan_id }, AUTH);
            const second = (await svc.createPlan(BASE)) as { plan_id: string };
            await svc.submit({ plan_id: second.plan_id }, AUTH);
            expect(legacy.tapis.submitExecution).toHaveBeenCalledTimes(2);
            expect(records.size).toBe(0);
        });
    });

    describe("plan id size", () => {
        it("still fits with the nonce for a long pre-model plan, and fails with a clear error past the limit", async () => {
            const svc = service();
            const long = (n: number) => ({
                ...BASE,
                model_id: "m".repeat(120),
                adapter_steps: Array.from({ length: n }, (_, i) => ({
                    adapter_plan_id: `a${i}`.padEnd(36, "a"),
                    model_io_id: "i".repeat(36),
                    source_resource_id: "s".repeat(36)
                }))
            });
            const ok = (await svc.createPlan(long(4))) as { plan_id: string };
            expect(ok.plan_id.length).toBeLessThanOrEqual(2400);
            await expect(svc.createPlan(long(40))).rejects.toMatchObject({
                code: "PLAN_TOO_LARGE"
            });
        });
    });
});
