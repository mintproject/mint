import useModelParameterService from "./useModelParameterService";
import { BadRequestError, NotFoundError } from "@/classes/common/errors";
import { AddParametersRequest } from "../../paths/problemStatements/tasks/subtasks";
import { Thread } from "@/classes/mint/mint-types";
import { convertApiUrlToW3Id } from "@/classes/mint/model-catalog-graphql-adapter";
import { GraphQL } from "@/config/graphql";
import { KeycloakAdapter } from "@/config/keycloak-adapter";

// Mocks
jest.mock("@/classes/mint/model-catalog-graphql-adapter", () => ({
    ...jest.requireActual("@/classes/mint/model-catalog-graphql-adapter"),
    convertApiUrlToW3Id: jest.fn()
}));
jest.mock("@/config/graphql", () => ({
    GraphQL: {
        instanceUsingAccessToken: jest.fn(),
        instance: jest.fn()
    }
}));
jest.mock("@/config/keycloak-adapter", () => ({
    KeycloakAdapter: {
        getUser: jest.fn()
    }
}));

// Fixtures
const bindingRequest: AddParametersRequest = {
    model_id:
        "http://api.models.mint.local/v1.8.0/modelconfigurationsetups/c07a6f98-6339-4033-84b0-6cd7daca6284?username=mint%40isi.edu",
    parameters: [
        {
            id: "https://w3id.org/okn/i/mint/parameter1",
            value: "value1"
        },
        {
            id: "https://w3id.org/okn/i/mint/parameter2",
            value: ["value2a", "value2b"]
        }
    ]
};

const subtask: Thread = {
    id: "IBPfQmxbzJ3GseVKh7Hz",
    task_id: "FEUMjksoMJdsIseM44q4",
    regionid: "texas",
    name: "test2",
    dates: {
        start_date: new Date("2023-12-31T00:00:00.000Z"),
        end_date: new Date("2025-12-31T00:00:00.000Z")
    },
    driving_variables: [],
    response_variables: [],
    execution_summary: {},
    events: [
        {
            event: "CREATE",
            userid: "mosorio",
            timestamp: new Date("2025-06-17T19:48:23.751Z"),
            notes: ""
        },
        {
            event: "SELECT_MODELS",
            userid: "mosorio",
            timestamp: new Date("2025-06-18T14:28:19.320Z"),
            notes: ""
        }
    ],
    models: {
        "https://w3id.org/okn/i/mint/c07a6f98-6339-4033-84b0-6cd7daca6284": {
            id: "https://w3id.org/okn/i/mint/c07a6f98-6339-4033-84b0-6cd7daca6284",
            name: "MODFLOW 2005 setup calibrated for Drought assessment (Recharge file is selected)",
            description: "Modflow configuration ",
            category: "Hydrology",
            region_name: "",
            dimensionality: "3D",
            model_version: "https://w3id.org/okn/i/mint/modflow_2005",
            model_name: "https://w3id.org/okn/i/mint/MODFLOW",
            model_configuration: "https://w3id.org/okn/i/mint/modflow_2005_cfg",
            parameter_assignment: "Calibration",
            parameter_assignment_details: "",
            calibration_target_variable: "",
            spatial_grid_type: "SpatiallyDistributedGrid",
            spatial_grid_resolution: "variable range",
            code_url: "https://portals.tapis.io/v3/apps/modflow-2005/0.0.6",
            software_image: "mintproject/modflow-2005:latest",
            input_files: [],
            output_files: [],
            input_parameters: []
        }
    },
    data: {},
    model_ensembles: {
        "https://w3id.org/okn/i/mint/c07a6f98-6339-4033-84b0-6cd7daca6284": {
            id: "e6681044-dd68-4618-8cc6-fa35db021030",
            bindings: {}
        }
    }
};

const modelW3Id = "https://w3id.org/okn/i/mint/c07a6f98-6339-4033-84b0-6cd7daca6284";

// GraphQL response shape: parameters = [{parameter: {id, has_fixed_value, ...}}]
const mockCatalogSetup = {
    id: bindingRequest.model_id,
    parameters: [
        { parameter: { id: "https://w3id.org/okn/i/mint/parameter1", has_fixed_value: null } },
        { parameter: { id: "https://w3id.org/okn/i/mint/parameter2", has_fixed_value: null } }
    ]
};

const mockApolloClient = {
    query: jest.fn()
};

describe("useModelParameterService", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        (convertApiUrlToW3Id as jest.Mock).mockReturnValue(modelW3Id);
        (GraphQL.instance as jest.Mock).mockReturnValue(mockApolloClient);
        (GraphQL.instanceUsingAccessToken as jest.Mock).mockReturnValue(mockApolloClient);
        (KeycloakAdapter.getUser as jest.Mock).mockReturnValue({
            email: "test@test.com",
            uid: "1",
            region: "",
            graph: ""
        });
    });

    it("should check if parameter has fixed value", () => {
        const parameterWithFixed = { id: "test", has_fixed_value: "fixed-value" };
        const parameterWithoutFixed = { id: "test", has_fixed_value: null };

        expect(useModelParameterService.hasParameterHasFixedValue(parameterWithFixed)).toBe(true);
        expect(useModelParameterService.hasParameterHasFixedValue(parameterWithoutFixed)).toBe(
            false
        );
    });

    it("should get model parameters excluding fixed values", async () => {
        // ModelWithParameters shape (produced by catalogModelToModelWithParameters)
        const modelWithParams = {
            id: bindingRequest.model_id,
            hasParameter: [
                { id: "https://w3id.org/okn/i/mint/parameter1", has_fixed_value: null },
                { id: "https://w3id.org/okn/i/mint/parameter2", has_fixed_value: null },
                { id: "https://w3id.org/okn/i/mint/parameter3", has_fixed_value: "fixed-value" }
            ]
        };

        const parameters = await useModelParameterService.getModelParameters(modelWithParams);
        expect(parameters).toHaveLength(2);
        expect(parameters.map((p) => p.id)).toEqual([
            "https://w3id.org/okn/i/mint/parameter1",
            "https://w3id.org/okn/i/mint/parameter2"
        ]);
    });

    it("should get model parameters by model id", async () => {
        mockApolloClient.query.mockResolvedValueOnce({
            data: { modelcatalog_configuration_by_pk: mockCatalogSetup }
        });

        const parameters = await useModelParameterService.getModelParametersByModelId(
            bindingRequest.model_id
        );
        expect(parameters).toHaveLength(2);
        expect(parameters.map((p) => p.id)).toEqual([
            "https://w3id.org/okn/i/mint/parameter1",
            "https://w3id.org/okn/i/mint/parameter2"
        ]);
    });

    it("should throw NotFoundError when model is not found", async () => {
        mockApolloClient.query.mockResolvedValueOnce({
            data: { modelcatalog_configuration_by_pk: null }
        });

        await expect(
            useModelParameterService.getModelParametersByModelId("invalid-id")
        ).rejects.toThrow(NotFoundError);
    });

    it("should match parameters correctly", async () => {
        const modelWithParams = {
            id: bindingRequest.model_id,
            hasParameter: [
                { id: "https://w3id.org/okn/i/mint/parameter1", has_fixed_value: null },
                { id: "https://w3id.org/okn/i/mint/parameter2", has_fixed_value: null }
            ]
        };

        const subtaskCopy = JSON.parse(JSON.stringify(subtask));
        await useModelParameterService.matchParameters(
            modelWithParams,
            bindingRequest,
            subtaskCopy
        );

        expect(
            subtaskCopy.model_ensembles[modelW3Id].bindings[
                "https://w3id.org/okn/i/mint/parameter1"
            ]
        ).toEqual(["value1"]);
        expect(
            subtaskCopy.model_ensembles[modelW3Id].bindings[
                "https://w3id.org/okn/i/mint/parameter2"
            ]
        ).toEqual(["value2a", "value2b"]);
    });

    it("should throw BadRequestError if parameter is not provided", async () => {
        const incompleteData = {
            ...bindingRequest,
            parameters: bindingRequest.parameters.slice(0, 1) // Remove the second parameter
        };
        const modelWithParams = {
            id: bindingRequest.model_id,
            hasParameter: [
                { id: "https://w3id.org/okn/i/mint/parameter1", has_fixed_value: null },
                { id: "https://w3id.org/okn/i/mint/parameter2", has_fixed_value: null }
            ]
        };

        const subtaskCopy = JSON.parse(JSON.stringify(subtask));

        await expect(
            useModelParameterService.matchParameters(modelWithParams, incompleteData, subtaskCopy)
        ).rejects.toThrow(BadRequestError);
    });

    it("should set parameter bindings successfully", async () => {
        mockApolloClient.query.mockResolvedValueOnce({
            data: { modelcatalog_configuration_by_pk: mockCatalogSetup }
        });

        const subtaskCopy = JSON.parse(JSON.stringify(subtask));
        await useModelParameterService.setParameterBindings(bindingRequest, subtaskCopy);

        expect(
            subtaskCopy.model_ensembles[modelW3Id].bindings[
                "https://w3id.org/okn/i/mint/parameter1"
            ]
        ).toEqual(["value1"]);
        expect(
            subtaskCopy.model_ensembles[modelW3Id].bindings[
                "https://w3id.org/okn/i/mint/parameter2"
            ]
        ).toEqual(["value2a", "value2b"]);
    });

    it("should throw NotFoundError if model is not found in thread", async () => {
        const subtaskCopy = JSON.parse(JSON.stringify(subtask));
        subtaskCopy.model_ensembles = {};
        await expect(
            useModelParameterService.setParameterBindings(bindingRequest, subtaskCopy)
        ).rejects.toThrow(NotFoundError);
    });
});
