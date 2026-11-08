import jwt, { Algorithm } from "jsonwebtoken";
import { getConfiguration } from "@/classes/mint/mint-functions";
import { UnauthorizedError } from "@/classes/common/errors";
export const getTokenFromRequest = (req: any) => {
    const authHeader = req.headers.authorization;
    return getTokenFromAuthorizationHeader(authHeader);
};

export const getTokenFromAuthorizationHeader = (authorizationHeader: string) => {
    if (!authorizationHeader || !authorizationHeader.startsWith("Bearer ")) {
        throw new UnauthorizedError("Invalid authorization header");
    }
    return authorizationHeader.split(" ")[1];
};

// Tenant public keys fetched from Tapis when none is configured, by tenant id.
const TENANT_KEY_TTL_MS = 24 * 60 * 60 * 1000;
const TENANT_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const tenantKeys = new Map<string, { key: string; at: number }>();

/** Test hook: forget fetched tenant keys. */
export const resetTenantKeyCache = () => tenantKeys.clear();

/**
 * The signing key for a Tapis tenant, read from the configured Tapis base URL
 * (`GET /v3/tenants/{tenant}`) and cached for a day. The tenant id comes from
 * the token's own (unverified) claims; it only selects which key we fetch from
 * our own Tapis, and the token is then verified against that key.
 */
const tenantPublicKey = async (tenant: string): Promise<string | null> => {
    const prefs = getConfiguration();
    const base = String(prefs.tapis?.basePath || "").replace(/\/$/, "");
    if (!base || !TENANT_ID.test(tenant)) return null;
    const cached = tenantKeys.get(tenant);
    if (cached && Date.now() - cached.at < TENANT_KEY_TTL_MS) return cached.key;
    try {
        const response = await fetch(`${base}/v3/tenants/${tenant}`);
        if (!response.ok) return null;
        const body: any = await response.json();
        const key = body?.result?.public_key;
        if (typeof key !== "string" || !key.trim()) return null;
        tenantKeys.set(tenant, { key, at: Date.now() });
        return key;
    } catch (error) {
        console.error("Tenant public key lookup failed:", error);
        return null;
    }
};

/**
 * Whether `token` is signed by the configured public key or, when none is
 * configured (the dev pods set no MINTDEV_TAPIS_PUBLIC_KEY), by the key of the
 * Tapis tenant the token names.
 */
export const verifyToken = async (token: string): Promise<boolean> => {
    const prefs = getConfiguration();
    const algorithms: Algorithm[] = prefs.auth.algorithms as Algorithm[];
    let publicKey = String(prefs.auth.public_key || "").replace(/\\n/g, "\n");
    if (!publicKey) {
        const claims = jwt.decode(token);
        const tenant = claims && typeof claims === "object" ? claims["tapis/tenant_id"] : undefined;
        publicKey = typeof tenant === "string" ? (await tenantPublicKey(tenant)) || "" : "";
    }
    if (!publicKey) {
        console.error("No public key configured and none could be fetched for the token's tenant");
        return false;
    }
    try {
        jwt.verify(token, publicKey, { algorithms });
        return true;
    } catch (error) {
        return false;
    }
};

/**
 * The username of the caller, from a verified JWT: the Tapis `tapis/username`
 * claim, else Keycloak's `preferred_username`. This is the `user_id` written
 * into permission rows, so it must come from a token that passed `verifyToken`.
 */
export const usernameFromToken = async (token: string): Promise<string> => {
    if (!token || !(await verifyToken(token))) {
        throw new UnauthorizedError("Invalid or unverifiable token");
    }
    const claims = jwt.decode(token);
    if (claims && typeof claims === "object") {
        for (const claim of ["tapis/username", "preferred_username"]) {
            const value = claims[claim];
            if (typeof value === "string" && value.trim()) return value.trim();
        }
    }
    throw new UnauthorizedError("Token carries no username");
};

export const securityHandlers = {
    BearerAuth: async (req, scopes) => {
        // Get the token from the Authorization header
        const token = getTokenFromRequest(req);
        if (!token) {
            return false;
        }
        try {
            return await verifyToken(token);
        } catch (error) {
            console.error("Token validation error:", error);
            return false;
        }
    },
    oauth2: async (req, scopes) => {
        // Get the token from the Authorization header
        const token = getTokenFromRequest(req);
        if (!token) {
            return false;
        }
        try {
            return await verifyToken(token);
        } catch (error) {
            console.error("Token validation error:", error);
            return false;
        }
    }
};
