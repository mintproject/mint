import { mapHasuraOutputsToModelOutputs } from "@/classes/graphql/graphql_functions";

describe("mapHasuraOutputsToModelOutputs", () => {
    it("maps Hasura configuration outputs to ModelOutput[]", () => {
        const hasuraOutputs = [
            {
                output: {
                    id: "https://w3id.org/okn/i/mint/cdd558dc",
                    label: "out.txt",
                    has_format: "txt",
                    description: "Message",
                    __typename: "modelcatalog_dataset_specification"
                },
                __typename: "modelcatalog_configuration_output"
            }
        ];

        const result = mapHasuraOutputsToModelOutputs(hasuraOutputs);

        expect(result).toEqual([
            {
                position: 1,
                model_io: {
                    id: "https://w3id.org/okn/i/mint/cdd558dc",
                    name: "out.txt",
                    format: "txt",
                    variables: []
                }
            }
        ]);
    });

    it("returns [] for null/undefined/empty input", () => {
        expect(mapHasuraOutputsToModelOutputs(null)).toEqual([]);
        expect(mapHasuraOutputsToModelOutputs(undefined)).toEqual([]);
        expect(mapHasuraOutputsToModelOutputs([])).toEqual([]);
    });

    it("skips entries with missing output", () => {
        const result = mapHasuraOutputsToModelOutputs([
            { output: null },
            {
                output: {
                    id: "id-1",
                    label: "a.tif",
                    has_format: "tif"
                }
            }
        ]);

        expect(result).toHaveLength(1);
        expect(result[0].model_io.name).toBe("a.tif");
    });

    it("handles missing label and has_format", () => {
        const result = mapHasuraOutputsToModelOutputs([{ output: { id: "id-1" } }]);

        expect(result[0].model_io.name).toBe("");
        expect(result[0].model_io.format).toBeUndefined();
    });
});
