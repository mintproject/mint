import { TapisExecutionService } from "@/classes/tapis/adapters/TapisExecutionService";

jest.mock("@/classes/mint/mint-functions", () => ({
    getConfiguration: jest.fn().mockReturnValue({})
}));

jest.mock("@/classes/graphql/graphql_functions", () => ({
    getExecution: jest.fn(),
    getModelOutputsByModelId: jest.fn(),
    incrementThreadModelSuccessfulRuns: jest.fn(),
    incrementThreadModelFailedRuns: jest.fn(),
    updateExecutionStatus: jest.fn(),
    updateExecutionStatusAndResultsv2: jest.fn(),
    getThreadModelByThreadIdExecutionId: jest.fn(),
    updateExecutionRunId: jest.fn(),
    decrementThreadModelSubmittedRuns: jest.fn(),
    handleFailedConnectionEnsemble: jest.fn()
}));

const SYSTEM = "cloud.data";

const respond = (init: { status: number; body?: string; headers?: Record<string, string> }) => {
    const fetchMock = jest
        .fn()
        .mockResolvedValue(
            new Response(init.body ?? "", { status: init.status, headers: init.headers })
        );
    global.fetch = fetchMock as unknown as typeof fetch;
    return fetchMock;
};

const readAll = async (stream: NodeJS.ReadableStream) => {
    let text = "";
    for await (const chunk of stream) text += chunk.toString();
    return text;
};

describe("TapisExecutionService.openArchiveFile", () => {
    const service = () => new TapisExecutionService("secret-token", "http://tapis.test/");
    const originalFetch = global.fetch;

    afterEach(() => {
        global.fetch = originalFetch;
    });

    it("streams the file from the Tapis content endpoint with the caller's token", async () => {
        const fetchMock = respond({
            status: 200,
            body: "hello",
            headers: { "content-type": "text/plain" }
        });

        const { stream, contentType } = await service().openArchiveFile(SYSTEM, "home/u/a b.txt");

        expect(fetchMock).toHaveBeenCalledWith(
            "http://tapis.test/v3/files/content/cloud.data/home/u/a%20b.txt",
            { headers: { "X-Tapis-Token": "secret-token" }, redirect: "manual" }
        );
        expect(contentType).toContain("text/plain");
        expect(await readAll(stream)).toBe("hello");
    });

    it.each([
        [401, 403, "Your account cannot read this file in Tapis storage."],
        [403, 403, "Your account cannot read this file in Tapis storage."],
        [404, 404, "Tapis storage has no such file."]
    ])("maps a Tapis %i to %i", async (tapis, ours, message) => {
        respond({ status: tapis, body: "raw tapis body secret-token" });

        await expect(service().openArchiveFile(SYSTEM, "a/b")).rejects.toMatchObject({
            statusCode: ours,
            message
        });
    });

    it("maps a Tapis 500 and a redirect to 502 without the body or the token", async () => {
        for (const status of [500, 302]) {
            respond({
                status,
                body: "raw tapis body secret-token",
                headers: { location: "http://evil" }
            });
            const error: { statusCode?: number; message?: string } = await service()
                .openArchiveFile(SYSTEM, "a/b")
                .catch((e) => e);
            expect(error.statusCode).toBe(502);
            expect(error.message).not.toContain("secret-token");
            expect(error.message).not.toContain("raw tapis body");
        }
    });

    it("maps a network failure to 502 without the cause", async () => {
        global.fetch = jest
            .fn()
            .mockRejectedValue(new Error("connect secret-token")) as unknown as typeof fetch;

        const error: { statusCode?: number; message?: string } = await service()
            .openArchiveFile(SYSTEM, "a/b")
            .catch((e) => e);

        expect(error.statusCode).toBe(502);
        expect(error.message).not.toContain("secret-token");
    });
});
