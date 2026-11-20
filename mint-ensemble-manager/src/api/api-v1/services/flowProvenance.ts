/**
 * What a flow run read and which settings it used, in the shape the catalog's
 * `execution_data_binding` and `execution_parameter_binding` tables keep it.
 *
 * A model run records both when its execution is created. A flow run has no model
 * job, so its record was empty: the results said what the flow made and nothing said
 * what it was made from. This module turns the adapter's plan (and, for a run whose
 * plan could not be read, the thread's own bindings) into those rows.
 *
 * Pure: nothing here reads or writes a store, so the live submit and the backfill
 * script (`scripts/backfill-flow-provenance.ts`) build their rows the same way.
 *
 * How the tables hold a flow run:
 * - `execution_data_binding (execution_id, model_io_id, resource_id)`: its key allows
 *   several resources under one input, so a collection input is one row per resource
 *   with the same `model_io_id`.
 * - `execution_parameter_binding (execution_id, model_parameter_id, parameter_value)`:
 *   `model_parameter_id` must be a catalog parameter of the flow, and the value is
 *   text. A setting that is a link to an earlier step's output has no value of its
 *   own; it is recorded as a reference, `linked: step 2 value lexicon_uri`, never as
 *   a copied value. A setting the flow's catalog entry does not declare has no row to
 *   go in; it is kept in `settings` (and so on the run's stored record) instead.
 * - A credential is never recorded. The flow's credentials come from the runner's
 *   secret store and are named by the plan's `secrets`; a setting is also withheld
 *   when its name reads as a credential or its value looks like a token.
 */

/** A file a flow input read, as the plan names it. */
export interface ProvenanceFile {
    name?: string;
    url: string;
}

/** One input of the flow and every file it read. A collection input has several. */
export interface ProvenanceInput {
    model_io_id: string;
    files: ProvenanceFile[];
}

/** One setting a run used: a value, or the reference to where a link took it from. */
export interface ProvenanceSetting {
    name: string;
    value: string;
    source: "thread" | "flow" | "link";
}

export interface FlowProvenance {
    inputs: { model_io_id: string; resources: { id: string; name: string; url: string }[] }[];
    /** The settings that are catalog parameters of the flow: rows of `execution_parameter_binding`. */
    parameters: { model_parameter_id: string; name: string; value: string }[];
    /** Every setting used, by name, whether or not the catalog declares it. Never a credential. */
    settings: Record<string, string>;
    /** Files the plan names that no catalog resource stands for, so no binding row can hold them. */
    unresolved: { model_io_id: string; url: string }[];
}

/** A name that reads as a credential. */
const SECRET_NAME = /(secret|password|passwd|token|credential|api[_-]?key|private[_-]?key|signal)/i;
/** A value that is itself a credential: a JWT or an authorization header. */
const SECRET_VALUE = /^(bearer\s+\S+|eyJ[\w-]+\.[\w-]+\.[\w-]*)$/i;

/** Names the plan says are the runner's credentials, and the fields they carry. */
export function secretNamesOf(planJson: any): Set<string> {
    const names = new Set<string>();
    for (const secret of Array.isArray(planJson?.secrets) ? planJson.secrets : []) {
        if (typeof secret?.name === "string") names.add(secret.name);
        for (const field of Array.isArray(secret?.fields) ? secret.fields : []) {
            if (typeof field === "string") names.add(field);
        }
    }
    return names;
}

export function isSecretSetting(name: string, value: string, secretNames: Set<string>): boolean {
    return secretNames.has(name) || SECRET_NAME.test(name) || SECRET_VALUE.test(value.trim());
}

/** How a link is written into a parameter value: where the value is taken from. */
export function describeLink(link: Record<string, unknown> | null | undefined): string {
    const from = link || {};
    if (typeof from.step === "number" && typeof from.value === "string") {
        return `linked: step ${from.step} value ${from.value}`;
    }
    if (typeof from.step === "number" && typeof from.output === "number") {
        return `linked: step ${from.step} output ${from.output}`;
    }
    if (typeof from.flow_input === "string") return `linked: flow input ${from.flow_input}`;
    if (typeof from.flow_parameter === "string") {
        return `linked: flow parameter ${from.flow_parameter}`;
    }
    return "linked";
}

function asText(value: unknown): string | null {
    if (value === undefined || value === null || value === "") return null;
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    return JSON.stringify(value);
}

function isUrl(value: unknown): value is string {
    return typeof value === "string" && value.length > 0;
}

/**
 * The inputs a planned flow read: each collection's files, and the one dataset of
 * every other bound input (the adapter keeps its location as the input's default).
 * The thread's region fills an input with no file, so it is not listed.
 */
export function inputsFromPlan(planJson: any): ProvenanceInput[] {
    const found = new Map<string, ProvenanceFile[]>();
    const flow = planJson?.flow || {};
    for (const collection of Array.isArray(flow.collections) ? flow.collections : []) {
        if (typeof collection?.input !== "string") continue;
        const files = (Array.isArray(collection.resources) ? collection.resources : [])
            .filter((resource: any) => isUrl(resource?.url))
            .map((resource: any) => ({
                url: resource.url as string,
                ...(typeof resource.name === "string" && resource.name
                    ? { name: resource.name as string }
                    : {})
            }));
        if (files.length) found.set(collection.input, files);
    }
    const parameters = new Map<string, any>(
        (Array.isArray(planJson?.parameters) ? planJson.parameters : []).map((p: any) => [
            p?.name,
            p
        ])
    );
    for (const input of Array.isArray(flow.inputs) ? flow.inputs : []) {
        if (typeof input?.input_id !== "string" || found.has(input.input_id)) continue;
        if (input.region || input.collection !== undefined) continue;
        const parameter = parameters.get(input.arg);
        if (parameter?.managed_source === "flow_input" && isUrl(parameter.default)) {
            found.set(input.input_id, [{ url: parameter.default }]);
        }
    }
    return [...found].map(([model_io_id, files]) => ({ model_io_id, files }));
}

/**
 * The settings a planned flow ran with, secret-free: what was sent (the thread's
 * values and the runner's own), the flow's fixed values for settings nobody sent,
 * and each link as a reference. A link takes the place of any other value for its
 * setting, as it does when the pipeline runs.
 */
export function settingsFromPlan(
    planJson: any,
    values: Record<string, unknown>
): ProvenanceSetting[] {
    const secretNames = secretNamesOf(planJson);
    const used = new Map<string, ProvenanceSetting>();
    const parameters: any[] = Array.isArray(planJson?.parameters) ? planJson.parameters : [];
    // Settings the run fills in itself (datasets, region, staging folder) are inputs
    // or plumbing, not settings anyone chose.
    const managed = new Set(parameters.filter((p) => p?.managed).map((p) => String(p.name)));

    for (const [name, raw] of Object.entries(values || {})) {
        const value = asText(raw);
        if (value !== null && !managed.has(name)) used.set(name, { name, value, source: "thread" });
    }
    for (const parameter of parameters) {
        const name = String(parameter?.name ?? "");
        const value = asText(parameter?.default);
        if (parameter?.default_source === "flow" && value !== null && !used.has(name)) {
            used.set(name, { name, value, source: "flow" });
        }
    }
    for (const link of Array.isArray(planJson?.flow?.linked_settings)
        ? planJson.flow.linked_settings
        : []) {
        if (typeof link?.setting !== "string") continue;
        used.set(link.setting, {
            name: link.setting,
            value: describeLink(link.from),
            source: "link"
        });
    }
    // A secret-named setting is withheld whatever its source; a link would only be a
    // reference, but the record has no use for naming a credential's setting either.
    return [...used.values()].filter(
        (setting) =>
            !isSecretSetting(
                setting.name,
                setting.source === "link" ? "" : setting.value,
                secretNames
            )
    );
}

function basename(url: string): string {
    const last = url.split("?")[0].replace(/\/+$/, "").split("/").pop();
    return last || url;
}

/**
 * Put the inputs and settings into the catalog's rows. `resources` finds the catalog
 * resource for a file's location; `parameterIds` finds the flow's catalog parameter
 * for a setting's name.
 */
export function buildFlowProvenance(
    inputs: ProvenanceInput[],
    settings: ProvenanceSetting[],
    resources: Map<string, { id: string; name?: string }>,
    parameterIds: Map<string, string>
): FlowProvenance {
    const unresolved: FlowProvenance["unresolved"] = [];
    const bound: FlowProvenance["inputs"] = [];
    for (const input of inputs) {
        const seen = new Set<string>();
        const rows: { id: string; name: string; url: string }[] = [];
        for (const file of input.files) {
            const resource = resources.get(file.url);
            if (!resource) {
                unresolved.push({ model_io_id: input.model_io_id, url: file.url });
                continue;
            }
            // The key is (execution, input, resource): the same file twice is one row.
            if (seen.has(resource.id)) continue;
            seen.add(resource.id);
            rows.push({
                id: resource.id,
                name: file.name || resource.name || basename(file.url),
                url: file.url
            });
        }
        if (rows.length) bound.push({ model_io_id: input.model_io_id, resources: rows });
    }
    const byParameter = new Map<string, FlowProvenance["parameters"][number]>();
    for (const setting of settings) {
        const id = parameterIds.get(setting.name);
        if (id) {
            byParameter.set(id, {
                model_parameter_id: id,
                name: setting.name,
                value: setting.value
            });
        }
    }
    return {
        inputs: bound,
        parameters: [...byParameter.values()],
        settings: Object.fromEntries(settings.map((setting) => [setting.name, setting.value])),
        unresolved
    };
}
