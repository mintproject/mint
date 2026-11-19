import { ExecutionCreation } from "@/classes/common/ExecutionCreation";
import { Thread } from "@/classes/mint/mint-types";
import { MockExecutionService } from "./mocks/MockExecutionService";

jest.mock("@/classes/graphql/graphql_functions");

const RUNNABLE = "https://w3id.org/okn/i/mint/runnable";
const NO_COMPONENT = "https://w3id.org/okn/i/mint/no-component";

function threadWithTwoModels(): Thread {
    return {
        model_ensembles: { [RUNNABLE]: { id: "tm-1" }, [NO_COMPONENT]: { id: "tm-2" } },
        models: {
            [RUNNABLE]: { id: RUNNABLE, code_url: "https://tapis.example/v3/apps/runnable" },
            [NO_COMPONENT]: { id: NO_COMPONENT, code_url: "" }
        }
    } as unknown as Thread;
}

describe("ExecutionCreation.prepareExecutions component checks", () => {
    let getModelDetails: jest.SpyInstance;

    beforeEach(() => {
        // A configuration with no component cannot be loaded at all.
        getModelDetails = jest
            .spyOn(
                ExecutionCreation.prototype as unknown as { getModelDetails: () => unknown },
                "getModelDetails"
            )
            .mockImplementation(async (model: { id: string; code_url: string }) => {
                if (!model.code_url) throw new Error("Component not found: " + model.id);
                return { id: "comp", version: "1", inputs: [], outputs: [] };
            });
        jest.spyOn(ExecutionCreation.prototype, "prepareModelExecutions").mockResolvedValue(true);
    });

    afterEach(() => jest.restoreAllMocks());

    it("checks only the model being run, so another model in the thread cannot stop it", async () => {
        const creation = new ExecutionCreation(
            threadWithTwoModels(),
            RUNNABLE,
            new MockExecutionService([])
        );

        await expect(creation.prepareExecutions()).resolves.toBe(true);

        expect(getModelDetails).toHaveBeenCalledTimes(1);
        expect(getModelDetails.mock.calls[0][0].id).toBe(RUNNABLE);
        expect(creation.prepareModelExecutions).toHaveBeenCalledWith(RUNNABLE);
    });

    it("still fails when the model being run is the one that cannot be loaded", async () => {
        const creation = new ExecutionCreation(
            threadWithTwoModels(),
            NO_COMPONENT,
            new MockExecutionService([])
        );

        await expect(creation.prepareExecutions()).rejects.toThrow("Component not found");
        expect(creation.prepareModelExecutions).not.toHaveBeenCalled();
    });

    it("checks every model when no model is named, as before", async () => {
        const creation = new ExecutionCreation(
            threadWithTwoModels(),
            "",
            new MockExecutionService([])
        );

        await expect(creation.prepareExecutions()).rejects.toThrow("Component not found");
        expect(getModelDetails.mock.calls.map((call) => call[0].id)).toEqual([
            RUNNABLE,
            NO_COMPONENT
        ]);
    });
});
