import { createUnifiedExecutionService, UnifiedExecutionError } from "./unifiedExecutionService";
import {
    UnifiedExecutionRecord,
    UnifiedExecutionStep,
    UnifiedExecutionStore
} from "./unifiedExecutionStore";
import { FlowThreadContext, readThreadBindings } from "./flowExecution";

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
        caller: "alice",
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
            async listByThread(threadId, modelId) {
                return [...records.values()].filter(
                    (record) => record.thread_id === threadId && record.model_id === modelId
                );
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

        describe("an input that takes a collection", () => {
            const THREE = [
                { id: "res-1", name: "a.csv", url: "https://files.example.org/a.csv" },
                { id: "res-2", name: "b.csv", url: "https://other.example.net/b.csv" },
                { id: "res-3", name: "c.txt", url: "tapis://corral/data/c.txt" }
            ];

            function collecting(inputs: FlowThreadContext["inputs"]) {
                flows.flowContext.mockResolvedValue(
                    context({ thread_bindings: { collections: ["in-corpus"] }, inputs })
                );
            }

            const corpus = (resources: typeof THREE) => ({
                model_io_id: "in-corpus",
                name: "Documents",
                format: "directory",
                standard_variables: ["sv:text"],
                optional: false,
                resources
            });

            it("sends every resource, in order, as one input and registers no data object for it", async () => {
                collecting([corpus(THREE)]);
                await service().createPlan(BODY, AUTH);

                expect(calls("/data-objects")).toHaveLength(0);
                expect(calls("/plans/flow")[0].body).toEqual({
                    flow_id: "cfg-flow",
                    inputs: {},
                    collections: {
                        "in-corpus": {
                            label: "Documents",
                            resources: [
                                { name: "a.csv", url: "https://files.example.org/a.csv" },
                                { name: "b.csv", url: "https://other.example.net/b.csv" },
                                { name: "c.txt", url: "tapis://corral/data/c.txt" }
                            ]
                        }
                    }
                });
            });

            it("still refuses several resources on an input the flow does not mark", async () => {
                const two = context({ thread_bindings: { collections: ["some-other-input"] } });
                two.inputs[0].resources.push({ id: "res-2", name: "More", url: "tapis://sys/more" });
                flows.flowContext.mockResolvedValue(two);
                await expect(service().createPlan(BODY, AUTH)).rejects.toMatchObject({
                    statusCode: 422,
                    code: "FLOW_FANOUT_UNSUPPORTED"
                });
                expect(calls("/plans/flow")).toHaveLength(0);
            });

            it("sends both forms when one input takes a collection and another a single dataset", async () => {
                collecting([
                    corpus(THREE),
                    {
                        model_io_id: "in-lexicon",
                        name: "Lexicon",
                        standard_variables: ["sv:terms"],
                        optional: false,
                        resources: [{ id: "res-9", name: "terms.csv", url: "tapis://sys/terms.csv" }]
                    }
                ]);
                await service().createPlan(BODY, AUTH);

                expect(calls("/data-objects")).toHaveLength(1);
                expect(calls("/data-objects")[0].body.resource_uri).toBe("tapis://sys/terms.csv");
                const sent = calls("/plans/flow")[0].body;
                expect(sent.inputs).toEqual({ "in-lexicon": "do-1" });
                expect(Object.keys(sent.collections)).toEqual(["in-corpus"]);
                expect(sent.collections["in-corpus"].resources).toHaveLength(3);
            });

            it("takes a marked input with one resource as a collection too", async () => {
                collecting([corpus(THREE.slice(0, 1))]);
                await service().createPlan(BODY, AUTH);
                expect(calls("/data-objects")).toHaveLength(0);
                expect(calls("/plans/flow")[0].body.collections["in-corpus"].resources).toHaveLength(1);
            });

            it("treats a marked input with no resource as unbound, unless it is optional", async () => {
                collecting([corpus([])]);
                await expect(service().createPlan(BODY, AUTH)).rejects.toMatchObject({
                    code: "FLOW_INPUT_UNBOUND"
                });
                expect(calls("/plans/flow")).toHaveLength(0);

                const optional = { ...corpus([]), optional: true };
                collecting([optional]);
                await service().createPlan(BODY, AUTH);
                expect(calls("/plans/flow")[0].body).toEqual({ flow_id: "cfg-flow", inputs: {} });
            });

            it("does not let the thread's region fill a collection input that has resources", async () => {
                flows.flowContext.mockResolvedValue(
                    context({
                        thread_bindings: { region: { input: "in-corpus" }, collections: ["in-corpus"] },
                        inputs: [corpus(THREE)],
                        region: {
                            id: "r",
                            name: "r",
                            geometries: [
                                {
                                    type: "Polygon",
                                    coordinates: [
                                        [
                                            [-97.9, 30.1],
                                            [-97.5, 30.1],
                                            [-97.5, 30.5],
                                            [-97.9, 30.1]
                                        ]
                                    ]
                                }
                            ]
                        } as any
                    })
                );
                await service().createPlan(BODY, AUTH);
                expect(calls("/plans/flow")[0].body.region).toBeUndefined();
                expect(calls("/plans/flow")[0].body.collections["in-corpus"]).toBeDefined();
            });

            it("reads the marker from the stored bindings, keeping only what is well formed", () => {
                expect(
                    readThreadBindings({
                        region: { input: "in-1", junk: 1 },
                        start_date: { parameter: "p" },
                        end_date: "nope",
                        collections: ["in-1", 5, null, "in-2"],
                        unknown: { input: "x" }
                    })
                ).toEqual({
                    region: { input: "in-1" },
                    start_date: { parameter: "p" },
                    collections: ["in-1", "in-2"]
                });
                expect(readThreadBindings(null)).toEqual({});
                expect(readThreadBindings({ collections: "in-1" })).toEqual({});
            });
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
                "ue_parent-1",
                AUTH
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

        it("checks that the caller may change the thread before anything is recorded", async () => {
            const svc = service();
            const plan = await svc.createPlan(BODY, AUTH);
            flows.flowContext.mockRejectedValue(new Error("You may not run models in this thread"));
            await expect(svc.submit({ plan_id: plan.plan_id }, AUTH)).rejects.toThrow(
                "You may not run models in this thread"
            );
            expect(flows.flowContext).toHaveBeenLastCalledWith(
                { thread_id: "thread-1", model_id: "cfg-flow" },
                AUTH,
                "write"
            );
            // Nothing recorded: the plan's own maker can still run it.
            expect(records.size).toBe(0);
            expect(flows.startFlowExecution).not.toHaveBeenCalled();
        });

        it("runs a plan only for the user who made it", async () => {
            const svc = service();
            const plan = await svc.createPlan(BODY, AUTH);
            flows.flowContext.mockResolvedValue(context({ caller: "bob" }));
            await expect(
                svc.submit({ plan_id: plan.plan_id }, "Bearer bobs-token")
            ).rejects.toMatchObject({ statusCode: 403, code: "FLOW_PLAN_NOT_YOURS" });
            expect(records.size).toBe(0);
            expect(calls("/workflows/submit")).toHaveLength(0);
        });

        it("does not hand a run back to someone who did not make its plan", async () => {
            const { svc, plan } = await submit();
            flows.flowContext.mockResolvedValue(context({ caller: "bob" }));
            await expect(
                svc.submit({ plan_id: plan.plan_id }, "Bearer bobs-token")
            ).rejects.toMatchObject({ code: "FLOW_PLAN_NOT_YOURS" });
        });

        it("takes up a submission that was recorded but never started", async () => {
            const svc = service();
            const plan = await svc.createPlan(BODY, AUTH);
            records.set("parent-1", {
                id: "parent-1",
                plan_id: plan.plan_id,
                thread_id: "thread-1",
                model_id: "cfg-flow",
                execution_engine: "tapis",
                status: "adapter_dispatching",
                adapter_run_ids: [],
                parameter_values: { output_uri: "tapis://sys/first" },
                model_child_id: "exec-earlier",
                created_at: new Date(Date.now() - 5 * 60 * 1000).toISOString()
            } as unknown as UnifiedExecutionRecord);

            const run = await svc.submit({ plan_id: plan.plan_id }, AUTH);
            expect(run.status).toBe("adapter_running");
            expect(run.model_child_id).toBe("exec-earlier");
            // The record it already wrote for the thread is reused, with the first values.
            expect(flows.startFlowExecution).not.toHaveBeenCalled();
            expect(calls("/workflows/submit")[0].body).toMatchObject({
                args: { output_uri: "tapis://sys/first" },
                idempotency_key: "ue_parent-1:adapter-plan-1"
            });
        });

        it("leaves a submission that is only just under way alone", async () => {
            const svc = service();
            const plan = await svc.createPlan(BODY, AUTH);
            records.set("parent-1", {
                id: "parent-1",
                plan_id: plan.plan_id,
                thread_id: "thread-1",
                model_id: "cfg-flow",
                status: "adapter_dispatching",
                adapter_run_ids: [],
                created_at: new Date().toISOString()
            } as unknown as UnifiedExecutionRecord);
            const run = await svc.submit({ plan_id: plan.plan_id }, AUTH);
            expect(run.status).toBe("adapter_dispatching");
            expect(calls("/workflows/submit")).toHaveLength(0);
        });

        it("refuses a second run of the flow in a thread while one is open", async () => {
            const { svc } = await submit();
            adapter({
                "/data-objects": () => ({ body: { id: "do-1" } }),
                "/plans/flow": () => ({
                    body: { plan_id: "adapter-plan-2", plan_json: PLAN_JSON }
                })
            });
            const second = await svc.createPlan(BODY, AUTH);
            await expect(svc.submit({ plan_id: second.plan_id }, AUTH)).rejects.toMatchObject({
                statusCode: 409,
                code: "FLOW_ALREADY_RUNNING"
            });
            expect(records.size).toBe(1);

            // Once the first is closed, the second may run.
            records.get("parent-1")!.status = "failed";
            adapter({
                "/workflows/submit": () => ({ body: { run_id: "run-2", status: "running" } })
            });
            const run = await svc.submit({ plan_id: second.plan_id }, AUTH);
            expect(run.run_id).toBe("ue_parent-2");
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

        it("shows a gather step ahead of the steps that read it, by its own id", async () => {
            const svc = await started();
            poll({
                status: "running",
                flow: {
                    steps: [
                        {
                            step: "gather-1",
                            name: "Gather Documents",
                            task_id: "gather-1",
                            depends_on: [],
                            status: "completed"
                        },
                        {
                            step: 1,
                            name: "ingest",
                            task_id: "step-1-x",
                            depends_on: ["gather-1"],
                            status: "running"
                        },
                        {
                            step: 2,
                            name: "score",
                            task_id: "step-2-x",
                            depends_on: ["gather-1", 1],
                            status: "pending"
                        }
                    ],
                    outputs: []
                }
            });
            const run = await svc.getRun("ue_parent-1", AUTH);
            expect(
                run.workflow_stages.map((s: any) => [s.stage_id, s.name, s.status, s.depends_on])
            ).toEqual([
                ["step-gather-1", "Gather Documents", "completed", []],
                ["step-1", "ingest", "running", ["step-gather-1"]],
                ["step-2", "score", "pending", ["step-gather-1", "step-1"]]
            ]);
            expect(run.workflow_stages[0].provider_ids).toMatchObject({ task_id: "gather-1" });
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

        it("cancels the pipeline and closes the thread's record of the run", async () => {
            const svc = await started();
            adapter({
                "/runs/run-1/cancel": () => ({ body: { status: "cancelled" } }),
                "/runs/run-1": () => ({
                    body: { status: "cancelled", error_message: "Cancelled by alice" }
                })
            });
            const run = await svc.cancelRun("ue_parent-1", AUTH);
            expect([run.status, run.failure_code]).toEqual(["failed", "CANCELLED_BY_USER"]);
            expect(calls("/runs/run-1/cancel")).toHaveLength(1);
            expect(flows.finishFlowExecution).toHaveBeenCalledWith(
                "thread-1",
                "cfg-flow",
                "exec-1",
                "failed",
                []
            );
            // Nothing follows a closed run.
            await svc.getRun("ue_parent-1", AUTH);
            expect(calls("/runs/run-1/poll")).toHaveLength(0);
        });

        it("files results from what the run kept, not from who is asking", async () => {
            const svc = await started();
            // The thread cannot be read now, or the caller is not one who may read it.
            flows.flowContext.mockRejectedValue(new Error("thread unavailable"));
            poll({ status: "completed", flow: FLOW_VIEW });
            const run = await svc.getRun("ue_parent-1", AUTH);
            expect(run.status).toBe("completed");
            expect(flows.finishFlowExecution.mock.calls[0][4]).toHaveLength(1);
        });

        it("does not follow or close a run for a caller with no token", async () => {
            const svc = await started();
            poll({ status: "completed", flow: FLOW_VIEW });
            const run = await svc.getRun("ue_parent-1", undefined);
            expect(run.status).toBe("adapter_running");
            expect(calls("/runs/run-1/poll")).toHaveLength(0);
            expect(flows.finishFlowExecution).not.toHaveBeenCalled();
        });

        it("fails a run that finished without saying where any output is", async () => {
            const svc = await started();
            poll({
                status: "completed",
                flow: { ...FLOW_VIEW, outputs: [{ step: 2, output_id: "out-report", value: null }] }
            });
            const run = await svc.getRun("ue_parent-1", AUTH);
            expect([run.status, run.failure_code]).toEqual(["failed", "FLOW_OUTPUTS_UNREPORTED"]);
            expect(flows.finishFlowExecution).toHaveBeenCalledWith(
                "thread-1",
                "cfg-flow",
                "exec-1",
                "failed",
                []
            );
        });

        it.each([
            "javascript:alert(1)",
            "https://elsewhere.example/report.md",
            "tapis://sys/out/../../other/secret",
            "tapis://sys/" + "x".repeat(2100),
            "tapis:///no-system"
        ])("does not file %s as a result", async (value) => {
            const svc = await started();
            poll({
                status: "completed",
                flow: {
                    ...FLOW_VIEW,
                    outputs: [
                        { step: 2, output_id: "out-report", value },
                        { step: 2, output_id: "out-counts", value: "tapis://sys/out/counts.csv" }
                    ]
                }
            });
            await svc.getRun("ue_parent-1", AUTH);
            expect(flows.finishFlowExecution.mock.calls[0][4]).toEqual([
                {
                    model_io_id: "out-counts",
                    name: "Term counts",
                    url: "tapis://sys/out/counts.csv"
                }
            ]);
        });

        it("files the location the adapter gives when a step reported a summary", async () => {
            // Seen on dev: a piece written for a chain reports one JSON summary.
            const svc = await started();
            poll({
                status: "completed",
                tapis_workflow_id: "pipe-9",
                tapis_run_id: "uuid-9",
                flow: {
                    ...FLOW_VIEW,
                    outputs: [
                        {
                            step: 2,
                            output_id: "out-report",
                            value: '{"output_uri": "tapis://sys/out", "documents": 81}',
                            location: "tapis://sys/out"
                        }
                    ]
                }
            });
            const run = await svc.getRun("ue_parent-1", AUTH);
            expect(run.status).toBe("completed");
            expect(flows.finishFlowExecution.mock.calls[0][4]).toEqual([
                { model_io_id: "out-report", name: "Sensemaking report", url: "tapis://sys/out" }
            ]);
            expect(run.workflow_stages[0].provider_ids).toMatchObject({
                workflow_id: "pipe-9",
                run_id: "uuid-9"
            });
        });

        it("goes by the adapter's word for the run, not Tapis's raw status", async () => {
            const svc = await started();
            poll({ status: "TERMINATED", flow: { ...FLOW_VIEW, status: "failed" } });
            const run = await svc.getRun("ue_parent-1", AUTH);
            expect([run.status, run.failure_code]).toEqual(["failed", "FLOW_FAILED"]);
        });

        it("closes a run Tapis ended, when the adapter gives only Tapis's status", async () => {
            const svc = await started();
            poll({ status: "TERMINATED" });
            const run = await svc.getRun("ue_parent-1", AUTH);
            expect(run.status).toBe("failed");
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
