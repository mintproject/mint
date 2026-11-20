import express from "express";
import request from "supertest";
import { secretsRouter, spatialRouter } from "@/api/api-v1/paths/adapterFront";
import { createAdapterFrontService } from "./adapterFrontService";
import { adapterRequest } from "./unifiedExecutionService";
import { UnifiedExecutionError } from "@/classes/common/errors";

const mockConfig: {
    svo_adapter_api?: string;
    svo_adapter_internal_secret?: string;
    graphql?: { secret?: string };
} = {};
jest.mock("@/classes/mint/mint-functions", () => ({
    getConfiguration: jest.fn(() => mockConfig)
}));

const BEARER = "Bearer alice.jwt";

function app(fake: jest.Mock) {
    const service = createAdapterFrontService(fake as unknown as typeof adapterRequest);
    const server = express();
    server.use(express.json());
    server.use("/v1/spatial", spatialRouter(service));
    server.use("/v1/secrets", secretsRouter(service));
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
