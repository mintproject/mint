import { Apps } from "@tapis/tapis-typescript";
import { TapisExecutionService } from "@/classes/tapis/adapters/TapisExecutionService";
import { ExecutionCreation } from "@/classes/common/ExecutionCreation";
import app from "../tests/fixtures/app";
import model from "../tests/fixtures/model";

jest.mock("@/classes/mint/mint-functions", () => ({
    getConfiguration: jest.fn().mockReturnValue({
        auth: { client_id: "c", server: "http://s", realm: "r" },
        graphql: { endpoint: "http://g", secret: "s", enable_ssl: false }
    })
}));
jest.mock("@/classes/graphql/graphql_functions_v2", () => ({
    getThread: jest.fn().mockResolvedValue({})
}));
jest.mock("@/classes/graphql/graphql_adapter", () => ({
    ...jest.requireActual("@/classes/graphql/graphql_adapter"),
    threadFromGQL: jest.fn().mockReturnValue({ id: "thread-1", models: {}, model_ensembles: {} })
}));
jest.mock("@/classes/common/ExecutionCreation");

const envEntry = (key: string, inputMode: string) => ({ key, value: "", inputMode, notes: {} });
const earthdata = {
    name: "earthdata",
    source: "owner_only" as const,
    env: { username: "EARTHDATA_USERNAME", password: "EARTHDATA_PASSWORD" }
};

const appWithEnv = (envVariables: unknown[]) =>
    ({
        ...app,
        jobAttributes: {
            ...app.jobAttributes,
            parameterSet: { ...app.jobAttributes.parameterSet, appArgs: [], envVariables }
        }
    }) as unknown as Apps.TapisApp;

const buildTask = async (tapisApp: Apps.TapisApp, secrets: any[]) => {
    const service = new TapisExecutionService("token", "http://tapis");
    jest.spyOn(service, "loadTapisApp").mockResolvedValue(tapisApp);
    (ExecutionCreation as unknown as jest.Mock).mockImplementation(() => ({
        prepareExecutions: jest.fn().mockResolvedValue(true),
        executionToBeRun: [{ id: "exec-1", bindings: {} }],
        threadRegion: {},
        component: { id: "app", version: "1" },
        model: {
            ...model,
            id: "config/subside",
            required_secrets: secrets,
            output_files: [{ id: "out", name: "out", format: "zip" }]
        }
    }));
    return service.buildCompositeWorkflowModelTask(
        { thread_id: "thread-1", model_id: "config/subside" },
        "wf/path"
    );
};

describe("buildCompositeWorkflowModelTask secrets descriptor", () => {
    test("adds configuration_id and required_secrets and keeps injected keys out of the job", async () => {
        const task = await buildTask(
            appWithEnv([
                envEntry("EARTHDATA_USERNAME", "INCLUDE_ON_DEMAND"),
                envEntry("EARTHDATA_PASSWORD", "REQUIRED")
            ]),
            [earthdata]
        );
        expect(task.configuration_id).toBe("config/subside");
        expect(task.required_secrets).toEqual([earthdata]);
        expect(task.job_definition.parameterSet?.envVariables).toEqual([]);
    });

    test("models without secrets get an empty required_secrets", async () => {
        const task = await buildTask(appWithEnv([]), []);
        expect(task.required_secrets).toEqual([]);
    });

    test.each([
        ["missing", [envEntry("EARTHDATA_USERNAME", "INCLUDE_ON_DEMAND")]],
        [
            "FIXED",
            [
                envEntry("EARTHDATA_USERNAME", "INCLUDE_ON_DEMAND"),
                envEntry("EARTHDATA_PASSWORD", "FIXED")
            ]
        ]
    ])("throws SECRET_ENV_UNDECLARED when an env key is %s", async (_label, envVariables) => {
        await expect(buildTask(appWithEnv(envVariables), [earthdata])).rejects.toMatchObject({
            name: "UnifiedExecutionError",
            statusCode: 422,
            code: "SECRET_ENV_UNDECLARED",
            message: expect.stringContaining("EARTHDATA_PASSWORD")
        });
    });
});
