/**
 * The thread's side of running a flow: reads what the thread bound to the flow, and
 * writes the run where the thread's screens look for it. A flow has no Tapis job,
 * so nothing here loads a component or talks to Tapis.
 */
import { GraphQL } from "@/config/graphql";
import { KeycloakAdapter } from "@/config/keycloak-adapter";
import { NotFoundError } from "@/classes/common/errors";
import { ExecutionCreation } from "@/classes/common/ExecutionCreation";
import { getMd5Hash, threadFromGQL, uuidv4 } from "@/classes/graphql/graphql_adapter";
import {
    deleteThreadModelExecutionIds,
    getExecution,
    getRegionDetails,
    incrementThreadModelSubmittedRuns,
    insertThreadModelExecutionSummary,
    setExecutions,
    setThreadModelExecutionIds,
    updateExecutionStatusResultsAndSummary
} from "@/classes/graphql/graphql_functions";
import { getThread } from "@/classes/graphql/graphql_functions_v2";
import getConfigurationFlowGQL from "@/classes/graphql/queries/model/get-configuration-flow.graphql";
import { Execution, ExecutionSummary, Thread } from "@/classes/mint/mint-types";
import { FlowThreadContext, FlowThreadService } from "./flowExecution";

const NOT_A_FLOW: FlowThreadContext = {
    is_flow: false,
    thread_bindings: {},
    inputs: [],
    parameters: [],
    outputs: []
};

async function configurationFlow(configurationId: string) {
    const client = GraphQL.instance(KeycloakAdapter.getUser());
    const result = await client.query({
        query: getConfigurationFlowGQL,
        variables: { id: configurationId },
        fetchPolicy: "no-cache"
    });
    return result?.data?.modelcatalog_configuration_flow_by_pk || null;
}

async function loadThread(threadId: string): Promise<Thread> {
    const response = await getThread(threadId);
    if (!response) throw new NotFoundError("Thread not found");
    return threadFromGQL(response);
}

function dateString(value: unknown): string | undefined {
    if (!value) return undefined;
    const date = value instanceof Date ? value : new Date(String(value));
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString().slice(0, 10);
}

/** Once per execution, however many callers are following the run at once. */
const finishing = new Map<string, Promise<void>>();

const executionsFlowService: FlowThreadService = {
    async flowContext(threadmodel): Promise<FlowThreadContext> {
        const flow = await configurationFlow(threadmodel.model_id);
        if (!flow) return NOT_A_FLOW;
        const thread = await loadThread(threadmodel.thread_id);
        const model = thread.models?.[threadmodel.model_id];
        if (!model || !thread.model_ensembles?.[threadmodel.model_id]) {
            throw new NotFoundError("Thread model not found");
        }
        // The same resolution a model run uses: a bound dataset becomes its selected files.
        const region = thread.regionid ? await getRegionDetails(thread.regionid) : null;
        const [bound] = ExecutionCreation.getModelInputBindings(model, thread, region) as [
            { bindings: Record<string, any[]> },
            string[]
        ];
        return {
            is_flow: true,
            thread_bindings:
                flow.thread_bindings_json && typeof flow.thread_bindings_json === "object"
                    ? flow.thread_bindings_json
                    : {},
            inputs: model.input_files.map((input) => ({
                model_io_id: input.id,
                name: input.name,
                format: input.format,
                standard_variables: input.standard_variables || [],
                optional: input.is_optional === true,
                resources: (bound.bindings[input.id] || [])
                    // A file with no location cannot be handed to the adapter.
                    .filter(
                        (resource) => resource && typeof resource.url === "string" && resource.url
                    )
                    .map((resource) => ({
                        id: String(resource.id),
                        name: String(resource.name || input.name),
                        url: resource.url as string
                    }))
            })),
            parameters: model.input_parameters.map((parameter) => {
                const value = (bound.bindings[parameter.id] || [])[0];
                return {
                    id: parameter.id,
                    name: parameter.name,
                    ...(value === undefined || value === null ? {} : { value: String(value) })
                };
            }),
            outputs: model.output_files.map((output) => ({
                model_io_id: output.id,
                name: output.name
            })),
            dates: {
                start_date: dateString(thread.dates?.start_date),
                end_date: dateString(thread.dates?.end_date)
            },
            region
        };
    },

    async startFlowExecution(threadId, modelId, runId): Promise<string> {
        const thread = await loadThread(threadId);
        const threadModelId = thread.model_ensembles?.[modelId]?.id;
        if (!threadModelId) throw new NotFoundError("Thread model not found");

        const summary: ExecutionSummary = {
            total_runs: 1,
            submitted_runs: 0,
            failed_runs: 0,
            successful_runs: 0,
            workflow_name: "",
            submitted_for_execution: true,
            submission_time: new Date(),
            submitted_for_ingestion: false,
            fetched_run_outputs: 0,
            ingested_runs: 0,
            submitted_for_registration: false,
            registered_runs: 0,
            submitted_for_publishing: false,
            published_runs: 0
        };
        const inserted = await insertThreadModelExecutionSummary(threadModelId, summary);
        if (inserted.errors) throw new Error("Error setting thread model execution summary");
        await deleteThreadModelExecutionIds(threadModelId);

        const execution: Execution = {
            id: uuidv4(),
            modelid: modelId,
            bindings: {},
            execution_engine: "tapis",
            // The thread's screens find the run's live status through this id.
            runid: runId,
            status: "WAITING",
            results: [],
            start_time: new Date(),
            selected: true
        };
        await setExecutions([execution], threadModelId);
        await setThreadModelExecutionIds(threadModelId, [execution.id]);
        await incrementThreadModelSubmittedRuns(threadModelId, 1);
        return execution.id;
    },

    async finishFlowExecution(threadId, modelId, executionId, status, outputs): Promise<void> {
        const inFlight = finishing.get(executionId);
        if (inFlight) return inFlight;
        const work = (async () => {
            const execution = await getExecution(executionId);
            if (!execution) throw new NotFoundError("Flow execution not found");
            // Following a run and reading its history can both arrive here. Never
            // rewrite a closed execution or count it twice.
            if (execution.status === "SUCCESS" || execution.status === "FAILURE") return;

            const thread = await loadThread(threadId);
            const threadModelId = thread.model_ensembles?.[modelId]?.id;
            if (!threadModelId) throw new NotFoundError("Thread model not found");

            execution.status = status === "completed" ? "SUCCESS" : "FAILURE";
            execution.run_progress = status === "completed" ? 1 : 0;
            execution.end_time = new Date();
            // One result per output of the flow, keyed by the output it is.
            const results: Record<string, { id: string; name: string; url: string }> = {};
            for (const output of outputs) {
                results[output.model_io_id] = {
                    id: getMd5Hash(output.url),
                    name: output.name,
                    url: output.url
                };
            }
            execution.results = results as any;
            await updateExecutionStatusResultsAndSummary(execution, threadModelId);
        })();
        finishing.set(executionId, work);
        try {
            await work;
        } finally {
            if (finishing.get(executionId) === work) finishing.delete(executionId);
        }
    }
};

export default executionsFlowService;
