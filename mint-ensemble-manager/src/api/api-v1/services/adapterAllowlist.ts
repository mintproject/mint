/**
 * The adapter routes the Ensemble Manager forwards for clients that used to call
 * the adapter directly (the dso-dynamo MCP). A fixed list of method and path pairs,
 * and nothing else: no operator or `/admin` route, no service-only route
 * (`register-output`, the deferred-plan bind, `/workflows/submit`), and no task
 * callback. Each route here is a user route: the adapter checks the caller's own
 * token on it, and the forward adds the shared secret only to prove the call came
 * through the front door.
 */

/** A path segment that is an id: no slash, and not a dot segment in any encoding. */
const ID = "[^/]+";

export interface AllowedRoute {
    method: "GET" | "POST";
    pattern: RegExp;
}

const route = (method: "GET" | "POST", path: string): AllowedRoute => ({
    method,
    pattern: new RegExp(`^${path}$`)
});

export const ALLOWED_ADAPTER_ROUTES: AllowedRoute[] = [
    // search
    route("GET", "/standard-variables"),
    route("GET", `/reachable/${ID}`),
    route("POST", "/plans/discover"),
    route("POST", "/plans/discover-sources"),
    route("POST", "/datasets/find"),
    route("GET", "/data-objects"),
    route("GET", "/transform-specs"),
    // configure
    route("POST", "/readiness/check"),
    route("POST", "/plans/model-run"),
    // flows
    route("POST", "/flows/check"),
    route("POST", "/plans/flow"),
    // authoring
    route("POST", "/data-objects"),
    route("POST", `/transform-specs/${ID}/test`),
    // monitor and run
    route("GET", "/runs"),
    route("POST", `/runs/${ID}/poll`),
    route("GET", `/runs/${ID}/provenance`),
    route("POST", "/workflows/generate")
];

/** Body fields only the Ensemble Manager's own server-owned calls may set. */
export const SERVER_OWNED_BODY_KEYS = [
    "owner_execution_id",
    "owner_model_child_id",
    "owner_tenant"
];

const DOT_SEGMENT = /^(\.|%2e){1,2}$/i;

/** Whether this method and raw (still percent-encoded) path may be forwarded. */
export function isForwardable(method: string, path: string): boolean {
    if (path.split("/").some((segment) => DOT_SEGMENT.test(segment))) return false;
    return ALLOWED_ADAPTER_ROUTES.some(
        (allowed) => allowed.method === method && allowed.pattern.test(path)
    );
}
