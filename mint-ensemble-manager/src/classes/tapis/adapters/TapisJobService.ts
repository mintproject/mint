import { Apps, Jobs } from "@tapis/tapis-typescript";
import { DataResource, Model } from "@/classes/mint/mint-types";
import { TapisComponentSeed } from "@/classes/tapis/typing";

export class TapisComponentContractError extends Error {
    readonly code = "COMPONENT_CONTRACT_MISMATCH";

    constructor(message: string) {
        super(message);
        this.name = "TapisComponentContractError";
    }
}

export class TapisJobService {
    private static readonly ALLOCATION = "PT2050-DataX";
    private static readonly SYSTEM_LOGICAL_QUEUE = "development";
    private static readonly SYSTEM_ID = "ls6";

    constructor(
        private jobsClient: Jobs.JobsApi,
        private subscriptionsClient: Jobs.SubscriptionsApi,
        private jobShareClient: Jobs.ShareApi
    ) {}

    async shareJob(jobId: string) {
        await this.jobShareClient.shareJob({
            jobUuid: jobId,
            reqShareJob: {
                jobResource: [Jobs.ReqShareJobJobResourceEnum.Output],
                jobPermission: Jobs.ReqShareJobJobPermissionEnum.Read
            }
        });
    }

    createJobRequest = (
        app: Apps.TapisApp,
        seed: TapisComponentSeed,
        model: Model,
        name: string,
        description: string,
        maxMinutes = 60,
        logicalQueue?: string
    ): Jobs.ReqSubmitJob => {
        const jobFileInputs = this.createJobFileInputsFromSeed(seed, app, model);
        const jobParameterSet: Jobs.JobParameterSet = {
            appArgs: this.getAppArgs(seed, app, model),
            containerArgs: [],
            schedulerOptions: this.getSchedulerOptions(app),
            envVariables: []
        };

        const request: Jobs.ReqSubmitJob = {
            name: name,
            description: description,
            appId: app.id,
            appVersion: app.version,
            fileInputs: jobFileInputs,
            nodeCount: app.jobAttributes?.nodeCount || 1,
            coresPerNode: app.jobAttributes?.coresPerNode || 1,
            maxMinutes,
            archiveSystemId: "ls6",
            archiveSystemDir:
                "HOST_EVAL($WORK)/tapis-jobs-archive/${JobCreateDate}/${JobName}-${JobUUID}",
            archiveOnAppError: true,
            execSystemId: app.jobAttributes?.execSystemId || TapisJobService.SYSTEM_ID,
            execSystemLogicalQueue:
                logicalQueue ||
                app.jobAttributes?.execSystemLogicalQueue ||
                TapisJobService.SYSTEM_LOGICAL_QUEUE,
            parameterSet: jobParameterSet
        };

        return request;
    };

    private getSchedulerOptions(app: Apps.TapisApp): Jobs.JobArgSpec[] {
        const appSchedulerOptions = app.jobAttributes?.parameterSet?.schedulerOptions || [];
        const fixedOptionNames = new Set(
            appSchedulerOptions
                .filter((option) => option.inputMode === Apps.ArgInputModeEnum.Fixed)
                .map((option) => option.name)
        );

        if (fixedOptionNames.has("TACC Allocation")) {
            // The application definition owns this value. Sending an option
            // with the same name in the job request is an override and Tapis
            // rejects the entire job definition.
            console.info("Skipping fixed scheduler option TACC Allocation");
            return [];
        }

        return [
            {
                name: "TACC Allocation",
                description: "The TACC allocation associated with this job execution",
                include: true,
                arg: `-A ${TapisJobService.ALLOCATION}`
            }
        ];
    }

    public createJobParameterSetFromSeed(
        seed: TapisComponentSeed,
        app: Apps.TapisApp,
        model: Model
    ): Jobs.JobParameterSet {
        return {
            appArgs: this.getAppArgs(seed, app, model)
        };
    }

    public getAppArgs(
        seed: TapisComponentSeed,
        app: Apps.TapisApp,
        model: Model
    ): Jobs.JobArgSpec[] {
        const jobArgs = app.jobAttributes;
        return jobArgs.parameterSet.appArgs.flatMap((parameterSet) => {
            if (parameterSet.inputMode === Apps.ArgInputModeEnum.Fixed) {
                // FIXED app arguments are owned by the Tapis application
                // definition. Sending them in a job request is interpreted as
                // an attempted override and rejected by Tapis.
                console.info(`Skipping fixed app argument ${parameterSet.name}`);
                return [];
            }

            const modelParameter = model.input_parameters.find(
                (parameter) => parameter.name === parameterSet.name
            );
            const arg = modelParameter ? seed.parameters[modelParameter.id] : parameterSet.arg;
            if (arg === undefined) {
                throw new Error(
                    `Tapis Job Input Parameter value ${parameterSet.name} could not be found. Tapis Job (app ${app.id}/${app.version}) requires this parameter. The model ${model.id} (${model.name}) has the following parameters: ${model.input_parameters.map((p) => p.name).join(", ")}`
                );
            }
            return {
                name: parameterSet.name,
                arg: arg
            } as Jobs.JobArgSpec;
        });
    }

    private findModelInput(fileInputName: string, model: Model) {
        const exactInput = model.input_files.find((input) => input.name === fileInputName);
        const appInputName = fileInputName.toLowerCase();
        const semanticInputNames = new Set([
            "mf6-simulation-archive",
            "mf6-wel",
            "mf6-rch",
            "mf2000-simulation-archive",
            "mf2000-wel",
            "mf2000-rch",
            "mf2005-simulation-archive",
            "mf2005-wel",
            "mf2005-rch"
        ]);
        if (exactInput || !semanticInputNames.has(appInputName)) {
            return exactInput;
        }

        return model.input_files.find((input) => {
            const inputName = input.name.toLowerCase();
            const inputId = input.id.toLowerCase();
            const inputFormat = input.format?.toLowerCase();
            const packageName = (value: string) =>
                new RegExp(`(^|[^a-z])${value}([^a-z]|$)`).test(inputName);

            if (appInputName.endsWith("-simulation-archive")) {
                return (
                    inputFormat === "zip" ||
                    inputName.includes("simulation archive") ||
                    inputName.includes("simulation_archive") ||
                    inputId.includes("simulation-archive")
                );
            }

            if (appInputName.endsWith("-wel")) {
                return (
                    inputFormat === "wel" ||
                    packageName("wel") ||
                    inputName.includes("well override") ||
                    inputId.endsWith("/modflow6_input_wel") ||
                    inputId.includes("modflow_2005_well") ||
                    inputId.includes("modflow-2005-wel-override")
                );
            }

            if (appInputName.endsWith("-rch")) {
                return (
                    (inputFormat === "rch" &&
                        !inputName.includes("rcha") &&
                        !inputName.includes("rchb")) ||
                    packageName("rch") ||
                    inputName.includes("recharge override") ||
                    inputId.endsWith("/modflow6_input_rch") ||
                    inputId.includes("modflow_2005_rech") ||
                    inputId.includes("modflow-2005-rch-override")
                );
            }

            return false;
        });
    }

    public createJobFileInputsFromSeed(
        seed: TapisComponentSeed,
        app: Apps.TapisApp,
        model: Model
    ): Jobs.JobFileInput[] {
        const jobInputs =
            app.jobAttributes?.fileInputs?.flatMap((fileInput) => {
                if (fileInput.inputMode === Apps.FileInputModeEnum.Fixed) {
                    // FIXED inputs are locked by the app definition; Tapis injects
                    // them from the app at submission. No model component input or
                    // user-provided dataset is required.
                    return [];
                }

                const modelInput = this.findModelInput(fileInput.name, model);

                if (!modelInput) {
                    if (fileInput.inputMode === Apps.FileInputModeEnum.Optional) {
                        console.info(
                            `Skipping optional app input ${fileInput.name} — no model input is registered`
                        );
                        return [];
                    }

                    const modelInputs = model.input_files.map((input) => input.name).join(", ");
                    throw new TapisComponentContractError(
                        `Component input not found for ${fileInput.name}. ` +
                            `Tapis app ${app.id}/${app.version} declares this file input, ` +
                            `but model ${model.id} declares: ${modelInputs || "none"}. ` +
                            "The Tapis app and model input contract must agree before submission."
                    );
                }

                const datasets = seed.datasets[modelInput.id] || [];

                if (datasets.length === 0 && modelInput.is_optional) {
                    // Skip optional input — no datasets bound, safe to omit from Tapis submission
                    console.info(
                        `Skipping optional input ${modelInput.name} — no datasets bound`
                    );
                    return [];
                }

                return datasets.map(
                    (dataset: DataResource) =>
                        ({
                            name: fileInput.name,
                            sourceUrl: dataset.url
                        }) as Jobs.JobFileInput
                );
            }) || [];

        return jobInputs;
    }
}
