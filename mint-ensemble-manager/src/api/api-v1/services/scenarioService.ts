import { createHash } from "crypto";
import { UnifiedExecutionError } from "@/classes/common/errors";
import { ForbiddenError, NotFoundError } from "@/classes/common/errors";
import { GraphQL } from "@/config/graphql";
import getModelcatalogConfigurationGQL from "@/classes/graphql/queries/model/get-modelcatalog-configuration.graphql";
import getConfigurationResponseVariablesGQL from "@/classes/graphql/queries/model/get-configuration-response-variables.graphql";
import { getRegionWithGeometries } from "@/classes/graphql/graphql_functions_v2";
import { SECRET_PARAMETER_TYPE } from "@/classes/graphql/graphql_adapter";
import { convertApiUrlToW3Id } from "@/classes/mint/model-catalog-graphql-adapter";
import { MintPermission, ProblemStatement } from "@/classes/mint/mint-types";
import { getTokenFromAuthorizationHeader, usernameFromToken } from "@/utils/authUtils";
import problemStatementsService from "./problemStatementsService";
import tasksService from "./tasksService";
import subTasksService from "./subTasksService";
import regionsService, { RegionsService } from "./regionsService";
import { parentRunId } from "./unifiedExecutionService";
import { UnifiedExecutionRecord, UnifiedExecutionStore } from "./unifiedExecutionStore";

/**
 * One call that gives a client a run: region, the caller's standing problem
 * statement, a task per region, a thread per run, the model bindings, then the
 * unified plan and submit. Submit is last, so every earlier step can be run
 * again safely; the client's idempotency_key makes the whole call repeatable.
 * See docs/design/2026-11-05-subside-runs-through-dynamo.md.
 */

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DATE_PARAMETERS = ["START_DATE", "END_DATE"] as const;

export interface CatalogParameter {
    id: string;
    label: string;
    defaultValue: string | null;
}

export interface ScenarioModelSpec {
    /** The parameters a thread binds: not fixed, not secrets. */
    parameters: CatalogParameter[];
    responseVariable?: string;
}

export interface ScenarioCatalog {
    getModelSpec(modelId: string, token: string): Promise<ScenarioModelSpec>;
}

export interface ScenarioDeps {
    unified: {
        createPlan(body: any, authorization?: string): Promise<any>;
        submit(body: any, authorization: string | undefined): Promise<any>;
    };
    store: UnifiedExecutionStore;
    problemStatements: Pick<
        typeof problemStatementsService,
        "createProblemStatement" | "getProblemStatementById"
    >;
    tasks: Pick<typeof tasksService, "createTask">;
    subTasks: Pick<typeof subTasksService, "createSubtask" | "setupModelConfigurationAndBindings">;
    regions: Pick<RegionsService, "createRegion" | "regionExists">;
    catalog: ScenarioCatalog;
    /** Region name and geometries, for the bbox the UI draws results over. */
    regionLookup: { getRegion(regionId: string): Promise<RegionRecord | null> };
}

export interface RegionRecord {
    id: string;
    name: string;
    geometries: { geometry: unknown }[];
}

export interface RegionSummary {
    id: string;
    name: string;
    bbox: [number, number, number, number] | null;
}

interface CreatedIds {
    region_id?: string;
    problem_statement_id?: string;
    task_id?: string;
    thread_id?: string;
    plan_id?: string;
}

interface ScenarioRequest {
    idempotency_key: string;
    app_label: string;
    name: string;
    region: { region_id: string } | { geojson: unknown; name: string };
    model_id: string;
    start_date: string;
    end_date: string;
    parameter_values: Record<string, unknown>;
    publish: string[];
    max_minutes?: unknown;
    dry_run: boolean;
}

const hash16 = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 16);

// JSON-encoded so no character in the label can shift the boundary between the two.
export const standingProblemStatementId = (username: string, appLabel: string) =>
    `ps-${hash16(JSON.stringify([username, appLabel]))}`;

/**
 * The key as stored: namespaced by the caller, so another caller's key can
 * neither match nor collide with it (and replaying one gives no signal).
 */
const scopedIdempotencyKey = (username: string, key: string) =>
    `${createHash("sha256").update(username).digest("hex").slice(0, 12)}:${key}`;

const APP_LABEL_PATTERN = /^[A-Za-z0-9_-]{1,40}$/;

const parseAppLabel = (value: unknown): string => {
    if (typeof value !== "string" || !APP_LABEL_PATTERN.test(value)) {
        throw unprocessable(
            "app_label must be 1 to 40 letters, digits, underscores or hyphens",
            "APP_LABEL_INVALID"
        );
    }
    return value;
};

const taskIdFor = (problemStatementId: string, regionId: string) =>
    `task-${hash16(`${problemStatementId}|${regionId}`)}`;

const badRequest = (message: string, code: string, details?: unknown) =>
    new UnifiedExecutionError(400, message, code, details);

const unprocessable = (message: string, code: string, details?: unknown) =>
    new UnifiedExecutionError(422, message, code, details);

const isRecord = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === "object" && !Array.isArray(value);

const isValidDate = (value: unknown): value is string => {
    if (typeof value !== "string" || !DATE_PATTERN.test(value)) return false;
    return new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
};

const nonEmptyString = (value: unknown, field: string, max = 200): string => {
    if (typeof value !== "string" || !value.trim() || value.length > max) {
        throw badRequest(
            `${field} is required (a string of at most ${max} characters)`,
            "INVALID_REQUEST"
        );
    }
    return value.trim();
};

const parseRequest = (body: any): ScenarioRequest => {
    if (!isRecord(body)) throw badRequest("A JSON request body is required", "INVALID_REQUEST");
    const region = body.region;
    if (!isRecord(region)) {
        throw badRequest("region must be {region_id} or {geojson, name}", "INVALID_REQUEST");
    }
    let parsedRegion: ScenarioRequest["region"];
    if (typeof region.region_id === "string" && region.region_id.trim()) {
        parsedRegion = { region_id: region.region_id.trim() };
    } else if (region.geojson !== undefined) {
        parsedRegion = {
            geojson: region.geojson,
            name: nonEmptyString(region.name, "region.name")
        };
    } else {
        throw badRequest("region must be {region_id} or {geojson, name}", "INVALID_REQUEST");
    }
    if (!isValidDate(body.start_date) || !isValidDate(body.end_date)) {
        throw badRequest("start_date and end_date must be YYYY-MM-DD dates", "INVALID_REQUEST");
    }
    if (body.start_date > body.end_date) {
        throw badRequest("start_date must not be after end_date", "INVALID_REQUEST");
    }
    if (body.parameter_values !== undefined && !isRecord(body.parameter_values)) {
        throw badRequest("parameter_values must be an object", "INVALID_REQUEST");
    }
    if (
        body.publish !== undefined &&
        (!Array.isArray(body.publish) || !body.publish.every((t: unknown) => typeof t === "string"))
    ) {
        throw badRequest("publish must be a list of catalog tokens", "INVALID_REQUEST");
    }
    const parameterValues = (body.parameter_values || {}) as Record<string, unknown>;
    for (const [name, expected] of [
        ["START_DATE", body.start_date],
        ["END_DATE", body.end_date]
    ]) {
        if (name in parameterValues && String(parameterValues[name]) !== expected) {
            throw unprocessable(
                `parameter_values.${name} (${parameterValues[name]}) differs from the request ${name === "START_DATE" ? "start_date" : "end_date"} (${expected})`,
                "DATES_CONFLICT"
            );
        }
    }
    return {
        idempotency_key: nonEmptyString(body.idempotency_key, "idempotency_key", 200),
        app_label: parseAppLabel(body.app_label),
        name: nonEmptyString(body.name, "name"),
        region: parsedRegion,
        model_id: nonEmptyString(body.model_id, "model_id", 500),
        start_date: body.start_date,
        end_date: body.end_date,
        parameter_values: parameterValues,
        publish: (body.publish || []) as string[],
        max_minutes: body.max_minutes,
        dry_run: body.dry_run === true
    };
};

const toBindingValue = (value: unknown): string | string[] =>
    Array.isArray(value) ? value.map(String) : String(value ?? "");

/**
 * Bind every catalog parameter the thread must carry: START_DATE/END_DATE from
 * the request dates, a supplied value by label (or id), else the catalog
 * default. Supplied names the model does not declare are returned as `extra`;
 * they are only valid if the plan declares them as publish parameters.
 */
const buildBindings = (spec: ScenarioModelSpec, request: ScenarioRequest) => {
    const dates: Record<string, string> = {
        START_DATE: request.start_date,
        END_DATE: request.end_date
    };
    const used = new Set<string>();
    const parameters = spec.parameters.map((parameter) => {
        let value: unknown;
        if (parameter.label in dates) {
            value = dates[parameter.label];
        } else {
            const key = [parameter.label, parameter.id].find(
                (name) => name in request.parameter_values
            );
            if (key !== undefined) used.add(key);
            value = key !== undefined ? request.parameter_values[key] : parameter.defaultValue;
        }
        return { id: parameter.id, value: toBindingValue(value) };
    });
    const extra: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(request.parameter_values)) {
        if (!used.has(name) && !(DATE_PARAMETERS as readonly string[]).includes(name)) {
            extra[name] = value;
        }
    }
    return { parameters, extra };
};

const stepError = (step: string, created: CreatedIds, error: unknown): UnifiedExecutionError => {
    const inner = error as {
        statusCode?: number;
        status?: number;
        code?: unknown;
        details?: unknown;
    };
    const status = inner?.statusCode ?? inner?.status ?? 500;
    const code = typeof inner?.code === "string" ? inner.code : "SCENARIO_STEP_FAILED";
    if (status >= 500) {
        // Server-side detail (Hasura, adapter or driver text) stays in the log.
        console.error(`Scenario step '${step}' failed:`, error);
        return new UnifiedExecutionError(status, `The ${step} step failed`, code, {
            step,
            created
        });
    }
    const message = error instanceof Error ? error.message : String(error);
    return new UnifiedExecutionError(status, message, code, {
        ...(isRecord(inner?.details) ? inner.details : {}),
        step,
        created
    });
};

const grantsRead = (permissions: MintPermission[] | undefined, username: string): boolean =>
    (permissions || []).some((p) => (p.userid === username || p.userid === "*") && p.read);

interface ThreadSummary {
    id: string;
    name: string;
    taskId: string;
    regionId: string | null;
    permissions: MintPermission[];
    start_date: string | null;
    end_date: string | null;
}

const threadsOf = (problemStatement: ProblemStatement): ThreadSummary[] => {
    const threads: ThreadSummary[] = [];
    for (const task of Object.values(problemStatement.tasks || {})) {
        for (const thread of Object.values(task.threads || {})) {
            threads.push({
                id: thread.id,
                name: thread.name,
                taskId: task.id,
                regionId: thread.regionid || task.regionid || null,
                permissions: thread.permissions || [],
                start_date: dateOnly(thread.dates?.start_date),
                end_date: dateOnly(thread.dates?.end_date)
            });
        }
    }
    return threads;
};

/** [west, south, east, north] of every position in the GeoJSON geometries, or null. */
export const bboxOfGeometries = (
    geometries: unknown[]
): [number, number, number, number] | null => {
    let west = Infinity;
    let south = Infinity;
    let east = -Infinity;
    let north = -Infinity;
    const visit = (node: unknown) => {
        if (!Array.isArray(node)) return;
        if (node.length >= 2 && typeof node[0] === "number" && typeof node[1] === "number") {
            west = Math.min(west, node[0]);
            east = Math.max(east, node[0]);
            south = Math.min(south, node[1]);
            north = Math.max(north, node[1]);
            return;
        }
        node.forEach(visit);
    };
    for (const geometry of geometries) {
        let parsed = geometry;
        if (typeof geometry === "string") {
            try {
                parsed = JSON.parse(geometry);
            } catch {
                continue;
            }
        }
        const g = parsed as { coordinates?: unknown; geometries?: unknown[] } | null;
        if (g?.geometries) g.geometries.forEach((inner) => visit((inner as any)?.coordinates));
        else visit(g?.coordinates);
    }
    return Number.isFinite(west) ? [west, south, east, north] : null;
};

const dateOnly = (value: unknown): string | null => {
    if (value instanceof Date)
        return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
    return typeof value === "string" ? value.slice(0, 10) : null;
};

const runRow = (
    record: UnifiedExecutionRecord,
    thread: ThreadSummary | undefined,
    region: RegionSummary | null
) => ({
    run_id: parentRunId(record.id),
    name: thread?.name ?? null,
    region,
    thread: { start_date: thread?.start_date ?? null, end_date: thread?.end_date ?? null },
    thread_id: record.thread_id,
    model_id: record.model_id,
    status: record.status,
    failure_code: record.failure_code || null,
    created_at: record.created_at,
    output_handoff: record.output_handoff || null
});

export function createScenarioService(deps: ScenarioDeps) {
    const { unified, store, problemStatements, tasks, subTasks, regions, catalog, regionLookup } =
        deps;

    /** The region's name and bbox; null when it cannot be read. */
    const summarizeRegion = async (regionId: string | null): Promise<RegionSummary | null> => {
        if (!regionId) return null;
        try {
            const region = await regionLookup.getRegion(regionId);
            if (!region) return null;
            return {
                id: region.id,
                name: region.name,
                bbox: bboxOfGeometries((region.geometries || []).map((g) => g.geometry))
            };
        } catch (error) {
            console.warn(`Could not read region ${regionId}:`, error);
            return null;
        }
    };

    const requireStore = () => {
        if (!store.findByIdempotencyKey || !store.listByThreads) {
            throw new UnifiedExecutionError(
                500,
                "the execution store cannot look up runs by key or thread",
                "STORE_UNSUPPORTED"
            );
        }
        return store as Required<
            Pick<UnifiedExecutionStore, "findByIdempotencyKey" | "listByThreads">
        >;
    };

    const standingPermissions = (username: string): MintPermission[] => [
        { userid: username, read: true, write: true, execute: true, owner: true }
    ];

    /** The caller's own thread for an earlier request with this key, as a response. */
    const reuse = async (
        record: UnifiedExecutionRecord,
        psId: string,
        username: string,
        authorization: string
    ) => {
        let found: ThreadSummary | undefined;
        try {
            const standing = await problemStatements.getProblemStatementById(psId, authorization);
            found = threadsOf(standing).find(
                (thread) =>
                    thread.id === record.thread_id && grantsRead(thread.permissions, username)
            );
        } catch (error) {
            if (!(error instanceof NotFoundError)) throw error;
        }
        if (!found) {
            throw new UnifiedExecutionError(
                409,
                "the run for this idempotency_key is not one of your threads",
                "IDEMPOTENCY_KEY_CONFLICT"
            );
        }
        return {
            problem_statement_id: psId,
            task_id: found.taskId,
            thread_id: record.thread_id,
            plan_id: record.plan_id,
            run_id: parentRunId(record.id),
            status: record.status,
            region: await summarizeRegion(found.regionId),
            thread: { start_date: found.start_date, end_date: found.end_date },
            reused: true
        };
    };

    return {
        async createScenario(body: any, authorization?: string) {
            const token = getTokenFromAuthorizationHeader(authorization);
            const username = await usernameFromToken(token);
            const created: CreatedIds = {};
            let step = "validate";
            try {
                const request = parseRequest(body);
                const psId = standingProblemStatementId(username, request.app_label);
                const permissions = standingPermissions(username);
                const modelId = convertApiUrlToW3Id(request.model_id);

                step = "idempotency";
                const storedKey = scopedIdempotencyKey(username, request.idempotency_key);
                const existing = await requireStore().findByIdempotencyKey(storedKey);
                if (existing) return await reuse(existing, psId, username, authorization);

                step = "model";
                const spec = await catalog.getModelSpec(modelId, token);
                const { parameters, extra } = buildBindings(spec, request);

                step = "region";
                let regionId: string;
                if ("region_id" in request.region) {
                    regionId = request.region.region_id;
                    if (!(await regions.regionExists(regionId, authorization))) {
                        throw new NotFoundError(`Region '${regionId}' does not exist`);
                    }
                } else {
                    regionId = (
                        await regions.createRegion(
                            { name: request.region.name, geojson: request.region.geojson },
                            authorization
                        )
                    ).region_id;
                }
                created.region_id = regionId;
                // The task is named after the region's own name.
                const regionSummary = await summarizeRegion(regionId);
                const regionName =
                    regionSummary?.name ||
                    ("name" in request.region ? request.region.name : regionId);

                const dates = {
                    start_date: request.start_date,
                    end_date: request.end_date
                } as unknown as { start_date: Date; end_date: Date };

                // problem_statement.region_id is NOT NULL, so the standing
                // statement takes the region of the run that first creates it.
                step = "problem_statement";
                created.problem_statement_id = await problemStatements.createProblemStatement(
                    {
                        id: psId,
                        name: `${request.app_label} runs`,
                        regionid: regionId,
                        dates
                    },
                    authorization,
                    { id: psId, ifAbsent: true, permissions }
                );

                step = "task";
                const taskId = taskIdFor(psId, regionId);
                created.task_id = await tasks.createTask(
                    psId,
                    {
                        id: taskId,
                        name: regionName,
                        problem_statement_id: psId,
                        regionid: regionId,
                        dates,
                        driving_variables: [],
                        response_variables: spec.responseVariable ? [spec.responseVariable] : []
                    },
                    authorization,
                    { id: taskId, ifAbsent: true, permissions }
                );

                step = "thread";
                created.thread_id = await subTasks.createSubtask(
                    psId,
                    taskId,
                    {
                        name: request.name,
                        task_id: taskId,
                        dates,
                        driving_variables: [],
                        response_variables: []
                    },
                    authorization,
                    { permissions }
                );

                step = "bindings";
                await subTasks.setupModelConfigurationAndBindings(
                    created.thread_id,
                    { model_id: modelId, data: [], parameters },
                    authorization
                );

                step = "plan";
                const plan = await unified.createPlan(
                    {
                        executor: "ensemble_manager",
                        thread_id: created.thread_id,
                        model_id: modelId,
                        execution_engine: "tapis",
                        publish: request.publish
                    },
                    authorization
                );
                created.plan_id = plan.plan_id;
                // Only the post-model adapter path honours dry_run. On any other
                // plan a "dry run" would start a real job, so it is refused.
                if (request.dry_run && !plan.post_model_adapter) {
                    throw unprocessable(
                        "dry_run is only supported for plans that run through the adapter",
                        "DRY_RUN_UNSUPPORTED"
                    );
                }
                const declared = new Set<string>(
                    (plan.parameters || []).map((p: { name: string }) => p.name)
                );
                const unknown = Object.keys(extra).filter((name) => !declared.has(name));
                if (unknown.length > 0) {
                    throw unprocessable(
                        `parameter_values names no parameter of this model or its publishers: ${unknown.join(", ")}`,
                        "UNKNOWN_PARAMETER",
                        { unknown }
                    );
                }

                step = "submit";
                const submitted = await unified.submit(
                    {
                        plan_id: plan.plan_id,
                        parameter_values: extra,
                        max_minutes: request.max_minutes,
                        idempotency_key: storedKey,
                        dry_run: request.dry_run
                    },
                    authorization
                );

                return {
                    problem_statement_id: psId,
                    task_id: taskId,
                    thread_id: created.thread_id,
                    plan_id: plan.plan_id,
                    run_id: submitted.run_id,
                    status: submitted.status,
                    region: regionSummary,
                    thread: { start_date: request.start_date, end_date: request.end_date },
                    reused: false,
                    ...(request.dry_run
                        ? {
                              dry_run: true,
                              tapis_workflow_definition: submitted.tapis_workflow_definition ?? null
                          }
                        : {})
                };
            } catch (error) {
                throw stepError(step, created, error);
            }
        },

        async listRuns(
            query: { problem_statement_id?: unknown; app_label?: unknown; limit?: unknown },
            authorization?: string
        ) {
            const token = getTokenFromAuthorizationHeader(authorization);
            const username = await usernameFromToken(token);
            const { listByThreads } = requireStore();

            const explicitId =
                typeof query.problem_statement_id === "string" ? query.problem_statement_id : "";
            if (!explicitId && query.app_label === undefined) {
                throw badRequest(
                    "problem_statement_id or app_label is required",
                    "PROBLEM_STATEMENT_REQUIRED"
                );
            }
            const psId =
                explicitId || standingProblemStatementId(username, parseAppLabel(query.app_label));
            const parsedLimit = Number(query.limit);
            const limit =
                Number.isInteger(parsedLimit) && parsedLimit > 0
                    ? Math.min(parsedLimit, MAX_LIST_LIMIT)
                    : DEFAULT_LIST_LIMIT;

            let problemStatement: ProblemStatement;
            try {
                problemStatement = await problemStatements.getProblemStatementById(
                    psId,
                    authorization!
                );
            } catch (error) {
                if (!(error instanceof NotFoundError)) {
                    console.error("Reading the problem statement failed:", error);
                    throw new UnifiedExecutionError(
                        500,
                        "Runs could not be listed",
                        "RUNS_LIST_FAILED"
                    );
                }
                // No standing statement yet is an empty history; an explicit id
                // the caller cannot read is indistinguishable from one that is
                // not there, and is reported as denied.
                if (!explicitId) return { problem_statement_id: psId, runs: [] };
                throw new ForbiddenError("You cannot read this problem statement");
            }
            if (!grantsRead(problemStatement.permissions, username)) {
                throw new ForbiddenError("You cannot read this problem statement");
            }

            // A thread is listed only if it is itself readable by the caller.
            const threads = threadsOf(problemStatement).filter((thread) =>
                grantsRead(thread.permissions, username)
            );
            const byId = new Map(threads.map((thread) => [thread.id, thread]));
            let records: UnifiedExecutionRecord[];
            try {
                records = await listByThreads(
                    threads.map((thread) => thread.id),
                    limit
                );
            } catch (error) {
                console.error("Listing runs failed:", error);
                throw new UnifiedExecutionError(
                    500,
                    "Runs could not be listed",
                    "RUNS_LIST_FAILED"
                );
            }
            const regionCache = new Map<string, Promise<RegionSummary | null>>();
            const regionOf = (regionId: string | null) => {
                if (!regionId) return Promise.resolve(null);
                if (!regionCache.has(regionId))
                    regionCache.set(regionId, summarizeRegion(regionId));
                return regionCache.get(regionId)!;
            };
            return {
                problem_statement_id: psId,
                runs: await Promise.all(
                    records
                        .slice()
                        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
                        .slice(0, limit)
                        .map(async (record) => {
                            const thread = byId.get(record.thread_id);
                            return runRow(record, thread, await regionOf(thread?.regionId ?? null));
                        })
                )
            };
        }
    };
}

/** Reads the model's bindable parameters and response variable from the catalog. */
export const catalogFromGraphql: ScenarioCatalog = {
    async getModelSpec(modelId, token) {
        const client = GraphQL.instanceUsingAccessToken(token);
        const result = await client.query({
            query: getModelcatalogConfigurationGQL,
            variables: { id: modelId },
            fetchPolicy: "no-cache"
        });
        const configuration = result.data?.modelcatalog_configuration_by_pk;
        if (!configuration) {
            throw new UnifiedExecutionError(
                404,
                `Model configuration not found for id: ${modelId}`,
                "MODEL_NOT_FOUND"
            );
        }
        const parameters: CatalogParameter[] = (configuration.parameters || [])
            .map((row: any) => row.parameter)
            .filter((p: any) => p.parameter_type !== SECRET_PARAMETER_TYPE && !p.has_fixed_value)
            .map((p: any) => ({
                id: p.id,
                label: p.label,
                defaultValue: p.has_default_value ?? null
            }));

        // The response variable is descriptive metadata: a catalog without it
        // must not block a run, so a failed lookup leaves the task without one.
        let responseVariable: string | undefined;
        try {
            const variables = await client.query({
                query: getConfigurationResponseVariablesGQL,
                variables: { id: modelId },
                fetchPolicy: "no-cache"
            });
            for (const row of variables.data?.modelcatalog_configuration_by_pk?.outputs || []) {
                for (const presentation of row.output?.presentations || []) {
                    const uri = presentation.presentation?.has_standard_variable;
                    if (typeof uri === "string" && uri && !responseVariable) responseVariable = uri;
                }
            }
        } catch (error) {
            console.warn("Could not read the model's response variable:", error);
        }
        return { parameters, responseVariable };
    }
};

export const defaultScenarioDeps = (
    unified: ScenarioDeps["unified"],
    store: UnifiedExecutionStore
): ScenarioDeps => ({
    unified,
    store,
    problemStatements: problemStatementsService,
    tasks: tasksService,
    subTasks: subTasksService,
    regions: regionsService,
    catalog: catalogFromGraphql,
    regionLookup: { getRegion: getRegionWithGeometries }
});
