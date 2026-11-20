import model from "@/classes/tapis/fixtures/model";
import bindings from "@/classes/tapis/fixtures/input-bindings";
import { getInputDatasets, getInputsParameters } from "@/classes/tapis/helpers";
import { Model, Region } from "@/classes/mint/mint-types";

test("get inputs datasets", () => {
    const key = "https://w3id.org/okn/i/mint/modflow_2005_BartonSprings_avg_Bas";
    const datasets = getInputDatasets(model, bindings);
    const datasets_keys = Object.keys(datasets);
    expect(datasets_keys).toHaveLength(9);
    expect(datasets_keys).toContain(key);
    expect(datasets[key]).toHaveLength(1);
    expect(datasets[key][0].id).toBe("6a40bdbdbb72888c539fdd4b39d50bba");
    expect(datasets[key][0].name).toBe("BARTON_SPRINGS_2001_2010AVERAGE.ba6");
    expect(datasets[key][0].url).toBe(
        "https://data.mint.isi.edu/files/sample-inputs-outputs/modflowInputs/BARTON_SPRINGS_2001_2010AVERAGE.ba6"
    );
});

describe("getInputsParameters", () => {
    const region = { geometries: [] } as unknown as Region;
    const paramId = "https://w3id.org/okn/i/mint/4103a17f-9927-4c76-824d-753daecd0698";

    const buildModel = (params: unknown[]): Model =>
        ({ input_parameters: params }) as unknown as Model;

    test("does not throw when binding value is empty string and parameter has no default", () => {
        const m = buildModel([{ id: paramId, type: "string" }]);
        const empty: Record<string, string> = { [paramId]: "" };
        expect(() => getInputsParameters(m, empty as never, region)).not.toThrow();
        const { parameters } = getInputsParameters(m, empty as never, region);
        expect(parameters[paramId]).toBeUndefined();
    });

    test("uses binding value when provided", () => {
        const m = buildModel([{ id: paramId, type: "int" }]);
        const b: Record<string, string> = { [paramId]: "42" };
        const { parameters, parameterTypes } = getInputsParameters(m, b as never, region);
        expect(parameters[paramId]).toBe("42");
        expect(parameterTypes[paramId]).toBe("int");
    });

    test("falls back to ip.value default", () => {
        const m = buildModel([{ id: paramId, type: "string", value: "default" }]);
        const { parameters } = getInputsParameters(m, {} as never, region);
        expect(parameters[paramId]).toBe("default");
    });
});
