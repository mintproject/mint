import {
    executionToGQL,
    executionFromGQL,
    executionResultsToGQL,
    modelIOFromCatalogGQL,
    modelFromGQL
} from "@/classes/graphql/graphql_adapter";
import { Execution } from "@/classes/mint/mint-types";

const makeExecution = (overrides: Partial<Execution> = {}): Execution => ({
    id: "abc123",
    modelid: "https://w3id.org/okn/i/mint/test-config",
    bindings: {},
    start_time: new Date("2024-01-01T00:00:00Z"),
    status: "WAITING",
    run_progress: 0,
    results: [],
    selected: false,
    ...overrides
});

describe("executionToGQL", () => {
    it("maps modelid to modelcatalog_configuration_id", () => {
        const ex = makeExecution({ modelid: "https://w3id.org/okn/i/mint/test-config" });
        const result = executionToGQL(ex);
        expect(result.modelcatalog_configuration_id).toBe("https://w3id.org/okn/i/mint/test-config");
        expect(result).not.toHaveProperty("model_id");
    });

    it("preserves status, run_progress, and other fields", () => {
        const ex = makeExecution({
            id: "exec-001",
            status: "RUNNING",
            run_progress: 42,
            execution_engine: "tapis",
            runid: "run-xyz"
        });
        const result = executionToGQL(ex);
        expect(result.status).toBe("RUNNING");
        expect(result.run_progress).toBe(42);
        expect(result.execution_engine).toBe("tapis");
        expect(result.run_id).toBe("run-xyz");
        expect(result.id).toBe("exec-001");
    });
});

describe("modelIOFromCatalogGQL", () => {
    it("reads is_optional=true from junction row", () => {
        const row = {
            input: { id: "ds-1", label: "DS One", has_format: "", position: 1 },
            is_optional: true
        };
        const result = modelIOFromCatalogGQL(row);
        expect(result.is_optional).toBe(true);
        expect(result.id).toBe("ds-1");
    });

    it("defaults is_optional to false when absent from junction row", () => {
        const row = {
            input: { id: "ds-2", label: "DS Two", has_format: "", position: 2 }
        };
        const result = modelIOFromCatalogGQL(row);
        expect(result.is_optional).toBe(false);
    });
});

describe("executionFromGQL", () => {
    const makeGQLExecution = (overrides: Record<string, any> = {}) => ({
        id: "abc-123",
        modelcatalog_configuration_id: "https://w3id.org/okn/i/mint/test-config",
        status: "SUCCESS",
        start_time: "2024-01-01T00:00:00Z",
        end_time: null,
        execution_engine: "localex",
        run_progress: 100,
        run_id: "run-abc",
        parameter_bindings: [],
        data_bindings: [],
        results: [],
        ...overrides
    });

    it("reads modelcatalog_configuration_id into Execution.modelid", () => {
        const gqlEx = makeGQLExecution({ modelcatalog_configuration_id: "https://w3id.org/okn/i/mint/test-config" });
        const result = executionFromGQL(gqlEx);
        expect(result.modelid).toBe("https://w3id.org/okn/i/mint/test-config");
    });

    it("returns undefined for modelid when modelcatalog_configuration_id is missing", () => {
        const gqlEx = makeGQLExecution();
        delete gqlEx.modelcatalog_configuration_id;
        const result = executionFromGQL(gqlEx);
        expect(result.modelid).toBeUndefined();
    });
});

describe("executionResultsToGQL", () => {
    it("serializes results whose resource has no time period", () => {
        expect(executionResultsToGQL({
            "output-1": {
                id: "resource-1",
                name: "model output",
                url: "tapis://ls6/output-1"
            }
        })).toMatchObject([{
            model_io_id: "output-1",
            resource: {
                data: {
                    dcid: "resource-1",
                    name: "model output",
                    url: "tapis://ls6/output-1"
                }
            }
        }]);
    });
});

describe("output junction archived_file and declaration order", () => {
    const outputRow = (id: string, position: number, archived_file?: string | null) => ({
        archived_file,
        output: { id, label: id, has_format: "tif", position }
    });

    it("reads archived_file from the output junction row", () => {
        expect(modelIOFromCatalogGQL(outputRow("o1", 1, "*.tif"), "output").archived_file).toBe(
            "*.tif"
        );
        expect(
            modelIOFromCatalogGQL(outputRow("o2", 1, null), "output").archived_file
        ).toBeUndefined();
    });

    it("orders outputs by position regardless of row order, ties by id", () => {
        const rows = [outputRow("d", 4), outputRow("c", 2), outputRow("b", 2), outputRow("a", 1)];
        const model = modelFromGQL({ id: "cfg", label: "Cfg", outputs: rows });
        expect(model.output_files.map((o) => o.id)).toEqual(["a", "b", "c", "d"]);
        expect(rows.map((r) => r.output.id)).toEqual(["d", "c", "b", "a"]);
    });

    it("orders inputs by position without mutating the rows", () => {
        const rows = [
            { input: { id: "i2", label: "i2", position: 3 } },
            { input: { id: "i1", label: "i1", position: 1 } }
        ];
        const model = modelFromGQL({ id: "cfg", label: "Cfg", inputs: rows });
        expect(model.input_files.map((i) => i.id)).toEqual(["i1", "i2"]);
    });
});
