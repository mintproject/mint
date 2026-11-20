/**
 * The thread's side of running a flow: reads what the thread bound to the flow, and
 * writes the run where the thread's screens look for it. A flow has no Tapis job,
 * so nothing here loads a component or talks to Tapis.
 */
import { GraphQL } from "@/config/graphql";
import { KeycloakAdapter } from "@/config/keycloak-adapter";
import { ForbiddenError, NotFoundError } from "@/classes/common/errors";
import { ExecutionCreation } from "@/classes/common/ExecutionCreation";
import { getMd5Hash, threadFromGQL, uuidv4 } from "@/classes/graphql/graphql_adapter";
import {
    addExecutionDataBinding,
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
import { getTokenFromAuthorizationHeader, usernameFromToken } from "@/utils/authUtils";
import { FlowThreadContext, FlowThreadService, readThreadBindings } from "./flowExecution";

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

/** May this user change the thread? The same rule the database applies to a write. */
function mayWrite(thread: any, username: string): boolean {
    const granted = (thread.permissions || []).some(
        (permission: any) =>
            permission?.write === true &&
            (permission.user_id === username || permission.user_id === "*")
    );
    const created = (thread.events || []).some(
        (event: any) => event?.event === "CREATE" && event.userid === username
    );
    return granted || created;
}

/**
 * The thread, read as the caller: the database returns it only to someone who may
 * read it. Running a flow changes the thread's run records, so `write` also asks
 * that the caller may change the thread. This service writes those records with
 * its own identity, so nothing later would stop a caller who may not.
 */
async function loadThreadAs(
    threadId: string,
    authorization: string,
    access: "read" | "write"
): Promise<{ thread: Thread; caller: string }> {
    const token = getTokenFromAuthorizationHeader(authorization);
    const caller = await usernameFromToken(token);
    const response: any = await getThread(threadId, token);
    if (!response) throw new NotFoundError("Thread not found");
    if (access === "write" && !mayWrite(response, caller)) {
        throw new ForbiddenError("You may not run models in this thread");
    }
    return { thread: threadFromGQL(response), caller };
}

/** The thread, read by this service for a run it already started for its submitter. */
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
    async flowContext(threadmodel, authorization, access = "read"): Promise<FlowThreadContext> {
        const flow = await configurationFlow(threadmodel.model_id);
        if (!flow) return NOT_A_FLOW;
        const { thread, caller } = await loadThreadAs(threadmodel.thread_id, authorization, access);
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
            caller,
            thread_bindings: readThreadBindings(flow.thread_bindings_json),
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

    async startFlowExecution(threadId, modelId, runId, authorization, provenance): Promise<string> {
        const { thread } = await loadThreadAs(threadId, authorization, "write");
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

        // What the run reads and the settings it uses, as a model run records them.
        const bindings: Execution["bindings"] = {};
        for (const input of provenance?.inputs || []) {
            bindings[input.model_io_id] = input.resources as any;
        }
        for (const parameter of provenance?.parameters || []) {
            bindings[parameter.model_parameter_id] = parameter.value;
        }
        const execution: Execution = {
            id: uuidv4(),
            modelid: modelId,
            bindings,
            execution_engine: "tapis",
            // The thread's screens find the run's live status through this id.
            runid: runId,
            status: "WAITING",
            results: [],
            start_time: new Date(),
            selected: true
        };
        const written = await setExecutions([execution], threadModelId);
        if (!written && Object.keys(bindings).length) {
            // The catalog refused the record (a binding it has no row for rolls the
            // whole write back). A run without its provenance is better than no run.
            console.error("flow execution not recorded with its bindings; recording without");
            execution.bindings = {};
            await setExecutions([execution], threadModelId);
        }
        await setThreadModelExecutionIds(threadModelId, [execution.id]);
        await incrementThreadModelSubmittedRuns(threadModelId, 1);
        return execution.id;
    },

    async recordFlowEdit(executionId, modelIoId, file): Promise<void> {
        await addExecutionDataBinding(executionId, modelIoId, file);
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
                    // Stored as the one row the catalog keeps per location, like a
                    // model's result: the id given here is replaced by a hash of the url.
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
