import { Apps } from "@tapis/tapis-typescript";
import { TapisExecutionService } from "@/classes/tapis/adapters/TapisExecutionService";
import { ExecutionCreation } from "@/classes/common/ExecutionCreation";
import { modelFromGQL } from "@/classes/graphql/graphql_adapter";
import { AOI_STANDARD_VARIABLE_URI } from "@/api/api-v1/services/inputStepDerivation";
import app from "../tests/fixtures/app";

jest.mock("@/classes/mint/mint-functions", () => ({
    getConfiguration: jest.fn().mockReturnValue({
        auth: { client_id: "c", server: "http://s", realm: "r" },
        graphql: { endpoint: "http://g", secret: "s", enable_ssl: false }
    })
}));
jest.mock("@/classes/graphql/graphql_functions_v2", () => ({
    getThread: jest.fn().mockResolvedValue({})
}));
jest.mock("@/classes/graphql/graphql_adapter", () => ({
    ...jest.requireActual("@/classes/graphql/graphql_adapter"),
    threadFromGQL: jest.fn()
}));
jest.mock("@/classes/common/ExecutionCreation");

import { threadFromGQL } from "@/classes/graphql/graphql_adapter";

const catalogInput = (id: string, label: string, standardVariables: string[], optional = true) => ({
    is_optional: optional,
    input: {
        id,
        label,
        has_format: "geojson",
        position: 1,
        presentations: standardVariables.map((uri) => ({
            presentation: { id: `${id}/presentation`, has_standard_variable: uri }
        }))
    }
});

const appWithInputs = (names: { name: string; inputMode?: string }[]) =>
    ({
        ...app,
        jobAttributes: {
            ...app.jobAttributes,
            parameterSet: { ...app.jobAttributes.parameterSet, appArgs: [], envVariables: [] },
            fileInputs: names.map(({ name, inputMode }) => ({
                name,
                inputMode: inputMode || "OPTIONAL",
                autoMountLocal: true,
                sourceUrl: null,
                targetPath: `config/${name}`
            }))
        }
    }) as unknown as Apps.TapisApp;

const region = { id: "region-waco", name: "Waco", geometries: [] };

// `bound` maps a model input id to the dataset resource urls bound to it.
async function find(
    inputs: ReturnType<typeof catalogInput>[],
    tapisApp: Apps.TapisApp,
    bound: Record<string, string[]> = {}
) {
    const model = modelFromGQL({
        id: "config/subside",
        label: "SUBSIDE",
        inputs,
        outputs: [{ output: { id: "out", label: "out", has_format: "zip" } }]
    });
    (threadFromGQL as jest.Mock).mockReturnValue({
        id: "thread-1",
        models: { "config/subside": model },
        model_ensembles: {}
    });
    const service = new TapisExecutionService("token", "http://tapis");
    jest.spyOn(service, "loadTapisApp").mockResolvedValue(tapisApp);
    const previewExecutions = jest.fn().mockResolvedValue(undefined);
    (ExecutionCreation as unknown as jest.Mock).mockImplementation(() => ({
        previewExecutions,
        prepareExecutions: jest.fn(),
        executionToBeRun: [
            {
                id: "exec-1",
                bindings: Object.fromEntries(
                    Object.entries(bound).flatMap(([id, urls]) =>
                        urls.map((url, i) => [id, { id: `${id}/r${i}`, name: "r", url }])
                    )
                )
            }
        ],
        threadRegion: region,
        component: { id: "app", version: "1" },
        model
    }));
    const result = await service.findUnboundInputsByStandardVariable(
        { thread_id: "thread-1", model_id: "config/subside" },
        AOI_STANDARD_VARIABLE_URI
    );
    return { result, previewExecutions };
}

describe("model input standard variables", () => {
    test("modelFromGQL exposes the standard variables of an input's presentations", () => {
        const model = modelFromGQL({
            id: "m",
            inputs: [
                catalogInput("in/aoi", "aoi-geojson", [AOI_STANDARD_VARIABLE_URI, AOI_STANDARD_VARIABLE_URI]),
                catalogInput("in/plain", "plain", [])
            ]
        });
        expect(model.input_files[0].standard_variables).toEqual([AOI_STANDARD_VARIABLE_URI]);
        expect(model.input_files[1].standard_variables).toEqual([]);
    });
});

describe("findUnboundInputsByStandardVariable", () => {
    beforeEach(() => jest.clearAllMocks());

    test("a typed input the job does not fill is returned, built without database writes", async () => {
        const { result, previewExecutions } = await find(
            [catalogInput("in/aoi", "aoi-geojson", [AOI_STANDARD_VARIABLE_URI])],
            appWithInputs([{ name: "aoi-geojson" }])
        );
        expect(result.inputs).toEqual([
            { app_input_name: "aoi-geojson", model_input_id: "in/aoi" }
        ]);
        expect(result.region).toBe(region);
        expect(result.outputs).toEqual([{ id: "out", name: "out", format: "zip" }]);
        expect(previewExecutions).toHaveBeenCalledTimes(1);
        const instance = (ExecutionCreation as unknown as jest.Mock).mock.results[0].value;
        expect(instance.prepareExecutions).not.toHaveBeenCalled();
    });

    test("a typed input filled by a bound dataset is not returned", async () => {
        const { result } = await find(
            [catalogInput("in/aoi", "aoi-geojson", [AOI_STANDARD_VARIABLE_URI])],
            appWithInputs([{ name: "aoi-geojson" }]),
            { "in/aoi": ["https://data.example/aoi.geojson"] }
        );
        expect(result.inputs).toEqual([]);
    });

    test("an untyped input is never derived and Tapis is not consulted", async () => {
        const service = new TapisExecutionService("token", "http://tapis");
        const load = jest.spyOn(service, "loadTapisApp");
        (threadFromGQL as jest.Mock).mockReturnValue({
            id: "thread-1",
            models: {
                "config/subside": modelFromGQL({
                    id: "config/subside",
                    inputs: [catalogInput("in/aoi", "aoi-geojson", [])]
                })
            },
            model_ensembles: {}
        });
        const result = await service.findUnboundInputsByStandardVariable(
            { thread_id: "thread-1", model_id: "config/subside" },
            AOI_STANDARD_VARIABLE_URI
        );
        expect(result).toEqual({ region: null, inputs: [], outputs: [] });
        expect(load).not.toHaveBeenCalled();
        expect(ExecutionCreation).not.toHaveBeenCalled();
    });

    test("a FIXED app input is never derived", async () => {
        const { result } = await find(
            [catalogInput("in/aoi", "aoi-geojson", [AOI_STANDARD_VARIABLE_URI])],
            appWithInputs([{ name: "aoi-geojson", inputMode: "FIXED" }])
        );
        expect(result.inputs).toEqual([]);
    });

    test("two typed unbound inputs are both returned for the caller to refuse", async () => {
        const { result } = await find(
            [
                catalogInput("in/a", "aoi-a", [AOI_STANDARD_VARIABLE_URI]),
                catalogInput("in/b", "aoi-b", [AOI_STANDARD_VARIABLE_URI])
            ],
            appWithInputs([{ name: "aoi-a" }, { name: "aoi-b" }])
        );
        expect(result.inputs.map((input) => input.app_input_name)).toEqual(["aoi-a", "aoi-b"]);
    });
});
