import { DataMap, Dataslice, Thread } from "@/classes/mint/mint-types";
import { AddDataRequest, DataInput } from "../../paths/problemStatements/tasks/subtasks";
import { uuidv4 } from "@/classes/graphql/graphql_adapter";
import { BadRequestError, NotFoundError } from "@/classes/common/errors";
import { convertApiUrlToW3Id } from "@/classes/mint/model-catalog-graphql-adapter";
import type { Modelcatalog_Parameter } from "@/classes/graphql/graphql";

// Local types for catalog model data from unified modelcatalog_configuration table
interface CatalogDatasetSpec {
    id: string;
    label?: string;
    description?: string;
    has_format?: string;
    position?: number;
}

/** A parameter of a catalog model configuration, as the catalog query returns it. */
export type CatalogParameterSpec = Pick<
    Modelcatalog_Parameter,
    "id" | "label" | "has_fixed_value" | "has_default_value" | "parameter_type"
>;

export interface CatalogModelConfiguration {
    id: string;
    label?: string;
    description?: string;
    has_component_location?: string;
    has_software_image?: string;
    model_configuration_id?: string | null;
    inputs?: Array<{ input: CatalogDatasetSpec }>;
    outputs?: Array<{ output: CatalogDatasetSpec }>;
    parameters?: Array<{ parameter: CatalogParameterSpec }>;
}

// Alias: both configurations and setups now come from the same unified table
type CatalogModelConfigurationSetup = CatalogModelConfiguration;
import { GraphQL } from "@/config/graphql";
import { KeycloakAdapter } from "@/config/keycloak-adapter";
import getModelcatalogConfigurationGQL from "@/classes/graphql/queries/model/get-modelcatalog-configuration.graphql";

// Inline interface for model input with fixed resource support
// Note: hasFixedResource is not in the new Hasura schema; all inputs from Hasura are treated as non-fixed
interface ModelInput {
    id: string;
    hasFixedResource?: unknown[];
}

// Inline interface for model with inputs (compatible with both old and new shapes)
interface ModelWithInputs {
    id: string;
    hasInput: ModelInput[];
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

const createDataSlice = (dataInput: DataInput, thread: Thread): Dataslice => {
    const sliceid = uuidv4();
    const dataslice = {
        id: sliceid,
        total_resources: dataInput.dataset.resources.length,
        selected_resources: dataInput.dataset.resources.length,
        resources: dataInput.dataset.resources.map((r) => ({
            ...r,
            time_period: {
                start_date: thread.dates.start_date,
                end_date: thread.dates.end_date
            },
            name: r.id,
            selected: true
        })),
        time_period: thread.dates,
        name: dataInput.dataset.id,
        resources_loaded: true,
        dataset: {
            ...dataInput.dataset,
            resource_count: dataInput.dataset.resources.length
        }
    } as Dataslice;
    return dataslice;
};

const hasInputHasFixedResource = (input: { hasFixedResource?: unknown[] }) => {
    return input.hasFixedResource && input.hasFixedResource.length > 0;
};

const findDataSpecificationByRequest = (input: { id: string }, data: AddDataRequest) => {
    const dataInput = data.data.find((d) => d.id === input.id);
    if (!dataInput) {
        throw new BadRequestError(`Data input ${input.id} has not been provided`);
    }
    return dataInput;
};

const createBinding = (
    input: { id: string; hasFixedResource?: unknown[] },
    data: AddDataRequest,
    thread: Thread
): Dataslice => {
    const dataInput = findDataSpecificationByRequest(input, data);
    return createDataSlice(dataInput, thread);
};

const validateThatAllInputsAreBound = (
    model: { id: string; hasInput: ModelInput[] },
    thread: Thread
) => {
    const modelInputs = model.hasInput;
    const w3id = convertApiUrlToW3Id(model.id);
    for (const input of modelInputs) {
        if (
            !hasInputHasFixedResource(input) &&
            thread.model_ensembles[w3id].bindings[input.id].length === 0
        ) {
            throw new BadRequestError(`Input ${input.id} is not bound`);
        }
    }
};

const getDataBindings = async (model: {
    hasInput: ModelInput[];
}): Promise<CatalogDatasetSpec[]> => {
    const inputs: CatalogDatasetSpec[] = [];
    const modelInputs = model.hasInput;
    for (const input of modelInputs) {
        if (!hasInputHasFixedResource(input)) {
            inputs.push(input as CatalogDatasetSpec);
        }
    }
    return inputs;
};

const matchInputs = async (
    model: { id: string; hasInput: ModelInput[] },
    data: AddDataRequest,
    thread: Thread
) => {
    const dataMap: DataMap = {};
    const modelInputs = model.hasInput;
    const w3id = convertApiUrlToW3Id(model.id);
    if (modelInputs && modelInputs.length > 0) {
        for (const input of modelInputs) {
            if (!hasInputHasFixedResource(input)) {
                const dataslice = createBinding(input, data, thread);
                dataMap[dataslice.id] = dataslice;
                if (thread.model_ensembles[w3id].bindings[input.id]) {
                    thread.model_ensembles[w3id].bindings[input.id].push(dataslice.id);
                } else {
                    thread.model_ensembles[w3id].bindings[input.id] = [dataslice.id];
                }
            }
        }
    }
    return dataMap;
};

/**
 * Converts a GraphQL catalog model (new shape) to the ModelWithInputs shape.
 * New shape: model.inputs = [{input: {id, label, ...}}]
 * For backward compatibility with hasFixedResource: all inputs are treated as non-fixed.
 */
const catalogModelToModelWithInputs = (
    model: CatalogModelConfiguration | CatalogModelConfigurationSetup
): ModelWithInputs => {
    const inputs = (model.inputs || []).map((row) => ({
        id: row.input.id,
        hasFixedResource: [] // No fixed resource in new Hasura schema
    }));
    return {
        id: model.id,
        hasInput: inputs
    };
};

const setInputBindings = async (data: AddDataRequest, subtask: Thread) => {
    let match = false;
    for (const [modelW3Id] of Object.entries(subtask.model_ensembles)) {
        if (modelW3Id === convertApiUrlToW3Id(data.model_id)) {
            match = true;
            const catalogModel = await fetchModelByW3Id(modelW3Id);
            if (!catalogModel) {
                throw new NotFoundError("Model not found");
            }
            const model = catalogModelToModelWithInputs(catalogModel);
            const dataMap = await matchInputs(model, data, subtask);
            validateThatAllInputsAreBound(model, subtask);
            return dataMap;
        }
    }
    if (!match) {
        throw new NotFoundError("Model not found");
    }
};

const getDataBindingsByModelId = async (model_id: string) => {
    const w3Id = convertApiUrlToW3Id(model_id);
    const catalogModel = await fetchModelByW3Id(w3Id);
    if (!catalogModel) {
        throw new NotFoundError("Model not found");
    }
    const model = catalogModelToModelWithInputs(catalogModel);
    return await getDataBindings(model);
};

const useModelInputService = {
    getDataBindingsByModelId,
    matchInputs,
    createDataSlice,
    hasInputHasFixedResource,
    findDataSpecificationByRequest,
    createBinding,
    validateThatAllInputsAreBound,
    getDataBindings,
    setInputBindings
};

export default useModelInputService;
