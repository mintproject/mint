import { createUnifiedExecutionService, UnifiedExecutionError } from "./unifiedExecutionService";
import {
    UnifiedExecutionRecord,
    UnifiedExecutionStep,
    UnifiedExecutionStore
} from "./unifiedExecutionStore";
import { FlowThreadContext } from "./flowExecution";

jest.mock("@/classes/mint/mint-functions", () => ({
    getConfiguration: jest.fn().mockReturnValue({
        execution_engine: "tapis",
        svo_adapter_api: "http://adapter.local",
        unified_plan_secret: "test-secret"
    })
}));

const AUTH = "Bearer user-token";
const BODY = { executor: "ensemble_manager", thread_id: "thread-1", model_id: "cfg-flow" };

function context(over: Partial<FlowThreadContext> = {}): FlowThreadContext {
    return {
        is_flow: true,
        thread_bindings: { start_date: { parameter: "par-start" } },
        inputs: [
            {
                model_io_id: "in-corpus",
                name: "Documents",
                format: "directory",
                standard_variables: ["sv:text"],
                optional: false,
                resources: [{ id: "res-1", name: "Wiki", url: "tapis://sys/docs" }]
            }
        ],
        parameters: [
            { id: "par-start", name: "start" },
            { id: "par-top", name: "top_n", value: "9" }
        ],
        outputs: [
            { model_io_id: "out-report", name: "Sensemaking report" },
            { model_io_id: "out-counts", name: "Term counts" }
        ],
        dates: { start_date: "2020-01-01", end_date: "2020-12-31" },
        ...over
    };
}

const PLAN_JSON = {
    steps: [
        { step: 1, name: "ingest", depends_on: [] },
        { step: 2, name: "score", depends_on: [1] }
    ],
    parameters: [
        { name: "output_uri", required: true },
        { name: "top_n", default: "25", default_source: "flow", required: false },
        { name: "source_uri", default: "tapis://sys/docs", managed: true }
    ],
    flow: { linked_settings: [] }
};

describe("running a flow from a thread", () => {
    const legacy = {
        local: { submitExecution: jest.fn() },
        wings: { submitExecution: jest.fn() },
        tapis: {
            submitExecution: jest.fn(),
            buildCompositeWorkflowModelTask: jest.fn(),
            compositeModelContext: jest.fn()
        }
    };
    const flows = {
        flowContext: jest.fn(),
        startFlowExecution: jest.fn(),
        finishFlowExecution: jest.fn()
    };
    let records: Map<string, UnifiedExecutionRecord>;
    let fetchMock: jest.Mock;

    function fakeStore(): UnifiedExecutionStore {
        const steps = new Map<string, UnifiedExecutionStep>();
        return {
            async getByPlanId(planId) {
                return [...records.values()].find((record) => record.plan_id === planId) || null;
            },
            async getById(id) {
                return records.get(id) || null;
            },
            async listSteps(executionId) {
                return [...steps.values()].filter((step) => step.execution_id === executionId);
            },
            async upsertStep(input) {
                const step = { id: `step-${input.step_key}`, ...input } as UnifiedExecutionStep;
                steps.set(step.step_key, step);
                return step;
            },
            async insert(input) {
                const record = { id: "parent-1", ...input } as UnifiedExecutionRecord;
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

    /** Answer the adapter's routes in the order the service calls them. */
    function adapter(routes: Record<string, (body: any) => { status?: number; body: any }>) {
        fetchMock.mockImplementation(async (url: string, init: any) => {
            const path = url.replace("http://adapter.local", "");
            const key = Object.keys(routes).find((route) => path.startsWith(route));
            if (!key) throw new Error("unexpected adapter call " + path);
            const answer = routes[key](init?.body ? JSON.parse(init.body) : undefined);
            const status = answer.status || 200;
            return { ok: status < 400, status, json: async () => answer.body };
        });
    }

    function calls(path: string) {
        return fetchMock.mock.calls
            .filter(([url]) => String(url).replace("http://adapter.local", "").startsWith(path))
            .map(([, init]) => ({
                body: init?.body ? JSON.parse(init.body) : undefined,
                headers: init?.headers || {}
            }));
    }

    const service = () =>
        createUnifiedExecutionService(legacy as any, { store: fakeStore(), flows });

    beforeEach(() => {
        jest.clearAllMocks();
        records = new Map();
        fetchMock = jest.fn();
        global.fetch = fetchMock as any;
        flows.flowContext.mockResolvedValue(context());
        flows.startFlowExecution.mockResolvedValue("exec-1");
        flows.finishFlowExecution.mockResolvedValue(undefined);
        adapter({
            "/data-objects": () => ({ body: { id: "do-1" } }),
            "/plans/flow": () => ({ body: { plan_id: "adapter-plan-1", plan_json: PLAN_JSON } }),
            "/workflows/submit": () => ({
                body: {
                    run_id: "run-1",
                    status: "running",
                    tapis_workflow_id: "pipe-1",
                    tapis_run_id: "uuid-1"
                }
            }),
            "/runs/run-1/poll": () => ({ body: { status: "running" } })
        });
    });

    describe("planning", () => {
        it("registers each bound dataset and asks the adapter for the flow's own plan", async () => {
            const plan = await service().createPlan(BODY, AUTH);

            expect(calls("/data-objects")[0].body).toEqual({
                label: "Wiki",
                resource_uri: "tapis://sys/docs",
                format: "directory",
                variables: [{ standard_variable_uri: "sv:text" }]
            });
            expect(calls("/plans/flow")[0].body).toEqual({
                flow_id: "cfg-flow",
                inputs: { "in-corpus": "do-1" }
            });
            expect(calls("/plans/flow")[0].headers.Authorization).toBe(AUTH);
            expect(plan.status).toBe("flow_ready");
            expect(plan.adapter_stage).toBe("flow");
            expect(plan.plan_id.startsWith("em_")).toBe(true);
            expect(plan.flow_steps).toEqual([
                { step: 1, name: "ingest", depends_on: [] },
                { step: 2, name: "score", depends_on: [1] }
            ]);
        });

        it("shows the runner what the flow's author chose, and what the thread fills in", async () => {
            const plan = await service().createPlan(BODY, AUTH);
            expect(plan.flow_settings).toEqual({ defaults: { top_n: "25" }, links: [] });
            // The thread's own value for a setting, and its start date where the flow asks.
            expect(plan.parameter_values).toEqual({ top_n: "9", start: "2020-01-01" });
        });

        it("does not touch the model path: no component, engine or publishing is looked at", async () => {
            await service().createPlan(BODY, AUTH);
            expect(legacy.tapis.compositeModelContext).not.toHaveBeenCalled();
            expect(fetchMock.mock.calls.map(([url]) => String(url))).not.toEqual(
                expect.arrayContaining([expect.stringContaining("/publishers")])
            );
        });

        it("plans a model as before when the thread's model is not a flow", async () => {
            flows.flowContext.mockResolvedValue(context({ is_flow: false }));
            legacy.tapis.compositeModelContext.mockResolvedValue({
                configuration_id: "cfg-flow",
                region: null,
                has_bound_inputs: false,
                filled_app_inputs: [],
                outputs: [],
                unmatched_optional_inputs: []
            });
            adapter({ "/publishers": () => ({ body: { publishers: [] } }) });
            const plan = await service().createPlan(BODY, AUTH);
            expect(plan.status).toBe("ready");
            expect(calls("/plans/flow")).toHaveLength(0);
        });

        it("refuses several datasets on one input, which would be several runs", async () => {
            const two = context();
            two.inputs[0].resources.push({ id: "res-2", name: "More", url: "tapis://sys/more" });
            flows.flowContext.mockResolvedValue(two);
            await expect(service().createPlan(BODY, AUTH)).rejects.toMatchObject({
                statusCode: 422,
                code: "FLOW_FANOUT_UNSUPPORTED"
            });
            expect(calls("/plans/flow")).toHaveLength(0);
        });

        it("refuses a required input with no dataset, and skips an optional one", async () => {
            const unbound = context();
            unbound.inputs[0].resources = [];
            flows.flowContext.mockResolvedValue(unbound);
            await expect(service().createPlan(BODY, AUTH)).rejects.toMatchObject({
                code: "FLOW_INPUT_UNBOUND"
            });

            unbound.inputs[0].optional = true;
            await service().createPlan(BODY, AUTH);
            expect(calls("/plans/flow")[0].body.inputs).toEqual({});
        });

        describe("the thread's region", () => {
            const SQUARE = {
                type: "Polygon",
                coordinates: [
                    [
                        [-97.9, 30.1],
                        [-97.5, 30.1],
                        [-97.5, 30.5],
                        [-97.9, 30.1]
                    ]
                ]
            };
            const withRegion = (over: Partial<FlowThreadContext> = {}) => {
                const base = context({
                    thread_bindings: { region: { input: "in-aoi" } },
                    region: { id: "region-1", geometries: [SQUARE] } as any,
                    ...over
                });
                base.inputs.push({
                    model_io_id: "in-aoi",
                    name: "Area of interest",
                    standard_variables: ["sv:boundary"],
                    optional: false,
                    resources: []
                });
                return base;
            };

            it("fills the input the flow marks for it when no dataset is bound there", async () => {
                flows.flowContext.mockResolvedValue(withRegion());
                await service().createPlan(BODY, AUTH);
                const sent = calls("/plans/flow")[0].body;
                expect(sent.inputs).toEqual({ "in-corpus": "do-1" });
                expect(sent.region.input).toBe("in-aoi");
                expect(sent.region.source.kind).toBe("geojson");
                expect(sent.region.source.geometry.type).toBe("MultiPolygon");
                expect(sent.region.source.derivation.region_id).toBe("region-1");
            });

            it("uses a dataset bound to that input in its place", async () => {
                const bound = withRegion();
                bound.inputs[1].resources = [
                    { id: "r", name: "AOI", url: "tapis://sys/aoi.geojson" }
                ];
                flows.flowContext.mockResolvedValue(bound);
                await service().createPlan(BODY, AUTH);
                const sent = calls("/plans/flow")[0].body;
                expect(sent.region).toBeUndefined();
                expect(Object.keys(sent.inputs)).toEqual(["in-corpus", "in-aoi"]);
            });

            it("still needs a dataset when the thread has no region", async () => {
                flows.flowContext.mockResolvedValue(withRegion({ region: null }));
                await expect(service().createPlan(BODY, AUTH)).rejects.toMatchObject({
                    code: "FLOW_INPUT_UNBOUND"
                });
            });

            it("says so when the thread's region has no boundary to send", async () => {
                flows.flowContext.mockResolvedValue(
                    withRegion({ region: { id: "region-1", geometries: [] } as any })
                );
                await expect(service().createPlan(BODY, AUTH)).rejects.toMatchObject({
                    statusCode: 422,
                    code: "FLOW_REGION_INVALID"
                });
            });
        });

        it("passes on the adapter's reason when the flow does not check out", async () => {
            adapter({
                "/data-objects": () => ({ body: { id: "do-1" } }),
                "/plans/flow": () => ({
                    status: 422,
                    body: {
                        detail: {
                            code: "FLOW_DOES_NOT_CHECK_OUT",
                            problems: [{ code: "FLOW_STEP_EMPTY", step: 2 }]
                        }
                    }
                })
            });
            await expect(service().createPlan(BODY, AUTH)).rejects.toMatchObject({
                statusCode: 422,
                code: "FLOW_DOES_NOT_CHECK_OUT"
            });
        });
    });

    describe("submitting", () => {
        async function submit(extra: Record<string, unknown> = {}) {
            const svc = service();
            const plan = await svc.createPlan(BODY, AUTH);
            return { svc, plan, run: await svc.submit({ plan_id: plan.plan_id, ...extra }, AUTH) };
        }

        it("records the run for the thread and starts one pipeline, with no Tapis job", async () => {
            const { run } = await submit({ parameter_values: { output_uri: "tapis://sys/out" } });

            expect(flows.startFlowExecution).toHaveBeenCalledWith(
                "thread-1",
                "cfg-flow",
                "ue_parent-1"
            );
            expect(legacy.tapis.submitExecution).not.toHaveBeenCalled();
            expect(legacy.tapis.buildCompositeWorkflowModelTask).not.toHaveBeenCalled();
            expect(calls("/workflows/submit")).toHaveLength(1);
            expect(run.run_id).toBe("ue_parent-1");
            expect(run.status).toBe("adapter_running");
            expect(run.adapter_stage).toBe("flow");
            expect(run.execution_mode).toBe("workflow_pipeline");
            expect(run.model_child_id).toBe("exec-1");
        });

        it("sends the thread's values, with the caller's own taking their place", async () => {
            await submit({ parameter_values: { output_uri: "tapis://sys/out", top_n: "3" } });
            expect(calls("/workflows/submit")[0].body).toMatchObject({
                plan_id: "adapter-plan-1",
                args: { top_n: "3", start: "2020-01-01", output_uri: "tapis://sys/out" },
                accept_flow_settings: false
            });
        });

        it("accepts the flow's settings only when the caller says so", async () => {
            await submit({ accept_flow_settings: true });
            expect(calls("/workflows/submit")[0].body.accept_flow_settings).toBe(true);
        });

        it("closes the run as failed when the adapter refuses it, and says why", async () => {
            adapter({
                "/data-objects": () => ({ body: { id: "do-1" } }),
                "/plans/flow": () => ({
                    body: { plan_id: "adapter-plan-1", plan_json: PLAN_JSON }
                }),
                "/workflows/submit": () => ({
                    status: 422,
                    body: {
                        detail: { code: "FLOW_SETTINGS_NOT_ACCEPTED", defaults: { top_n: "25" } }
                    }
                })
            });
            const svc = service();
            const plan = await svc.createPlan(BODY, AUTH);
            await expect(svc.submit({ plan_id: plan.plan_id }, AUTH)).rejects.toMatchObject({
                statusCode: 422,
                code: "FLOW_SETTINGS_NOT_ACCEPTED"
            });
            const record = records.get("parent-1")!;
            expect([record.status, record.failure_code]).toEqual([
                "failed",
                "FLOW_SETTINGS_NOT_ACCEPTED"
            ]);
            expect(flows.finishFlowExecution).toHaveBeenCalledWith(
                "thread-1",
                "cfg-flow",
                "exec-1",
                "failed",
                []
            );
        });

        it("starts a plan once: a second submit returns the same run", async () => {
            const { svc, plan } = await submit();
            const again = await svc.submit({ plan_id: plan.plan_id }, AUTH);
            expect(again.run_id).toBe("ue_parent-1");
            expect(calls("/workflows/submit")).toHaveLength(1);
            expect(flows.startFlowExecution).toHaveBeenCalledTimes(1);
        });

        it("needs a signed-in caller", async () => {
            const svc = service();
            const plan = await svc.createPlan(BODY, AUTH);
            await expect(svc.submit({ plan_id: plan.plan_id }, undefined)).rejects.toBeInstanceOf(
                UnifiedExecutionError
            );
            expect(calls("/workflows/submit")).toHaveLength(0);
        });
    });

    describe("following", () => {
        const FLOW_VIEW = {
            steps: [
                {
                    step: 1,
                    name: "ingest",
                    task_id: "step-1-x",
                    depends_on: [],
                    status: "completed"
                },
                { step: 2, name: "score", task_id: "step-2-x", depends_on: [1], status: "running" }
            ],
            outputs: [
                { step: 2, output: 0, output_id: "out-report", value: "tapis://sys/out/report.md" },
                { step: 2, output: 1, output_id: "out-counts", value: null },
                { step: 1, value: "job_uuid", value_: "x" },
                {
                    step: 2,
                    output: 2,
                    output_id: "someone-elses-output",
                    value: "tapis://sys/elsewhere"
                }
            ]
        };

        async function started() {
            const svc = service();
            const plan = await svc.createPlan(BODY, AUTH);
            await svc.submit({ plan_id: plan.plan_id }, AUTH);
            return svc;
        }

        function poll(body: any) {
            adapter({ "/runs/run-1/poll": () => ({ body }) });
        }

        it("shows one stage per step, in order, and no model stage", async () => {
            const svc = await started();
            poll({ status: "running", flow: FLOW_VIEW });
            const run = await svc.getRun("ue_parent-1", AUTH);
            expect(
                run.workflow_stages.map((s: any) => [
                    s.stage_id,
                    s.type,
                    s.name,
                    s.status,
                    s.depends_on
                ])
            ).toEqual([
                ["step-1", "flow_step", "ingest", "completed", []],
                ["step-2", "flow_step", "score", "running", ["step-1"]]
            ]);
            expect(run.status).toBe("adapter_running");
            expect(flows.finishFlowExecution).not.toHaveBeenCalled();
        });

        it("shows the run as one stage before its steps are known", async () => {
            const svc = await started();
            poll({ status: "running" });
            const run = await svc.getRun("ue_parent-1", AUTH);
            expect(run.workflow_stages.map((s: any) => [s.stage_id, s.status])).toEqual([
                ["flow", "running"]
            ]);
        });

        it("files each output its step reported as a result, and only the flow's own outputs", async () => {
            const svc = await started();
            poll({ status: "completed", flow: FLOW_VIEW });
            const run = await svc.getRun("ue_parent-1", AUTH);

            expect(run.status).toBe("completed");
            expect(flows.finishFlowExecution).toHaveBeenCalledWith(
                "thread-1",
                "cfg-flow",
                "exec-1",
                "completed",
                [
                    {
                        model_io_id: "out-report",
                        name: "Sensemaking report",
                        url: "tapis://sys/out/report.md"
                    }
                ]
            );
        });

        it("closes the run once: a later look does not ask again or file results twice", async () => {
            const svc = await started();
            poll({ status: "completed", flow: FLOW_VIEW });
            await svc.getRun("ue_parent-1", AUTH);
            await svc.getRun("ue_parent-1", AUTH);
            expect(flows.finishFlowExecution).toHaveBeenCalledTimes(1);
            expect(calls("/runs/run-1/poll")).toHaveLength(1);
        });

        it("closes the run as failed when a step fails, with the step's reason", async () => {
            const svc = await started();
            poll({
                status: "failed",
                error_message: "step 2 could not read its input",
                flow: {
                    steps: [
                        { step: 1, name: "ingest", depends_on: [], status: "completed" },
                        {
                            step: 2,
                            name: "score",
                            depends_on: [1],
                            status: "failed",
                            message: "no such file"
                        }
                    ],
                    outputs: []
                }
            });
            const run = await svc.getRun("ue_parent-1", AUTH);
            expect([run.status, run.failure_code]).toEqual(["failed", "FLOW_FAILED"]);
            expect(run.error_message).toBe("step 2 could not read its input");
            expect(run.workflow_stages[1].error_message).toBe("no such file");
            expect(flows.finishFlowExecution).toHaveBeenCalledWith(
                "thread-1",
                "cfg-flow",
                "exec-1",
                "failed",
                []
            );
        });

        it("leaves the run as it is when the adapter cannot be asked", async () => {
            const svc = await started();
            adapter({
                "/runs/run-1/poll": () => ({ status: 502, body: { detail: "bad gateway" } })
            });
            const run = await svc.getRun("ue_parent-1", AUTH);
            expect(run.status).toBe("adapter_running");
            expect(flows.finishFlowExecution).not.toHaveBeenCalled();
        });
    });
});
