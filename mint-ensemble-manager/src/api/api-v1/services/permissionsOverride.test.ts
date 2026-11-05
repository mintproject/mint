import problemStatementsService from "./problemStatementsService";
import tasksService from "./tasksService";
import subTasksService from "./subTasksService";
import { addProblemStatement, addTask, addThread } from "@/classes/graphql/graphql_functions";

jest.mock("@/classes/mint/mint-functions", () => ({
    getConfiguration: jest.fn().mockReturnValue({})
}));
jest.mock("@/classes/graphql/graphql_functions", () => ({
    addProblemStatement: jest.fn().mockResolvedValue("ps-1"),
    addTask: jest.fn().mockResolvedValue("task-1"),
    addThread: jest.fn().mockResolvedValue("thread-1"),
    getTask: jest.fn().mockResolvedValue({ id: "task-1", problem_statement_id: "ps-1" })
}));
jest.mock("@/classes/graphql/graphql_functions_v2", () => ({
    getProblemStatement: jest.fn().mockResolvedValue({
        id: "ps-1",
        name: "ps",
        start_date: "2024-01-01",
        end_date: "2024-12-31",
        region_id: "region-1",
        events: [],
        permissions: [],
        tasks: []
    }),
    checkVariableExistsById: jest.fn().mockResolvedValue(true),
    checkRegionExistsById: jest.fn().mockResolvedValue(true)
}));

const AUTH = "Bearer some-token";
const SHARED = [{ read: true, write: true, execute: true, owner: false, userid: "*" }];
const CALLER = [{ read: true, write: true, execute: true, owner: true, userid: "alice" }];
const dates = { start_date: new Date("2024-01-01"), end_date: new Date("2024-12-31") };

describe("permissions on problem statements, tasks and threads", () => {
    beforeEach(() => jest.clearAllMocks());

    it("keeps userid * for a problem statement created without an override", async () => {
        await problemStatementsService.createProblemStatement(
            { name: "ps", regionid: "region-1", dates } as any,
            AUTH
        );
        expect((addProblemStatement as jest.Mock).mock.calls[0][0].permissions).toEqual(SHARED);
    });

    it("uses the supplied permissions, id and ifAbsent for a problem statement", async () => {
        await problemStatementsService.createProblemStatement(
            { name: "ps", regionid: "region-1", dates } as any,
            AUTH,
            { permissions: CALLER, id: "ps-x", ifAbsent: true }
        );
        const [info, , options] = (addProblemStatement as jest.Mock).mock.calls[0];
        expect(info.permissions).toEqual(CALLER);
        expect(options).toMatchObject({ id: "ps-x", ifAbsent: true });
    });

    it("keeps userid * for a task created without an override", async () => {
        await tasksService.createTask(
            "ps-1",
            { name: "t", response_variables: [], driving_variables: [], dates } as any,
            AUTH
        );
        expect((addTask as jest.Mock).mock.calls[0][1].permissions).toEqual(SHARED);
    });

    it("uses the supplied permissions for a task", async () => {
        await tasksService.createTask(
            "ps-1",
            { name: "t", response_variables: [], driving_variables: [], dates } as any,
            AUTH,
            { permissions: CALLER, id: "task-x", ifAbsent: true }
        );
        const [, task, , options] = (addTask as jest.Mock).mock.calls[0];
        expect(task.permissions).toEqual(CALLER);
        expect(options).toMatchObject({ id: "task-x", ifAbsent: true });
    });

    it("keeps userid * for a thread, and uses the supplied permissions when given", async () => {
        const thread = () =>
            ({
                name: "th",
                task_id: "task-1",
                driving_variables: [],
                response_variables: [],
                dates
            }) as any;
        await subTasksService.createSubtask("ps-1", "task-1", thread(), AUTH);
        expect((addThread as jest.Mock).mock.calls[0][1].permissions).toEqual(SHARED);
        await subTasksService.createSubtask("ps-1", "task-1", thread(), AUTH, {
            permissions: CALLER
        });
        expect((addThread as jest.Mock).mock.calls[1][1].permissions).toEqual(CALLER);
    });
});
