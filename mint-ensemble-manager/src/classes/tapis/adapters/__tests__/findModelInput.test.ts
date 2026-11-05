import { Apps } from "@tapis/tapis-typescript";
import { TapisJobService } from "@/classes/tapis/adapters/TapisJobService";
import { Model } from "@/classes/mint/mint-types";

const input = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
    id,
    name,
    variables: [],
    ...extra
});

const modelOf = (inputs: ReturnType<typeof input>[]) =>
    ({ input_files: inputs }) as unknown as Model;
const service = new TapisJobService(undefined as never, undefined as never, undefined as never);

describe("TapisJobService.findModelInput", () => {
    test("prefers the app_input_name binding over a label match", () => {
        const model = modelOf([
            input("in/label", "aoi-geojson"),
            input("in/bound", "AOI GeoJSON", { app_input_name: "aoi-geojson" })
        ]);
        expect(service.findModelInput("aoi-geojson", model)?.id).toBe("in/bound");
    });

    test("falls back to the exact label for an unbound model", () => {
        const model = modelOf([input("in/label", "aoi-geojson")]);
        expect(service.findModelInput("aoi-geojson", model)?.id).toBe("in/label");
    });

    test("keeps the MODFLOW fuzzy fallback", () => {
        const model = modelOf([input("in/zip", "Simulation archive", { format: "zip" })]);
        expect(service.findModelInput("mf6-simulation-archive", model)?.id).toBe("in/zip");
    });

    test("returns undefined when nothing matches", () => {
        expect(service.findModelInput("nope", modelOf([input("in/a", "a")]))).toBeUndefined();
    });
});

describe("TapisJobService.findUnmatchedOptionalInputs", () => {
    test("lists OPTIONAL app inputs no model input feeds", () => {
        const app = {
            jobAttributes: {
                fileInputs: [
                    { name: "aoi-geojson", inputMode: "OPTIONAL" },
                    { name: "mystery", inputMode: "OPTIONAL" },
                    { name: "required-x", inputMode: "REQUIRED" },
                    { name: "fixed-x", inputMode: "FIXED" }
                ]
            }
        } as unknown as Apps.TapisApp;
        const model = modelOf([input("in/bound", "AOI", { app_input_name: "aoi-geojson" })]);
        expect(service.findUnmatchedOptionalInputs(app, model)).toEqual(["mystery"]);
    });
});
