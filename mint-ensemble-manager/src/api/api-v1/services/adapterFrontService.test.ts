import express from "express";
import request from "supertest";
import {
    adapterForwardRouter,
    piecesRouter,
    secretsRouter,
    spatialRouter
} from "@/api/api-v1/paths/adapterFront";
import { adapterForward, createAdapterFrontService } from "./adapterFrontService";
import { adapterRequest } from "./unifiedExecutionService";
import { warnIfAdapterSecretMissing } from "./adapterConfig";
import { ALLOWED_ADAPTER_ROUTES, isForwardable } from "./adapterAllowlist";
import { UnifiedExecutionError } from "@/classes/common/errors";

const mockConfig: {
    svo_adapter_api?: string;
    svo_adapter_internal_secret?: string;
    graphql?: { secret?: string };
} = {};
jest.mock("@/classes/graphql/graphql_functions_v2", () => ({
    getThread: jest.fn().mockResolvedValue({ id: "thread-1" })
}));

jest.mock("@/classes/mint/mint-functions", () => ({
    getConfiguration: jest.fn(() => mockConfig)
}));

const BEARER = "Bearer alice.jwt";

function app(fake: jest.Mock, forward: jest.Mock = jest.fn()) {
    const service = createAdapterFrontService(
        fake as unknown as typeof adapterRequest,
        forward as never
    );
    const server = express();
    server.use(express.json());
    server.use("/v1/spatial", spatialRouter(service));
    server.use("/v1/secrets", secretsRouter(service));
    server.use("/v1/etl-pieces", piecesRouter(service));
    server.use("/v1/adapter", adapterForwardRouter(service));
    return server;
}

describe("the adapter front routes", () => {
    it("reads spatial layers through the adapter without needing a token", async () => {
        const fake = jest.fn().mockResolvedValue({ layers: [{ id: "a" }] });
        const res = await request(app(fake)).get("/v1/spatial/layers");
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ layers: [{ id: "a" }] });
        expect(fake).toHaveBeenCalledWith("/spatial/layers", {}, undefined);
    });

    it("forwards the caller's own token, and only that, for the secrets routes", async () => {
        const fake = jest.fn().mockResolvedValue({ name: "earthdata" });
        const agent = request(app(fake));
        await agent.get("/v1/secrets").set("Authorization", BEARER).expect(200);
        await agent
            .put("/v1/secrets/earth data")
            .set("Authorization", BEARER)
            .send({ fields: { username: "u", password: "p" } })
            .expect(200);
        await agent.delete("/v1/secrets/earthdata").set("Authorization", BEARER).expect(200);
        expect(fake.mock.calls).toEqual([
            ["/secrets", {}, BEARER],
            [
                "/secrets/earth%20data",
                { method: "PUT", body: { fields: { username: "u", password: "p" } } },
                BEARER
            ],
            ["/secrets/earthdata", { method: "DELETE" }, BEARER]
        ]);
    });

    it("refuses the secrets routes without a token and never calls the adapter", async () => {
        const fake = jest.fn();
        const agent = request(app(fake));
        for (const call of [
            agent.get("/v1/secrets"),
            agent.put("/v1/secrets/x").send({ fields: {} }),
            agent.delete("/v1/secrets/x")
        ]) {
            const res = await call;
            expect(res.status).toBe(401);
            expect(res.body.code).toBe("TAPIS_AUTH_REQUIRED");
        }
        expect(fake).not.toHaveBeenCalled();
    });

    it("never caches a secrets response", async () => {
        const res = await request(app(jest.fn().mockResolvedValue([])))
            .get("/v1/secrets")
            .set("Authorization", BEARER);
        expect(res.headers["cache-control"]).toBe("no-store");
    });

    it("passes the adapter's refusal on, and does not echo a secret value when it fails", async () => {
        const refusing = jest
            .fn()
            .mockRejectedValue(
                new UnifiedExecutionError(409, "run in progress", "SECRET_LOCKED_BY_RUN")
            );
        let res = await request(app(refusing))
            .put("/v1/secrets/x")
            .set("Authorization", BEARER)
            .send({ fields: { password: "hunter2" } });
        expect([res.status, res.body.code]).toEqual([409, "SECRET_LOCKED_BY_RUN"]);

        const down = jest.fn().mockRejectedValue(new Error("connect failed: hunter2"));
        const spy = jest.spyOn(console, "error").mockImplementation(() => undefined);
        res = await request(app(down))
            .put("/v1/secrets/x")
            .set("Authorization", BEARER)
            .send({ fields: { password: "hunter2" } });
        spy.mockRestore();
        expect(res.status).toBe(502);
        expect(JSON.stringify(res.body)).not.toContain("hunter2");
    });
});

describe("the shared secret sent to the adapter", () => {
    const realFetch = global.fetch;
    let fetchMock: jest.Mock;

    beforeEach(() => {
        delete process.env.SVO_ADAPTER_INTERNAL_SERVICE_SECRET;
        delete mockConfig.svo_adapter_internal_secret;
        mockConfig.svo_adapter_api = "https://adapter.example/";
        mockConfig.graphql = { secret: "hasura-admin" };
        fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
        global.fetch = fetchMock as unknown as typeof fetch;
    });
    afterEach(() => {
        global.fetch = realFetch;
    });

    it("is never the Hasura admin secret", async () => {
        await adapterRequest("/spatial/layers", {}, BEARER);
        const headers = fetchMock.mock.calls[0][1].headers;
        expect(headers).not.toHaveProperty("X-Ensemble-Manager-Secret");
        expect(JSON.stringify(headers)).not.toContain("hasura-admin");
        expect(headers.Authorization).toBe(BEARER);
    });

    it("is the dedicated setting, from the environment first and then the config", async () => {
        mockConfig.svo_adapter_internal_secret = "from-config";
        await adapterRequest("/x", {}, BEARER);
        expect(fetchMock.mock.calls[0][1].headers["X-Ensemble-Manager-Secret"]).toBe("from-config");

        process.env.SVO_ADAPTER_INTERNAL_SERVICE_SECRET = "from-env";
        await adapterRequest("/x", {}, BEARER);
        expect(fetchMock.mock.calls[1][1].headers["X-Ensemble-Manager-Secret"]).toBe("from-env");
        delete process.env.SVO_ADAPTER_INTERNAL_SERVICE_SECRET;
    });
});

describe("the startup warning for a missing service secret", () => {
    beforeEach(() => {
        delete process.env.SVO_ADAPTER_INTERNAL_SERVICE_SECRET;
        delete mockConfig.svo_adapter_internal_secret;
        mockConfig.graphql = { secret: "hasura-admin" };
    });

    it("warns once, naming the setting and no value, when an adapter is set without it", () => {
        const log = { warn: jest.fn() };
        mockConfig.svo_adapter_api = "https://adapter.example";
        expect(warnIfAdapterSecretMissing(log)).toBe(true);
        expect(log.warn).toHaveBeenCalledTimes(1);
        const message = log.warn.mock.calls[0][0] as string;
        expect(message).toContain("SVO_ADAPTER_INTERNAL_SERVICE_SECRET");
        expect(message).not.toContain("hasura-admin");
    });

    it("is silent when the secret is set, or no adapter is configured", () => {
        const log = { warn: jest.fn() };
        mockConfig.svo_adapter_api = "https://adapter.example";
        mockConfig.svo_adapter_internal_secret = "service-only";
        expect(warnIfAdapterSecretMissing(log)).toBe(false);
        delete mockConfig.svo_adapter_internal_secret;
        mockConfig.svo_adapter_api = "";
        expect(warnIfAdapterSecretMissing(log)).toBe(false);
        expect(log.warn).not.toHaveBeenCalled();
    });
});

describe("the piece-authoring routes", () => {
    const answer = (status: number, body: unknown, retryAfter?: string) =>
        jest.fn().mockResolvedValue({ status, body: JSON.stringify(body), retryAfter });

    it("forwards each call with the caller's token and encodes the piece id", async () => {
        const forward = answer(200, { ok: true });
        const agent = request(app(jest.fn(), forward));
        await agent
            .post("/v1/etl-pieces/from-repository")
            .set("Authorization", BEARER)
            .send({ dry_run: true })
            .expect(200);
        await agent.get("/v1/etl-pieces/approvals").set("Authorization", BEARER).expect(200);
        await agent
            .get("/v1/etl-pieces/a%2Fb%3Ac/approval")
            .set("Authorization", BEARER)
            .expect(200);
        await agent
            .put("/v1/etl-pieces/a%2Fb%3Ac/approval")
            .set("Authorization", BEARER)
            .send({ approved: true, reviewed_sha256: "abc" })
            .expect(200);
        expect(forward.mock.calls).toEqual([
            ["/pieces/from-repository", { method: "POST", body: { dry_run: true } }, BEARER],
            ["/pieces/approvals", {}, BEARER],
            ["/transform-specs/a%2Fb%3Ac/approval", {}, BEARER],
            [
                "/transform-specs/a%2Fb%3Ac/approval",
                { method: "PUT", body: { approved: true, reviewed_sha256: "abc" } },
                BEARER
            ]
        ]);
    });

    it("refuses a call with no token in the adapter's own error shape", async () => {
        const forward = jest.fn();
        const res = await request(app(jest.fn(), forward)).get("/v1/etl-pieces/approvals");
        expect(res.status).toBe(401);
        expect(res.body).toEqual({
            detail: { code: "TAPIS_AUTH_REQUIRED", message: expect.any(String) }
        });
        expect(forward).not.toHaveBeenCalled();
    });

    it("passes the adapter's status, error body and Retry-After through", async () => {
        const refusal = { detail: { code: "PIECE_RATE_LIMITED", message: "slow down" } };
        const res = await request(app(jest.fn(), answer(429, refusal, "42")))
            .post("/v1/etl-pieces/from-repository")
            .set("Authorization", BEARER)
            .send({});
        expect(res.status).toBe(429);
        expect(res.headers["retry-after"]).toBe("42");
        expect(res.body).toEqual(refusal);
        expect(res.headers["cache-control"]).toBe("no-store");
    });
});

describe("adapterForward", () => {
    const realFetch = global.fetch;
    afterEach(() => {
        global.fetch = realFetch;
        delete mockConfig.svo_adapter_internal_secret;
    });

    it("sends the token and the shared secret and returns status, body and Retry-After", async () => {
        mockConfig.svo_adapter_api = "https://adapter.example/";
        mockConfig.svo_adapter_internal_secret = "service-only";
        delete process.env.SVO_ADAPTER_INTERNAL_SERVICE_SECRET;
        const fetchMock = jest.fn().mockResolvedValue({
            status: 429,
            text: async () => '{"detail":"later"}',
            headers: { get: (name: string) => (name === "retry-after" ? "7" : null) }
        });
        global.fetch = fetchMock as unknown as typeof fetch;
        const answer = await adapterForward("/pieces/approvals", {}, BEARER);
        expect(answer).toEqual({ status: 429, body: '{"detail":"later"}', retryAfter: "7" });
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe("https://adapter.example/pieces/approvals");
        expect(init.headers).toMatchObject({
            Authorization: BEARER,
            "X-Front-Door-Secret": "service-only"
        });
        // The header that grants the EM's own powers is never sent for a user's call.
        expect(init.headers).not.toHaveProperty("X-Ensemble-Manager-Secret");
    });

    it("answers 503 or 502 in the adapter's shape when it is unset or down", async () => {
        mockConfig.svo_adapter_api = "";
        expect((await adapterForward("/x", {}, BEARER)).status).toBe(503);
        mockConfig.svo_adapter_api = "https://adapter.example";
        global.fetch = jest.fn().mockRejectedValue(new Error("down")) as unknown as typeof fetch;
        const down = await adapterForward("/x", {}, BEARER);
        expect(down.status).toBe(502);
        expect(JSON.parse(down.body).detail.code).toBe("SVO_ADAPTER_UNREACHABLE");
    });
});

describe("the allowlisted adapter forward", () => {
    const answer = (status = 200, body: unknown = { ok: true }, retryAfter?: string) =>
        jest.fn().mockResolvedValue({ status, body: JSON.stringify(body), retryAfter });
    const send = (forward: jest.Mock) => request(app(jest.fn(), forward));

    it.each([
        ["get", "/v1/adapter/standard-variables", "GET", "/standard-variables"],
        ["get", "/v1/adapter/reachable/do-1", "GET", "/reachable/do-1"],
        ["post", "/v1/adapter/plans/discover", "POST", "/plans/discover"],
        ["post", "/v1/adapter/plans/discover-sources", "POST", "/plans/discover-sources"],
        ["post", "/v1/adapter/datasets/find", "POST", "/datasets/find"],
        ["get", "/v1/adapter/data-objects", "GET", "/data-objects"],
        ["get", "/v1/adapter/transform-specs", "GET", "/transform-specs"],
        ["post", "/v1/adapter/readiness/check", "POST", "/readiness/check"],
        ["post", "/v1/adapter/plans/model-run", "POST", "/plans/model-run"],
        ["post", "/v1/adapter/flows/check", "POST", "/flows/check"],
        ["post", "/v1/adapter/flows/propose", "POST", "/flows/propose"],
        ["post", "/v1/adapter/plans/flow", "POST", "/plans/flow"],
        ["post", "/v1/adapter/data-objects", "POST", "/data-objects"],
        ["post", "/v1/adapter/transform-specs/a%2Fb/test", "POST", "/transform-specs/a%2Fb/test"],
        ["get", "/v1/adapter/runs", "GET", "/runs"],
        ["post", "/v1/adapter/runs/r1/poll", "POST", "/runs/r1/poll"],
        ["get", "/v1/adapter/runs/r1/provenance", "GET", "/runs/r1/provenance"],
        ["post", "/v1/adapter/workflows/generate", "POST", "/workflows/generate"]
    ] as const)(
        "forwards %s %s with the caller's token",
        async (verb, url, method, adapterPath) => {
            const forward = answer();
            const res = await send(forward)[verb](url).set("Authorization", BEARER).send({});
            expect(res.status).toBe(200);
            expect(forward.mock.calls[0][0]).toBe(adapterPath);
            expect(forward.mock.calls[0][2]).toBe(BEARER);
            expect(forward.mock.calls[0][1].method ?? "GET").toBe(method);
        }
    );

    it("lists exactly the 18 routes the MCP needs", () => {
        expect(ALLOWED_ADAPTER_ROUTES).toHaveLength(18);
    });

    it.each([
        ["GET", "/admin/sync-status"],
        ["POST", "/admin/reset"],
        ["PUT", "/admin/secrets"],
        ["POST", "/transform-specs"],
        ["POST", "/workflows/submit"],
        ["POST", "/plans/deferred"],
        ["POST", "/plans/deferred/p1/bind"],
        ["POST", "/runs/r1/register-output"],
        ["POST", "/runs/r1/signal"],
        ["GET", "/runs/r1/credentials"],
        ["POST", "/runs/r1/token"],
        ["GET", "/runs/r1/steps/1/secrets"],
        ["GET", "/secrets"],
        ["DELETE", "/data-objects"],
        ["PUT", "/runs/r1/poll"],
        ["GET", "/runs/../admin/sync-status"],
        ["GET", "/reachable/%2e%2e"],
        ["GET", "/runs//poll"],
        ["GET", "/health"]
    ])("refuses %s %s with 404 and never calls the adapter", async (method, path) => {
        expect(isForwardable(method, path)).toBe(false);
        const forward = answer();
        const agent = send(forward);
        const res = await agent[method.toLowerCase() as "get"](`/v1/adapter${path}`).set(
            "Authorization",
            BEARER
        );
        expect(res.status).toBe(404);
        expect(forward).not.toHaveBeenCalled();
    });

    it("needs a token", async () => {
        const forward = answer();
        const res = await send(forward).get("/v1/adapter/runs");
        expect(res.status).toBe(401);
        expect(res.body.detail.code).toBe("TAPIS_AUTH_REQUIRED");
        expect(forward).not.toHaveBeenCalled();
    });

    it("passes the query string through for GET only", async () => {
        const forward = answer();
        await send(forward)
            .get("/v1/adapter/runs?limit=5&status=running&status=failed&offset=10")
            .set("Authorization", BEARER);
        expect(forward.mock.calls[0][0]).toBe(
            "/runs?limit=5&status=running&status=failed&offset=10"
        );
        await send(forward)
            .post("/v1/adapter/plans/discover?admin=1&x=y")
            .set("Authorization", BEARER)
            .send({ a: 1 });
        expect(forward.mock.calls[1][0]).toBe("/plans/discover");
    });

    it("caps the request body", async () => {
        const forward = answer();
        const res = await send(forward)
            .post("/v1/adapter/plans/discover")
            .set("Authorization", BEARER)
            .send({ blob: "x".repeat(80 * 1024) });
        expect(res.status).toBe(413);
        expect(res.body.detail.code).toBe("REQUEST_TOO_LARGE");
        expect(forward).not.toHaveBeenCalled();
    });

    it("does not let a user set the server-owned data object fields", async () => {
        const forward = answer();
        for (const key of ["owner_execution_id", "owner_model_child_id", "owner_tenant"]) {
            const res = await send(forward)
                .post("/v1/adapter/data-objects")
                .set("Authorization", BEARER)
                .send({ label: "x", resource_uri: "y", [key]: "ue_1" });
            expect(res.status).toBe(400);
            expect(res.body.detail.code).toBe("SERVER_OWNED_FIELD");
        }
        expect(forward).not.toHaveBeenCalled();
    });

    it("passes the adapter's status, error body and Retry-After through", async () => {
        const refusal = { detail: { code: "TAPIS_AUTH_REQUIRED" } };
        const res = await send(answer(429, refusal, "9"))
            .post("/v1/adapter/readiness/check")
            .set("Authorization", BEARER)
            .send({});
        expect(res.status).toBe(429);
        expect(res.headers["retry-after"]).toBe("9");
        expect(res.body).toEqual(refusal);
    });
});
