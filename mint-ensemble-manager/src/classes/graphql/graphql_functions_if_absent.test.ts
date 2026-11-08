import {
    addProblemStatement,
    addTask,
    insertRegionIfAbsent,
    isAlreadyPresent
} from "@/classes/graphql/graphql_functions";
import { GraphQL } from "@/config/graphql";

jest.mock("@/config/graphql", () => ({
    GraphQL: { instanceUsingAccessToken: jest.fn(), instance: jest.fn() }
}));

// What Hasura answers when the parent row of a nested insert already exists.
const zeroRows = (table: string) => {
    const message = `cannot proceed to insert array relations since insert to table "${table}" affects zero rows`;
    return Object.assign(new Error(message), { graphQLErrors: [{ message }] });
};

const dates = { start_date: new Date("2024-01-01"), end_date: new Date("2024-12-31") };
const statement = { name: "ps", regionid: "r", dates, events: [], permissions: [] } as any;
const task = {
    name: "t",
    dates,
    driving_variables: [],
    response_variables: [],
    events: [],
    permissions: []
} as any;

const client = (mutate: jest.Mock) =>
    (GraphQL.instanceUsingAccessToken as jest.Mock).mockReturnValue({ mutate });

describe("create-if-absent when the row already exists", () => {
    it("recognises Hasura's zero-rows error, by message or by graphQLErrors", () => {
        expect(isAlreadyPresent(zeroRows("problem_statement"))).toBe(true);
        expect(
            isAlreadyPresent({
                graphQLErrors: [{ message: 'insert to table "task" affects zero rows' }]
            })
        ).toBe(true);
        expect(isAlreadyPresent(new Error("permission denied"))).toBe(false);
        expect(isAlreadyPresent(undefined)).toBe(false);
    });

    it("returns the id of an existing problem statement instead of failing", async () => {
        client(jest.fn().mockRejectedValue(zeroRows("problem_statement")));
        await expect(
            addProblemStatement(statement, "tok", { id: "ps-1", ifAbsent: true })
        ).resolves.toBe("ps-1");
    });

    it("returns the id of an existing task instead of failing", async () => {
        client(jest.fn().mockRejectedValue(zeroRows("task")));
        await expect(
            addTask(statement, task, "tok", { id: "task-1", ifAbsent: true })
        ).resolves.toBe("task-1");
    });

    it("still fails for any other error, and for a plain create that hits a conflict", async () => {
        client(jest.fn().mockRejectedValue(new Error("permission denied")));
        await expect(
            addProblemStatement(statement, "tok", { id: "ps-1", ifAbsent: true })
        ).rejects.toThrow();
        client(jest.fn().mockRejectedValue(zeroRows("problem_statement")));
        await expect(addProblemStatement(statement, "tok", {})).rejects.toThrow();
        await expect(addProblemStatement(statement, "tok", { id: "ps-1" })).rejects.toThrow();
    });
});

describe("insertRegionIfAbsent when the region already exists", () => {
    const region = { id: "aoi-1", name: "r", geometries: { data: [{ geometry: "{}" }] } };
    const instance = (mutate: jest.Mock) =>
        (GraphQL.instance as jest.Mock).mockReturnValue({ mutate });

    it("answers false (nothing written) instead of failing", async () => {
        instance(jest.fn().mockRejectedValue(zeroRows("region")));
        await expect(insertRegionIfAbsent(region)).resolves.toBe(false);
    });

    it("answers true when a row was written, and still fails on any other error", async () => {
        instance(jest.fn().mockResolvedValue({ data: { insert_region: { affected_rows: 1 } } }));
        await expect(insertRegionIfAbsent(region)).resolves.toBe(true);
        instance(jest.fn().mockRejectedValue(new Error("permission denied")));
        await expect(insertRegionIfAbsent(region)).rejects.toThrow();
    });
});
