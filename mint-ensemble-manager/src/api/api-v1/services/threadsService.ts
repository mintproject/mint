import {
    Thread,
    ProblemStatement,
    Task,
    Dataset,
    ExecutionSummary,
    Region,
    Dataslice,
    DataMap,
    IdMap,
    ProblemStatementEvent,
    TaskEvent
} from "@/classes/mint/mint-types";
import { queryDatasetDetails } from "@/classes/mint/data-catalog-functions";
import {
    addProblemStatement,
    addTask,
    addThread,
    getProblemStatement,
    getRegionDetails,
    getTask,
    getThread,
    getThreadV2,
    getTotalConfigurations,
    setThreadData,
    setThreadModels,
    setThreadParameters
} from "@/classes/graphql/graphql_functions";
import { getCreateEvent, uuidv4 } from "@/classes/graphql/graphql_adapter";
import { fetchMintConfig } from "@/classes/mint/mint-functions";
import { KeycloakAdapter } from "@/config/keycloak-adapter";
import { GraphQL } from "@/config/graphql";
import getModelcatalogConfigurationGQL from "@/classes/graphql/queries/model/get-modelcatalog-configuration.graphql";
import { createResponse, GenericResponse } from "./util";
import type { CatalogModelConfiguration } from "./useModelService/useModelInputService";

// ./api-v1/services/threadsService.js

/** A period as the create-thread request gives it. */
interface RequestPeriod {
    from: string;
    to: string;
}

/** The create-thread request: the problem statement, task and thread to find or make. */
export interface CreateThreadRequest {
    problem_statement: {
        id?: string;
        name?: string;
        regionid?: string;
        time_period?: RequestPeriod;
    };
    task: {
        id?: string;
        name?: string;
        regionid?: string;
        indicatorid?: string;
        interventionid?: string;
        time_period?: RequestPeriod;
    };
    thread: {
        name?: string;
        modelid: string;
        datasets?: Record<string, string | string[]>;
        parameters?: Record<string, string | string[]>;
    };
}

export interface ThreadsService {
    getThread(thread_id: string): Promise<Thread>;
    createThread(desc: CreateThreadRequest): Promise<GenericResponse>;
}

const threadsService: ThreadsService = {
    async getThread(thread_id: string) {
        const mint_prefs = await fetchMintConfig();
        KeycloakAdapter.signIn(mint_prefs.graphql.username, mint_prefs.graphql.password);
        return await getThreadV2(thread_id);
    },

    async createThread(desc: CreateThreadRequest) {
        const mint_prefs = await fetchMintConfig();
        KeycloakAdapter.signIn(mint_prefs.graphql.username, mint_prefs.graphql.password);

        // Create Problem Statement if needed
        const prob_desc = desc.problem_statement;
        let prob: ProblemStatement = null;
        if (prob_desc.id) {
            prob = await getProblemStatement(prob_desc.id);
        } else {
            prob = {
                name: prob_desc.name,
                regionid: prob_desc.regionid,
                dates: {
                    start_date: new Date(prob_desc.time_period.from),
                    end_date: new Date(prob_desc.time_period.to)
                },
                tasks: [],
                events: [getCreateEvent("Problem Statement from API") as ProblemStatementEvent],
                permissions: [{ read: true, write: true, execute: true, owner: false, userid: "*" }]
            };
            prob.id = await addProblemStatement(prob);
        }

        // Create Task if needed
        const task_desc = desc.task;
        let task: Task = null;
        const time_period = task_desc.time_period ? task_desc.time_period : prob_desc.time_period;
        if (task_desc.id) {
            task = await getTask(task_desc.id);
        } else {
            task = {
                name: task_desc.name,
                regionid: task_desc.regionid,
                problem_statement_id: prob.id,
                response_variables: [task_desc.indicatorid],
                driving_variables: task_desc.interventionid ? [task_desc.interventionid] : [],
                dates: {
                    start_date: new Date(time_period.from),
                    end_date: new Date(time_period.to)
                },
                events: [getCreateEvent("Task from API") as TaskEvent],
                permissions: [{ read: true, write: true, execute: true, owner: false, userid: "*" }]
            };
            task.id = await addTask(prob, task);
        }

        // Create Thread
        const thread_desc = desc.thread;
        const thread_name = thread_desc.name ? thread_desc.name : null;
        const thread_notes = "Added thread from API";

        let thread = {
            name: thread_name,
            task_id: task.id,
            dates: task.dates,
            driving_variables: task.driving_variables,
            response_variables: task.response_variables,
            model_ensembles: {},
            models: {},
            execution_summary: {},
            events: [getCreateEvent(thread_notes)],
            permissions: [{ read: true, write: true, execute: true, owner: false, userid: "*" }]
        } as Thread;

        // Store Thread (no data or models yet)
        thread.id = await addThread(task, thread);

        // Fetch region details
        const region: Region = await getRegionDetails(task.regionid);

        /*
        Set Thread Model
        */
        const W3_ID_URI_PREFIX = "https://w3id.org/okn/i/mint/";
        const modelW3Id = desc.thread.modelid.startsWith("https://w3id.org/")
            ? desc.thread.modelid
            : W3_ID_URI_PREFIX + desc.thread.modelid;
        const apolloClient = GraphQL.instanceUsingAccessToken(
            KeycloakAdapter.getAccessToken ? KeycloakAdapter.getAccessToken() : ""
        );
        const setupResult = await apolloClient.query({
            query: getModelcatalogConfigurationGQL,
            variables: { id: modelW3Id },
            fetchPolicy: "no-cache"
        });
        const catalogSetup = setupResult.data?.modelcatalog_configuration_by_pk;
        if (!catalogSetup) {
            throw new Error(`Model configuration setup not found for id: ${modelW3Id}`);
        }
        const model: CatalogModelConfiguration = catalogSetup;
        // Create thread_model row directly with modelcatalog_configuration_id FK
        await setThreadModels([{ id: modelW3Id }], "Added models", thread);

        thread = await getThread(thread.id);

        /*
         Set Thread Data
        */
        const data: DataMap = {};
        const model_ensembles = thread.model_ensembles;

        // Fetch dataset details from the Data Catalog
        // model.inputs is the new GraphQL shape: [{input: {id, label, ...}}]
        const modelInputs = (model.inputs || []).map((row) => row.input);
        for (let i = 0; i < modelInputs.length; i++) {
            const input_file = modelInputs[i];
            // New shape uses flat fields; no hasFixedResource in new schema so treat all as non-fixed
            let datasetids = thread_desc.datasets[input_file.label];
            if (datasetids) {
                model_ensembles[modelW3Id].bindings[input_file.id] = [];

                if (!(datasetids instanceof Array)) datasetids = [datasetids];
                for (let j = 0; j < datasetids.length; j++) {
                    const dsid = datasetids[j];
                    // No hasPresentation in new shape; pass empty variables array
                    const variables: string[] = [];
                    const dataset: Dataset = await queryDatasetDetails(
                        modelW3Id,
                        input_file.id,
                        variables,
                        dsid,
                        thread.dates,
                        region,
                        mint_prefs
                    );
                    const sliceid = uuidv4();
                    const dataslice = {
                        id: sliceid,
                        total_resources: dataset.resources.length,
                        selected_resources: dataset.resources.filter((res) => res.selected).length,
                        resources: dataset.resources,
                        time_period: thread.dates,
                        name: dataset.name,
                        dataset: dataset,
                        resources_loaded: dataset.resources_loaded
                    } as Dataslice;
                    data[sliceid] = dataslice;
                    model_ensembles[modelW3Id].bindings[input_file.id].push(sliceid!);
                }
            }
        }

        await setThreadData(data, model_ensembles, "Setting thread data via API", thread);

        // Set Thread Parameters
        const execution_summary: IdMap<ExecutionSummary> = {};
        // model.parameters is the new GraphQL shape: [{parameter: {id, label, has_fixed_value, has_default_value, ...}}]
        const modelParameters = (model.parameters || []).map((row) => row.parameter);
        for (let i = 0; i < modelParameters.length; i++) {
            const input_parameter = modelParameters[i];
            // New shape uses flat scalar fields (not array-wrapped)
            if (!input_parameter.has_fixed_value) {
                let value = thread_desc.parameters[input_parameter.label];
                if (!value) value = input_parameter.has_default_value;
                if (!(value instanceof Array)) value = [value];
                model_ensembles[modelW3Id].bindings[input_parameter.id] = value;
            }
        }
        // Get total number of configs to run using a compatible shape
        const modelForConfigs = {
            id: modelW3Id,
            hasInput: modelInputs.map((inp) => ({ id: inp.id, hasFixedResource: [] })),
            hasParameter: modelParameters.map((p) => ({
                id: p.id,
                hasFixedValue: p.has_fixed_value ? [p.has_fixed_value] : []
            }))
        };
        const totalconfigs = getTotalConfigurations(
            modelForConfigs,
            model_ensembles[modelW3Id].bindings,
            data
        );
        execution_summary[modelW3Id] = {
            total_runs: totalconfigs,
            submitted_runs: 0,
            failed_runs: 0,
            successful_runs: 0
        } as ExecutionSummary;

        await setThreadParameters(
            model_ensembles,
            execution_summary,
            "Setting thread parameters via API",
            thread
        );

        // Return details of newly created thread
        const modelthread = {
            problem_statement_id: prob.id,
            task_id: task.id,
            thread_id: thread.id
        };
        return createResponse("success", JSON.stringify(modelthread));
    }
};

export default threadsService;
