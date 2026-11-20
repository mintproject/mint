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
    return internalSecretFrom(getConfiguration() as { svo_adapter_internal_secret?: string });
}

/** The same secret, from a configuration object a caller already holds. */
export function internalSecretFrom(prefs: { svo_adapter_internal_secret?: string }): string {
    return (
        process.env.SVO_ADAPTER_INTERNAL_SERVICE_SECRET || prefs.svo_adapter_internal_secret || ""
    );
}

/**
 * One startup warning when an adapter is configured but the shared service secret is
 * not: the Ensemble Manager would then call the adapter without it, and the adapter
 * answers 503 on its service-only routes (and refuses everything with its front door
 * on). Names the setting, never a value. Returns whether it warned.
 */
export function warnIfAdapterSecretMissing(log: { warn: (message: string) => void }): boolean {
    if (!adapterBaseUrl() || adapterInternalSecret()) return false;
    log.warn(
        "SVO adapter is configured but SVO_ADAPTER_INTERNAL_SERVICE_SECRET (or " +
            "svo_adapter_internal_secret) is not: calls to the adapter carry no shared service secret"
    );
    return true;
}
