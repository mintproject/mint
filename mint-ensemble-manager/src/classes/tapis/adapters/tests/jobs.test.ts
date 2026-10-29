import seeds from "./fixtures/seeds";
import app, {
    appWithOptionalInput,
    appWithUnknownRequiredInput,
    appWithFixedInput,
    appWithMixedInputs
} from "./fixtures/app";
import model, { modelWithOptionalInput } from "./fixtures/model";
import jobFileInputsExpected from "./expected/jobFileInputs";
import { expectedJobParameterSetNonDefault } from "./expected/jobParameterSet";
import { TapisJobService } from "@/classes/tapis/adapters/TapisJobService";
import { Apps, Jobs } from "@tapis/tapis-typescript";
import { Model } from "@/classes/mint/mint-types";

test("test create job file inputs from seed", () => {
    const jobService = new TapisJobService(
        new Jobs.JobsApi(),
        new Jobs.SubscriptionsApi(),
        new Jobs.ShareApi()
    );
    const jobInputs = jobService.createJobFileInputsFromSeed(seeds[0], app, model);
    const jobParameterSet = jobService.createJobParameterSetFromSeed(seeds[0], app, model);
    expect(jobInputs).toEqual(jobFileInputsExpected);
    expect(jobParameterSet).toEqual(expectedJobParameterSetNonDefault);
});

test("FIXED app arguments are omitted from the Tapis job override set", () => {
    const jobService = new TapisJobService(
        new Jobs.JobsApi(),
        new Jobs.SubscriptionsApi(),
        new Jobs.ShareApi()
    );
    const appWithFixedArgument = {
        ...app,
        jobAttributes: {
            ...app.jobAttributes,
            parameterSet: {
                ...app.jobAttributes.parameterSet,
                appArgs: [
                    {
                        name: "mf6DefaultDir",
                        arg: "/scratch/default-mf6",
                        inputMode: Apps.ArgInputModeEnum.Fixed,
                        notes: {}
                    },
                    ...app.jobAttributes.parameterSet.appArgs
                ]
            }
        }
    } as Apps.TapisApp;

    const args = jobService.getAppArgs(seeds[0], appWithFixedArgument, model);

    expect(args).toEqual(expectedJobParameterSetNonDefault.appArgs);
    expect(args.find((arg) => arg.name === "mf6DefaultDir")).toBeUndefined();
});

test("a FIXED TACC Allocation scheduler option is not overridden", () => {
    const jobService = new TapisJobService(
        new Jobs.JobsApi(),
        new Jobs.SubscriptionsApi(),
        new Jobs.ShareApi()
    );
    const appWithFixedAllocation = {
        ...app,
        jobAttributes: {
            ...app.jobAttributes,
            parameterSet: {
                ...app.jobAttributes.parameterSet,
                schedulerOptions: [
                    ...(app.jobAttributes.parameterSet.schedulerOptions || []),
                    {
                        name: "TACC Allocation",
                        description: "Owned by the application",
                        inputMode: Apps.ArgInputModeEnum.Fixed,
                        arg: "-A PT2050-DataX",
                        notes: {}
                    }
                ]
            }
        }
    } as Apps.TapisApp;

    const request = jobService.createJobRequest(
        appWithFixedAllocation,
        seeds[0],
        model,
        "test-job",
        "test description"
    );

    expect(request.parameterSet?.schedulerOptions).toEqual([]);
});

test("uses the requested maximum runtime for a Tapis batch job", () => {
    const jobService = new TapisJobService(
        new Jobs.JobsApi(),
        new Jobs.SubscriptionsApi(),
        new Jobs.ShareApi()
    );

    const request = jobService.createJobRequest(
        app,
        seeds[0],
        model,
        "test-job",
        "test description",
        135
    );

    expect(request.maxMinutes).toBe(135);
});

test("uses a requested logical queue instead of the app's default queue", () => {
    const jobService = new TapisJobService(
        new Jobs.JobsApi(),
        new Jobs.SubscriptionsApi(),
        new Jobs.ShareApi()
    );
    const withQueue = (queue?: string) =>
        jobService.createJobRequest(
            app,
            seeds[0],
            model,
            "test-job",
            "test description",
            60,
            queue
        ).execSystemLogicalQueue;

    expect(withQueue("vm-small")).toBe("vm-small");
    // Without a request the app's own queue (the fixture declares "development") applies.
    expect(withQueue()).toBe("development");
});

const seedWithMissingOptionalInput = {
    ...seeds[0],
    datasets: {}
};

const seedWithOptionalInputBound = {
    ...seeds[0],
    datasets: {
        "https://w3id.org/okn/i/mint/optional-ds": [
            { id: "ds1", url: "https://example.com/optional.dat", name: "optional.dat", type: "" }
        ]
    }
};

const appWithUnmodeledOptionalInput: Apps.TapisApp = {
    ...app,
    jobAttributes: {
        ...app.jobAttributes,
        fileInputs: [
            ...(app.jobAttributes?.fileInputs || []),
            {
                name: "mf6-sim-nam",
                description: "Optional simulation name file",
                inputMode: "OPTIONAL",
                autoMountLocal: true,
                sourceUrl: null,
                targetPath: "provided/mfsim.nam"
            }
        ]
    }
} as Apps.TapisApp;

test("optional input with no datasets is skipped", () => {
    const jobService = new TapisJobService(
        new Jobs.JobsApi(),
        new Jobs.SubscriptionsApi(),
        new Jobs.ShareApi()
    );
    const jobInputs = jobService.createJobFileInputsFromSeed(
        seedWithMissingOptionalInput,
        appWithOptionalInput,
        modelWithOptionalInput
    );
    expect(jobInputs.find((i) => i.name === "optional_file")).toBeUndefined();
    expect(jobInputs).toHaveLength(0);
});

test("throws a contract error when app fileInput name is not found in model.input_files", () => {
    const jobService = new TapisJobService(
        new Jobs.JobsApi(),
        new Jobs.SubscriptionsApi(),
        new Jobs.ShareApi()
    );
    expect(() =>
        jobService.createJobFileInputsFromSeed(
            { ...seeds[0], datasets: {} },
            appWithUnknownRequiredInput,
            model
        )
    ).toThrow("The Tapis app and model input contract must agree before submission.");
});

test("FIXED input is skipped — Tapis injects sourceUrl from app definition", () => {
    const jobService = new TapisJobService(
        new Jobs.JobsApi(),
        new Jobs.SubscriptionsApi(),
        new Jobs.ShareApi()
    );
    const seedNoDatasets = { ...seeds[0], datasets: {} };
    expect(() =>
        jobService.createJobFileInputsFromSeed(seedNoDatasets, appWithFixedInput, model)
    ).not.toThrow();
    const jobInputs = jobService.createJobFileInputsFromSeed(
        seedNoDatasets,
        appWithFixedInput,
        model
    );
    expect(jobInputs.find((i) => i.name === "Fixed Input")).toBeUndefined();
    expect(jobInputs).toHaveLength(0);
});

test("FIXED input alongside OPTIONAL input — both safely omitted when unbound", () => {
    const jobService = new TapisJobService(
        new Jobs.JobsApi(),
        new Jobs.SubscriptionsApi(),
        new Jobs.ShareApi()
    );
    const jobInputs = jobService.createJobFileInputsFromSeed(
        seedWithMissingOptionalInput,
        appWithMixedInputs,
        modelWithOptionalInput
    );
    expect(jobInputs).toHaveLength(0);
});

test("optional input with datasets present is included", () => {
    const jobService = new TapisJobService(
        new Jobs.JobsApi(),
        new Jobs.SubscriptionsApi(),
        new Jobs.ShareApi()
    );
    const jobInputs = jobService.createJobFileInputsFromSeed(
        seedWithOptionalInputBound,
        appWithOptionalInput,
        modelWithOptionalInput
    );
    expect(jobInputs.find((i) => i.name === "optional_file")).toBeDefined();
});

test("unmodeled optional app inputs are omitted without failing submission", () => {
    const jobService = new TapisJobService(
        new Jobs.JobsApi(),
        new Jobs.SubscriptionsApi(),
        new Jobs.ShareApi()
    );

    const jobInputs = jobService.createJobFileInputsFromSeed(
        seedWithMissingOptionalInput,
        appWithUnmodeledOptionalInput,
        model
    );

    expect(jobInputs.find((input) => input.name === "mf6-sim-nam")).toBeUndefined();
});

test("semantic MODFLOW 6 model inputs map to Tapis file-input names", () => {
    const archiveId = "https://w3id.org/okn/i/mint/wmobley-modflow-6-simulation-archive";
    const wellId = "https://w3id.org/okn/i/mint/modflow6_input_wel";
    const rechargeId = "https://w3id.org/okn/i/mint/modflow6_input_rch";
    const mf6App = {
        ...app,
        id: "modflow6-simulation",
        version: "0.0.febed09",
        jobAttributes: {
            ...app.jobAttributes,
            fileInputs: [
                {
                    name: "mf6-simulation-archive",
                    description: "Required simulation archive",
                    inputMode: "REQUIRED",
                    autoMountLocal: true,
                    sourceUrl: null,
                    targetPath: "simulation.zip"
                },
                {
                    name: "mf6-wel",
                    description: "Optional well package override",
                    inputMode: "OPTIONAL",
                    autoMountLocal: true,
                    sourceUrl: null,
                    targetPath: "provided/model.wel"
                },
                {
                    name: "mf6-rch",
                    description: "Optional recharge package override",
                    inputMode: "OPTIONAL",
                    autoMountLocal: true,
                    sourceUrl: null,
                    targetPath: "provided/model.rch"
                }
            ]
        }
    } as Apps.TapisApp;
    const mf6Model = {
        ...model,
        id: "mf6-model",
        input_files: [
            {
                id: archiveId,
                name: "MODFLOW 6 simulation archive",
                type: "",
                format: "zip",
                variables: [],
                is_optional: false
            },
            {
                id: wellId,
                name: "MODFLOW 6 well override",
                type: "",
                format: "wel",
                variables: [],
                is_optional: true
            },
            {
                id: rechargeId,
                name: "MODFLOW 6 recharge override",
                type: "",
                format: "rch",
                variables: [],
                is_optional: true
            }
        ]
    } as Model;
    const semanticSeed = {
        ...seeds[0],
        datasets: {
            [archiveId]: [
                {
                    id: "archive-resource",
                    name: "simulation.zip",
                    url: "https://example.com/simulation.zip",
                    type: "zip"
                }
            ],
            [wellId]: [
                {
                    id: "well-resource",
                    name: "model.wel",
                    url: "https://example.com/model.wel",
                    type: "wel"
                }
            ],
            [rechargeId]: [
                {
                    id: "recharge-resource",
                    name: "model.rch",
                    url: "https://example.com/model.rch",
                    type: "rch"
                }
            ]
        }
    };
    const jobService = new TapisJobService(
        new Jobs.JobsApi(),
        new Jobs.SubscriptionsApi(),
        new Jobs.ShareApi()
    );

    expect(jobService.createJobFileInputsFromSeed(semanticSeed, mf6App, mf6Model)).toEqual([
        { name: "mf6-simulation-archive", sourceUrl: "https://example.com/simulation.zip" },
        { name: "mf6-wel", sourceUrl: "https://example.com/model.wel" },
        { name: "mf6-rch", sourceUrl: "https://example.com/model.rch" }
    ]);
});

test("semantic MODFLOW 2005 inputs map to the archive-first Tapis contract", () => {
    const archiveId =
        "https://w3id.org/okn/i/mint/wmobley-modflow-2005-simulation-archive";
    const wellId = "https://w3id.org/okn/i/mint/modflow_2005_Well";
    const rechargeId = "https://w3id.org/okn/i/mint/modflow_2005_Rech";
    const mf2005App = {
        ...app,
        id: "modflow-2005-simulation",
        version: "0.0.f8480a8",
        jobAttributes: {
            ...app.jobAttributes,
            fileInputs: [
                {
                    name: "mf2005-simulation-archive",
                    description: "Required simulation archive",
                    inputMode: "REQUIRED",
                    autoMountLocal: true,
                    sourceUrl: null,
                    targetPath: "simulation.zip"
                },
                {
                    name: "mf2005-wel",
                    description: "Optional well package override",
                    inputMode: "OPTIONAL",
                    autoMountLocal: true,
                    sourceUrl: null,
                    targetPath: "provided/model.wel"
                },
                {
                    name: "mf2005-rch",
                    description: "Optional recharge package override",
                    inputMode: "OPTIONAL",
                    autoMountLocal: true,
                    sourceUrl: null,
                    targetPath: "provided/model.rch"
                }
            ]
        }
    } as Apps.TapisApp;
    const mf2005Model = {
        ...model,
        id: "mf2005-model",
        input_files: [
            {
                id: archiveId,
                name: "MODFLOW 2005 simulation archive",
                type: "",
                format: "zip",
                variables: [],
                is_optional: false
            },
            {
                id: wellId,
                name: "MODFLOW 2005 well override",
                type: "",
                format: "dat",
                variables: [],
                is_optional: true
            },
            {
                id: rechargeId,
                name: "MODFLOW 2005 recharge override",
                type: "",
                format: "dat",
                variables: [],
                is_optional: true
            }
        ]
    } as Model;
    const semanticSeed = {
        ...seeds[0],
        datasets: {
            [archiveId]: [{ id: "archive", name: "simulation.zip", url: "https://example.com/simulation.zip", type: "zip" }],
            [wellId]: [{ id: "well", name: "model.wel", url: "https://example.com/model.wel", type: "wel" }],
            [rechargeId]: [{ id: "recharge", name: "model.rch", url: "https://example.com/model.rch", type: "rch" }]
        }
    };
    const jobService = new TapisJobService(
        new Jobs.JobsApi(),
        new Jobs.SubscriptionsApi(),
        new Jobs.ShareApi()
    );

    expect(jobService.createJobFileInputsFromSeed(semanticSeed, mf2005App, mf2005Model)).toEqual([
        { name: "mf2005-simulation-archive", sourceUrl: "https://example.com/simulation.zip" },
        { name: "mf2005-wel", sourceUrl: "https://example.com/model.wel" },
        { name: "mf2005-rch", sourceUrl: "https://example.com/model.rch" }
    ]);
});

test("semantic MODFLOW 2000 archive input maps to the archive-first Tapis contract", () => {
    const archiveId =
        "https://w3id.org/okn/i/mint/wmobley-modflow-2000-simulation-archive";
    const mf2000App = {
        ...app,
        id: "modflow-2000-simulation",
        version: "0.0.febed09",
        jobAttributes: {
            ...app.jobAttributes,
            fileInputs: [
                {
                    name: "mf2000-simulation-archive",
                    description: "Required simulation archive",
                    inputMode: "REQUIRED",
                    autoMountLocal: true,
                    sourceUrl: null,
                    targetPath: "simulation.zip"
                }
            ]
        }
    } as Apps.TapisApp;
    const mf2000Model = {
        ...model,
        id: "mf2000-model",
        input_files: [
            {
                id: archiveId,
                name: "MODFLOW 2000 simulation archive",
                type: "",
                format: "zip",
                variables: [],
                is_optional: false
            }
        ]
    } as Model;
    const semanticSeed = {
        ...seeds[0],
        datasets: {
            [archiveId]: [
                {
                    id: "archive",
                    name: "simulation.zip",
                    url: "https://example.com/simulation.zip",
                    type: "zip"
                }
            ]
        }
    };
    const jobService = new TapisJobService(
        new Jobs.JobsApi(),
        new Jobs.SubscriptionsApi(),
        new Jobs.ShareApi()
    );

    expect(jobService.createJobFileInputsFromSeed(semanticSeed, mf2000App, mf2000Model)).toEqual([
        { name: "mf2000-simulation-archive", sourceUrl: "https://example.com/simulation.zip" }
    ]);
});
