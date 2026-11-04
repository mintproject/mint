import {
    modelFromGQL,
    modelSecretFromCatalogGQL,
    threadParameterBindingsToGQL
} from "@/classes/graphql/graphql_adapter";
import { ExecutionCreation } from "@/classes/common/ExecutionCreation";
import { getInputsParameters } from "@/classes/tapis/helpers";
import { Model, Region } from "@/classes/mint/mint-types";
import { MockExecutionService } from "@/classes/common/__tests__/mocks/MockExecutionService";

jest.mock("@/classes/mint/mint-functions", () => ({
    getConfiguration: jest.fn().mockReturnValue({ execution_engine: "tapis" })
}));

const secretRow = {
    id: "param/earthdata",
    label: "earthdata",
    description: "NASA Earthdata login",
    parameter_type: "secret",
    position: 3,
    has_default_value: null,
    has_accepted_values: ["username=EARTHDATA_USERNAME", "password=EARTHDATA_PASSWORD"]
};
const plainRow = {
    id: "param/start_date",
    label: "START_DATE",
    parameter_type: "string",
    position: 1,
    has_default_value: "2024-01-01"
};
const catalogConfig = {
    id: "config/subside",
    label: "SUBSIDE",
    parameters: [{ parameter: plainRow }, { parameter: secretRow }]
};

describe("secret catalog parameters", () => {
    let model: Model;
    beforeEach(() => {
        model = modelFromGQL(catalogConfig);
    });

    test("secret rows are moved from input_parameters to required_secrets", () => {
        expect(model.input_parameters.map((p) => p.id)).toEqual(["param/start_date"]);
        expect(model.required_secrets).toEqual([
            {
                name: "earthdata",
                description: "NASA Earthdata login",
                source: "owner_only",
                env: { username: "EARTHDATA_USERNAME", password: "EARTHDATA_PASSWORD" }
            }
        ]);
    });

    test("configurations without secrets get an empty required_secrets", () => {
        const plain = modelFromGQL({ ...catalogConfig, parameters: [{ parameter: plainRow }] });
        expect(plain.required_secrets).toEqual([]);
    });

    test("source is parsed from usage_notes and defaults to owner_only", () => {
        expect(
            modelSecretFromCatalogGQL({ ...secretRow, usage_notes: "source=user_then_owner" })
                .source
        ).toBe("user_then_owner");
        expect(
            modelSecretFromCatalogGQL({ ...secretRow, usage_notes: "source=bogus" }).source
        ).toBe("owner_only");
    });

    test("getInputsParameters never sees the secret", () => {
        const { parameters, parameterTypes } = getInputsParameters(
            model,
            { "param/earthdata": ["x"], "param/start_date": ["2024-02-02"] } as any,
            {} as Region
        );
        expect(Object.keys(parameters)).toEqual(["param/start_date"]);
        expect(Object.keys(parameterTypes)).toEqual(["param/start_date"]);
    });

    test("a binding for a secret parameter id is ignored when persisting thread bindings", () => {
        const thread = { models: { [model.id]: model } } as any;
        const bindings = threadParameterBindingsToGQL(
            {
                [model.id]: {
                    id: "tm-1",
                    bindings: {
                        "param/start_date": ["2024-02-02"],
                        "param/earthdata": ["hunter2"]
                    }
                }
            } as any,
            thread
        );
        expect(bindings).toEqual([
            {
                thread_model_id: "tm-1",
                model_parameter_id: "param/start_date",
                parameter_value: "2024-02-02"
            }
        ]);
    });

    test("ExecutionCreation.getModelDetails excludes the secret from component inputs", async () => {
        const creation = new ExecutionCreation(
            { models: {}, model_ensembles: {} } as any,
            model.id,
            new MockExecutionService([])
        );
        jest.spyOn(creation as any, "loadComponentFromTapis").mockResolvedValue({
            id: "comp",
            version: "1"
        });
        const component = await (creation as any).getModelDetails({
            ...model,
            code_url: "tapis://app",
            input_files: [],
            output_files: []
        });
        expect(component.inputs.map((i: any) => i.id)).toEqual(["param/start_date"]);
    });
});
