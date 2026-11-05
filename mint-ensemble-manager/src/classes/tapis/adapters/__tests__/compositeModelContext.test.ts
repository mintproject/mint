import { Apps } from "@tapis/tapis-typescript";
import { TapisExecutionService } from "@/classes/tapis/adapters/TapisExecutionService";
import { ExecutionCreation } from "@/classes/common/ExecutionCreation";
import { modelFromGQL } from "@/classes/graphql/graphql_adapter";
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

const catalogInput = (id: string, label: string, appInputName?: string, optional = true) => ({
    is_optional: optional,
    app_input_name: appInputName ?? null,
    input: { id, label, has_format: "geojson", position: 1, presentations: [] }
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

function buildService(inputs: ReturnType<typeof catalogInput>[]) {
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
    return { model, service: new TapisExecutionService("token", "http://tapis") };
}

// `bound` maps a model input id to the dataset resource urls bound to it; the
// job definition's fileInputs come from the real TapisJobService.
async function context(
    inputs: ReturnType<typeof catalogInput>[],
    tapisApp: Apps.TapisApp,
    bound: Record<string, string[]> = {}
) {
    const { model, service } = buildService(inputs);
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
    const result = await service.compositeModelContext({
        thread_id: "thread-1",
        model_id: "config/subside"
    });
    return { result, previewExecutions };
}

describe("model input app_input_name", () => {
    test("modelFromGQL carries the catalog binding, absent when null", () => {
        const model = modelFromGQL({
            id: "m",
            inputs: [
                catalogInput("in/aoi", "AOI GeoJSON", "aoi-geojson"),
                catalogInput("in/x", "x")
            ]
        });
        expect(model.input_files[0].app_input_name).toBe("aoi-geojson");
        expect(model.input_files[1].app_input_name).toBeUndefined();
    });
});

describe("compositeModelContext", () => {
    beforeEach(() => jest.clearAllMocks());

    test("returns the configuration, region and outputs, built without database writes", async () => {
        const { result, previewExecutions } = await context(
            [catalogInput("in/aoi", "AOI GeoJSON", "aoi-geojson")],
            appWithInputs([{ name: "aoi-geojson" }])
        );
        expect(result).toMatchObject({
            configuration_id: "config/subside",
            region,
            has_bound_inputs: true,
            outputs: [{ id: "out", name: "out", format: "zip" }]
        });
        expect(previewExecutions).toHaveBeenCalledTimes(1);
        const instance = (ExecutionCreation as unknown as jest.Mock).mock.results[0].value;
        expect(instance.prepareExecutions).not.toHaveBeenCalled();
    });

    test("filled_app_inputs holds bound datasets and FIXED app inputs, not unfilled ones", async () => {
        const { result } = await context(
            [
                catalogInput("in/aoi", "AOI GeoJSON", "aoi-geojson"),
                catalogInput("in/dem", "dem", "dem")
            ],
            appWithInputs([
                { name: "aoi-geojson" },
                { name: "dem" },
                { name: "earthdata-netrc", inputMode: "FIXED" }
            ]),
            { "in/dem": ["https://data.example/dem.tif"] }
        );
        expect([...result.filled_app_inputs].sort()).toEqual(["dem", "earthdata-netrc"]);
    });

    test("an OPTIONAL app input matched by neither binding nor label is reported", async () => {
        const { result } = await context(
            [catalogInput("in/aoi", "AOI GeoJSON", "aoi-geojson")],
            appWithInputs([{ name: "aoi-geojson" }, { name: "mystery" }])
        );
        expect(result.unmatched_optional_inputs).toEqual(["mystery"]);
    });

    test("a model with no bound input returns early without consulting Tapis", async () => {
        const { service } = buildService([catalogInput("in/aoi", "aoi-geojson")]);
        const load = jest.spyOn(service, "loadTapisApp");
        const result = await service.compositeModelContext({
            thread_id: "thread-1",
            model_id: "config/subside"
        });
        expect(result).toMatchObject({
            configuration_id: "config/subside",
            region: null,
            has_bound_inputs: false,
            filled_app_inputs: [],
            unmatched_optional_inputs: []
        });
        expect(load).not.toHaveBeenCalled();
        expect(ExecutionCreation).not.toHaveBeenCalled();
    });
});
