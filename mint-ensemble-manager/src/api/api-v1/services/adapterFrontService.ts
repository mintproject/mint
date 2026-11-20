import { UnifiedExecutionError } from "@/classes/common/errors";
import { adapterRequest } from "./unifiedExecutionService";

type AdapterRequest = typeof adapterRequest;

/**
 * Routes the web app used to call on the SVO adapter itself. The adapter is an
 * internal engine now: this service carries the caller's own token and the shared
 * service secret (added by `adapterRequest`) to it, and returns what it answers.
 * The adapter still verifies the token and decides what the caller may see; the
 * Ensemble Manager never names a user to it.
 */
export function createAdapterFrontService(request: AdapterRequest = adapterRequest) {
    function requireToken(authorization?: string): string {
        if (!authorization) {
            throw new UnifiedExecutionError(
                401,
                "a valid Tapis bearer token is required",
                "TAPIS_AUTH_REQUIRED"
            );
        }
        return authorization;
    }

    return {
        /** Known backend spatial sources. A public reference read, so no token is required. */
        spatialLayers(authorization?: string) {
            return request("/spatial/layers", {}, authorization);
        },

        /** The caller's own secrets: names, field names and dates, never values. */
        listSecrets(authorization?: string) {
            return request("/secrets", {}, requireToken(authorization));
        },

        putSecret(name: string, body: unknown, authorization?: string) {
            return request(
                `/secrets/${encodeURIComponent(name)}`,
                { method: "PUT", body },
                requireToken(authorization)
            );
        },

        deleteSecret(name: string, authorization?: string) {
            return request(
                `/secrets/${encodeURIComponent(name)}`,
                { method: "DELETE" },
                requireToken(authorization)
            );
        }
    };
}

export type AdapterFrontService = ReturnType<typeof createAdapterFrontService>;
