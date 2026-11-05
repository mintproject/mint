import { Thread } from "@/classes/mint/mint-types";
import { AddParametersRequest } from "../../paths/problemStatements/tasks/subtasks";
import { BadRequestError, NotFoundError } from "@/classes/common/errors";
import { convertApiUrlToW3Id } from "@/classes/mint/model-catalog-graphql-adapter";
import { GraphQL } from "@/config/graphql";
import { KeycloakAdapter } from "@/config/keycloak-adapter";
import { SECRET_PARAMETER_TYPE } from "@/classes/graphql/graphql_adapter";
import getModelcatalogConfigurationGQL from "@/classes/graphql/queries/model/get-modelcatalog-configuration.graphql";

// Local types for catalog model data from unified modelcatalog_configuration table
interface CatalogParameter {
    id: string;
    label?: string;
    description?: string;
    has_default_value?: string;
    has_fixed_value?: string;
    has_minimum_accepted_value?: string;
    has_maximum_accepted_value?: string;
    parameter_type?: string;
    position?: number;
    has_accepted_values?: string[] | null;
    has_data_type?: string;
}

interface CatalogModelConfiguration {
    id: string;
    label?: string;
    description?: string;
    has_component_location?: string;
    has_software_image?: string;
    model_configuration_id?: string | null;
    parameters?: Array<{ parameter: CatalogParameter }>;
}

// Alias: both configurations and setups now come from the same unified table
type CatalogModelConfigurationSetup = CatalogModelConfiguration;

// Inline interface for parameter with fixed value (new flat shape from Hasura)
interface ModelParameter {
    id: string;
    has_fixed_value?: string;
}

// Inline interface for model with parameters
interface ModelWithParameters {
    id: string;
    hasParameter: ModelParameter[];
}

const fetchModelByW3Id = async (
    w3Id: string,
    accessToken?: string
): Promise<CatalogModelConfiguration | CatalogModelConfigurationSetup> => {
    const apolloClient = accessToken
        ? GraphQL.instanceUsingAccessToken(accessToken)
        : GraphQL.instance(KeycloakAdapter.getUser());

    // Try configuration first
    const configResult = await apolloClient.query({
        query: getModelcatalogConfigurationGQL,
        variables: { id: w3Id },
        fetchPolicy: "no-cache"
    });
    const catalogConfig = configResult.data?.modelcatalog_configuration_by_pk;
    if (catalogConfig) {
        return catalogConfig as CatalogModelConfiguration;
    }

    return null;
};

/**
 * Converts a GraphQL catalog model (new shape) to the ModelWithParameters shape.
 * New shape: model.parameters = [{parameter: {id, has_fixed_value, ...}}]
 */
const catalogModelToModelWithParameters = (
    model: CatalogModelConfiguration | CatalogModelConfigurationSetup
): ModelWithParameters => {
    // Secret parameters carry the owner-provided credentials a model declares;
    // they are never bound by the thread, so the binder must not demand them.
    const parameters = ((model as any).parameters || [])
        .filter((row: any) => row.parameter.parameter_type !== SECRET_PARAMETER_TYPE)
        .map((row: any) => ({
            id: row.parameter.id,
            has_fixed_value: row.parameter.has_fixed_value
        }));
    return {
        id: model.id,
        hasParameter: parameters
    };
};

const hasParameterHasFixedValue = (parameter: ModelParameter) => {
    return !!parameter.has_fixed_value;
};

const getModelParameters = async (model: ModelWithParameters): Promise<CatalogParameter[]> => {
    const parameters: CatalogParameter[] = [];
    const modelParameters = model.hasParameter;
    for (const parameter of modelParameters) {
        if (!hasParameterHasFixedValue(parameter)) {
            parameters.push({ id: parameter.id } as CatalogParameter);
        }
    }
    return parameters;
};

const matchParameters = async (
    model: ModelWithParameters,
    data: AddParametersRequest,
    thread: Thread
) => {
    const w3id = convertApiUrlToW3Id(model.id);
    if (model.hasParameter && model.hasParameter.length > 0) {
        for (const parameter of model.hasParameter) {
            if (!hasParameterHasFixedValue(parameter)) {
                const parameterInput = data.parameters.find((p) => p.id === parameter.id);
                if (!parameterInput) {
                    throw new BadRequestError(`Parameter ${parameter.id} is not provided`);
                }
                if (parameterInput.value instanceof Array) {
                    thread.model_ensembles[w3id].bindings[parameter.id] =
                        parameterInput.value as string[];
                } else {
                    thread.model_ensembles[w3id].bindings[parameter.id] = [
                        parameterInput.value
                    ] as string[];
                }
            }
        }
    }
};

const validateThatAllParametersAreBound = (model: ModelWithParameters, thread: Thread) => {
    const modelParameters = model.hasParameter;
    const w3id = convertApiUrlToW3Id(model.id);
    for (const parameter of modelParameters) {
        if (!hasParameterHasFixedValue(parameter)) {
            if (thread.model_ensembles[w3id].bindings[parameter.id].length === 0) {
                throw new BadRequestError(`Parameter ${parameter.id} is not bound`);
            }
        }
    }
};

const setParameterBindings = async (data: AddParametersRequest, subtask: Thread) => {
    let match = false;
    for (const [modelW3Id] of Object.entries(subtask.model_ensembles)) {
        if (modelW3Id === convertApiUrlToW3Id(data.model_id)) {
            match = true;
            const catalogModel = await fetchModelByW3Id(modelW3Id);
            if (!catalogModel) {
                throw new NotFoundError("Model not found");
            }
            const model = catalogModelToModelWithParameters(catalogModel);
            await matchParameters(model, data, subtask);
            validateThatAllParametersAreBound(model, subtask);
        }
    }
    if (!match) {
        throw new NotFoundError("Model not found");
    }
};

const getModelParametersByModelId = async (model_id: string) => {
    const w3Id = convertApiUrlToW3Id(model_id);
    const catalogModel = await fetchModelByW3Id(w3Id);
    if (!catalogModel) {
        throw new NotFoundError("Model not found");
    }
    const model = catalogModelToModelWithParameters(catalogModel);
    return await getModelParameters(model);
};

const useModelParameterService = {
    matchParameters,
    setParameterBindings,
    getModelParametersByModelId,
    getModelParameters,
    hasParameterHasFixedValue
};

export default useModelParameterService;
