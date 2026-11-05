import express from "express";
import request from "supertest";
import unifiedExecutionRouter from "@/api/api-v1/paths/unifiedExecution";
import { createUnifiedExecutionService, UnifiedExecutionError } from "./unifiedExecutionService";
import {
    UnifiedExecutionRecord,
    UnifiedExecutionStep,
    UnifiedExecutionStore
} from "./unifiedExecutionStore";

jest.mock("@/classes/mint/mint-functions", () => ({
    getConfiguration: jest.fn().mockReturnValue({
        execution_engine: "tapis",
        svo_adapter_api: "http://adapter.local",
        unified_plan_secret: "test-secret"
    })
}));

describe("unifiedExecutionService", () => {
    const legacy = {
        local: { submitExecution: jest.fn() },
        wings: { submitExecution: jest.fn() },
        tapis: {
            submitExecution: jest.fn(),
            buildCompositeWorkflowModelTask: jest.fn(),
            findUnboundInputsByStandardVariable: jest.fn(),
            getExecution: jest.fn(),
            getJobStatus: jest.fn(),
            updateCompositeWorkflowExecution: jest.fn()
        }
    };

    beforeEach(() => {
        jest.clearAllMocks();
        global.fetch = jest.fn();
        // By default a model has no area-of-interest input (e.g. MODFLOW).
        legacy.tapis.findUnboundInputsByStandardVariable.mockResolvedValue({
            region: null,
            inputs: [],
            outputs: []
        });
    });

    function fakeStore(): UnifiedExecutionStore {
        const records = new Map<string, UnifiedExecutionRecord>();
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
                const step = {
                    id: `step-${input.step_key}`,
                    ...input
                } as UnifiedExecutionStep;
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
            async compareAndSet(id, expectedRevision, set) {
                const record = records.get(id);
                if (!record || record.state_revision !== expectedRevision) return null;
                Object.assign(record, set, { state_revision: expectedRevision + 1 });
                return record;
            }
        };
    }

    it("normalizes an adapter plan and preserves its parameter contract", async () => {
        (global.fetch as jest.Mock).mockResolvedValue({
            ok: true,
            json: async () => ({
                status: "transform_required",
                plan_id: "adapter-plan-1",
                plan_json: { parameters: [{ name: "start_date", required: true }] }
            })
        });
        const service = createUnifiedExecutionService(legacy);

        const result = await service.createPlan(
            {
                executor: "svo_adapter",
                adapter_request: { data_object_id: "source-1", target_contract: {} }
            },
            "Bearer user-token"
        );

        expect(result).toMatchObject({
            executor: "svo_adapter",
            plan_id: "svo_adapter-plan-1",
            parameters: [{ name: "start_date", required: true }]
        });
        expect((global.fetch as jest.Mock).mock.calls[0][0]).toBe("http://adapter.local/plans");
    });

    it("preserves structured SVO adapter validation errors", async () => {
        (global.fetch as jest.Mock).mockResolvedValue({
            ok: false,
            status: 422,
            json: async () => ({
                detail: {
                    code: "INVALID_PARAMETERS",
                    message: "geo_actor_id is required",
                    parameters: { geo_actor_id: "required" }
                }
            })
        });
        const service = createUnifiedExecutionService(legacy);

        await expect(
            service.createPlan(
                {
                    executor: "svo_adapter",
                    adapter_request: { data_object_id: "source-1", target_contract: {} }
                },
                "Bearer user-token"
            )
        ).rejects.toMatchObject({
            statusCode: 422,
            code: "INVALID_PARAMETERS",
            message: "geo_actor_id is required",
            details: {
                code: "INVALID_PARAMETERS",
                parameters: { geo_actor_id: "required" }
            }
        });
    });

    it("relays a structured SECRET_REQUIRED adapter 422 with its extra fields to the route response", async () => {
        const missing = [
            { name: "earthdata", source: "owner_only", fields: ["username", "password"] }
        ];
        (global.fetch as jest.Mock).mockResolvedValue({
            ok: false,
            status: 422,
            json: async () => ({
                detail: {
                    code: "SECRET_REQUIRED",
                    message: "Required secret earthdata is not configured",
                    missing
                }
            })
        });
        const app = express();
        app.use(express.json());
        app.use("/plans", unifiedExecutionRouter(createUnifiedExecutionService(legacy)));

        const response = await request(app)
            .post("/plans")
            .set("Authorization", "Bearer user-token")
            .send({
                executor: "svo_adapter",
                adapter_request: { data_object_id: "source-1", target_contract: {} }
            });

        expect(response.status).toBe(422);
        expect(response.body.code).toBe("SECRET_REQUIRED");
        expect(response.body.message).toBe("Required secret earthdata is not configured");
        expect(response.body.details.missing).toEqual(missing);
    });

    it("forwards a requested maximum model runtime to the Tapis execution engine", async () => {
        legacy.tapis.submitExecution.mockResolvedValue({ submittedExecutions: ["run-1"] });
        const service = createUnifiedExecutionService(legacy);
        const plan = await service.createPlan({
            executor: "ensemble_manager",
            thread_id: "thread-1",
            model_id: "model-1",
            execution_engine: "tapis"
        });

        await service.submit({ plan_id: plan.plan_id, max_minutes: 135 }, "Bearer user-token");

        expect(legacy.tapis.submitExecution).toHaveBeenCalledWith(
            { thread_id: "thread-1", model_id: "model-1", max_minutes: 135 },
            "Bearer user-token"
        );
    });

    it("forwards a requested logical queue to the Tapis execution engine", async () => {
        legacy.tapis.submitExecution.mockResolvedValue({ submittedExecutions: ["run-1"] });
        const service = createUnifiedExecutionService(legacy);
        const plan = await service.createPlan({
            executor: "ensemble_manager",
            thread_id: "thread-1",
            model_id: "model-1",
            execution_engine: "tapis"
        });

        await service.submit({ plan_id: plan.plan_id, queue: "development" }, "Bearer user-token");

        expect(legacy.tapis.submitExecution).toHaveBeenCalledWith(
            { thread_id: "thread-1", model_id: "model-1", queue: "development" },
            "Bearer user-token"
        );
    });

    it("rejects a queue value that is not a queue name", async () => {
        const service = createUnifiedExecutionService(legacy);
        const plan = await service.createPlan({
            executor: "ensemble_manager",
            thread_id: "thread-1",
            model_id: "model-1",
            execution_engine: "tapis"
        });

        await expect(
            service.submit({ plan_id: plan.plan_id, queue: "dev; rm -rf" }, "Bearer user-token")
        ).rejects.toMatchObject({ statusCode: 422, code: "INVALID_QUEUE" });
        expect(legacy.tapis.submitExecution).not.toHaveBeenCalled();
    });

    it("rejects a non-positive maximum model runtime", async () => {
        const service = createUnifiedExecutionService(legacy);
        const plan = await service.createPlan({
            executor: "ensemble_manager",
            thread_id: "thread-1",
            model_id: "model-1",
            execution_engine: "tapis"
        });

        await expect(
            service.submit({ plan_id: plan.plan_id, max_minutes: 0 }, "Bearer user-token")
        ).rejects.toMatchObject({ statusCode: 422, code: "INVALID_MAX_MINUTES" });
        expect(legacy.tapis.submitExecution).not.toHaveBeenCalled();
    });

    it("registers a selected source object before planning its adapter transform", async () => {
        (global.fetch as jest.Mock)
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({ id: "ckan-resource-1" })
            })
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({
                    status: "transform_required",
                    plan_id: "adapter-plan-1",
                    plan_json: { parameters: [] }
                })
            });
        const service = createUnifiedExecutionService(legacy);

        const result = await service.createPlan(
            {
                executor: "svo_adapter",
                adapter_request: {
                    data_object_id: "ckan-resource-1",
                    data_object: {
                        id: "ckan-resource-1",
                        label: "MODFLOW archive",
                        resource_uri: "https://ckan.example/resource/archive.zip",
                        format: "zip",
                        variables: [{ standard_variable_uri: "mint:archive" }]
                    },
                    target_dataset_specification_id: "mint:model-input"
                }
            },
            "Bearer user-token"
        );

        expect(result.plan_id).toBe("svo_adapter-plan-1");
        expect((global.fetch as jest.Mock).mock.calls[0][0]).toBe(
            "http://adapter.local/data-objects"
        );
        expect(JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body)).toMatchObject({
            id: "ckan-resource-1",
            resource_uri: "https://ckan.example/resource/archive.zip"
        });
        expect((global.fetch as jest.Mock).mock.calls[1][0]).toBe("http://adapter.local/plans");
        expect(JSON.parse((global.fetch as jest.Mock).mock.calls[1][1].body)).toEqual({
            data_object_id: "ckan-resource-1",
            target_dataset_specification_id: "mint:model-input"
        });
    });

    it("dispatches a legacy plan to the configured execution engine", async () => {
        legacy.tapis.submitExecution.mockResolvedValue({ submittedExecutions: ["run-1"] });
        const service = createUnifiedExecutionService(legacy);
        const plan = await service.createPlan({
            executor: "ensemble_manager",
            thread_id: "thread-1",
            model_id: "model-1",
            execution_engine: "tapis"
        });

        const result = await service.submit({ plan_id: plan.plan_id }, "Bearer user-token");

        expect(legacy.tapis.submitExecution).toHaveBeenCalledWith(
            { thread_id: "thread-1", model_id: "model-1" },
            "Bearer user-token"
        );
        expect(result).toMatchObject({
            executor: "ensemble_manager",
            execution_mode: "job",
            model_child_id: "run-1",
            model_job_id: "run-1",
            adapter_runs: []
        });
    });

    it("normalizes the execution id from a legacy submitted execution object", async () => {
        legacy.tapis.submitExecution.mockResolvedValue({
            submittedExecutions: [{ execution: { id: "model-child-1" }, jobId: "job-1" }]
        });
        const service = createUnifiedExecutionService(legacy);
        const plan = await service.createPlan({
            executor: "ensemble_manager",
            thread_id: "thread-1",
            model_id: "model-1",
            execution_engine: "tapis"
        });

        await expect(
            service.submit({ plan_id: plan.plan_id }, "Bearer user-token")
        ).resolves.toMatchObject({
            execution_mode: "job",
            model_child_id: "model-child-1",
            model_job_id: "job-1"
        });
    });

    it("returns a validation error when the Tapis app and model contracts differ", async () => {
        legacy.tapis.submitExecution.mockRejectedValue(
            Object.assign(new Error("Tapis app and model input contract differ"), {
                code: "COMPONENT_CONTRACT_MISMATCH"
            })
        );
        const service = createUnifiedExecutionService(legacy);
        const plan = await service.createPlan({
            executor: "ensemble_manager",
            thread_id: "thread-1",
            model_id: "model-1",
            execution_engine: "tapis"
        });

        await expect(
            service.submit({ plan_id: plan.plan_id }, "Bearer user-token")
        ).rejects.toMatchObject({
            statusCode: 422,
            code: "COMPONENT_CONTRACT_MISMATCH"
        });
    });

    it("preserves a serialized contract error message instead of returning object text", async () => {
        legacy.tapis.submitExecution.mockRejectedValue({
            code: "COMPONENT_CONTRACT_MISMATCH",
            message: "Tapis app requires mf6-nam, but the model provides a simulation archive"
        });
        const service = createUnifiedExecutionService(legacy);
        const plan = await service.createPlan({
            executor: "ensemble_manager",
            thread_id: "thread-1",
            model_id: "model-1",
            execution_engine: "tapis"
        });

        await expect(
            service.submit({ plan_id: plan.plan_id }, "Bearer user-token")
        ).rejects.toMatchObject({
            statusCode: 422,
            code: "COMPONENT_CONTRACT_MISMATCH",
            message: "Tapis app requires mf6-nam, but the model provides a simulation archive"
        });
    });

    it("rejects a tampered legacy plan identifier", async () => {
        const service = createUnifiedExecutionService(legacy);
        const plan = await service.createPlan({
            executor: "ensemble_manager",
            thread_id: "thread-1",
            model_id: "model-1",
            execution_engine: "tapis"
        });
        const tampered = `${plan.plan_id}x`;

        await expect(
            service.submit({ plan_id: tampered }, "Bearer user-token")
        ).rejects.toMatchObject({
            statusCode: 404,
            code: "PLAN_NOT_FOUND"
        });
    });

    it("forwards adapter parameter values through the server boundary", async () => {
        (global.fetch as jest.Mock).mockResolvedValue({
            ok: true,
            json: async () => ({
                run_id: "adapter-run-1",
                status: "running",
                tapis_workflow_id: "workflow-direct-1",
                tapis_run_id: "tapis-direct-1"
            })
        });
        const service = createUnifiedExecutionService(legacy);

        const result = await service.submit(
            {
                plan_id: "svo_plan-1",
                parameter_values: { start_date: "2024-01-01" },
                execution_id: "parent-1"
            },
            "Bearer user-token"
        );

        expect((global.fetch as jest.Mock).mock.calls[0][0]).toBe(
            "http://adapter.local/workflows/submit"
        );
        expect(JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body)).toMatchObject({
            plan_id: "plan-1",
            args: { start_date: "2024-01-01" },
            execution_id: "parent-1"
        });
        expect(result).toMatchObject({
            executor: "svo_adapter",
            execution_mode: "workflow",
            child_execution_id: "adapter-run-1",
            parent_execution_id: "parent-1"
        });
    });

    it("reconciles adapter output before dispatching the downstream model", async () => {
        legacy.tapis.submitExecution.mockResolvedValue({ submittedExecutions: ["model-run-1"] });
        (global.fetch as jest.Mock)
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({
                    run_id: "adapter-run-1",
                    status: "running",
                    tapis_workflow_id: "workflow-1",
                    tapis_run_id: "tapis-run-1"
                })
            })
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({ status: "completed" })
            })
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({
                    id: "adapter-run-1",
                    status: "completed",
                    output_data_object_id: "output-1"
                })
            })
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({
                    id: "output-1",
                    label: "springflow output",
                    resource_uri: "https://example.test/springflow.csv"
                })
            });

        const store = fakeStore();
        const service = createUnifiedExecutionService(legacy, { store });
        const plan = await service.createPlan({
            executor: "ensemble_manager",
            thread_id: "thread-1",
            model_id: "model-1",
            execution_engine: "tapis",
            adapter_steps: [
                {
                    adapter_plan_id: "adapter-plan-1",
                    model_io_id: "springflow-input",
                    source_resource_id: "source-1"
                }
            ]
        });

        const submitted = await service.submit(
            {
                plan_id: plan.plan_id,
                adapter_parameter_values: { "adapter-plan-1": { start_date: "2024-01-01" } }
            },
            "Bearer user-token"
        );
        expect(submitted).toMatchObject({
            status: "adapter_running",
            run_id: "ue_parent-1",
            execution_mode: "workflow_pipeline",
            tapis_workflow: {
                provider: "tapis-workflows",
                workflow_id: "workflow-1",
                run_id: "tapis-run-1",
                stage_count: 1
            },
            adapter_runs: [
                {
                    run_id: "adapter-run-1",
                    execution_kind: "workflow",
                    tapis_workflow_id: "workflow-1",
                    tapis_run_id: "tapis-run-1"
                }
            ]
        });

        const reconciled = await service.getRun("ue_parent-1", "Bearer user-token");
        expect(reconciled).toMatchObject({
            status: "model_submitted",
            model_child_id: "model-run-1",
            workflow_stages: expect.arrayContaining([
                expect.objectContaining({
                    stage_id: "model",
                    type: "model",
                    status: "running",
                    provider_ids: { model_child_id: "model-run-1" }
                })
            ])
        });
        expect(legacy.tapis.submitExecution).toHaveBeenCalledWith(
            {
                thread_id: "thread-1",
                model_id: "model-1",
                adapter_resource_overrides: [
                    {
                        model_io_id: "springflow-input",
                        resource_id: "output-1",
                        name: "springflow output",
                        url: "https://example.test/springflow.csv"
                    }
                ]
            },
            "Bearer user-token"
        );
    });

    it("retries a parent adapter poll after an auth-related unknown status", async () => {
        (global.fetch as jest.Mock).mockResolvedValueOnce({
            ok: true,
            json: async () => ({
                run_id: "adapter-run-1",
                status: "running",
                tapis_workflow_id: "workflow-1",
                tapis_run_id: "tapis-run-1"
            })
        });
        const store = fakeStore();
        const service = createUnifiedExecutionService(legacy, { store });
        const plan = await service.createPlan({
            executor: "ensemble_manager",
            thread_id: "thread-1",
            model_id: "model-1",
            execution_engine: "tapis",
            adapter_steps: [
                {
                    adapter_plan_id: "adapter-plan-1",
                    model_io_id: "springflow-input",
                    source_resource_id: "source-1"
                }
            ]
        });

        await service.submit({ plan_id: plan.plan_id }, "Bearer initial-token");
        await store.update("parent-1", {
            status: "adapter_unknown",
            failure_code: "ADAPTER_STATUS_UNKNOWN",
            error_message: "log in with a Tapis token to poll this run"
        });
        (global.fetch as jest.Mock)
            .mockResolvedValueOnce({ ok: true, json: async () => ({ status: "running" }) })
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({
                    id: "adapter-run-1",
                    status: "running",
                    tapis_workflow_id: "workflow-1",
                    tapis_run_id: "tapis-run-1"
                })
            });

        const recovered = await service.getRun("ue_parent-1", "Bearer refreshed-token");

        expect(recovered).toMatchObject({
            status: "adapter_running",
            failure_code: "ADAPTER_STATUS_UNKNOWN"
        });
        expect((global.fetch as jest.Mock).mock.calls.at(-2)?.[1].headers).toMatchObject({
            Authorization: "Bearer refreshed-token"
        });
        expect((global.fetch as jest.Mock).mock.calls.at(-1)?.[1].headers).toMatchObject({
            Authorization: "Bearer refreshed-token"
        });
    });

    it("surfaces an adapter child's stall verdict as a parent failure code and clears it on recovery", async () => {
        (global.fetch as jest.Mock).mockResolvedValueOnce({
            ok: true,
            json: async () => ({
                run_id: "adapter-run-1",
                status: "running",
                tapis_workflow_id: "workflow-1",
                tapis_run_id: "tapis-run-1"
            })
        });
        const store = fakeStore();
        const service = createUnifiedExecutionService(legacy, { store });
        const plan = await service.createPlan({
            executor: "ensemble_manager",
            thread_id: "thread-1",
            model_id: "model-1",
            execution_engine: "tapis",
            adapter_steps: [
                {
                    adapter_plan_id: "adapter-plan-1",
                    model_io_id: "springflow-input",
                    source_resource_id: "source-1"
                }
            ]
        });
        await service.submit({ plan_id: plan.plan_id }, "Bearer user-token");

        const stalledRun = {
            id: "adapter-run-1",
            status: "running",
            health: "stalled",
            error_message:
                "Dispatched to Tapis Workflows at 2026-11-02 13:05 UTC; no signal has been received",
            model_job_uuid: null,
            started_at: null,
            tapis_workflow_id: "workflow-1",
            tapis_run_id: "tapis-run-1"
        };
        (global.fetch as jest.Mock)
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({ status: "running", health: "stalled" })
            })
            .mockResolvedValueOnce({ ok: true, json: async () => stalledRun });

        const stalled = await service.getRun("ue_parent-1", "Bearer user-token");

        expect(stalled).toMatchObject({
            status: "adapter_running",
            failure_code: "COMPOSITE_WORKFLOW_STALLED",
            error_message: expect.stringContaining("no signal has been received")
        });
        expect((stalled.adapter_runs as any[])[0]).toMatchObject({ health: "stalled" });
        expect(
            (stalled.workflow_stages as any[]).find((stage) => stage.type === "adapter_input")
        ).toMatchObject({ status: "running", health: "stalled" });

        (global.fetch as jest.Mock)
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({ status: "running", health: "ok" })
            })
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({
                    ...stalledRun,
                    health: "ok",
                    error_message: null,
                    model_job_uuid: "job-1",
                    started_at: "2026-11-02T13:05:20Z"
                })
            });

        const recovered = await service.getRun("ue_parent-1", "Bearer user-token");

        expect(recovered).toMatchObject({
            status: "adapter_running",
            failure_code: null,
            error_message: null
        });
        expect((recovered.adapter_runs as any[])[0]).toMatchObject({
            health: "ok",
            model_job_id: "job-1",
            started_at: "2026-11-02T13:05:20Z"
        });
    });

    it("cancels the active adapter children as the caller and records the cancellation", async () => {
        (global.fetch as jest.Mock).mockResolvedValueOnce({
            ok: true,
            json: async () => ({
                run_id: "adapter-run-1",
                status: "running",
                tapis_workflow_id: "workflow-1",
                tapis_run_id: "tapis-run-1"
            })
        });
        const store = fakeStore();
        const service = createUnifiedExecutionService(legacy, { store });
        const plan = await service.createPlan({
            executor: "ensemble_manager",
            thread_id: "thread-1",
            model_id: "model-1",
            execution_engine: "tapis",
            adapter_steps: [
                {
                    adapter_plan_id: "adapter-plan-1",
                    model_io_id: "springflow-input",
                    source_resource_id: "source-1"
                }
            ]
        });
        await service.submit({ plan_id: plan.plan_id }, "Bearer user-token");
        (global.fetch as jest.Mock)
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({
                    run_id: "adapter-run-1",
                    status: "cancelled",
                    terminated: true
                })
            })
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({
                    id: "adapter-run-1",
                    status: "cancelled",
                    error_message: "Cancelled by alice",
                    health: null
                })
            });

        const cancelled = await service.cancelRun("ue_parent-1", "Bearer user-token");

        expect(cancelled).toMatchObject({
            status: "failed",
            failure_code: "CANCELLED_BY_USER",
            error_message: "Cancelled by alice"
        });
        const cancelCall = (global.fetch as jest.Mock).mock.calls.at(-2);
        expect(cancelCall?.[0]).toBe("http://adapter.local/runs/adapter-run-1/cancel");
        expect(cancelCall?.[1]).toMatchObject({
            method: "POST",
            headers: expect.objectContaining({ Authorization: "Bearer user-token" })
        });
        expect((cancelled.adapter_runs as any[])[0]).toMatchObject({ status: "cancelled" });

        await expect(service.cancelRun("ue_parent-1", "Bearer user-token")).rejects.toMatchObject({
            statusCode: 409,
            code: "RUN_NOT_CANCELLABLE"
        });
    });

    it("refuses to cancel without a bearer token", async () => {
        const service = createUnifiedExecutionService(legacy, { store: fakeStore() });
        await expect(service.cancelRun("ue_parent-1", undefined)).rejects.toMatchObject({
            statusCode: 401,
            code: "AUTHORIZATION_REQUIRED"
        });
        expect(global.fetch).not.toHaveBeenCalled();
    });

    it("blocks parent submission when the first adapter child rejects parameters", async () => {
        (global.fetch as jest.Mock).mockResolvedValue({
            ok: false,
            status: 422,
            json: async () => ({
                detail: {
                    code: "INVALID_PARAMETERS",
                    message: "start_date is required"
                }
            })
        });
        const store = fakeStore();
        const service = createUnifiedExecutionService(legacy, { store });
        const plan = await service.createPlan({
            executor: "ensemble_manager",
            thread_id: "thread-1",
            model_id: "model-1",
            execution_engine: "tapis",
            adapter_steps: [
                {
                    adapter_plan_id: "adapter-plan-1",
                    model_io_id: "springflow-input",
                    source_resource_id: "source-1"
                }
            ]
        });

        await expect(
            service.submit(
                { plan_id: plan.plan_id, adapter_parameter_values: {} },
                "Bearer user-token"
            )
        ).rejects.toMatchObject({ statusCode: 422, code: "INVALID_PARAMETERS" });
        expect(legacy.tapis.submitExecution).not.toHaveBeenCalled();
        await expect(service.getRun("ue_parent-1")).resolves.toMatchObject({ status: "failed" });
    });

    it("runs a deferred output adapter after the model execution succeeds", async () => {
        (global.fetch as jest.Mock).mockResolvedValueOnce({
            ok: true,
            json: async () => ({
                status: "deferred",
                plan_id: "deferred-plan-1",
                plan_hash: "deferred-hash-1",
                plan_json: {
                    parameters: [
                        { name: "allocation", required: true, managed: true },
                        { name: "geo_actor_id", required: true, managed: true },
                        { name: "source_uri", required: true, managed: true },
                        { name: "start_date", required: true },
                        { name: "end_date", required: true },
                        { name: "aoi_geojson_uri", required: true },
                        { name: "threshold", required: true }
                    ]
                }
            })
        });
        legacy.tapis.buildCompositeWorkflowModelTask.mockResolvedValue({
            execution_id: "model-child-1",
            output_uri: "tapis://ls6/mint-workflow-output/ue_parent-1/model/cbb",
            output_name: "cbb",
            output_format: "cbc",
            job_definition: {
                name: "mint-workflow-model-model-child-1",
                appId: "modflow6",
                appVersion: "0.0.1"
            }
        });
        legacy.tapis.getExecution.mockResolvedValue({
            status: "SUCCESS",
            results: [
                {
                    model_io: { id: "cbc-output" },
                    resource: {
                        name: "spring.cbc",
                        url: "tapis://ls6/scratch/provider-job-1/output/spring.cbc"
                    }
                }
            ]
        });
        legacy.tapis.getJobStatus.mockResolvedValue({ status: "SUCCESS" });
        const store = fakeStore();
        const service = createUnifiedExecutionService(legacy, { store });

        const plan = await service.createPlan({
            executor: "ensemble_manager",
            thread_id: "thread-1",
            model_id: "model-1",
            execution_engine: "tapis",
            post_model_adapter: {
                model_io_id: "cbc-output",
                model_output_key: "cbb",
                source_contract: { standard_variable_uri: "mint:cbc", format: "cbc" },
                target_contract: { standard_variable_uri: "mint:springflow" }
            }
        });
        expect(plan).toMatchObject({
            status: "post_model_ready",
            parameters: expect.arrayContaining([
                { name: "threshold", required: true },
                { name: "allocation", required: true, managed: true }
            ])
        });

        (global.fetch as jest.Mock).mockResolvedValueOnce({
            ok: true,
            json: async () => ({
                run_id: "post-model-run-1",
                status: "running",
                tapis_workflow_id: "workflow-post-model-1",
                tapis_run_id: "tapis-post-model-1"
            })
        });

        const submitted = await service.submit(
            {
                plan_id: plan.plan_id,
                adapter_parameter_values: {
                    "deferred-plan-1": {
                        threshold: 0.5,
                        start_date: "2001-01-01",
                        end_date: "2010-12-31",
                        aoi_geojson_uri: "https://example.test/gma/4"
                    }
                }
            },
            "Bearer user-token"
        );
        expect(submitted).toMatchObject({
            status: "model_running",
            run_id: "ue_parent-1",
            adapter_stage: "post_model"
        });
        expect(legacy.tapis.submitExecution).not.toHaveBeenCalled();
        expect(legacy.tapis.buildCompositeWorkflowModelTask).toHaveBeenCalledWith(
            { thread_id: "thread-1", model_id: "model-1", output_name: "cbb" },
            "ue_parent-1",
            "Bearer user-token"
        );
        expect(
            (submitted.workflow_stages as any[]).find((stage) => stage.stage_id === "model")
        ).toMatchObject({
            type: "model",
            status: "running",
            provider_ids: { model_child_id: "model-child-1" }
        });
        expect(
            (submitted.workflow_stages as any[]).find(
                (stage) => stage.stage_id === "output-handoff"
            )
        ).toMatchObject({ type: "output_handoff", status: "planned" });
        await expect(store.listSteps?.("parent-1")).resolves.toEqual(
            expect.arrayContaining([
                expect.objectContaining({ step_key: "model", stage: "model", status: "running" }),
                expect.objectContaining({
                    step_key: "output-handoff",
                    stage: "output_handoff",
                    status: "planned"
                })
            ])
        );

        (global.fetch as jest.Mock)
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({
                    status: "running",
                    tapis_workflow_id: "workflow-post-model-1",
                    tapis_run_id: "tapis-post-model-1"
                })
            })
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({ id: "post-model-run-1", status: "running" })
            });

        const adapterStarted = await service.getRun("ue_parent-1", "Bearer user-token");
        expect(adapterStarted).toMatchObject({
            status: "model_running",
            execution_mode: "workflow_pipeline",
            tapis_workflow: {
                provider: "tapis-workflows",
                workflow_id: "workflow-post-model-1",
                run_id: "tapis-post-model-1",
                stage_count: 1
            },
            adapter_runs: [
                {
                    run_id: "post-model-run-1",
                    execution_kind: "composite_workflow",
                    tapis_workflow_id: "workflow-post-model-1",
                    tapis_run_id: "tapis-post-model-1"
                }
            ]
        });
        const workflowSubmitCall = (global.fetch as jest.Mock).mock.calls.find(([url]) =>
            String(url).endsWith("/workflows/submit")
        );
        expect(workflowSubmitCall).toBeDefined();
        expect(workflowSubmitCall[1].headers).toMatchObject({
            Authorization: "Bearer user-token"
        });
        expect(JSON.parse(workflowSubmitCall[1].body)).toMatchObject({
            args: expect.objectContaining({
                execution_id: "ue_parent-1"
            }),
            model_task: expect.objectContaining({
                stage_id: "model",
                output_name: "cbb",
                output_uri: "tapis://ls6/mint-workflow-output/ue_parent-1/model/cbb"
            })
        });

        (global.fetch as jest.Mock)
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({
                    status: "completed",
                    output_uri: "tapis://ls6/mint-workflow-output/ue_parent-1/final.csv",
                    result: { schema_version: 1, status: "ok", value: 49.7, unit: "cfs" }
                })
            })
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({ id: "post-model-run-1", status: "completed" })
            })
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({
                    output_data_object: {
                        id: "final-output-1",
                        resource_uri: "tapis://ls6/mint-workflow-output/ue_parent-1/final.csv"
                    }
                })
            });

        const completed = await service.getRun("ue_parent-1", "Bearer user-token");
        expect(completed).toMatchObject({
            status: "completed",
            output_handoff: { result: { value: 49.7, unit: "cfs" } }
        });
        const workflowSubmitCalls = (global.fetch as jest.Mock).mock.calls.filter(([url]) =>
            String(url).endsWith("/workflows/submit")
        );
        expect(workflowSubmitCalls).toHaveLength(1);
        expect(legacy.tapis.updateCompositeWorkflowExecution).toHaveBeenCalledWith(
            "thread-1",
            "model-1",
            "model-child-1",
            "completed",
            undefined
        );
        expect(
            (completed.workflow_stages as any[]).find(
                (stage) => stage.stage_id === "output-handoff"
            )
        ).toMatchObject({ status: "succeeded" });
        expect(legacy.tapis.updateCompositeWorkflowExecution).toHaveBeenCalledTimes(1);
        expect(legacy.tapis.submitExecution).not.toHaveBeenCalled();
        expect(legacy.tapis.getExecution).not.toHaveBeenCalled();
    });

    it("retries composite orchestration after a transient workflow poll failure", async () => {
        (global.fetch as jest.Mock).mockResolvedValueOnce({
            ok: true,
            json: async () => ({
                status: "deferred",
                plan_id: "deferred-plan-1",
                plan_hash: "deferred-hash-1",
                plan_json: { parameters: [] }
            })
        });
        legacy.tapis.buildCompositeWorkflowModelTask.mockResolvedValue({
            execution_id: "model-child-1",
            output_uri: "tapis://ls6/mint-workflow-output/ue_parent-1/model/cbb",
            output_name: "cbb",
            job_definition: { appId: "model-app", appVersion: "0.0.1" }
        });
        const store = fakeStore();
        const service = createUnifiedExecutionService(legacy, { store });
        const plan = await service.createPlan({
            executor: "ensemble_manager",
            thread_id: "thread-1",
            model_id: "model-1",
            execution_engine: "tapis",
            post_model_adapter: {
                model_io_id: "cbc-output",
                model_output_key: "cbc-output",
                source_contract: { standard_variable_uri: "mint:cbc", format: "cbc" },
                target_contract: { standard_variable_uri: "mint:springflow" }
            }
        });
        (global.fetch as jest.Mock).mockResolvedValueOnce({
            ok: true,
            json: async () => ({
                run_id: "post-model-run-1",
                status: "running",
                tapis_workflow_id: "workflow-post-model-1",
                tapis_run_id: "tapis-post-model-1"
            })
        });
        await service.submit({ plan_id: plan.plan_id }, "Bearer initial-token");
        await store.update("parent-1", {
            status: "unknown",
            failure_code: "COMPOSITE_WORKFLOW_STATUS_UNKNOWN",
            error_message: "transient model poll failure"
        });
        (global.fetch as jest.Mock)
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({
                    status: "running",
                    tapis_workflow_id: "workflow-post-model-1",
                    tapis_run_id: "tapis-post-model-1"
                })
            })
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({ id: "post-model-run-1", status: "running" })
            });

        const recovered = await service.getRun("ue_parent-1", "Bearer refreshed-token");

        expect(recovered).toMatchObject({
            status: "model_running",
            failure_code: null,
            error_message: null
        });
        expect((global.fetch as jest.Mock).mock.calls.at(-2)?.[1].headers).toMatchObject({
            Authorization: "Bearer refreshed-token"
        });
        expect((global.fetch as jest.Mock).mock.calls.at(-1)?.[1].headers).toMatchObject({
            Authorization: "Bearer refreshed-token"
        });
        expect(legacy.tapis.buildCompositeWorkflowModelTask).toHaveBeenCalledTimes(1);
    });

    describe("composite model submission to the adapter", () => {
        async function submitComposite() {
            (global.fetch as jest.Mock).mockResolvedValueOnce({
                ok: true,
                json: async () => ({
                    status: "deferred",
                    plan_id: "deferred-plan-1",
                    plan_hash: "deferred-hash-1",
                    plan_json: { parameters: [] }
                })
            });
            legacy.tapis.buildCompositeWorkflowModelTask.mockResolvedValue({
                execution_id: "model-child-1",
                configuration_id: "config/subside",
                required_secrets: [
                    {
                        name: "earthdata",
                        env: { username: "EARTHDATA_USERNAME" },
                        source: "owner_only"
                    }
                ],
                output_uri: "tapis://ls6/mint-workflow-output/ue_parent-1/model/cbb",
                output_name: "cbb",
                job_definition: { appId: "model-app", appVersion: "0.0.1" }
            });
            const store = fakeStore();
            const service = createUnifiedExecutionService(legacy, { store });
            const plan = await service.createPlan({
                executor: "ensemble_manager",
                thread_id: "thread-1",
                model_id: "model-1",
                execution_engine: "tapis",
                post_model_adapter: {
                    model_io_id: "cbc-output",
                    model_output_key: "cbc-output",
                    source_contract: { standard_variable_uri: "mint:cbc", format: "cbc" },
                    target_contract: { standard_variable_uri: "mint:springflow" }
                }
            });
            return { store, service, plan };
        }

        it("sends configuration_id and required_secrets in model_task", async () => {
            const { service, plan } = await submitComposite();
            (global.fetch as jest.Mock).mockResolvedValueOnce({
                ok: true,
                json: async () => ({ run_id: "post-model-run-1", status: "running" })
            });
            await service.submit({ plan_id: plan.plan_id }, "Bearer user-token");

            const call = (global.fetch as jest.Mock).mock.calls.find(([url]) =>
                String(url).endsWith("/workflows/submit")
            );
            const modelTask = JSON.parse(call[1].body).model_task;
            expect(Object.keys(modelTask).sort()).toEqual(
                [
                    "configuration_id",
                    "job_definition",
                    "output_format",
                    "output_name",
                    "output_uri",
                    "required_secrets",
                    "stage_id"
                ].sort()
            );
            expect(modelTask.configuration_id).toBe("config/subside");
            expect(modelTask.required_secrets).toEqual([
                { name: "earthdata", env: { username: "EARTHDATA_USERNAME" }, source: "owner_only" }
            ]);
        });

        it.each([["SIGNALS_REQUIRED"], ["SECRETS_NOT_CONFIGURED"], ["SECRET_UNREADABLE"]])(
            "surfaces an adapter 503 %s to the client",
            async (code) => {
                const { service, plan, store } = await submitComposite();
                (global.fetch as jest.Mock).mockResolvedValueOnce({
                    ok: false,
                    status: 503,
                    json: async () => ({ detail: { code, message: `adapter refused: ${code}` } })
                });
                await expect(
                    service.submit({ plan_id: plan.plan_id }, "Bearer user-token")
                ).rejects.toMatchObject({
                    statusCode: 503,
                    code,
                    message: `adapter refused: ${code}`
                });
                await expect(store.getById("parent-1")).resolves.toMatchObject({
                    status: "failed",
                    failure_code: code
                });
            }
        );

        it("still treats an unstructured adapter 5xx as an unknown submission", async () => {
            const { service, plan } = await submitComposite();
            (global.fetch as jest.Mock).mockResolvedValueOnce({
                ok: false,
                status: 502,
                json: async () => ({})
            });
            await expect(
                service.submit({ plan_id: plan.plan_id }, "Bearer user-token")
            ).resolves.toMatchObject({ status: "unknown" });
        });

        it("surfaces SECRET_ENV_UNDECLARED from the descriptor build as a 422", async () => {
            const { service, plan } = await submitComposite();
            legacy.tapis.buildCompositeWorkflowModelTask.mockRejectedValueOnce(
                new UnifiedExecutionError(422, "env key not declared", "SECRET_ENV_UNDECLARED")
            );
            await expect(
                service.submit({ plan_id: plan.plan_id }, "Bearer user-token")
            ).rejects.toMatchObject({ statusCode: 422, code: "SECRET_ENV_UNDECLARED" });
        });
    });

    describe("input-side ETL derivation", () => {
        const AOI = "https://w3id.org/okn/i/mint/area_of_interest__boundary";
        const square = (x: number) => ({
            type: "Polygon",
            coordinates: [
                [
                    [x, 0],
                    [x + 1, 0],
                    [x + 1, 1],
                    [x, 1],
                    [x, 0]
                ]
            ]
        });
        const outputs = [{ id: "out-io", name: "cbb", format: "cbc" }];
        const aoiInput = { app_input_name: "aoi-geojson", model_input_id: "in/aoi" };
        const postModel = {
            model_io_id: "cbc-output",
            model_output_key: "cbc-output",
            source_contract: { standard_variable_uri: "mint:cbc", format: "cbc" },
            target_contract: { standard_variable_uri: "mint:springflow" }
        };
        const baseRequest = {
            executor: "ensemble_manager",
            thread_id: "thread-1",
            model_id: "model-1",
            execution_engine: "tapis"
        };

        // Adapter stub keyed by path; records every call.
        function stubAdapter(deferredSteps: unknown[] = []) {
            (global.fetch as jest.Mock).mockImplementation(async (url: string, init: any) => {
                const path = String(url).replace("http://adapter.local", "");
                if (path === "/plans/input") {
                    return {
                        ok: true,
                        json: async () => ({
                            steps: [{ type: "function", name: "aoi-from-boundary" }],
                            parameters: []
                        })
                    };
                }
                if (path === "/plans/deferred") {
                    return {
                        ok: true,
                        json: async () => ({
                            status: "deferred",
                            plan_id: "deferred-plan-1",
                            plan_hash: "deferred-hash-1",
                            plan_json: { parameters: [], steps: deferredSteps }
                        })
                    };
                }
                return { ok: true, json: async () => ({ run_id: "run-1", status: "queued" }) };
            });
        }
        const adapterCalls = (path: string) =>
            (global.fetch as jest.Mock).mock.calls.filter(([url]) => String(url).endsWith(path));
        const found = (geometries: any[], inputs: any[] = [aoiInput]) => ({
            region: { id: "region-waco", name: "Waco", category_id: "c", geometries },
            inputs,
            outputs
        });

        it("derives one input step from the thread region and stores it on the plan", async () => {
            stubAdapter();
            legacy.tapis.findUnboundInputsByStandardVariable.mockResolvedValue(
                found([square(0), square(3)])
            );
            const service = createUnifiedExecutionService(legacy, { store: fakeStore() });
            const plan = (await service.createPlan(
                { ...baseRequest, post_model_adapter: postModel },
                "Bearer user-token"
            )) as any;

            expect(legacy.tapis.findUnboundInputsByStandardVariable).toHaveBeenCalledWith(
                { thread_id: "thread-1", model_id: "model-1" },
                AOI,
                "Bearer user-token"
            );
            expect(JSON.parse(adapterCalls("/plans/input")[0][1].body)).toEqual({
                source_kind: "geojson",
                target_standard_variable_uri: AOI,
                app_input_name: "aoi-geojson"
            });
            expect(plan.input_steps).toHaveLength(1);
            expect(plan.input_steps[0]).toMatchObject({
                name: "aoi-geojson",
                app_input_name: "aoi-geojson",
                steps: [{ type: "function", name: "aoi-from-boundary" }],
                params: {},
                source: { kind: "geojson", geometry: { type: "MultiPolygon" } },
                derivation: { method: "region_geometry", region_id: "region-waco", vertices_in: 10 }
            });
            expect(plan.input_steps[0].source.geometry.coordinates).toHaveLength(2);
            // The signed plan carries them, so submit and getPlan see the same AOI.
            expect(((await service.getPlan(plan.plan_id)) as any).input_steps).toEqual(
                plan.input_steps
            );
        });

        it("uses the bounding box and records it when the geometry is too large", async () => {
            stubAdapter();
            const ring = Array.from({ length: 3000 }, (_, i) => [
                100 + Math.cos(i / 3000) * 0.5,
                30 + Math.sin(i / 3000) * 0.5
            ]);
            ring.push(ring[0]);
            legacy.tapis.findUnboundInputsByStandardVariable.mockResolvedValue(
                found([{ type: "Polygon", coordinates: [ring] }])
            );
            const service = createUnifiedExecutionService(legacy, { store: fakeStore() });
            const plan = (await service.createPlan(
                { ...baseRequest, post_model_adapter: postModel },
                "Bearer user-token"
            )) as any;
            expect(JSON.parse(adapterCalls("/plans/input")[0][1].body).source_kind).toBe("bbox");
            expect(plan.input_steps[0].source.kind).toBe("bbox");
            expect(plan.input_steps[0].derivation).toMatchObject({
                method: "region_bbox",
                vertices_in: 3001
            });
        });

        it("rejects a non-polygon region geometry", async () => {
            stubAdapter();
            legacy.tapis.findUnboundInputsByStandardVariable.mockResolvedValue(
                found([{ type: "Point", coordinates: [0, 0] }])
            );
            const service = createUnifiedExecutionService(legacy, { store: fakeStore() });
            await expect(
                service.createPlan(
                    { ...baseRequest, post_model_adapter: postModel },
                    "Bearer user-token"
                )
            ).rejects.toMatchObject({ statusCode: 422, code: "AOI_REGION_GEOMETRY_INVALID" });
        });

        it("derives nothing when no input qualifies", async () => {
            stubAdapter();
            legacy.tapis.findUnboundInputsByStandardVariable.mockResolvedValue(
                found([square(0)], [])
            );
            const service = createUnifiedExecutionService(legacy, { store: fakeStore() });
            const plan = (await service.createPlan(
                { ...baseRequest, post_model_adapter: postModel },
                "Bearer user-token"
            )) as any;
            expect(plan.input_steps).toBeUndefined();
            expect(adapterCalls("/plans/input")).toHaveLength(0);
            expect(
                JSON.parse(
                    Buffer.from(
                        plan.plan_id.slice(3).split(".")[0].replace(/-/g, "+").replace(/_/g, "/"),
                        "base64"
                    ).toString("utf8")
                )
            ).not.toHaveProperty("input_steps");
        });

        it("rejects more than one input typed as the area of interest", async () => {
            stubAdapter();
            legacy.tapis.findUnboundInputsByStandardVariable.mockResolvedValue(
                found([square(0)], [aoiInput, { app_input_name: "aoi-b", model_input_id: "in/b" }])
            );
            const service = createUnifiedExecutionService(legacy, { store: fakeStore() });
            const request = service.createPlan(
                { ...baseRequest, post_model_adapter: postModel },
                "Bearer user-token"
            );
            await expect(request).rejects.toMatchObject({
                statusCode: 422,
                code: "AOI_MULTIPLE_INPUTS_UNSUPPORTED",
                message: expect.stringContaining("aoi-geojson, aoi-b")
            });
            expect(adapterCalls("/plans/input")).toHaveLength(0);
        });

        it("rejects a region over the area cap", async () => {
            stubAdapter();
            legacy.tapis.findUnboundInputsByStandardVariable.mockResolvedValue(
                found([
                    {
                        type: "Polygon",
                        coordinates: [
                            [
                                [-110, 20],
                                [-90, 20],
                                [-90, 40],
                                [-110, 40],
                                [-110, 20]
                            ]
                        ]
                    }
                ])
            );
            const service = createUnifiedExecutionService(legacy, { store: fakeStore() });
            await expect(
                service.createPlan({ ...baseRequest }, "Bearer user-token")
            ).rejects.toMatchObject({ statusCode: 422, code: "AOI_REGION_TOO_LARGE" });
        });

        it("derives automatically for a plain Tapis plan with no flag or post-model adapter", async () => {
            stubAdapter([]);
            legacy.tapis.findUnboundInputsByStandardVariable.mockResolvedValue(
                found([square(0)])
            );
            const service = createUnifiedExecutionService(legacy, { store: fakeStore() });
            const plan = (await service.createPlan({ ...baseRequest }, "Bearer user-token")) as any;
            expect(plan.status).toBe("post_model_ready");
            expect(plan.input_steps).toHaveLength(1);
            expect(plan.post_model_adapter).toMatchObject({ adapter_plan_id: "deferred-plan-1" });
        });

        it("does not derive when input_etl is false", async () => {
            stubAdapter([]);
            legacy.tapis.findUnboundInputsByStandardVariable.mockResolvedValue(
                found([square(0)])
            );
            const service = createUnifiedExecutionService(legacy, { store: fakeStore() });
            const plan = (await service.createPlan(
                { ...baseRequest, input_etl: false },
                "Bearer user-token"
            )) as any;
            expect(legacy.tapis.findUnboundInputsByStandardVariable).not.toHaveBeenCalled();
            expect(plan.input_steps).toBeUndefined();
            expect(plan.status).toBe("ready");
        });

        it("leaves a plan with no AOI-typed input (e.g. MODFLOW) unchanged", async () => {
            stubAdapter();
            legacy.tapis.findUnboundInputsByStandardVariable.mockResolvedValue(
                found([square(0)], [])
            );
            const service = createUnifiedExecutionService(legacy, { store: fakeStore() });
            const plan = (await service.createPlan({ ...baseRequest }, "Bearer user-token")) as any;
            expect(plan.status).toBe("ready");
            expect(plan.input_steps).toBeUndefined();
            expect(plan.post_model_adapter).toBeNull();
            expect(adapterCalls("/plans/deferred")).toHaveLength(0);
        });

        it("builds an input-only composite from an identity deferred plan", async () => {
            stubAdapter([]);
            legacy.tapis.findUnboundInputsByStandardVariable.mockResolvedValue(
                found([square(0)])
            );
            const service = createUnifiedExecutionService(legacy, { store: fakeStore() });
            const plan = (await service.createPlan(
                { ...baseRequest, input_etl: true },
                "Bearer user-token"
            )) as any;
            expect(plan.status).toBe("post_model_ready");
            expect(plan.input_steps).toHaveLength(1);
            const deferred = JSON.parse(adapterCalls("/plans/deferred")[0][1].body);
            expect(deferred.source_contract).toEqual({ format: "cbc" });
            expect(deferred.target_contract).toEqual({ format: "cbc" });
            expect(deferred.model_output_key).toBe("cbb");
            expect(plan.post_model_adapter).toMatchObject({
                adapter_plan_id: "deferred-plan-1",
                model_io_id: "out-io",
                model_output_key: "cbb"
            });
        });

        it("keeps an input-only request a plain plan when nothing needs deriving", async () => {
            stubAdapter();
            legacy.tapis.findUnboundInputsByStandardVariable.mockResolvedValue(
                found([square(0)], [])
            );
            const service = createUnifiedExecutionService(legacy, { store: fakeStore() });
            const plan = (await service.createPlan(
                { ...baseRequest, input_etl: true },
                "Bearer user-token"
            )) as any;
            expect(plan.status).toBe("ready");
            expect(plan.post_model_adapter).toBeNull();
            expect(adapterCalls("/plans/deferred")).toHaveLength(0);
        });

        it("refuses an input-only plan if the adapter planned post-model steps", async () => {
            stubAdapter([{ type: "function" }]);
            legacy.tapis.findUnboundInputsByStandardVariable.mockResolvedValue(
                found([square(0)])
            );
            const service = createUnifiedExecutionService(legacy, { store: fakeStore() });
            await expect(
                service.createPlan({ ...baseRequest, input_etl: true }, "Bearer user-token")
            ).rejects.toMatchObject({ statusCode: 502, code: "INPUT_ONLY_PLAN_NOT_IDENTITY" });
        });

        it("still rejects separate-workflow adapter steps combined with a post-model adapter", async () => {
            stubAdapter();
            const service = createUnifiedExecutionService(legacy, { store: fakeStore() });
            await expect(
                service.createPlan(
                    {
                        ...baseRequest,
                        post_model_adapter: postModel,
                        adapter_steps: [
                            {
                                adapter_plan_id: "p",
                                model_io_id: "io",
                                source_resource_id: "r"
                            }
                        ]
                    },
                    "Bearer user-token"
                )
            ).rejects.toMatchObject({ code: "MIXED_ADAPTER_STAGES_UNSUPPORTED" });
        });

        describe("submit", () => {
            const modelTaskResult = (fileInputs: { name: string; sourceUrl: string }[] = []) => ({
                execution_id: "model-child-1",
                configuration_id: "config/subside",
                required_secrets: [],
                output_uri: "tapis://ls6/mint-workflow-output/ue_parent-1/model/cbb",
                output_name: "cbb",
                job_definition: { appId: "model-app", appVersion: "0.0.1", fileInputs }
            });

            async function planAndSubmit(geometries: any[], fileInputs: any[] = []) {
                stubAdapter();
                legacy.tapis.findUnboundInputsByStandardVariable.mockResolvedValue(
                    found(geometries)
                );
                legacy.tapis.buildCompositeWorkflowModelTask.mockResolvedValue(
                    modelTaskResult(fileInputs)
                );
                const store = fakeStore();
                const service = createUnifiedExecutionService(legacy, { store });
                const plan = (await service.createPlan(
                    { ...baseRequest, post_model_adapter: postModel },
                    "Bearer user-token"
                )) as any;
                (global.fetch as jest.Mock).mockClear();
                await service
                    .submit({ plan_id: plan.plan_id }, "Bearer user-token")
                    .catch((error) => error);
                const call = adapterCalls("/workflows/submit")[0];
                return { plan, store, call, body: call ? JSON.parse(call[1].body) : undefined };
            }

            it("forwards input_steps in model_task with the exact key set", async () => {
                const { plan, body } = await planAndSubmit([square(0)]);
                expect(Object.keys(body.model_task).sort()).toEqual(
                    [
                        "configuration_id",
                        "input_steps",
                        "job_definition",
                        "output_format",
                        "output_name",
                        "output_uri",
                        "required_secrets",
                        "stage_id"
                    ].sort()
                );
                expect(body.model_task.input_steps).toEqual(plan.input_steps);
            });

            it("puts a hash of input_steps in the idempotency key", async () => {
                const a = await planAndSubmit([square(0)]);
                const b = await planAndSubmit([square(7)]);
                const keyA = a.call[1].headers["Idempotency-Key"];
                const keyB = b.call[1].headers["Idempotency-Key"];
                expect(keyA).toBe(a.body.idempotency_key);
                expect(keyA).toMatch(/:in-[0-9a-f]{64}$/);
                expect(keyA).not.toBe(keyB);
            });

            it("changes the plan hash when the region changes", async () => {
                const a = await planAndSubmit([square(0)]);
                const b = await planAndSubmit([square(7)]);
                const recordA = await a.store.getById("parent-1");
                const recordB = await b.store.getById("parent-1");
                expect(a.plan.plan_id).not.toBe(b.plan.plan_id);
                expect(recordA?.plan_hash).toMatch(/^[0-9a-f]{64}$/);
                expect(recordA?.plan_hash).not.toBe(recordB?.plan_hash);
            });

            it("fails with INPUT_CONFLICT before calling the adapter when a dataset fills the input", async () => {
                const { call, store } = await planAndSubmit(
                    [square(0)],
                    [{ name: "aoi-geojson", sourceUrl: "https://data.example/aoi.geojson" }]
                );
                expect(call).toBeUndefined();
                await expect(store.getById("parent-1")).resolves.toMatchObject({
                    status: "failed",
                    failure_code: "INPUT_CONFLICT"
                });
            });

            it("leaves MODFLOW-style composite plans unchanged", async () => {
                stubAdapter();
                legacy.tapis.findUnboundInputsByStandardVariable.mockResolvedValue(
                    found([square(0)], [])
                );
                legacy.tapis.buildCompositeWorkflowModelTask.mockResolvedValue(modelTaskResult());
                const service = createUnifiedExecutionService(legacy, { store: fakeStore() });
                const plan = (await service.createPlan(
                    { ...baseRequest, post_model_adapter: postModel },
                    "Bearer user-token"
                )) as any;
                (global.fetch as jest.Mock).mockClear();
                await service.submit({ plan_id: plan.plan_id }, "Bearer user-token");
                const body = JSON.parse(adapterCalls("/workflows/submit")[0][1].body);
                expect(body.model_task).not.toHaveProperty("input_steps");
                expect(body.idempotency_key).toBe("ue_parent-1:deferred-plan-1:" + body.idempotency_key.split(":")[2]);
                expect(body.idempotency_key).not.toContain(":in-");
            });
        });
    });

    it("does not retry unrelated terminal unknown executions", async () => {
        (global.fetch as jest.Mock).mockResolvedValueOnce({
            ok: true,
            json: async () => ({
                status: "deferred",
                plan_id: "deferred-plan-1",
                plan_hash: "deferred-hash-1",
                plan_json: { parameters: [] }
            })
        });
        legacy.tapis.submitExecution.mockResolvedValue({
            submittedExecutions: [{ execution: { id: "model-child-1" }, jobId: "provider-job-1" }]
        });
        const store = fakeStore();
        const service = createUnifiedExecutionService(legacy, { store });
        const plan = await service.createPlan({
            executor: "ensemble_manager",
            thread_id: "thread-1",
            model_id: "model-1",
            execution_engine: "tapis",
            post_model_adapter: {
                model_io_id: "cbc-output",
                model_output_key: "cbc-output",
                source_contract: { standard_variable_uri: "mint:cbc", format: "cbc" },
                target_contract: { standard_variable_uri: "mint:springflow" }
            }
        });
        await service.submit({ plan_id: plan.plan_id }, "Bearer initial-token");
        await store.update("parent-1", {
            status: "unknown",
            failure_code: "MODEL_SUBMISSION_UNKNOWN",
            error_message: "model submission failed"
        });
        const fetchCallsBeforeRead = (global.fetch as jest.Mock).mock.calls.length;

        await expect(
            service.getRun("ue_parent-1", "Bearer refreshed-token")
        ).resolves.toMatchObject({
            status: "unknown",
            failure_code: "MODEL_SUBMISSION_UNKNOWN"
        });
        expect((global.fetch as jest.Mock).mock.calls).toHaveLength(fetchCallsBeforeRead);
    });
});
