import { createUnifiedExecutionService } from "./unifiedExecutionService";
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
            getExecution: jest.fn(),
            getJobStatus: jest.fn(),
            updateCompositeWorkflowExecution: jest.fn()
        }
    };

    beforeEach(() => {
        jest.clearAllMocks();
        global.fetch = jest.fn();
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
        (global.fetch as jest.Mock)
            .mockResolvedValueOnce({
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
            submittedExecutions: [
                { execution: { id: "model-child-1" }, jobId: "provider-job-1" }
            ]
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
