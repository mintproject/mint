import jwt from "jsonwebtoken";
import { getConfiguration } from "@/classes/mint/mint-functions";
import { resetTenantKeyCache, usernameFromToken, verifyToken } from "../authUtils";

jest.mock("@/classes/mint/mint-functions", () => ({
    getConfiguration: jest.fn()
}));

const configured = () =>
    (getConfiguration as jest.Mock).mockReturnValue({
        auth: { public_key: "test-key", algorithms: ["HS256"] },
        tapis: { basePath: "https://portals.example" }
    });
const unconfigured = () =>
    (getConfiguration as jest.Mock).mockReturnValue({
        auth: { public_key: "", algorithms: ["HS256"] },
        tapis: { basePath: "https://portals.example/" }
    });

const sign = (claims: object, key = "test-key") => jwt.sign(claims, key, { algorithm: "HS256" });

const tenantResponse = (key: string | null, ok = true) =>
    Promise.resolve({
        ok,
        json: async () => ({ result: key === null ? {} : { public_key: key } })
    });

describe("usernameFromToken with a configured key", () => {
    beforeEach(() => {
        configured();
        resetTenantKeyCache();
    });

    it("reads the Tapis tapis/username claim", async () => {
        const token = sign({ "tapis/username": "alice", preferred_username: "other" });
        await expect(usernameFromToken(token)).resolves.toBe("alice");
    });

    it("falls back to the Keycloak preferred_username claim", async () => {
        await expect(usernameFromToken(sign({ preferred_username: "bob" }))).resolves.toBe("bob");
    });

    it("rejects a verified token with no username", async () => {
        await expect(usernameFromToken(sign({ sub: "123" }))).rejects.toMatchObject({
            statusCode: 401
        });
    });

    it("rejects a token that does not verify, whatever it claims", async () => {
        const forged = sign({ "tapis/username": "mallory" }, "other-key");
        await expect(usernameFromToken(forged)).rejects.toMatchObject({ statusCode: 401 });
    });
});

describe("verifyToken without a configured key", () => {
    const fetchMock = jest.fn();
    beforeEach(() => {
        unconfigured();
        resetTenantKeyCache();
        fetchMock.mockReset();
        (global as any).fetch = fetchMock;
    });

    it("fetches the token's tenant key from the configured Tapis and verifies against it", async () => {
        fetchMock.mockReturnValue(tenantResponse("tenant-key"));
        const token = sign(
            { "tapis/username": "alice", "tapis/tenant_id": "portals" },
            "tenant-key"
        );
        await expect(usernameFromToken(token)).resolves.toBe("alice");
        expect(fetchMock).toHaveBeenCalledWith("https://portals.example/v3/tenants/portals");
    });

    it("caches the tenant key", async () => {
        fetchMock.mockReturnValue(tenantResponse("tenant-key"));
        const token = sign({ "tapis/tenant_id": "portals" }, "tenant-key");
        expect(await verifyToken(token)).toBe(true);
        expect(await verifyToken(token)).toBe(true);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("rejects a token signed with another key even when the tenant key is fetched", async () => {
        fetchMock.mockReturnValue(tenantResponse("tenant-key"));
        expect(await verifyToken(sign({ "tapis/tenant_id": "portals" }, "other-key"))).toBe(false);
    });

    it("rejects a token naming a malformed tenant without fetching", async () => {
        expect(await verifyToken(sign({ "tapis/tenant_id": "../admin" }, "tenant-key"))).toBe(
            false
        );
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("rejects when the tenant lookup fails or has no key", async () => {
        fetchMock.mockReturnValueOnce(tenantResponse(null, false));
        expect(await verifyToken(sign({ "tapis/tenant_id": "portals" }, "tenant-key"))).toBe(false);
        fetchMock.mockReturnValueOnce(tenantResponse(null));
        expect(await verifyToken(sign({ "tapis/tenant_id": "portals" }, "tenant-key"))).toBe(false);
    });

    it("rejects a token with no tenant claim", async () => {
        expect(await verifyToken(sign({ "tapis/username": "alice" }, "tenant-key"))).toBe(false);
        expect(fetchMock).not.toHaveBeenCalled();
    });
});
