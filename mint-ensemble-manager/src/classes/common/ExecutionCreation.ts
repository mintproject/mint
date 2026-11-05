import {
    deleteThreadModelExecutionIds,
    getExecutionHash,
    getRegionDetails,
    incrementThreadModelSubmittedRuns,
    incrementThreadModelSuccessfulRuns,
    listSuccessfulExecutionIds,
    insertThreadModelExecutionSummary,
    setExecutions,
    setThreadModelExecutionIds
} from "@/classes/graphql/graphql_functions";
import { getConfiguration } from "@/classes/mint/mint-functions";
import {
    Execution,
    ExecutionSummary,
    Model,
    ModelIO,
    ModelIOBindings,
    ModelParameter,
    Region,
    Thread,
    ThreadModelMap
} from "@/classes/mint/mint-types";
import { TapisComponent } from "@/classes/tapis/typing";
import { IExecutionService } from "@/interfaces/IExecutionService";
import { HttpError } from "./errors";
import { uuidv4 } from "../graphql/graphql_adapter";

const MAX_CONFIGURATIONS = 1000000;
// Add interface for IO/Parameter details
interface ComponentIODetails {
    id: string;
    role: string;
    prefix: string;
    isParam: boolean;
    format?: string;
    type: string;
}

export class ExecutionCreation {
    private static readonly BATCH_SIZE = 500;
    public thread: Thread;
    public threadRegion: Region;
    public modelid: string;
    public executionToBeRun: Execution[];
    public model: Model;
    public component: TapisComponent;
    public token: string | undefined;
    public executionService: IExecutionService;

    constructor(
        thread: Thread,
        modelid: string,
        executionService: IExecutionService,
        token?: string
    ) {
        this.thread = thread;
        this.modelid = modelid;
        this.executionToBeRun = [];
        this.token = token;
        this.executionService = executionService;
    }

    private async verifyComponents(): Promise<void> {
        for (const modelid in this.thread.model_ensembles) {
            const component = await this.getModelDetails(this.thread.models[modelid]);
            await this.executionService.verifyComponent(component);
        }
    }

    public async prepareExecutions(): Promise<boolean> {
        await this.verifyComponents();
        for (const pmodelid in this.thread.model_ensembles) {
            if (!this.modelid || this.modelid === pmodelid) {
                return await this.prepareModelExecutions(pmodelid);
            }
        }
        return true;
    }

    public async prepareModelExecutions(modelid: string): Promise<boolean> {
        const { modelEnsembleId, configs, inputIds } = await this.resolveModelConfigurations(
            modelid
        );
        if (configs !== null) {
            await this.createThreadModelExecutionSummary(configs, modelEnsembleId);
            await deleteThreadModelExecutionIds(modelEnsembleId);
            await this.createExecutions(configs, modelEnsembleId, inputIds, modelid);
        }
        return true;
    }

    /**
     * Resolve this model's component and its first execution in memory, with no
     * database writes (no execution summary, no execution rows). Used to inspect
     * the job a submit would build while planning. `executionToBeRun` holds at
     * most the first two configurations: enough to tell a fan-out from a single run.
     */
    public async previewExecutions(): Promise<void> {
        const { configs, inputIds } = await this.resolveModelConfigurations(this.modelid);
        if (configs === null) return;
        this.component = await this.getModelDetails(this.model);
        this.executionToBeRun = this.createExecutionsBatch(
            configs.slice(0, 2),
            inputIds,
            this.modelid
        );
    }

    private async resolveModelConfigurations(modelid: string) {
        if (!this.thread.execution_summary) this.thread.execution_summary = {};
        console.log("Thread", JSON.stringify(this.thread));
        this.model = this.thread.models[modelid];
        const modelEnsembleId = this.thread.model_ensembles[modelid].id;
        this.threadRegion = await getRegionDetails(this.thread.regionid);
        const executionDetails = ExecutionCreation.getModelInputBindings(
            this.thread.models[modelid],
            this.thread,
            this.threadRegion
        );
        const threadModel = executionDetails[0] as ThreadModelMap;
        const inputIds = executionDetails[1] as string[];
        const configs = ExecutionCreation.getModelInputConfigurations(
            threadModel.bindings,
            inputIds
        );
        return { modelEnsembleId, configs, inputIds };
    }

    private async createExecutions(
        configs: Array<Array<string | number>>,
        thread_model_id: string,
        inputIds: string[],
        modelid: string
    ): Promise<void> {
        this.model = this.thread.models[modelid];
        this.component = await this.getModelDetails(this.model);

        for (let i = 0; i < configs.length; i += ExecutionCreation.BATCH_SIZE) {
            const bindings = configs.slice(i, i + ExecutionCreation.BATCH_SIZE);
            const executions: Execution[] = this.createExecutionsBatch(bindings, inputIds, modelid);

            // const successful_execution_ids = await listSuccessfulExecutionIds(
            //     executionsBatch.map((e) => e.id)
            // );
            // const executions_to_be_run = executionsBatch.filter(
            //     (e) => successful_execution_ids.indexOf(e.id) < 0
            // );
            // const executionsAlreadyRun = executionsBatch.filter(
            //     (e) => successful_execution_ids.indexOf(e.id) >= 0
            // );
            // for (const execution of executionsAlreadyRun) {
            //     execution.run_progress = 1;
            //     this.executionAlreadyRun.push(execution);
            // }
            // this.executionAlreadyRun = [
            //     ...this.executionAlreadyRun,
            //     ...executionsBatch.filter((e) => successful_execution_ids.indexOf(e.id) >= 0)
            // ];
            await setExecutions(executions, thread_model_id);
            await setThreadModelExecutionIds(
                thread_model_id,
                executions.map((e) => e.id)
            );
            await incrementThreadModelSubmittedRuns(thread_model_id, executions.length);
            this.executionToBeRun = executions;
        }
    }

    private async updateSuccessfulExecutionOnThread(
        successful_execution_ids: string[],
        thread_model_id: string
    ): Promise<void> {
        const num_already_run = successful_execution_ids.length;
        if (num_already_run > 0) {
            await incrementThreadModelSubmittedRuns(thread_model_id, num_already_run);
            await incrementThreadModelSuccessfulRuns(thread_model_id, num_already_run);
        }
    }

    private async createThreadModelExecutionSummary(
        configs: any[][],
        thread_model_id: string
    ): Promise<void> {
        const summary: ExecutionSummary = {
            total_runs: configs.length,
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
        const result = await insertThreadModelExecutionSummary(thread_model_id, summary);
        if (result.errors) {
            console.error("Error setting thread model execution summary:", result.errors);
            throw new Error("Error setting thread model execution summary");
        }
    }

    private createExecutionsBatch(
        bindings: any[][],
        inputIds: string[],
        modelid: string
    ): Execution[] {
        return bindings.map((binding) => {
            const inputBindings: any = {};
            for (let j = 0; j < inputIds.length; j++) {
                inputBindings[inputIds[j]] = binding[j];
            }
            return this.createExecutionMetadata(modelid, inputBindings);
        });
    }

    private createExecutionMetadata(
        modelid: string,
        inputBindings: any,
        reuseExistingExecutions = false
    ): Execution {
        const execution: Execution = {
            modelid: modelid,
            bindings: inputBindings,
            execution_engine: "localex",
            runid: null,
            status: "WAITING",
            results: [],
            start_time: new Date(),
            selected: true
        };
        if (reuseExistingExecutions) {
            execution.id = getExecutionHash(execution);
        } else {
            execution.id = uuidv4();
        }
        return execution;
    }

    private async getModelDetails(model: Model): Promise<TapisComponent> {
        let comp: TapisComponent;
        const configuration = getConfiguration();
        if (configuration.execution_engine === "tapis") {
            comp = await this.loadComponentFromTapis(model.code_url);
        } else {
            comp = await this.loadComponent(model.code_url);
        }
        comp.inputs = [];
        comp.outputs = [];

        model.input_files.forEach((input) => {
            const details = this._getModelIODetails(input, "input");
            if (!details) throw new Error("Input file missing position: " + input.id);
            comp.inputs.push(details);
        });

        model.input_parameters.forEach((param) => {
            const details = this._getModelParamDetails(param);
            if (!details) throw new Error("Input parameter missing position: " + param.id);
            comp.inputs.push(details);
        });

        model.output_files.forEach((output) => {
            const details = this._getModelIODetails(output, "output");
            if (!details) throw new Error("Output file missing position: " + output.id);
            comp.outputs.push(details);
        });

        return comp;
    }

    private async loadComponentFromTapis(component_url: string): Promise<TapisComponent> {
        const response = await fetch(component_url, {
            headers: {
                "x-tapis-token": `${this.token}`
            }
        });
        if (response.ok) {
            const { result } = await response.json();
            return result as TapisComponent;
        } else if (response.status === 404) {
            throw new HttpError(
                404,
                `Component not found: ${component_url} error: ${response.statusText}`
            );
        } else if (response.status === 403) {
            throw new HttpError(403, `Forbidden: ${component_url} error: ${response.statusText}`);
        } else {
            throw new HttpError(
                response.status,
                `Response status not ok: ${component_url} error: ${response.statusText}`
            );
        }
    }

    private async loadComponent(component_url: string): Promise<TapisComponent> {
        // If token is provided, use it to fetch the component
        const response = await fetch(component_url, {
            headers: {
                "X-Tapis-Token": `${this.token}`
            }
        });
        if (response.ok) {
            const data = await response.text();
            const component = JSON.parse(data) as TapisComponent;
            console.log(component);
            if (component.id && component.version) {
                return component;
            }
            console.error(`Invalid component: ${component_url}`);
            throw new Error("Invalid component");
        } else if (response.status === 404) {
            throw new HttpError(404, `Component not found: ${component_url}`);
        } else if (response.status === 403) {
            throw new HttpError(403, `Forbidden: ${component_url}`);
        } else {
            throw new HttpError(
                response.status,
                `Response status not ok: ${component_url} error: ${response.statusText}`
            );
        }
    }

    private _getModelIODetails(io: ModelIO, iotype: string): ComponentIODetails | null {
        if (!io.position) {
            return null;
        }
        const pfx = iotype === "input" ? "-i" : "-o";
        return {
            id: io.id,
            role: io.name,
            prefix: pfx + io.position,
            isParam: false,
            format: io.format,
            type: io.type
        };
    }

    private _getModelParamDetails(param: ModelParameter): ComponentIODetails {
        return {
            id: param.id,
            role: param.name,
            prefix: "-p" + param.position,
            isParam: true,
            type: param.type
        };
    }

    public static processInputFiles(
        modelInputFiles: ModelIO[],
        threadModel: ThreadModelMap,
        thread: Thread
    ): string[] {
        const inputIds = [];
        modelInputFiles.forEach((io) => {
            // Optional inputs without a user binding or fixed value contribute no
            // values to the cartesian product — including their id would push an
            // undefined slot into cartProd and crash. Downstream Tapis/localex
            // adapters tolerate the missing key.
            if (io.is_optional && !io.value && !threadModel.bindings[io.id]) {
                return;
            }

            inputIds.push(io.id);

            if (!io.value) {
                // Expand a dataset to its constituent "selected" resources
                // FIXME: Create a collection if the model input has dimensionality of 1
                if (threadModel.bindings[io.id]) {
                    let nexecution: any[] = [];
                    threadModel.bindings[io.id].map((dsid) => {
                        const ds = thread.data[dsid];
                        let selected_resources = ds.resources.filter((res) => res.selected);
                        // Fix for older saved resources
                        if (selected_resources.length == 0) selected_resources = ds.resources;
                        nexecution = nexecution.concat(selected_resources);
                    });
                    threadModel.bindings[io.id] = nexecution;
                }
            } else {
                threadModel.bindings[io.id] = io.value.resources as any[];
            }
        });
        return inputIds;
    }

    public static processInputParameters(
        modelInputParameters: ModelParameter[],
        threadModel: ThreadModelMap,
        region: Region
    ): string[] {
        const inputIds = [];
        modelInputParameters.forEach((io) => {
            inputIds.push(io.id);

            if (io.value) {
                // If this is a non-adjustable parameter, set the binding value to the fixed value
                threadModel.bindings[io.id] = [io.value];
            }

            // HACK: Add region id to __region_geojson (Not replacing )
            if (
                threadModel.bindings[io.id] &&
                threadModel.bindings[io.id][0] == "__region_geojson"
            ) {
                threadModel.bindings[io.id] = ["__region_geojson:" + region.id];
            }
        });
        return inputIds;
    }

    public static getModelInputBindings = (model: Model, thread: Thread, region: Region) => {
        const modelEnsemble = thread.model_ensembles[model.id];
        const threadModel = {
            id: modelEnsemble.id,
            bindings: Object.assign({}, modelEnsemble.bindings)
        } as ThreadModelMap;
        const inputFileIds = ExecutionCreation.processInputFiles(
            model.input_files,
            threadModel,
            thread
        );
        const parameterIds = ExecutionCreation.processInputParameters(
            model.input_parameters,
            threadModel,
            region
        );

        return [threadModel, [...inputFileIds, ...parameterIds]];
    };

    /**
     * Generates all possible input configurations for a model execution by calculating
     * the cartesian product of all input bindings.
     *
     * @param threadModel - Contains the model's input bindings (parameters and data)
     * @param inputIds - List of input IDs to generate configurations for
     * @returns Array of input configurations if total combinations is under MAX_CONFIGURATIONS,
     *          otherwise returns null
     *
     * For example, if we have:
     * - input1: ['a', 'b']
     * - input2: ['x', 'y']
     *
     * It will generate configurations:
     * [['a','x'], ['a','y'], ['b','x'], ['b','y']]
     */
    private static getModelInputConfigurations = (
        dataBindings: ModelIOBindings,
        inputIds: string[]
    ) => {
        const { inputBindings, totalproducts } = ExecutionCreation.getInputBindingsAndTotalProducts(
            dataBindings,
            inputIds
        );
        return totalproducts < MAX_CONFIGURATIONS
            ? ExecutionCreation.cartProd(inputBindings)
            : null;
    };

    public static getInputBindingsAndTotalProducts(
        dataBindings: ModelIOBindings,
        inputIds: string[]
    ): { inputBindings: any[]; totalproducts: number } {
        const inputBindings: any[] = [];
        let totalproducts = 1;

        // For each input, get its possible values and calculate total combinations
        inputIds.map((inputid) => {
            inputBindings.push(dataBindings[inputid]);
            if (dataBindings[inputid]) totalproducts *= dataBindings[inputid].length;
        });

        return { inputBindings, totalproducts };
    }

    private static cartProd = (lists: any[]) => {
        let ps: any[] = [],
            acc: any[][] = [[]],
            i = lists.length;
        while (i--) {
            let subList = lists[i],
                j = subList.length;
            while (j--) {
                let x = subList[j],
                    k = acc.length;
                while (k--) ps.push([x].concat(acc[k]));
            }
            acc = ps;
            ps = [];
        }
        return acc.reverse();
    };
}
