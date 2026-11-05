import jwt from "jsonwebtoken";
import { usernameFromToken } from "../authUtils";

jest.mock("@/classes/mint/mint-functions", () => ({
    getConfiguration: jest.fn().mockReturnValue({
        auth: { public_key: "test-key", algorithms: ["HS256"] }
    })
}));

const sign = (claims: object, key = "test-key") => jwt.sign(claims, key, { algorithm: "HS256" });

describe("usernameFromToken", () => {
    it("reads the Tapis tapis/username claim", () => {
        const token = sign({ "tapis/username": "alice", preferred_username: "other" });
        expect(usernameFromToken(token)).toBe("alice");
    });

    it("falls back to the Keycloak preferred_username claim", () => {
        expect(usernameFromToken(sign({ preferred_username: "bob" }))).toBe("bob");
    });

    it("rejects a verified token with no username", () => {
        expect(() => usernameFromToken(sign({ sub: "123" }))).toThrow(
            expect.objectContaining({ statusCode: 401 })
        );
    });

    it("rejects a token that does not verify, whatever it claims", () => {
        const forged = sign({ "tapis/username": "mallory" }, "other-key");
        expect(() => usernameFromToken(forged)).toThrow(
            expect.objectContaining({ statusCode: 401 })
        );
    });
});
