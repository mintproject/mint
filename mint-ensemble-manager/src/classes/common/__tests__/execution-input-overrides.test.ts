import { applyExecutionInputOverrides } from "@/classes/common/execution-input-overrides";

describe("applyExecutionInputOverrides", () => {
    it("replaces one model input with adapter-produced resources", () => {
        const thread: any = {
            id: "thread-1",
            data: {},
            models: {
                "model-1": {
                    input_files: [{ id: "springflow-input" }]
                }
            },
            model_ensembles: {
                "model-1": { id: "thread-model-1", bindings: { "springflow-input": ["old-slice"] } }
            }
        };

        applyExecutionInputOverrides(thread, "model-1", [
            {
                model_io_id: "springflow-input",
                resource_id: "output-1",
                name: "springflow output",
                url: "https://example.test/springflow.csv"
            }
        ]);

        const sliceId = thread.model_ensembles["model-1"].bindings["springflow-input"][0];
        expect(sliceId).toContain("__unified_adapter_output");
        expect(thread.data[sliceId].resources).toEqual([
            {
                id: "output-1",
                name: "springflow output",
                url: "https://example.test/springflow.csv",
                selected: true
            }
        ]);
    });

    it("rejects an output targeted at a non-input model I/O", () => {
        const thread: any = {
            id: "thread-1",
            data: {},
            models: { "model-1": { input_files: [{ id: "input-1" }] } },
            model_ensembles: { "model-1": { id: "thread-model-1", bindings: {} } }
        };

        expect(() =>
            applyExecutionInputOverrides(thread, "model-1", [
                {
                    model_io_id: "output-1",
                    resource_id: "resource-1",
                    url: "https://example.test/out"
                }
            ])
        ).toThrow("is not an input");
    });
});
