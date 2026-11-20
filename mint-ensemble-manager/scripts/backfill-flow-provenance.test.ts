import { backfillFlowProvenance, Gql, planOf } from "./backfill-flow-provenance";

const planId = (flow: unknown) =>
    "em_" +
    Buffer.from(
        JSON.stringify({ executor: "ensemble_manager", thread_id: "t1", model_id: "cfg", flow })
    )
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "") +
    ".sig";

const STORED_PLAN = {
    parameters: [
        { name: "top_n", default: "25", default_source: "flow" },
        { name: "lexicon_uri" },
        { name: "ckan_token", default: "tok", default_source: "flow" }
    ],
    secrets: [],
    flow: {
        linked_settings: [
            { step: 2, setting: "lexicon_uri", from: { step: 1, value: "lexicon_uri" } }
        ],
        inputs: [],
        collections: [
            {
                input: "in-corpus",
                resources: [
                    { name: "a.csv", url: "https://x/a.csv" },
                    { name: "b.csv", url: "https://x/b.csv" },
                    { name: "gone.csv", url: "https://x/gone.csv" }
                ]
            }
        ]
    }
};

const FLOW_RUN = {
    id: "run-1",
    plan_id: planId({ adapter_plan_id: "ap-1", planned_by: "alice" }),
    thread_id: "t1",
    model_id: "cfg",
    model_child_id: "exec-1",
    parameter_values: { top_n: "7", api_key: "k-secret" },
    adapter_run_ids: [
        {
            last_pause: { model_io_id: "out-lexicon", output_key: "1:1" },
            replacement: {
                url: "https://ckan/edit.json",
                file: "lexicon_draft.json",
                resource_id: "r9"
            }
        }
    ],
    model_result: {}
};

function fixture(over: { runs?: unknown[]; plan?: unknown; bindings?: unknown[] } = {}) {
    const writes: { query: string; variables: any }[] = [];
    const gql: Gql = async (query, variables: any) => {
        if (query.includes("mutation")) {
            writes.push({ query, variables });
            return {};
        }
        if (query.includes("FlowRuns")) return { unified_execution: over.runs ?? [FLOW_RUN] };
        if (query.includes("Execution(")) {
            return {
                execution_by_pk: {
                    id: variables.id,
                    data_bindings: over.bindings ?? [],
                    parameter_bindings: []
                }
            };
        }
        if (query.includes("Plan(")) {
            return {
                adapter_workflow_plan_by_pk:
                    over.plan === null ? null : { id: "ap-1", plan_json: over.plan ?? STORED_PLAN }
            };
        }
        if (query.includes("Resources(")) {
            return {
                resource: [
                    { id: "res-a", name: "a.csv", url: "https://x/a.csv" },
                    { id: "res-b", name: "b.csv", url: "https://x/b.csv" }
                ]
            };
        }
        if (query.includes("Parameters(")) {
            return {
                modelcatalog_configuration_by_pk: {
                    parameters: [
                        { parameter: { id: "par-top", label: "top_n" } },
                        { parameter: { id: "par-lex", label: "lexicon_uri" } },
                        { parameter: { id: "par-key", label: "api_key", parameter_type: "secret" } }
                    ]
                }
            };
        }
        throw new Error("unexpected query " + query);
    };
    return { gql, writes };
}

describe("backfilling flow provenance", () => {
    it("reads the plan id the service wrote", () => {
        expect(planOf(FLOW_RUN.plan_id).flow.adapter_plan_id).toBe("ap-1");
        expect(planOf("not-a-plan")).toBeNull();
    });

    it("by default only reports what it would write, and writes nothing", async () => {
        const { gql, writes } = fixture();
        const [report] = await backfillFlowProvenance(gql, { apply: false });

        expect(writes).toEqual([]);
        expect(report.outcome).toBe("rebuilt");
        expect(report.data_bindings).toEqual([
            { model_io_id: "in-corpus", resource_id: "res-a", name: "a.csv" },
            { model_io_id: "in-corpus", resource_id: "res-b", name: "b.csv" }
        ]);
        expect(report.unresolved_urls).toEqual(["https://x/gone.csv"]);
        expect(report.parameter_bindings).toEqual([
            { model_parameter_id: "par-top", value: "7" },
            { model_parameter_id: "par-lex", value: "linked: step 1 value lexicon_uri" }
        ]);
        expect(report.edit).toEqual({ model_io_id: "out-lexicon", url: "https://ckan/edit.json" });
        // No credential in the report, whatever sent it.
        expect(JSON.stringify(report)).not.toMatch(/k-secret|tok|api_key|ckan_token/);
    });

    it("writes only with --apply, insert-only", async () => {
        const { gql, writes } = fixture();
        await backfillFlowProvenance(gql, { apply: true });

        expect(writes).toHaveLength(2);
        const data = writes[0].variables.objects;
        expect(data.map((row: any) => row.resource_id ?? row.resource.data.url)).toEqual([
            "res-a",
            "res-b",
            "https://ckan/edit.json"
        ]);
        expect(writes[0].query).toContain("update_columns: []");
        expect(writes[1].variables.objects).toEqual([
            { execution_id: "exec-1", model_parameter_id: "par-top", parameter_value: "7" },
            {
                execution_id: "exec-1",
                model_parameter_id: "par-lex",
                parameter_value: "linked: step 1 value lexicon_uri"
            }
        ]);
    });

    it("leaves a run that already has its inputs alone", async () => {
        const { gql, writes } = fixture({
            runs: [{ ...FLOW_RUN, adapter_run_ids: [{}] }],
            bindings: [{ model_io_id: "in-corpus", resource_id: "res-a" }]
        });
        const [report] = await backfillFlowProvenance(gql, { apply: true });
        expect(report.data_bindings).toEqual([]);
        expect(writes.every((write) => write.query.includes("Params"))).toBe(true);
    });

    it("says a run is partial when the adapter's plan is gone, and skips non-flow runs", async () => {
        const { gql } = fixture({
            plan: null,
            runs: [FLOW_RUN, { ...FLOW_RUN, id: "model", plan_id: "em_" + "e30" + ".sig" }]
        });
        const reports = await backfillFlowProvenance(gql, { apply: false });
        expect(reports).toHaveLength(1);
        expect(reports[0].outcome).toBe("partial");
        expect(reports[0].data_bindings).toEqual([]);
        expect(reports[0].parameter_bindings).toEqual([
            { model_parameter_id: "par-top", value: "7" }
        ]);
    });

    it("skips a run that never created its execution", async () => {
        const { gql } = fixture({ runs: [{ ...FLOW_RUN, model_child_id: null }] });
        const [report] = await backfillFlowProvenance(gql, { apply: false });
        expect(report.outcome).toBe("skipped");
    });
});
