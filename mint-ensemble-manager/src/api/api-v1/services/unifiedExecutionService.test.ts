import { createHash } from "crypto";
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
            compositeModelContext: jest.fn(),
            getExecution: jest.fn(),
            getJobStatus: jest.fn(),
            updateCompositeWorkflowExecution: jest.fn()
        }
    };

    beforeEach(() => {
        jest.clearAllMocks();
        global.fetch = jest.fn();
        // By default a model has no bound input (e.g. MODFLOW registered before the binding).
        legacy.tapis.compositeModelContext.mockResolvedValue({
            configuration_id: "model-1",
            region: null,
            has_bound_inputs: false,
            filled_app_inputs: [],
            outputs: [],
            unmatched_optional_inputs: []
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

        it("sends dry_run to the adapter and leaves the run planned, not running", async () => {
            const { service, plan, store } = await submitComposite();
            (global.fetch as jest.Mock).mockResolvedValueOnce({
                ok: true,
                json: async () => ({
                    run_id: "generated-run-1",
                    status: "generated",
                    tapis_workflow_definition: { id: "pipeline" }
                })
            });
            const response = await service.submit(
                { plan_id: plan.plan_id, dry_run: true },
                "Bearer user-token"
            );

            const call = (global.fetch as jest.Mock).mock.calls.find(([url]) =>
                String(url).endsWith("/workflows/submit")
            );
            expect(JSON.parse(call[1].body).dry_run).toBe(true);
            expect(response).toMatchObject({
                status: "planned",
                dry_run: true,
                tapis_workflow_definition: { id: "pipeline" }
            });
            await expect(store.getById("parent-1")).resolves.toMatchObject({
                status: "planned",
                idempotency_key: "dry-run:parent-1"
            });
        });

        it("does not send dry_run on a normal submit", async () => {
            const { service, plan } = await submitComposite();
            (global.fetch as jest.Mock).mockResolvedValueOnce({
                ok: true,
                json: async () => ({ run_id: "post-model-run-1", status: "running" })
            });
            await service.submit({ plan_id: plan.plan_id }, "Bearer user-token");
            const call = (global.fetch as jest.Mock).mock.calls.find(([url]) =>
                String(url).endsWith("/workflows/submit")
            );
            expect(JSON.parse(call[1].body)).not.toHaveProperty("dry_run");
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

    describe("input-side ETL planning by the bridge", () => {
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
        const plannedStep = {
            name: "aoi-geojson",
            app_input_name: "aoi-geojson",
            steps: [{ type: "function", name: "aoi-from-boundary" }],
            source: { kind: "geojson" },
            params: {},
            derivation: { method: "region_geometry" }
        };

        // Adapter stub keyed by path; records every call. The digest follows the
        // request's sources so a changed region changes the digest, as it would
        // when the bridge hashes the steps it builds.
        function stubAdapter(
            deferredSteps: unknown[] = [],
            modelInputs: (body: any) => { status?: number; json: any } = (body) => ({
                json: {
                    input_steps: [plannedStep],
                    considered: [
                        {
                            app_input_name: "aoi-geojson",
                            standard_variable_uri: "mint:aoi",
                            optional: true,
                            outcome: "planned",
                            blocking: false
                        }
                    ],
                    steps_digest: `digest-${createHash("sha256").update(JSON.stringify(body.sources)).digest("hex").slice(0, 12)}`,
                    registry: "ok"
                }
            })
        ) {
            (global.fetch as jest.Mock).mockImplementation(async (url: string, init: any) => {
                const path = String(url).replace("http://adapter.local", "");
                if (path === "/plans/model-inputs") {
                    const result = modelInputs(JSON.parse(init.body));
                    const status = result.status ?? 200;
                    return { ok: status < 400, status, json: async () => result.json };
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
        const context = (geometries: any[], extra: Record<string, unknown> = {}) => ({
            configuration_id: "config/subside",
            region: { id: "region-waco", name: "Waco", category_id: "c", geometries },
            has_bound_inputs: true,
            filled_app_inputs: ["earthdata-netrc"],
            unmatched_optional_inputs: [],
            outputs,
            ...extra
        });

        it("sends the region source to /plans/model-inputs and stores the result on the plan", async () => {
            stubAdapter();
            legacy.tapis.compositeModelContext.mockResolvedValue(context([square(0), square(3)]));
            const service = createUnifiedExecutionService(legacy, { store: fakeStore() });
            const plan = (await service.createPlan(
                { ...baseRequest, post_model_adapter: postModel },
                "Bearer user-token"
            )) as any;

            expect(legacy.tapis.compositeModelContext).toHaveBeenCalledWith(
                { thread_id: "thread-1", model_id: "model-1" },
                "Bearer user-token"
            );
            const request = JSON.parse(adapterCalls("/plans/model-inputs")[0][1].body);
            expect(Object.keys(request).sort()).toEqual(
                ["configuration_id", "filled_app_inputs", "sources"].sort()
            );
            expect(request.configuration_id).toBe("config/subside");
            expect(request.filled_app_inputs).toEqual(["earthdata-netrc"]);
            expect(request.sources).toHaveLength(1);
            expect(request.sources[0]).toMatchObject({
                kind: "geojson",
                geometry: { type: "MultiPolygon" },
                derivation: { method: "region_geometry", region_id: "region-waco", vertices_in: 10 }
            });
            expect(request.sources[0].geometry.coordinates).toHaveLength(2);

            expect(plan.input_steps).toEqual([plannedStep]);
            expect(plan.input_sources).toEqual(request.sources);
            expect(plan.filled_app_inputs).toEqual(["earthdata-netrc"]);
            expect(plan.steps_digest).toMatch(/^digest-/);
            expect(plan.input_warnings).toBeUndefined();
            // The signed plan keeps only the references: plan_id is a uniquely
            // indexed column, so geometry and steps must not be encoded into it.
            const stored = (await service.getPlan(plan.plan_id)) as any;
            expect(stored.input_region_id).toBe("region-waco");
            expect(stored.steps_digest).toBe(plan.steps_digest);
            expect(stored.input_steps).toBeUndefined();
            expect(stored.input_sources).toBeUndefined();
            expect(plan.plan_id.length).toBeLessThan(2400);
        });

        it("keeps the plan id small even for a region with many vertices", async () => {
            stubAdapter();
            const ring = Array.from({ length: 3000 }, (_, i) => [
                Math.cos((i / 3000) * 2 * Math.PI),
                Math.sin((i / 3000) * 2 * Math.PI)
            ]);
            ring.push(ring[0]);
            legacy.tapis.compositeModelContext.mockResolvedValue(
                context([{ type: "Polygon", coordinates: [ring] }])
            );
            const service = createUnifiedExecutionService(legacy, { store: fakeStore() });
            const plan = (await service.createPlan(
                { ...baseRequest, post_model_adapter: postModel },
                "Bearer user-token"
            )) as any;
            expect(plan.input_steps).toHaveLength(1);
            expect(plan.plan_id.length).toBeLessThan(2400);
        });

        it("uses the bounding box when the geometry is too large to send inline", async () => {
            stubAdapter();
            const ring = Array.from({ length: 3000 }, (_, i) => [
                100 + Math.cos(i / 3000) * 0.5,
                30 + Math.sin(i / 3000) * 0.5
            ]);
            ring.push(ring[0]);
            legacy.tapis.compositeModelContext.mockResolvedValue(
                context([{ type: "Polygon", coordinates: [ring] }])
            );
            const service = createUnifiedExecutionService(legacy, { store: fakeStore() });
            const plan = (await service.createPlan(
                { ...baseRequest, post_model_adapter: postModel },
                "Bearer user-token"
            )) as any;
            const request = JSON.parse(adapterCalls("/plans/model-inputs")[0][1].body);
            expect(request.sources[0]).toMatchObject({
                kind: "bbox",
                derivation: { method: "region_bbox", vertices_in: 3001 }
            });
            expect(plan.input_sources[0].kind).toBe("bbox");
        });

        it("rejects a non-polygon region geometry", async () => {
            stubAdapter();
            legacy.tapis.compositeModelContext.mockResolvedValue(
                context([{ type: "Point", coordinates: [0, 0] }])
            );
            const service = createUnifiedExecutionService(legacy, { store: fakeStore() });
            await expect(
                service.createPlan(
                    { ...baseRequest, post_model_adapter: postModel },
                    "Bearer user-token"
                )
            ).rejects.toMatchObject({ statusCode: 422, code: "AOI_REGION_GEOMETRY_INVALID" });
            expect(adapterCalls("/plans/model-inputs")).toHaveLength(0);
        });

        it("rejects a model with bound inputs when the thread has no region", async () => {
            stubAdapter();
            legacy.tapis.compositeModelContext.mockResolvedValue({
                ...context([]),
                region: null
            });
            const service = createUnifiedExecutionService(legacy, { store: fakeStore() });
            await expect(
                service.createPlan({ ...baseRequest }, "Bearer user-token")
            ).rejects.toMatchObject({ statusCode: 422, code: "AOI_REGION_UNAVAILABLE" });
        });

        it("makes no adapter call for a model with no bound inputs", async () => {
            stubAdapter();
            legacy.tapis.compositeModelContext.mockResolvedValue(
                context([], { has_bound_inputs: false, region: null })
            );
            const service = createUnifiedExecutionService(legacy, { store: fakeStore() });
            const plan = (await service.createPlan(
                { ...baseRequest, post_model_adapter: postModel },
                "Bearer user-token"
            )) as any;
            expect(plan.input_steps).toBeUndefined();
            expect(adapterCalls("/plans/model-inputs")).toHaveLength(0);
            // Not silent: the plan says why nothing was planned.
            expect(plan.input_warnings).toEqual([expect.stringContaining("no app-input bindings")]);
            expect(
                JSON.parse(
                    Buffer.from(
                        plan.plan_id.slice(3).split(".")[0].replace(/-/g, "+").replace(/_/g, "/"),
                        "base64"
                    ).toString("utf8")
                )
            ).not.toHaveProperty("input_steps");
        });

        it("turns an adapter 404 into 502 ADAPTER_CAPABILITY_MISSING, never no steps", async () => {
            stubAdapter([], () => ({ status: 404, json: { detail: "Not Found" } }));
            legacy.tapis.compositeModelContext.mockResolvedValue(context([square(0)]));
            const service = createUnifiedExecutionService(legacy, { store: fakeStore() });
            await expect(
                service.createPlan({ ...baseRequest }, "Bearer user-token")
            ).rejects.toMatchObject({ statusCode: 502, code: "ADAPTER_CAPABILITY_MISSING" });
        });

        it("passes other adapter refusals through unchanged", async () => {
            stubAdapter([], () => ({
                status: 422,
                json: { detail: { code: "AOI_REGION_TOO_LARGE", message: "too large" } }
            }));
            legacy.tapis.compositeModelContext.mockResolvedValue(context([square(0)]));
            const service = createUnifiedExecutionService(legacy, { store: fakeStore() });
            await expect(
                service.createPlan({ ...baseRequest }, "Bearer user-token")
            ).rejects.toMatchObject({ statusCode: 422, code: "AOI_REGION_TOO_LARGE" });
        });

        it("rejects a blocking no_path with 422 NO_INPUT_TRANSFORM_PATH", async () => {
            stubAdapter([], () => ({
                json: {
                    input_steps: [],
                    considered: [
                        {
                            app_input_name: "aoi-geojson",
                            standard_variable_uri: "mint:aoi",
                            optional: false,
                            outcome: "no_path",
                            blocking: true
                        }
                    ],
                    steps_digest: "d",
                    registry: "ok"
                }
            }));
            legacy.tapis.compositeModelContext.mockResolvedValue(context([square(0)]));
            const service = createUnifiedExecutionService(legacy, { store: fakeStore() });
            await expect(
                service.createPlan({ ...baseRequest }, "Bearer user-token")
            ).rejects.toMatchObject({
                statusCode: 422,
                code: "NO_INPUT_TRANSFORM_PATH",
                message: expect.stringContaining("aoi-geojson")
            });
        });

        describe("input warnings", () => {
            const warningResult = () => ({
                json: {
                    input_steps: [],
                    considered: [
                        {
                            app_input_name: "aoi-geojson",
                            optional: true,
                            outcome: "unbound",
                            blocking: false
                        },
                        {
                            app_input_name: "dem",
                            optional: true,
                            outcome: "no_path",
                            blocking: false
                        },
                        { app_input_name: "ok", outcome: "filled", blocking: false }
                    ],
                    steps_digest: "d",
                    registry: "missing"
                }
            });

            it("lists registry-missing, unbound, optional no_path and unmatched optional inputs", async () => {
                stubAdapter([], warningResult);
                legacy.tapis.compositeModelContext.mockResolvedValue(
                    context([square(0)], { unmatched_optional_inputs: ["extra-input"] })
                );
                const service = createUnifiedExecutionService(legacy, { store: fakeStore() });
                const plan = (await service.createPlan(
                    { ...baseRequest },
                    "Bearer user-token"
                )) as any;
                expect(plan.input_warnings).toHaveLength(4);
                expect(plan.input_warnings.join("\n")).toEqual(
                    expect.stringContaining("sync-from-mint")
                );
                expect(plan.input_warnings.join("\n")).toEqual(
                    expect.stringContaining("aoi-geojson")
                );
                expect(plan.input_warnings.join("\n")).toEqual(expect.stringContaining("dem"));
                expect(plan.input_warnings.join("\n")).toEqual(
                    expect.stringContaining("extra-input")
                );
                // No steps: the plan stays an ordinary non-composite plan.
                expect(plan.input_steps).toBeUndefined();
                expect(plan.status).toBe("ready");
                // Warnings are advisory and travel with the response, not the plan.
                expect((await service.getPlan(plan.plan_id)) as any).not.toHaveProperty(
                    "input_warnings"
                );
            });

            it("strict_inputs turns warnings into 422 INPUT_WARNINGS", async () => {
                stubAdapter([], warningResult);
                legacy.tapis.compositeModelContext.mockResolvedValue(context([square(0)]));
                const service = createUnifiedExecutionService(legacy, { store: fakeStore() });
                await expect(
                    service.createPlan({ ...baseRequest, strict_inputs: true }, "Bearer user-token")
                ).rejects.toMatchObject({ statusCode: 422, code: "INPUT_WARNINGS" });
            });

            it("strict_inputs passes a clean plan", async () => {
                stubAdapter();
                legacy.tapis.compositeModelContext.mockResolvedValue(context([square(0)]));
                const service = createUnifiedExecutionService(legacy, { store: fakeStore() });
                const plan = (await service.createPlan(
                    { ...baseRequest, strict_inputs: true },
                    "Bearer user-token"
                )) as any;
                expect(plan.input_warnings).toBeUndefined();
                expect(plan.input_steps).toHaveLength(1);
            });
        });

        it("plans automatically for a plain Tapis plan with no flag or post-model adapter", async () => {
            stubAdapter([]);
            legacy.tapis.compositeModelContext.mockResolvedValue(context([square(0)]));
            const service = createUnifiedExecutionService(legacy, { store: fakeStore() });
            const plan = (await service.createPlan({ ...baseRequest }, "Bearer user-token")) as any;
            expect(plan.status).toBe("post_model_ready");
            expect(plan.input_steps).toHaveLength(1);
            expect(plan.post_model_adapter).toMatchObject({ adapter_plan_id: "deferred-plan-1" });
        });

        it("does not plan when input_etl is false", async () => {
            stubAdapter([]);
            legacy.tapis.compositeModelContext.mockResolvedValue(context([square(0)]));
            const service = createUnifiedExecutionService(legacy, { store: fakeStore() });
            const plan = (await service.createPlan(
                { ...baseRequest, input_etl: false },
                "Bearer user-token"
            )) as any;
            expect(legacy.tapis.compositeModelContext).not.toHaveBeenCalled();
            expect(adapterCalls("/plans/model-inputs")).toHaveLength(0);
            expect(plan.input_steps).toBeUndefined();
            expect(plan.status).toBe("ready");
        });

        it("leaves a plan whose model has no bound input (e.g. MODFLOW) unchanged", async () => {
            stubAdapter();
            legacy.tapis.compositeModelContext.mockResolvedValue(
                context([square(0)], { has_bound_inputs: false })
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
            legacy.tapis.compositeModelContext.mockResolvedValue(context([square(0)]));
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

        it("keeps an input-only request a plain plan when the bridge plans no steps", async () => {
            stubAdapter([], () => ({
                json: { input_steps: [], considered: [], steps_digest: "d", registry: "ok" }
            }));
            legacy.tapis.compositeModelContext.mockResolvedValue(context([square(0)]));
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
            legacy.tapis.compositeModelContext.mockResolvedValue(context([square(0)]));
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

            async function planAndSubmit(geometries: any[]) {
                stubAdapter();
                legacy.tapis.compositeModelContext.mockResolvedValue(context(geometries));
                legacy.tapis.buildCompositeWorkflowModelTask.mockResolvedValue(modelTaskResult());
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

            it("sends input_sources, filled_app_inputs and expected_steps_digest, not steps", async () => {
                const { plan, body } = await planAndSubmit([square(0)]);
                expect(Object.keys(body.model_task).sort()).toEqual(
                    [
                        "configuration_id",
                        "expected_steps_digest",
                        "filled_app_inputs",
                        "input_sources",
                        "job_definition",
                        "output_format",
                        "output_name",
                        "output_uri",
                        "required_secrets",
                        "stage_id"
                    ].sort()
                );
                expect(body.model_task).not.toHaveProperty("input_steps");
                expect(body.model_task.input_sources).toEqual(plan.input_sources);
                expect(body.model_task.filled_app_inputs).toEqual(plan.filled_app_inputs);
                expect(body.model_task.expected_steps_digest).toBe(plan.steps_digest);
            });

            it("puts the steps digest in the idempotency key", async () => {
                const a = await planAndSubmit([square(0)]);
                const b = await planAndSubmit([square(7)]);
                const keyA = a.call[1].headers["Idempotency-Key"];
                const keyB = b.call[1].headers["Idempotency-Key"];
                expect(keyA).toBe(a.body.idempotency_key);
                expect(keyA.endsWith(`:in-${a.plan.steps_digest}`)).toBe(true);
                expect(keyA).not.toBe(keyB);
            });

            it("refuses to submit when the thread region changed since the plan", async () => {
                stubAdapter();
                legacy.tapis.compositeModelContext.mockResolvedValue(context([square(0)]));
                legacy.tapis.buildCompositeWorkflowModelTask.mockResolvedValue(modelTaskResult());
                const service = createUnifiedExecutionService(legacy, { store: fakeStore() });
                const plan = (await service.createPlan(
                    { ...baseRequest, post_model_adapter: postModel },
                    "Bearer user-token"
                )) as any;
                legacy.tapis.compositeModelContext.mockResolvedValue(
                    context([square(0)], {
                        region: {
                            id: "region-dallas",
                            name: "Dallas",
                            category_id: "c",
                            geometries: [square(0)]
                        }
                    })
                );
                await expect(
                    service.submit({ plan_id: plan.plan_id }, "Bearer user-token")
                ).rejects.toMatchObject({ statusCode: 422, code: "INPUT_REGION_CHANGED" });
                expect(adapterCalls("/workflows/submit")).toHaveLength(0);
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

            it("leaves MODFLOW-style composite plans unchanged", async () => {
                stubAdapter();
                legacy.tapis.compositeModelContext.mockResolvedValue(
                    context([square(0)], { has_bound_inputs: false })
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
                for (const key of [
                    "input_steps",
                    "input_sources",
                    "filled_app_inputs",
                    "expected_steps_digest"
                ]) {
                    expect(body.model_task).not.toHaveProperty(key);
                }
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

    describe("output publication", () => {
        const stacStep = { type: "catalog_register", name: "stac-publish", publishes: true };
        const publishers = {
            configuration_id: "model-1",
            publishers: [
                {
                    transform_spec_id: "ts-subside-stac-publish",
                    name: "STAC publish",
                    catalog_tokens: ["ckan", "stac"],
                    parameters: [
                        {
                            name: "stac_collection",
                            type: "string",
                            required: false,
                            default: "subsidence-rates-dev",
                            allowed_values: ["subsidence-rates-dev"]
                        },
                        { name: "public", type: "boolean", required: false, default: false }
                    ],
                    can_publish: { ok: true, reason: "" }
                }
            ]
        };
        const baseRequest = {
            executor: "ensemble_manager",
            thread_id: "thread-1",
            model_id: "model-1",
            execution_engine: "tapis"
        };
        const plannedInput = {
            name: "aoi-geojson",
            app_input_name: "aoi-geojson",
            steps: [{ type: "function", name: "aoi-from-boundary" }],
            source: { kind: "geojson" },
            params: {},
            derivation: { method: "region_geometry" }
        };
        const square = {
            type: "Polygon",
            coordinates: [
                [
                    [0, 0],
                    [1, 0],
                    [1, 1],
                    [0, 1],
                    [0, 0]
                ]
            ]
        };

        function stubAdapter(deferredSteps: unknown[] = [stacStep]) {
            (global.fetch as jest.Mock).mockImplementation(async (url: string, init: any) => {
                const path = String(url).replace("http://adapter.local", "");
                const ok = (json: unknown) => ({ ok: true, status: 200, json: async () => json });
                if (path.startsWith("/publishers")) return ok(publishers);
                if (path === "/plans/model-inputs") {
                    return ok({
                        input_steps: [plannedInput],
                        considered: [],
                        steps_digest: "digest-1",
                        registry: "ok"
                    });
                }
                if (path === "/plans/deferred") {
                    return ok({
                        status: "deferred",
                        plan_id: "deferred-plan-1",
                        plan_hash: "deferred-hash-1",
                        plan_json: {
                            parameters: publishers.publishers[0].parameters,
                            steps: deferredSteps
                        }
                    });
                }
                return ok({ run_id: "run-1", status: "queued" });
            });
            legacy.tapis.compositeModelContext.mockResolvedValue({
                configuration_id: "config/subside",
                region: {
                    id: "region-waco",
                    name: "Waco",
                    category_id: "c",
                    geometries: [square]
                },
                has_bound_inputs: true,
                filled_app_inputs: [],
                unmatched_optional_inputs: [],
                outputs: [{ id: "out-io", name: "displacement", format: "geotiff" }]
            });
        }
        const calls = (path: string) =>
            (global.fetch as jest.Mock).mock.calls.filter(([url]) => String(url).endsWith(path));

        it("sets the target catalog from publish and lists the publisher parameters", async () => {
            stubAdapter();
            const service = createUnifiedExecutionService(legacy, { store: fakeStore() });
            const plan = (await service.createPlan(
                { ...baseRequest, publish: ["ckan", "stac"] },
                "Bearer user-token"
            )) as any;

            const deferred = JSON.parse(calls("/plans/deferred")[0][1].body);
            expect(deferred.source_contract).toEqual({ format: "geotiff" });
            expect(deferred.target_contract).toEqual({ format: "geotiff", catalog: "ckan+stac" });
            expect(calls("/publishers?configuration_id=model-1")).toHaveLength(1);
            expect(calls("/publishers?configuration_id=model-1")[0][1].headers).toMatchObject({
                Authorization: "Bearer user-token"
            });
            expect(plan.status).toBe("post_model_ready");
            expect(plan.parameters.map((p: any) => p.name)).toEqual(["stac_collection", "public"]);
            expect(plan.parameters[0].allowed_values).toEqual(["subsidence-rates-dev"]);
            expect(((await service.getPlan(plan.plan_id)) as any).publish).toEqual([
                "ckan",
                "stac"
            ]);
        });

        it("merges the catalog into an explicit post_model_adapter target contract", async () => {
            stubAdapter();
            const service = createUnifiedExecutionService(legacy, { store: fakeStore() });
            await service.createPlan(
                {
                    ...baseRequest,
                    input_etl: false,
                    publish: ["stac"],
                    post_model_adapter: {
                        model_io_id: "out-io",
                        model_output_key: "displacement",
                        source_contract: { format: "geotiff" },
                        target_contract: { format: "geotiff", unit: "m" }
                    }
                },
                "Bearer user-token"
            );
            const deferred = JSON.parse(calls("/plans/deferred")[0][1].body);
            expect(deferred.target_contract).toEqual({
                format: "geotiff",
                unit: "m",
                catalog: "stac"
            });
        });

        it("rejects an unknown catalog token with the available tokens", async () => {
            stubAdapter();
            const service = createUnifiedExecutionService(legacy, { store: fakeStore() });
            await expect(
                service.createPlan({ ...baseRequest, publish: ["zenodo"] }, "Bearer user-token")
            ).rejects.toMatchObject({
                statusCode: 422,
                code: "PUBLISH_CATALOG_UNKNOWN",
                details: { requested: ["zenodo"], available: ["ckan", "stac"] }
            });
            expect(calls("/plans/deferred")).toHaveLength(0);
        });

        it("does not consult the adapter publishers when publish is empty or absent", async () => {
            stubAdapter([]);
            const service = createUnifiedExecutionService(legacy, { store: fakeStore() });
            const plan = (await service.createPlan(
                { ...baseRequest, publish: [] },
                "Bearer user-token"
            )) as any;
            expect(calls("/publishers?configuration_id=model-1")).toHaveLength(0);
            expect(JSON.parse(calls("/plans/deferred")[0][1].body).target_contract).toEqual({
                format: "geotiff"
            });
            expect(((await service.getPlan(plan.plan_id)) as any).publish).toBeUndefined();
        });

        it("builds the publish plan for a model that derives no input steps and dispatches it as usual", async () => {
            stubAdapter();
            legacy.tapis.compositeModelContext.mockResolvedValue({
                configuration_id: "config/subside",
                region: null,
                has_bound_inputs: false,
                filled_app_inputs: [],
                unmatched_optional_inputs: [],
                outputs: [{ id: "out-io", name: "displacement", format: "geotiff" }]
            });
            legacy.tapis.buildCompositeWorkflowModelTask.mockResolvedValue({
                execution_id: "model-child-1",
                output_uri: "tapis://ls6/mint-workflow-output/ue_parent-1/model/displacement",
                output_name: "displacement",
                job_definition: { name: "j", appId: "a", appVersion: "1" }
            });
            const store = fakeStore();
            const service = createUnifiedExecutionService(legacy, { store });
            const plan = (await service.createPlan(
                { ...baseRequest, publish: ["ckan", "stac"] },
                "Bearer user-token"
            )) as any;
            expect(plan.status).toBe("post_model_ready");
            expect(plan.input_steps).toBeUndefined();
            expect(plan.post_model_adapter.target_contract).toEqual({
                format: "geotiff",
                catalog: "ckan+stac"
            });
            expect(plan.parameters).toHaveLength(2);

            await service.submit({ plan_id: plan.plan_id }, "Bearer user-token");
            const submit = JSON.parse(calls("/workflows/submit")[0][1].body);
            expect(submit.model_task).toMatchObject({ output_name: "displacement" });
            expect(submit.expected_steps_digest).toBeUndefined();
            expect(submit.input_sources).toBeUndefined();
            expect(submit.plan_id).toBe("deferred-plan-1");
        });

        it("refuses publish when the plan has no post-model stage", async () => {
            stubAdapter();
            const service = createUnifiedExecutionService(legacy, { store: fakeStore() });
            await expect(
                service.createPlan(
                    { ...baseRequest, input_etl: false, publish: ["stac"] },
                    "Bearer user-token"
                )
            ).rejects.toMatchObject({ statusCode: 422, code: "PUBLISH_REQUIRES_POST_MODEL" });
        });

        it("accepts publishing steps on an identity plan and rejects other steps", async () => {
            stubAdapter([stacStep]);
            const service = createUnifiedExecutionService(legacy, { store: fakeStore() });
            await expect(
                service.createPlan({ ...baseRequest, publish: ["stac"] }, "Bearer user-token")
            ).resolves.toMatchObject({ status: "post_model_ready" });

            stubAdapter([{ type: "unit_convert" }]);
            await expect(
                service.createPlan({ ...baseRequest, publish: ["stac"] }, "Bearer user-token")
            ).rejects.toMatchObject({ code: "INPUT_ONLY_PLAN_NOT_IDENTITY" });
        });

        it("still rejects a publishing step on an identity plan that did not ask to publish", async () => {
            stubAdapter([stacStep]);
            const service = createUnifiedExecutionService(legacy, { store: fakeStore() });
            await expect(
                service.createPlan({ ...baseRequest }, "Bearer user-token")
            ).rejects.toMatchObject({ code: "INPUT_ONLY_PLAN_NOT_IDENTITY" });
        });

        it("keeps the encoded plan under the size budget with publish and long ids", async () => {
            stubAdapter();
            legacy.tapis.compositeModelContext.mockResolvedValue({
                configuration_id: "config/subside",
                region: {
                    id: "r".repeat(36),
                    name: "Waco",
                    category_id: "c",
                    geometries: [square]
                },
                has_bound_inputs: true,
                filled_app_inputs: [],
                unmatched_optional_inputs: [],
                outputs: [{ id: "o".repeat(120), name: "displacement", format: "geotiff" }]
            });
            const service = createUnifiedExecutionService(legacy, { store: fakeStore() });
            const plan = (await service.createPlan(
                {
                    ...baseRequest,
                    thread_id: "t".repeat(60),
                    model_id: "m".repeat(120),
                    publish: ["ckan", "stac"]
                },
                "Bearer user-token"
            )) as any;
            expect(plan.plan_id.length).toBeLessThan(2400);
            expect(plan.parameters).toHaveLength(2);
        });

        // Post-model reconciliation: a stored plan, a record, and an adapter stub.
        const secretSign = (plan: Record<string, unknown>) => {
            const encoded = Buffer.from(JSON.stringify(plan))
                .toString("base64")
                .replace(/\+/g, "-")
                .replace(/\//g, "_")
                .replace(/=+$/, "");
            const signature = require("crypto")
                .createHmac("sha256", "test-secret")
                .update(encoded)
                .digest("hex");
            return `em_${encoded}.${signature}`;
        };
        const wacoPlan = (extra: Record<string, unknown> = {}) => ({
            executor: "ensemble_manager",
            thread_id: "thread-1",
            model_id: "model-1",
            execution_engine: "tapis",
            input_region_id: "region-waco",
            steps_digest: "digest-1",
            post_model_adapter: {
                adapter_plan_id: "deferred-plan-1",
                model_io_id: "out-io",
                model_output_key: "displacement",
                source_contract: { format: "geotiff" },
                target_contract: { format: "geotiff" },
                plan_hash: "deferred-hash-1",
                parameters: []
            },
            ...extra
        });
        const seed = async (
            store: UnifiedExecutionStore,
            set: Partial<UnifiedExecutionRecord>,
            planExtra: Record<string, unknown> = {}
        ) =>
            store.insert({
                plan_id: secretSign(wacoPlan(planExtra)),
                thread_id: "thread-1",
                model_id: "model-1",
                execution_engine: "tapis",
                status: "adapter_running",
                idempotency_key: "k",
                plan_hash: "h",
                adapter_steps: [],
                adapter_run_ids: [],
                parameter_values: {},
                parameter_values_hash: "pv",
                model_child_id: "model-child-1",
                model_result: { output_uri: "tapis://ls6/out/model" },
                output_handoff: { data_object_id: "do-1", resource_uri: "tapis://ls6/out/model" },
                ...set
            } as any);
        const postModelChild = (extra: Record<string, unknown> = {}) => ({
            adapter_plan_id: "deferred-plan-1",
            model_io_id: "out-io",
            stage: "post_model",
            run_id: "post-run-1",
            status: "running",
            execution_kind: "workflow",
            ...extra
        });
        function stubRun(run: Record<string, unknown>, overrides: Record<string, any> = {}) {
            (global.fetch as jest.Mock).mockImplementation(async (url: string) => {
                const path = String(url).replace("http://adapter.local", "");
                const respond = (status: number, json: unknown) => ({
                    ok: status < 400,
                    status,
                    json: async () => json
                });
                if (overrides[path]) return respond(...(overrides[path] as [number, unknown]));
                if (path === "/runs/post-run-1/poll" || path === "/runs/post-run-1") {
                    return respond(200, run);
                }
                if (path.endsWith("/register-output")) {
                    return respond(200, { output_data_object: { id: "do-final" } });
                }
                if (path.endsWith("/bind")) return respond(200, { bound_plan_id: "bound-1" });
                if (path === "/workflows/submit") {
                    return respond(200, { run_id: "post-run-2", status: "running" });
                }
                return respond(200, {});
            });
        }

        it("ends completed with the output retained when the publication failed, and never resubmits", async () => {
            stubRun({
                status: "failed",
                error_message: "task failed",
                publication: { status: "failed", error: "CKAN 403 forbidden" }
            });
            const store = fakeStore();
            await seed(store, { adapter_run_ids: [postModelChild()] });
            const service = createUnifiedExecutionService(legacy, { store });

            const first = (await service.getRun("ue_parent-1", "Bearer user-token")) as any;
            expect(first.status).toBe("completed");
            expect(first.output_handoff).toMatchObject({
                data_object_id: "do-1",
                resource_uri: "tapis://ls6/out/model",
                publication: { status: "failed", error: "CKAN 403 forbidden" }
            });
            expect(legacy.tapis.updateCompositeWorkflowExecution).toHaveBeenCalledWith(
                "thread-1",
                "model-1",
                "model-child-1",
                "completed",
                expect.objectContaining({ url: "tapis://ls6/out/model" })
            );

            const second = (await service.getRun("ue_parent-1", "Bearer user-token")) as any;
            expect(second.status).toBe("completed");
            expect(second.output_handoff.publication.status).toBe("failed");
            expect(calls("/workflows/submit")).toHaveLength(0);
            expect(calls("/bind")).toHaveLength(0);
            const mirror = legacy.tapis.updateCompositeWorkflowExecution.mock.calls.at(-1);
            expect(mirror?.[3]).toBe("completed");
            expect(mirror?.[4]).toBeDefined();
        });

        it("copies the publication links into output_handoff when published", async () => {
            const publication = {
                status: "published",
                ckan_dataset: "https://ckan.test/dataset/ue-1",
                stac_item: "https://stac.test/collections/c/items/ue-1",
                public: true,
                catalog: "ckan+stac",
                extra_field: "dropped"
            };
            stubRun({
                status: "completed",
                output_uri: "tapis://ls6/out/final",
                publication
            });
            const store = fakeStore();
            await seed(store, { adapter_run_ids: [postModelChild()] });
            const service = createUnifiedExecutionService(legacy, { store });

            const done = (await service.getRun("ue_parent-1", "Bearer user-token")) as any;
            expect(done.status).toBe("completed");
            expect(done.output_handoff.publication).toEqual({
                status: "published",
                ckan_dataset: publication.ckan_dataset,
                stac_item: publication.stac_item,
                public: true,
                catalog: "ckan+stac"
            });
        });

        it("completes a published run from output_handoff alone, ignoring the child's STAC output_uri", async () => {
            const publication = { status: "published", stac_item: "https://stacapi.test/i/1" };
            for (const outputUri of ["https://stacapi.test/collections/c/items/ue-1", undefined]) {
                jest.clearAllMocks();
                stubRun({
                    status: "completed",
                    ...(outputUri ? { output_uri: outputUri } : {}),
                    publication
                });
                const store = fakeStore();
                await seed(store, { adapter_run_ids: [postModelChild()] });
                const service = createUnifiedExecutionService(legacy, { store });

                const done = (await service.getRun("ue_parent-1", "Bearer user-token")) as any;
                expect(done.status).toBe("completed");
                expect(done.output_handoff).toMatchObject({
                    data_object_id: "do-1",
                    resource_uri: "tapis://ls6/out/model",
                    publication: { status: "published" }
                });
                expect(done.output_handoff.final_resource_uri).toBeUndefined();
                expect(done.output_handoff.final_output_data_object_id).toBeUndefined();
                expect(calls("/register-output")).toHaveLength(0);
                for (const call of legacy.tapis.updateCompositeWorkflowExecution.mock.calls) {
                    expect(call[4]?.url).toBe("tapis://ls6/out/model");
                }
                // A later poll neither resubmits nor waits on the child.
                const again = (await service.getRun("ue_parent-1", "Bearer user-token")) as any;
                expect(again.status).toBe("completed");
                expect(calls("/workflows/submit")).toHaveLength(0);
            }
        });

        it("keeps a polled publication when the persisted run carries null", async () => {
            const publication = { status: "published", stac_item: "https://stac.test/i/1" };
            stubRun(
                {},
                {
                    "/runs/post-run-1/poll": [200, { status: "completed", publication }],
                    "/runs/post-run-1": [200, { status: "completed", publication: null }]
                }
            );
            const store = fakeStore();
            await seed(store, { adapter_run_ids: [postModelChild()] });
            const service = createUnifiedExecutionService(legacy, { store });
            const done = (await service.getRun("ue_parent-1", "Bearer user-token")) as any;
            expect(done.output_handoff.publication.status).toBe("published");
        });

        it("does not mirror the handoff URI for a run without a publication outcome", async () => {
            stubRun({ status: "completed", output_uri: "tapis://ls6/out/final" });
            const store = fakeStore();
            await seed(store, {
                status: "completed",
                model_result: {},
                adapter_run_ids: [],
                output_handoff: { data_object_id: "do-1", resource_uri: "tapis://ls6/out/model" }
            });
            const service = createUnifiedExecutionService(legacy, { store });
            await service.getRun("ue_parent-1", "Bearer user-token");
            expect(legacy.tapis.updateCompositeWorkflowExecution).toHaveBeenCalledWith(
                "thread-1",
                "model-1",
                "model-child-1",
                "completed",
                undefined
            );
        });

        it("does not mark awaiting_owner for a plan that did not ask to publish", async () => {
            legacy.tapis.getExecution.mockResolvedValue({
                status: "SUCCESS",
                results: [
                    {
                        model_io: { id: "out-io" },
                        resource: { name: "disp", url: "tapis://ls6/out/model" }
                    }
                ]
            });
            legacy.tapis.getJobStatus.mockResolvedValue({ status: "SUCCESS" });
            stubRun({}, { "/workflows/submit": [403, { detail: { code: "RUN_OWNER_MISMATCH" } }] });
            const store = fakeStore();
            await seed(store, { status: "model_succeeded" });
            const service = createUnifiedExecutionService(legacy, { store });
            const run = (await service.getRun("ue_parent-1", "Bearer other")) as any;
            expect(run.status).toBe("failed");
            expect(run.output_handoff?.publication).toBeUndefined();
        });

        it("rejects a submitted value outside allowed_values and merges top-level with per-plan values", async () => {
            stubAdapter();
            const service = createUnifiedExecutionService(legacy, { store: fakeStore() });
            const plan = (await service.createPlan(
                { ...baseRequest, publish: ["ckan", "stac"] },
                "Bearer user-token"
            )) as any;
            legacy.tapis.buildCompositeWorkflowModelTask.mockResolvedValue({
                execution_id: "model-child-1",
                output_uri: "tapis://ls6/o",
                output_name: "displacement",
                job_definition: { name: "j", appId: "a", appVersion: "1" }
            });
            await expect(
                service.submit(
                    {
                        plan_id: plan.plan_id,
                        parameter_values: { stac_collection: "subsidence-rates" }
                    },
                    "Bearer user-token"
                )
            ).rejects.toMatchObject({
                statusCode: 422,
                code: "PARAMETER_VALIDATION_FAILED",
                details: {
                    fields: [
                        {
                            name: "stac_collection",
                            reason: "not_allowed",
                            allowed: ["subsidence-rates-dev"]
                        }
                    ]
                }
            });
            expect(calls("/workflows/submit")).toHaveLength(0);

            await service.submit(
                {
                    plan_id: plan.plan_id,
                    parameter_values: { public: true },
                    adapter_parameter_values: {
                        "deferred-plan-1": { stac_collection: "subsidence-rates-dev" }
                    }
                },
                "Bearer user-token"
            );
            const args = JSON.parse(calls("/workflows/submit")[0][1].body).args;
            expect(args).toMatchObject({ public: true, stac_collection: "subsidence-rates-dev" });
        });

        it("waits for the owner on a 403 RUN_OWNER_MISMATCH and retries on a later poll", async () => {
            legacy.tapis.getExecution.mockResolvedValue({
                status: "SUCCESS",
                results: [
                    {
                        model_io: { id: "out-io" },
                        resource: { name: "disp", url: "tapis://ls6/out/model" }
                    }
                ]
            });
            legacy.tapis.getJobStatus.mockResolvedValue({ status: "SUCCESS" });
            stubRun({}, { "/workflows/submit": [403, { detail: { code: "RUN_OWNER_MISMATCH" } }] });
            const store = fakeStore();
            await seed(store, { status: "model_succeeded" }, { publish: ["ckan", "stac"] });
            const service = createUnifiedExecutionService(legacy, { store });

            const awaiting = (await service.getRun("ue_parent-1", "Bearer other-user")) as any;
            expect(awaiting.status).toBe("model_succeeded");
            expect(awaiting.status).not.toBe("failed");
            expect(awaiting.output_handoff.publication).toEqual({ status: "awaiting_owner" });
            expect(awaiting.failure_code ?? null).toBeNull();

            stubRun({});
            const dispatched = (await service.getRun("ue_parent-1", "Bearer owner")) as any;
            expect(dispatched.status).toBe("adapter_running");
            const submits = calls("/workflows/submit");
            expect(submits).toHaveLength(2);
            expect(submits[1][1].headers).toMatchObject({ Authorization: "Bearer owner" });
            expect(dispatched.output_handoff.publication).toBeUndefined();
        });

        it("dispatches an old identity plan with no publish as before", async () => {
            legacy.tapis.getExecution.mockResolvedValue({
                status: "SUCCESS",
                results: [
                    {
                        model_io: { id: "out-io" },
                        resource: { name: "disp", url: "tapis://ls6/out/model" }
                    }
                ]
            });
            legacy.tapis.getJobStatus.mockResolvedValue({ status: "SUCCESS" });
            stubRun({});
            const store = fakeStore();
            await seed(store, { status: "model_succeeded" });
            const service = createUnifiedExecutionService(legacy, { store });
            const planId = secretSign(wacoPlan());
            expect(((await service.getPlan(planId)) as any).publish).toBeUndefined();

            const run = (await service.getRun("ue_parent-1", "Bearer owner")) as any;
            expect(run.status).toBe("adapter_running");
            expect(calls("/workflows/submit")).toHaveLength(1);
            expect(calls("/publishers?configuration_id=model-1")).toHaveLength(0);
            const body = JSON.parse(calls("/workflows/submit")[0][1].body);
            expect(JSON.stringify(body)).not.toContain("catalog");
            expect(run.output_handoff.publication).toBeUndefined();
        });

        it("proxies the adapter publishers for a model", async () => {
            stubAdapter();
            const service = createUnifiedExecutionService(legacy, { store: fakeStore() });
            await expect(service.listPublishers("model-1", "Bearer user-token")).resolves.toEqual(
                publishers
            );
            await expect(service.listPublishers(undefined)).rejects.toMatchObject({
                statusCode: 400
            });
        });
    });
});
