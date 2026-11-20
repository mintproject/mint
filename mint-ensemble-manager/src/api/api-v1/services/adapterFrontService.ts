import { UnifiedExecutionError } from "@/classes/common/errors";
import { adapterRequest } from "./unifiedExecutionService";
import { adapterBaseUrl, adapterInternalSecret } from "./adapterConfig";
import { SERVER_OWNED_BODY_KEYS, isForwardable } from "./adapterAllowlist";

type AdapterRequest = typeof adapterRequest;

/** The adapter's answer to a passthrough call, relayed as it came. */
export interface AdapterAnswer {
    status: number;
    /** The response body exactly as the adapter sent it (JSON text). */
    body: string;
    /** The `Retry-After` of a 429, so the page can say when to try again. */
    retryAfter?: string;
}

type AdapterForward = (
    path: string,
    init: { method?: string; body?: unknown },
    authorization?: string
) => Promise<AdapterAnswer>;

/** The most a forwarded request body may be, in serialized characters. */
export const MAX_FORWARD_BODY_BYTES = 64 * 1024;

function queryString(query: Record<string, unknown>): string {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
        for (const item of Array.isArray(value) ? value : [value]) {
            if (typeof item === "string") params.append(key, item);
        }
    }
    const text = params.toString();
    return text ? `?${text}` : "";
}

const adapterError = (status: number, code: string, message: string): AdapterAnswer => ({
    status,
    body: JSON.stringify({ detail: { code, message } })
});

/**
 * Call the adapter with the caller's token and the shared service secret (as
 * `X-Front-Door-Secret`), and return its status and body untouched. The piece-authoring page reads the
 * adapter's own error bodies (`detail.code`, `detail.message`) and its 429
 * `Retry-After`, which `adapterRequest` would flatten into one message.
 */
export async function adapterForward(
    path: string,
    init: { method?: string; body?: unknown },
    authorization?: string
): Promise<AdapterAnswer> {
    const base = adapterBaseUrl();
    if (!base) {
        return adapterError(503, "SVO_ADAPTER_UNAVAILABLE", "SVO adapter is not configured");
    }
    const secret = adapterInternalSecret();
    let response: Response;
    try {
        response = await fetch(`${base}${path}`, {
            method: init.method || "GET",
            headers: {
                "Content-Type": "application/json",
                // Not X-Ensemble-Manager-Secret: that header also lets the adapter read
                // every run and accept server-owned writes. This one only opens the front
                // door for a call whose user the adapter verifies from the token.
                ...(secret ? { "X-Front-Door-Secret": secret } : {}),
                ...(authorization ? { Authorization: authorization } : {})
            },
            ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) })
        });
    } catch {
        return adapterError(502, "SVO_ADAPTER_UNREACHABLE", "The SVO adapter could not be reached");
    }
    return {
        status: response.status,
        body: await response.text().catch(() => ""),
        retryAfter: response.headers?.get?.("retry-after") ?? undefined
    };
}

/**
 * Routes the web app used to call on the SVO adapter itself. The adapter is an
 * internal engine now: this service carries the caller's own token and the shared
 * service secret (added by `adapterRequest`) to it, and returns what it answers.
 * The adapter still verifies the token and decides what the caller may see; the
 * Ensemble Manager never names a user to it.
 */
export function createAdapterFrontService(
    request: AdapterRequest = adapterRequest,
    forward: AdapterForward = adapterForward
) {
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

    function requireTokenAnswer(authorization?: string): AdapterAnswer | undefined {
        return authorization
            ? undefined
            : adapterError(401, "TAPIS_AUTH_REQUIRED", "a valid Tapis bearer token is required");
    }

    const enc = encodeURIComponent;

    return {
        /**
         * Forward one allowlisted user route to the adapter. `path` is the raw,
         * still-encoded adapter path; `query` passes through for GET only; the body is
         * capped and may not set the fields only server-owned calls set.
         */
        async forwardAllowed(
            method: string,
            path: string,
            query: Record<string, unknown>,
            body: unknown,
            authorization?: string
        ): Promise<AdapterAnswer> {
            if (!isForwardable(method, path)) {
                return adapterError(
                    404,
                    "ADAPTER_ROUTE_NOT_FORWARDED",
                    "this adapter route is not available through the Ensemble Manager"
                );
            }
            const unauthenticated = requireTokenAnswer(authorization);
            if (unauthenticated) return unauthenticated;
            if (method === "POST") {
                const size = JSON.stringify(body ?? {}).length;
                if (size > MAX_FORWARD_BODY_BYTES) {
                    return adapterError(413, "REQUEST_TOO_LARGE", "the request body is too large");
                }
                if (
                    body &&
                    typeof body === "object" &&
                    SERVER_OWNED_BODY_KEYS.some((key) => key in (body as object))
                ) {
                    return adapterError(
                        400,
                        "SERVER_OWNED_FIELD",
                        "owner_execution_id, owner_model_child_id and owner_tenant are set by the server"
                    );
                }
            }
            const search = method === "GET" ? queryString(query) : "";
            return forward(
                `${path}${search}`,
                method === "POST" ? { method, body: body ?? {} } : {},
                authorization
            );
        },

        /** Register (or preview) a piece from a repository commit. */
        async registerPiece(body: unknown, authorization?: string): Promise<AdapterAnswer> {
            return (
                requireTokenAnswer(authorization) ||
                forward("/pieces/from-repository", { method: "POST", body }, authorization)
            );
        },

        async listPieceApprovals(authorization?: string): Promise<AdapterAnswer> {
            return (
                requireTokenAnswer(authorization) || forward("/pieces/approvals", {}, authorization)
            );
        },

        async getPieceApproval(specId: string, authorization?: string): Promise<AdapterAnswer> {
            return (
                requireTokenAnswer(authorization) ||
                forward(`/transform-specs/${enc(specId)}/approval`, {}, authorization)
            );
        },

        async setPieceApproval(
            specId: string,
            body: unknown,
            authorization?: string
        ): Promise<AdapterAnswer> {
            return (
                requireTokenAnswer(authorization) ||
                forward(
                    `/transform-specs/${enc(specId)}/approval`,
                    { method: "PUT", body },
                    authorization
                )
            );
        },

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
