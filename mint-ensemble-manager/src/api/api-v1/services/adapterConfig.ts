import { getConfiguration } from "@/classes/mint/mint-functions";

/** The SVO adapter's base URL, without a trailing slash. Empty when none is configured. */
export function adapterBaseUrl(): string {
    const prefs = getConfiguration() as { svo_adapter_api?: string };
    return (prefs.svo_adapter_api || process.env.SVO_ADAPTER_API || "").replace(/\/$/, "");
}

/**
 * The shared secret sent to the adapter as `X-Ensemble-Manager-Secret`. It is a
 * credential of its own: it never falls back to the Hasura admin secret
 * (`graphql.secret`), so a leak of one is not a leak of the other. Empty when it is
 * not set, and then the adapter answers 503 on the routes that need it.
 */
export function adapterInternalSecret(): string {
    const prefs = getConfiguration() as { svo_adapter_internal_secret?: string };
    return (
        process.env.SVO_ADAPTER_INTERNAL_SERVICE_SECRET || prefs.svo_adapter_internal_secret || ""
    );
}
