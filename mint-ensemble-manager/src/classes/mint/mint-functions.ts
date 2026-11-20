import {
    Thread,
    MintPreferences,
    ExecutionSummary,
    Execution,
    InputBindings,
    ThreadModelMap
} from "./mint-types";
import {
    setupModelWorkflow,
    fetchWingsTemplate,
    loginToWings,
    runModelExecutions,
    fetchWingsRunsStatuses,
    fetchWingsRunResults
} from "@/classes/wings/wings-functions";
import {
    getModelInputBindings,
    getModelInputConfigurations,
    deleteThreadModelExecutionIds,
    setThreadModelExecutionIds,
    getExecutionHash,
    listSuccessfulExecutionIds,
    getThreadModelExecutionIds,
    getExecutions,
    setExecutions,
    getThread,
    setThreadModelExecutionSummary,
    getRegionDetails
} from "@/classes/graphql/graphql_functions";

import fs from "fs-extra";

import { DEVMODE, DEVHOMEDIR, PORT } from "@/config/app";

export const getConfiguration = (): MintPreferences => {
    let config_file = process.env.ENSEMBLE_MANAGER_CONFIG_FILE;
    if (!config_file) {
        config_file = __dirname + "/config/config.json";
    }

    const prefs = JSON.parse(fs.readFileSync(config_file, "utf8")) as MintPreferences;
    if (prefs.graphql && !prefs.graphql.secret && process.env.HASURA_GRAPHQL_ADMIN_SECRET) {
        prefs.graphql.secret = process.env.HASURA_GRAPHQL_ADMIN_SECRET;
    }
    return prefs;
};

export const fetchMintConfig = async () => {
    const prefs = getConfiguration();
    if (prefs.execution_engine == "wings") {
        const res = await fetch(prefs.wings.server + "/config");
        const wdata = await res.json();
        prefs.wings.export_url = wdata["internal_server"];
        prefs.wings.storage = wdata["storage"];
        prefs.wings.dotpath = wdata["dotpath"];
        prefs.wings.onturl = wdata["ontology"];
    }
    if (DEVMODE) {
        prefs.ensemble_manager_api = "http://localhost:" + PORT + "/v1";
        prefs.localex.datadir = DEVHOMEDIR + "/data";
        prefs.localex.codedir = DEVHOMEDIR + "/code";
        prefs.localex.logdir = DEVHOMEDIR + "/logs";
        prefs.localex.dataurl = "file://" + DEVHOMEDIR + "/data";
        prefs.localex.logurl = "file://" + DEVHOMEDIR + "/logs";
    }
    return prefs;
};

export const saveAndRunExecutions = async (
    thread: Thread,
    modelid: string,
    prefs: MintPreferences
) => {
    // Setup Model for execution on Wings
    await loginToWings(prefs); // Login to Wings now Happens at the top app level

    for (const pmodelid in thread.model_ensembles) {
        if (!modelid || modelid == pmodelid)
            await saveAndRunExecutionsForModel(pmodelid, thread, prefs);
    }
    console.log("Finished sending all executions for execution");

    monitorAllExecutions(thread, modelid, prefs);
};

export const saveAndRunExecutionsForModel = async (
    modelid: string,
    thread: Thread,
    prefs: MintPreferences
) => {
    if (!thread.execution_summary) thread.execution_summary = {};

    const thread_model_id = thread.model_ensembles[modelid].id;
    const model = thread.models[modelid];

    const thread_region = await getRegionDetails(thread.regionid);
    const execution_details = getModelInputBindings(model, thread, thread_region);
    const threadModel = execution_details[0] as ThreadModelMap;
    const inputIds = execution_details[1] as string[];
    const configs = getModelInputConfigurations(threadModel, inputIds);

    if (configs != null) {
        // Delete existing thread model execution ids
        deleteThreadModelExecutionIds(thread_model_id);

        // Setup Model for execution on Wings
        const workflowid = await setupModelWorkflow(model, thread, prefs);
        const tpl_package = await fetchWingsTemplate(workflowid, prefs);

        const datasets = {}; // Map of datasets to be registered (passed to Wings to keep track)

        // Setup some book-keeping to help in searching for results
        const execution_summary = {
            total_runs: configs.length,
            workflow_name: workflowid.replace(/.+#/, ""),
            submission_time: new Date()
        } as ExecutionSummary;

        setThreadModelExecutionSummary(thread_model_id, execution_summary);

        // Work in batches
        const batchSize = 100; // Deal with executions from firebase in this batch size

        const executionBatchSize = 10; // Run workflows in Wings in batches

        // Create executions in batches
        for (let i = 0; i < configs.length; i += batchSize) {
            const bindings = configs.slice(i, i + batchSize);

            const executions: Execution[] = [];
            const executionids: string[] = [];

            // Create executions for this batch
            bindings.map((binding) => {
                const inputBindings: InputBindings = {};
                for (let j = 0; j < inputIds.length; j++) {
                    inputBindings[inputIds[j]] = binding[j];
                }
                //console.log(inputBindings);
                const execution = {
                    modelid: modelid,
                    bindings: inputBindings,
                    runid: null,
                    status: null,
                    results: [],
                    start_time: new Date(),
                    selected: true
                } as Execution;
                execution.id = getExecutionHash(execution);

                executionids.push(execution.id);
                executions.push(execution);
            });

            // Check if any current executions already exist
            // - Note: execution ids are uniquely defined by the model id and inputs
            const all_execution_ids = await listSuccessfulExecutionIds(executionids);
            const current_execution_ids = all_execution_ids.filter((eid) => eid); // Filter for null/undefined execution ids

            // Run executions in smaller batches
            for (let i = 0; i < executions.length; i += executionBatchSize) {
                const eslice = executions.slice(i, i + executionBatchSize);
                // Get executions that arent already run
                const eslice_nr = eslice.filter(
                    (execution) => current_execution_ids.indexOf(execution.id) < 0
                );
                if (eslice_nr.length > 0) {
                    const runids = await runModelExecutions(
                        thread,
                        eslice_nr,
                        datasets,
                        tpl_package,
                        prefs
                    );
                    for (let j = 0; j < eslice_nr.length; j++) {
                        eslice_nr[j].runid = runids[j];
                        eslice_nr[j].status = "WAITING";
                        eslice_nr[j].execution_engine = "wings";
                        eslice_nr[j].run_progress = 0;
                    }
                    setExecutions(eslice_nr, thread_model_id);
                }
            }

            // Save thread execution ids (to be used for later retrieval of executions)
            setThreadModelExecutionIds(thread_model_id, executionids);
        }
    }
    console.log("Finished submitting all executions for model: " + modelid);
};

export const monitorAllExecutions = async (
    thread: Thread,
    modelid: string,
    prefs: MintPreferences
) => {
    const currentTimeout = 30000; // Check every 30 seconds

    console.log("Start monitoring for " + thread.id);

    checkStatusAllExecutions(thread, modelid, prefs).then(() => {
        console.log("Status checking finished");
        getThread(thread.id).then((thr: Thread) => {
            thread = thr;
            let done = true;
            Object.keys(thread.model_ensembles).map((modelid) => {
                const summary = thread.execution_summary[modelid];
                if (summary.total_runs != summary.successful_runs + summary.failed_runs) {
                    done = false;
                }
            });
            // FIXME: Check for a global shared variable if a request comes to abort for this thread
            if (!done) {
                setTimeout(() => {
                    monitorAllExecutions(thread, modelid, prefs);
                }, currentTimeout);
            } else {
                console.log("Finished Monitoring for " + thread.id + ". Thread runs have finished");
            }
        });
    });
};

export const checkStatusAllExecutions = async (
    thread: Thread,
    modelid: string,
    prefs: MintPreferences
) => {
    // Setup Model for execution on Wings
    await loginToWings(prefs); // Login to Wings now Happens at the top app level

    for (const pmodelid in thread.model_ensembles) {
        if (!modelid || modelid == pmodelid)
            await checkStatusAllExecutionsForModel(pmodelid, thread, prefs);
    }
    console.log("Finished checking executions");
};

export const checkStatusAllExecutionsForModel = async (
    modelid: string,
    thread: Thread,
    prefs: MintPreferences
) => {
    const thread_model_id = thread.model_ensembles[modelid].id;
    const summary = thread.execution_summary[modelid];

    // await loginToWings(prefs); // Login to Wings handled at the top now

    // FIXME: Some problem with the submission times
    const runtimeInfos = await fetchWingsRunsStatuses(
        summary.workflow_name,
        Math.floor(summary.submission_time.getTime()),
        summary.total_runs,
        prefs
    );

    let start = 0;
    const pageSize = 100;
    let numSuccessful = 0;
    let numFailed = 0;
    let numRunning = 0;

    const threadModelExecutionIds = await getThreadModelExecutionIds(thread_model_id);

    for (;;) {
        const executionids = threadModelExecutionIds.slice(start, start + pageSize);
        const executions = await getExecutions(executionids);
        start += pageSize;

        if (!executions || executions.length == 0) break;

        const changed_executions: Execution[] = [];

        executions.map((execution) => {
            // Check if the execution is not already finished (probably from another run)
            if (execution.status == "WAITING" || execution.status == "RUNNING") {
                const runtimeInfo = runtimeInfos[execution.runid];
                if (runtimeInfo) {
                    if (runtimeInfo.status != execution.status) {
                        if (runtimeInfo.status == "SUCCESS" || runtimeInfo.status == "FAILURE") {
                            execution.run_progress = 1;
                        }
                        execution.status = runtimeInfo.status;
                        changed_executions.push(execution);
                    }
                } else {
                    // Execution not yet submitted
                    //console.log(execution);
                }
            }
            switch (execution.status) {
                case "RUNNING":
                    numRunning++;
                    break;
                case "SUCCESS":
                    numSuccessful++;
                    break;
                case "FAILURE":
                    numFailed++;
                    break;
            }
        });

        const finished_executions = changed_executions.filter(
            (execution) => execution.status == "SUCCESS"
        );

        // Fetch Results of executions that have finished
        const results = await Promise.all(
            finished_executions.map((execution) => {
                return fetchWingsRunResults(execution, prefs);
            })
        );
        for (let i = 0; i < finished_executions.length; i++) {
            if (results[i]) finished_executions[i].results = results[i];
        }

        // Update all executions
        setExecutions(changed_executions, thread_model_id);
    }

    summary.successful_runs = numSuccessful;
    summary.failed_runs = numFailed;
    summary.submitted_runs = numRunning + numSuccessful + numFailed;

    await setThreadModelExecutionSummary(thread_model_id, summary);
};
