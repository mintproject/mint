import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { createHash } from "crypto";
import unifiedExecutionRouter from "@/api/api-v1/paths/unifiedExecution";
import { NotFoundError, UnifiedExecutionError } from "@/classes/common/errors";
import {
    bboxOfGeometries,
    createScenarioService,
    ScenarioDeps,
    standingProblemStatementId
} from "./scenarioService";
import { UnifiedExecutionRecord } from "./unifiedExecutionStore";

jest.mock("@/classes/mint/mint-functions", () => ({
    getConfiguration: jest.fn().mockReturnValue({
        auth: { public_key: "test-key", algorithms: ["HS256"] }
    })
}));
jest.mock("@/classes/graphql/graphql_functions", () => ({}));
jest.mock("@/classes/graphql/graphql_functions_v2", () => ({}));

const tokenFor = (username: string) =>
    `Bearer ${jwt.sign({ "tapis/username": username }, "test-key", { algorithm: "HS256" })}`;
const alice = tokenFor("alice");
const bob = tokenFor("bob");

const scoped = (username: string, key: string) =>
    `${createHash("sha256").update(username).digest("hex").slice(0, 12)}:${key}`;

const MODEL = "https://w3id.org/okn/i/mint/opera-disp-s1-werc";
const SQUARE = {
    type: "Polygon",
    coordinates: [
        [
            [-97.3, 31.4],
            [-97.0, 31.4],
            [-97.0, 31.7],
            [-97.3, 31.7],
            [-97.3, 31.4]
        ]
    ]
};

function build(overrides: Partial<ScenarioDeps> = {}) {
    const calls: string[] = [];
    const problemStatements = new Map<string, any>();
    const records: UnifiedExecutionRecord[] = [];
    let threadCounter = 0;
    let planCounter = 0;

    const deps: ScenarioDeps = {
        unified: {
            createPlan: jest.fn(async (body: any) => {
                calls.push("plan");
                planCounter += 1;
                return {
                    plan_id: `plan-${planCounter}`,
                    parameters: [{ name: "ckan_dataset" }],
                    post_model_adapter: { adapter_plan_id: "adapter-1" },
                    body
                };
            }),
            submit: jest.fn(async (body: any) => {
                calls.push("submit");
                const record = {
                    id: `exec-${records.length + 1}`,
                    plan_id: body.plan_id,
                    thread_id: [...problemStatements.values()]
                        .flatMap((ps) => Object.values<any>(ps.tasks))
                        .flatMap((task) => Object.keys(task.threads))
                        .pop(),
                    model_id: MODEL,
                    status: "model_running",
                    // The real service frees the key of a dry-run record.
                    idempotency_key: body.dry_run
                        ? `dry-run:${records.length + 1}`
                        : body.idempotency_key,
                    created_at: `2026-11-0${records.length + 1}T00:00:00Z`
                } as UnifiedExecutionRecord;
                records.push(record);
                return { run_id: `ue_${record.id}`, status: record.status };
            })
        },
        store: {
            findByIdempotencyKey: async (key) =>
                records.find((record) => record.idempotency_key === key) || null,
            listByThreads: jest.fn(async (ids: string[]) =>
                records.filter((record) => ids.includes(record.thread_id))
            )
        } as any,
        problemStatements: {
            createProblemStatement: jest.fn(async (ps: any, _auth: string, options: any = {}) => {
                calls.push("problem_statement");
                if (!problemStatements.has(options.id)) {
                    problemStatements.set(options.id, {
                        id: options.id,
                        permissions: options.permissions,
                        tasks: {}
                    });
                }
                return options.id;
            }),
            getProblemStatementById: jest.fn(async (id: string) => {
                const ps = problemStatements.get(id);
                if (!ps) throw new NotFoundError("Problem statement not found");
                return ps;
            })
        } as any,
        tasks: {
            createTask: jest.fn(async (psId: string, task: any, _auth: string, options: any) => {
                calls.push("task");
                const ps = problemStatements.get(psId);
                ps.tasks[options.id] ||= { id: options.id, regionid: task.regionid, threads: {} };
                return options.id;
            })
        } as any,
        subTasks: {
            createSubtask: jest.fn(
                async (
                    psId: string,
                    taskId: string,
                    thread: any,
                    _auth: string,
                    options: any = {}
                ) => {
                    calls.push("thread");
                    threadCounter += 1;
                    const id = `thread-${threadCounter}`;
                    problemStatements.get(psId).tasks[taskId].threads[id] = {
                        id,
                        name: thread.name,
                        regionid: undefined,
                        permissions: options.permissions,
                        dates: {
                            start_date: new Date(`${thread.dates.start_date}T00:00:00Z`),
                            end_date: new Date(`${thread.dates.end_date}T00:00:00Z`)
                        }
                    };
                    return id;
                }
            ),
            setupModelConfigurationAndBindings: jest.fn(async () => {
                calls.push("bindings");
            })
        } as any,
        regions: {
            createRegion: jest.fn(async () => {
                calls.push("region");
                return { region_id: "aoi-abc", created: true };
            }),
            regionExists: jest.fn(async () => true)
        },
        catalog: {
            getModelSpec: jest.fn(async () => ({
                parameters: [
                    { id: "p-start", label: "START_DATE", defaultValue: null },
                    { id: "p-end", label: "END_DATE", defaultValue: null },
                    { id: "p-workers", label: "NUM_WORKERS", defaultValue: "4" },
                    { id: "p-mode", label: "REFERENCE_MODE", defaultValue: "auto" },
                    { id: "p-frames", label: "FRAME_IDS", defaultValue: null }
                ],
                responseVariable: "https://w3id.org/okn/i/mint/DISPLACEMENT"
            }))
        },
        regionLookup: {
            getRegion: jest.fn(async (id: string) => ({
                id,
                name: "Waco",
                geometries: [{ geometry: SQUARE }]
            }))
        },
        ...overrides
    };
    return { deps, calls, problemStatements, records, service: createScenarioService(deps) };
}

const body = (extra: Record<string, unknown> = {}) => ({
    idempotency_key: "key-1",
    app_label: "SUBSIDE",
    name: "WERC Waco 2024",
    region: { geojson: SQUARE, name: "Waco" },
    model_id: MODEL,
    start_date: "2024-01-01",
    end_date: "2024-12-31",
    parameter_values: { NUM_WORKERS: 8 },
    publish: ["ckan", "stac"],
    max_minutes: 240,
    ...extra
});

describe("scenarioService.createScenario", () => {
    it("runs the steps in order with submit last", async () => {
        const { service, calls } = build();
        const result = await service.createScenario(body(), alice);
        expect(calls).toEqual([
            "region",
            "problem_statement",
            "task",
            "thread",
            "bindings",
            "plan",
            "submit"
        ]);
        expect(result).toMatchObject({
            problem_statement_id: standingProblemStatementId("alice", "SUBSIDE"),
            thread_id: "thread-1",
            plan_id: "plan-1",
            run_id: "ue_exec-1",
            status: "model_running",
            reused: false
        });
        expect(result.task_id).toMatch(/^task-[0-9a-f]{16}$/);
    });

    it("gives the standing statement, task and thread the caller only", async () => {
        const { service, deps } = build();
        await service.createScenario(body(), alice);
        const permissions = [
            { userid: "alice", read: true, write: true, execute: true, owner: true }
        ];
        expect(
            (deps.problemStatements.createProblemStatement as jest.Mock).mock.calls[0][2]
        ).toMatchObject({
            ifAbsent: true,
            permissions
        });
        expect((deps.tasks.createTask as jest.Mock).mock.calls[0][3]).toMatchObject({
            ifAbsent: true,
            permissions
        });
        expect((deps.subTasks.createSubtask as jest.Mock).mock.calls[0][4]).toEqual({
            permissions,
            createdBy: "alice"
        });
        // Hasura shows a row to its creator through the CREATE event, so every
        // level names the caller (the per-user permission row alone is not enough).
        expect(
            (deps.problemStatements.createProblemStatement as jest.Mock).mock.calls[0][2]
        ).toMatchObject({ createdBy: "alice" });
        expect((deps.tasks.createTask as jest.Mock).mock.calls[0][3]).toMatchObject({
            createdBy: "alice"
        });
    });

    it("creates the standing problem statement once across concurrent calls", async () => {
        const { service, problemStatements } = build();
        const [first, second] = await Promise.all([
            service.createScenario(body({ idempotency_key: "a" }), alice),
            service.createScenario(body({ idempotency_key: "b" }), alice)
        ]);
        expect(problemStatements.size).toBe(1);
        expect(first.problem_statement_id).toBe(second.problem_statement_id);
        expect(first.task_id).toBe(second.task_id);
        expect(first.thread_id).not.toBe(second.thread_id);
    });

    it("keeps each user's standing problem statement separate", async () => {
        expect(standingProblemStatementId("alice", "SUBSIDE")).not.toBe(
            standingProblemStatementId("bob", "SUBSIDE")
        );
        expect(standingProblemStatementId("alice", "SUBSIDE")).not.toBe(
            standingProblemStatementId("alice", "OTHER")
        );
    });

    it("rejects parameter_values dates that differ from the request dates, creating nothing", async () => {
        const { service, calls } = build();
        await expect(
            service.createScenario(body({ parameter_values: { START_DATE: "2023-01-01" } }), alice)
        ).rejects.toMatchObject({
            statusCode: 422,
            code: "DATES_CONFLICT",
            details: { step: "validate", created: {} }
        });
        expect(calls).toEqual([]);
    });

    it("accepts parameter_values dates equal to the request dates", async () => {
        const { service } = build();
        await expect(
            service.createScenario(body({ parameter_values: { START_DATE: "2024-01-01" } }), alice)
        ).resolves.toMatchObject({ reused: false });
    });

    it("binds START_DATE and END_DATE to the request dates, with catalog defaults and overrides", async () => {
        const { service, deps } = build();
        await service.createScenario(body(), alice);
        const [threadId, request] = (deps.subTasks.setupModelConfigurationAndBindings as jest.Mock)
            .mock.calls[0];
        expect(threadId).toBe("thread-1");
        expect(request.model_id).toBe(MODEL);
        expect(request.data).toEqual([]);
        expect(request.parameters).toEqual([
            { id: "p-start", value: "2024-01-01" },
            { id: "p-end", value: "2024-12-31" },
            { id: "p-workers", value: "8" },
            { id: "p-mode", value: "auto" },
            { id: "p-frames", value: "" }
        ]);
    });

    it("passes the dates as YYYY-MM-DD strings to the problem statement, task and thread", async () => {
        const { service, deps } = build();
        await service.createScenario(body(), alice);
        const ps = (deps.problemStatements.createProblemStatement as jest.Mock).mock.calls[0][0];
        const task = (deps.tasks.createTask as jest.Mock).mock.calls[0][1];
        const thread = (deps.subTasks.createSubtask as jest.Mock).mock.calls[0][2];
        for (const dates of [ps.dates, task.dates, thread.dates]) {
            expect(dates).toEqual({ start_date: "2024-01-01", end_date: "2024-12-31" });
        }
        expect(task.response_variables).toEqual(["https://w3id.org/okn/i/mint/DISPLACEMENT"]);
    });

    it("returns the same run for a repeated idempotency_key without submitting again", async () => {
        const { service, deps, calls } = build();
        const first = await service.createScenario(body(), alice);
        const again = await service.createScenario(body(), alice);
        expect(again).toMatchObject({
            run_id: first.run_id,
            thread_id: first.thread_id,
            task_id: first.task_id,
            plan_id: first.plan_id,
            reused: true
        });
        expect(deps.unified.submit).toHaveBeenCalledTimes(1);
        expect(calls.filter((call) => call === "thread")).toHaveLength(1);
    });

    it("namespaces the stored key by caller, so another caller's key never matches", async () => {
        const { service, deps } = build();
        const mine = await service.createScenario(body(), alice);
        const theirs = await service.createScenario(body(), bob);
        expect(theirs.reused).toBe(false);
        expect(theirs.run_id).not.toBe(mine.run_id);
        const keys = (deps.unified.submit as jest.Mock).mock.calls.map(
            ([call]) => call.idempotency_key
        );
        expect(keys).toEqual([scoped("alice", "key-1"), scoped("bob", "key-1")]);
    });

    it("does not leak server-side error text from a 5xx step", async () => {
        const { service, deps } = build();
        (deps.subTasks.createSubtask as jest.Mock).mockRejectedValueOnce(
            Object.assign(new Error('violates foreign key constraint "thread_task_id_fkey"'), {
                statusCode: 500
            })
        );
        const error: any = await service.createScenario(body(), alice).catch((e) => e);
        expect(error.statusCode).toBe(500);
        expect(JSON.stringify(error.message) + JSON.stringify(error.details)).not.toMatch(
            /constraint/
        );
        expect(error.code).toBe("SCENARIO_STEP_FAILED");
        expect(error.details.step).toBe("thread");
    });

    it("refuses dry_run when the plan has no post-model adapter, before submitting", async () => {
        const { service, deps } = build();
        (deps.unified.createPlan as jest.Mock).mockResolvedValueOnce({
            plan_id: "plan-legacy",
            parameters: [],
            post_model_adapter: null
        });
        await expect(service.createScenario(body({ dry_run: true }), alice)).rejects.toMatchObject({
            statusCode: 422,
            code: "DRY_RUN_UNSUPPORTED",
            details: { step: "plan" }
        });
        expect(deps.unified.submit).not.toHaveBeenCalled();
    });

    it("runs a real submit for the same key after a dry run (the dry run released it)", async () => {
        const { service, deps } = build();
        // The unified service frees the key of a dry-run record, so the lookup misses.
        await service.createScenario(body({ dry_run: true }), alice);
        const real = await service.createScenario(body(), alice);
        expect(real.reused).toBe(false);
        expect((deps.unified.submit as jest.Mock).mock.calls[1][0].dry_run).toBe(false);
    });

    it.each(["has space", "semi;colon", "a|b", "", "x".repeat(41)])(
        "rejects app_label %p with 422",
        async (label) => {
            const { service, calls } = build();
            await expect(
                service.createScenario(body({ app_label: label }), alice)
            ).rejects.toMatchObject({ statusCode: 422, code: "APP_LABEL_INVALID" });
            expect(calls).toEqual([]);
        }
    );

    it("does not let a separator in the label collide two (user, label) pairs", () => {
        expect(standingProblemStatementId("a|b", "c")).not.toBe(
            standingProblemStatementId("a", "b|c")
        );
    });

    it("names the task after the region's name when only a region_id is given", async () => {
        const { service, deps } = build();
        await service.createScenario(body({ region: { region_id: "aoi-abc" } }), alice);
        expect((deps.tasks.createTask as jest.Mock).mock.calls[0][1].name).toBe("Waco");
    });

    it("reports the failing step and the ids created so far", async () => {
        const { service, deps } = build();
        (deps.subTasks.createSubtask as jest.Mock).mockRejectedValueOnce(
            new Error("hasura said no")
        );
        await expect(service.createScenario(body(), alice)).rejects.toMatchObject({
            statusCode: 500,
            code: "SCENARIO_STEP_FAILED",
            message: "The thread step failed",
            details: {
                step: "thread",
                created: {
                    region_id: "aoi-abc",
                    problem_statement_id: standingProblemStatementId("alice", "SUBSIDE"),
                    task_id: expect.stringMatching(/^task-/)
                }
            }
        });
        expect(deps.unified.submit).not.toHaveBeenCalled();
    });

    it("keeps the inner error's status and code, adding step and created", async () => {
        const { service, deps } = build();
        (deps.unified.submit as jest.Mock).mockRejectedValueOnce(
            new UnifiedExecutionError(422, "owner has not provided earthdata", "SECRET_REQUIRED", {
                secret: "earthdata"
            })
        );
        await expect(service.createScenario(body(), alice)).rejects.toMatchObject({
            statusCode: 422,
            code: "SECRET_REQUIRED",
            details: {
                secret: "earthdata",
                step: "submit",
                created: { thread_id: "thread-1", plan_id: "plan-1" }
            }
        });
    });

    it("sends dry_run, the idempotency key and only publish parameters to submit", async () => {
        const { service, deps } = build();
        const result = await service.createScenario(
            body({ dry_run: true, parameter_values: { NUM_WORKERS: 8, ckan_dataset: "waco" } }),
            alice
        );
        expect(deps.unified.submit).toHaveBeenCalledWith(
            {
                plan_id: "plan-1",
                parameter_values: { ckan_dataset: "waco" },
                max_minutes: 240,
                idempotency_key: scoped("alice", "key-1"),
                dry_run: true
            },
            alice
        );
        expect((result as { dry_run?: boolean }).dry_run).toBe(true);
        expect((deps.unified.createPlan as jest.Mock).mock.calls[0][0]).toEqual({
            executor: "ensemble_manager",
            thread_id: "thread-1",
            model_id: MODEL,
            execution_engine: "tapis",
            publish: ["ckan", "stac"]
        });
    });

    it("rejects a parameter that neither the model nor the publishers declare", async () => {
        const { service, deps } = build();
        await expect(
            service.createScenario(body({ parameter_values: { NOT_A_PARAMETER: 1 } }), alice)
        ).rejects.toMatchObject({ statusCode: 422, code: "UNKNOWN_PARAMETER" });
        expect(deps.unified.submit).not.toHaveBeenCalled();
    });

    it("looks up an existing region and reports a missing one", async () => {
        const { service, deps } = build();
        await service.createScenario(body({ region: { region_id: "aoi-abc" } }), alice);
        expect(deps.regions.createRegion).not.toHaveBeenCalled();
        (deps.regions.regionExists as jest.Mock).mockResolvedValueOnce(false);
        await expect(
            service.createScenario(
                body({ idempotency_key: "k2", region: { region_id: "aoi-nope" } }),
                alice
            )
        ).rejects.toMatchObject({ statusCode: 404, details: { step: "region" } });
    });

    it("requires an idempotency_key and a bearer token", async () => {
        const { service } = build();
        await expect(
            service.createScenario(body({ idempotency_key: undefined }), alice)
        ).rejects.toMatchObject({ statusCode: 400, code: "INVALID_REQUEST" });
        expect(() => service.createScenario(body(), undefined)).rejects.toMatchObject({
            statusCode: 401
        });
    });

    it("returns the run's region with a bbox and its thread dates", async () => {
        const { service } = build();
        const result = await service.createScenario(body(), alice);
        expect(result.region).toEqual({
            id: "aoi-abc",
            name: "Waco",
            bbox: [-97.3, 31.4, -97.0, 31.7]
        });
        expect(result.thread).toEqual({ start_date: "2024-01-01", end_date: "2024-12-31" });
        const reused = await service.createScenario(body(), alice);
        expect(reused.region).toEqual(result.region);
        expect(reused.thread).toEqual(result.thread);
    });

    it("gives a null bbox when the region has no geometry", async () => {
        const { service, deps } = build();
        (deps.regionLookup.getRegion as jest.Mock).mockResolvedValue({
            id: "aoi-abc",
            name: "Empty",
            geometries: []
        });
        const result = await service.createScenario(body(), alice);
        expect(result.region).toEqual({ id: "aoi-abc", name: "Empty", bbox: null });
    });
});

describe("bboxOfGeometries", () => {
    it("covers every part and accepts geometry JSON strings", () => {
        const far = { type: "Point", coordinates: [10, 20] };
        expect(bboxOfGeometries([SQUARE, JSON.stringify(far)])).toEqual([-97.3, 20, 10, 31.7]);
        expect(bboxOfGeometries([])).toBeNull();
        expect(bboxOfGeometries(["not json"])).toBeNull();
    });
});

describe("scenarioService.listRuns", () => {
    it("lists the caller's runs newest first with region, thread dates and handoff", async () => {
        const { service, records } = build();
        await service.createScenario(body({ idempotency_key: "a", name: "first" }), alice);
        await service.createScenario(body({ idempotency_key: "b", name: "second" }), alice);
        records[1].output_handoff = { resource_uri: "tapis://x" };
        records[1].failure_code = null;

        const { runs, problem_statement_id } = await service.listRuns(
            { app_label: "SUBSIDE" },
            alice
        );
        expect(problem_statement_id).toBe(standingProblemStatementId("alice", "SUBSIDE"));
        expect(runs.map((run) => run.name)).toEqual(["second", "first"]);
        expect(runs[0]).toEqual({
            run_id: "ue_exec-2",
            name: "second",
            region: { id: "aoi-abc", name: "Waco", bbox: [-97.3, 31.4, -97.0, 31.7] },
            thread: { start_date: "2024-01-01", end_date: "2024-12-31" },
            thread_id: "thread-2",
            model_id: MODEL,
            status: "model_running",
            failure_code: null,
            created_at: "2026-11-02T00:00:00Z",
            output_handoff: { resource_uri: "tapis://x" }
        });
    });

    it("passes limit to the store query", async () => {
        const { service, deps } = build();
        await service.createScenario(body(), alice);
        await service.listRuns({ app_label: "SUBSIDE", limit: "7" }, alice);
        expect((deps.store.listByThreads as jest.Mock).mock.calls[0][1]).toBe(7);
    });

    it("lists only threads the caller can read, not every thread of the statement", async () => {
        const { service, problemStatements } = build();
        const created = await service.createScenario(body(), alice);
        const ps = problemStatements.get(created.problem_statement_id);
        const task: any = Object.values(ps.tasks)[0];
        task.threads["thread-foreign"] = {
            id: "thread-foreign",
            name: "someone else",
            permissions: [{ userid: "carol", read: true }]
        };
        const { runs } = await service.listRuns({ app_label: "SUBSIDE" }, alice);
        expect(runs.map((run) => run.thread_id)).toEqual([created.thread_id]);
        // A thread with no permission rows is not readable either.
        task.threads[created.thread_id].permissions = [];
        const none = await service.listRuns({ app_label: "SUBSIDE" }, alice);
        expect(none.runs).toEqual([]);
    });

    it("denies a problem statement whose permission list is empty", async () => {
        const { service, problemStatements } = build();
        const created = await service.createScenario(body(), alice);
        problemStatements.get(created.problem_statement_id).permissions = [];
        await expect(service.listRuns({ app_label: "SUBSIDE" }, alice)).rejects.toMatchObject({
            statusCode: 403
        });
    });

    it("rejects an invalid app_label in the list query", async () => {
        const { service } = build();
        await expect(service.listRuns({ app_label: "no spaces" }, alice)).rejects.toMatchObject({
            statusCode: 422,
            code: "APP_LABEL_INVALID"
        });
    });

    it("reports a store failure generically", async () => {
        const { service, deps } = build();
        await service.createScenario(body(), alice);
        (deps.store.listByThreads as jest.Mock).mockRejectedValueOnce(
            new Error("hasura: secret detail")
        );
        const error: any = await service.listRuns({ app_label: "SUBSIDE" }, alice).catch((e) => e);
        expect(error).toMatchObject({ statusCode: 500, code: "RUNS_LIST_FAILED" });
        expect(error.message).not.toMatch(/secret detail/);
    });

    it("honours limit", async () => {
        const { service } = build();
        await service.createScenario(body({ idempotency_key: "a" }), alice);
        await service.createScenario(body({ idempotency_key: "b" }), alice);
        const { runs } = await service.listRuns({ app_label: "SUBSIDE", limit: "1" }, alice);
        expect(runs).toHaveLength(1);
    });

    it("answers 403 when the caller may not read the problem statement", async () => {
        const { service } = build();
        const created = await service.createScenario(body(), alice);
        await expect(
            service.listRuns({ problem_statement_id: created.problem_statement_id }, bob)
        ).rejects.toMatchObject({ statusCode: 403 });
    });

    it("answers 403 for an explicit id that is not readable or not there", async () => {
        const { service } = build();
        await expect(
            service.listRuns({ problem_statement_id: "ps-unknown" }, alice)
        ).rejects.toMatchObject({ statusCode: 403 });
    });

    it("answers an empty list when the caller has no standing statement yet", async () => {
        const { service } = build();
        await expect(service.listRuns({ app_label: "SUBSIDE" }, alice)).resolves.toMatchObject({
            runs: []
        });
    });

    it("requires problem_statement_id or app_label", async () => {
        const { service } = build();
        await expect(service.listRuns({}, alice)).rejects.toMatchObject({ statusCode: 400 });
    });
});

describe("route order", () => {
    it("serves /plans/scenario and /plans/runs ahead of /:planId and /runs/:runId", async () => {
        const unified = {
            getPlan: jest.fn(async () => ({ from: "getPlan" })),
            getRun: jest.fn(async () => ({ from: "getRun" })),
            listPublishers: jest.fn(),
            createPlan: jest.fn(),
            submit: jest.fn(),
            cancelRun: jest.fn()
        };
        const scenario = {
            createScenario: jest.fn(async () => ({ from: "scenario" })),
            listRuns: jest.fn(async () => ({ from: "list" }))
        };
        const app = express()
            .use(express.json())
            .use("/plans", unifiedExecutionRouter(unified, scenario as any));

        const created = await request(app).post("/plans/scenario").send({ idempotency_key: "k" });
        const listed = await request(app).get("/plans/runs?app_label=SUBSIDE&limit=5");
        const one = await request(app).get("/plans/runs/ue_1");
        const plan = await request(app).get("/plans/some-plan");

        expect(created.body).toEqual({ from: "scenario" });
        expect(listed.body).toEqual({ from: "list" });
        expect(scenario.listRuns).toHaveBeenCalledWith(
            { app_label: "SUBSIDE", limit: "5" },
            undefined
        );
        expect(one.body).toEqual({ from: "getRun" });
        expect(plan.body).toEqual({ from: "getPlan" });
        expect(unified.getRun).toHaveBeenCalledTimes(1);
        expect(unified.getPlan).toHaveBeenCalledTimes(1);
    });

    it("maps a thrown scenario error to its status, code and details", async () => {
        const scenario = {
            createScenario: jest.fn(async () => {
                throw new UnifiedExecutionError(422, "bad", "DATES_CONFLICT", { step: "validate" });
            }),
            listRuns: jest.fn()
        };
        const app = express()
            .use(express.json())
            .use("/plans", unifiedExecutionRouter({}, scenario as any));
        const response = await request(app).post("/plans/scenario").send({});
        expect(response.status).toBe(422);
        expect(response.body).toEqual({
            message: "bad",
            code: "DATES_CONFLICT",
            details: { step: "validate" }
        });
    });
});

describe("authentication on the new routes", () => {
    const forged = `Bearer ${jwt.sign({ "tapis/username": "alice" }, "wrong-key", { algorithm: "HS256" })}`;

    it("answers 401 to a forged JWT before reading the body or touching any dependency", async () => {
        const { deps, service } = build();
        const unified = { getPlan: jest.fn(), getRun: jest.fn() };
        const app = express()
            .use(express.json())
            .use("/plans", unifiedExecutionRouter(unified, service));

        const scenario = await request(app)
            .post("/plans/scenario")
            .set("Authorization", forged)
            .send({ not: "even a valid request" });
        const runs = await request(app)
            .get("/plans/runs?app_label=SUBSIDE")
            .set("Authorization", forged);

        expect(scenario.status).toBe(401);
        expect(runs.status).toBe(401);
        for (const dep of [
            deps.problemStatements.createProblemStatement,
            deps.problemStatements.getProblemStatementById,
            deps.store.listByThreads,
            deps.unified.createPlan,
            deps.unified.submit,
            deps.regions.createRegion
        ]) {
            expect(dep).not.toHaveBeenCalled();
        }
    });

    it("answers 401 to a missing or malformed Authorization header", async () => {
        const { service } = build();
        await expect(service.createScenario(body(), undefined)).rejects.toMatchObject({
            statusCode: 401
        });
        await expect(service.listRuns({ app_label: "SUBSIDE" }, "Basic abc")).rejects.toMatchObject(
            { statusCode: 401 }
        );
    });
});
