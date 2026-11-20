import { getThread } from "@/classes/graphql/graphql_functions_v2";
import { adapterRequest, createUnifiedExecutionService } from "./unifiedExecutionService";
import { UnifiedExecutionStore } from "./unifiedExecutionStore";

jest.mock("@/classes/graphql/graphql_functions_v2", () => ({ getThread: jest.fn() }));
jest.mock("@/classes/mint/mint-functions", () => ({
    getConfiguration: jest.fn().mockReturnValue({
        execution_engine: "tapis",
        svo_adapter_api: "http://adapter.local",
        svo_adapter_internal_secret: "service-only",
        unified_plan_secret: "test-secret"
    })
}));

type Service = ReturnType<typeof createUnifiedExecutionService>;

const BEARER = "Bearer user-token";
const EM_HEADER = "X-Ensemble-Manager-Secret";
const USER_HEADER = "X-Front-Door-Secret";

const legacy = {
    local: { submitExecution: jest.fn() },
    wings: { submitExecution: jest.fn() },
    tapis: { submitExecution: jest.fn() }
};

function headersOf(call: unknown[]): Record<string, string> {
    return (call[1] as { headers: Record<string, string> }).headers;
}

describe("which secret header a call to the adapter sends", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        delete process.env.SVO_ADAPTER_INTERNAL_SERVICE_SECRET;
        global.fetch = jest.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({ id: "x", plan_json: {}, publishers: [] })
        }) as unknown as typeof fetch;
    });

    function lastHeaders(): Record<string, string> {
        const calls = (global.fetch as jest.Mock).mock.calls;
        return headersOf(calls[calls.length - 1]);
    }

    it("sends the Ensemble Manager's own header by default, and the user header for a user's call", async () => {
        await adapterRequest("/workflows/submit", { method: "POST", body: {} }, BEARER);
        expect(lastHeaders()[EM_HEADER]).toBe("service-only");
        expect(lastHeaders()).not.toHaveProperty(USER_HEADER);

        await adapterRequest("/plans", { method: "POST", body: {}, asUser: true }, BEARER);
        expect(lastHeaders()[USER_HEADER]).toBe("service-only");
        expect(lastHeaders()).not.toHaveProperty(EM_HEADER);
        expect(lastHeaders().Authorization).toBe(BEARER);
    });

    it.each([
        ["getPlan (svo_)", (s: Service) => s.getPlan("svo_p1", BEARER)],
        ["getRun (an adapter run id)", (s: Service) => s.getRun("run-1", BEARER)],
        ["cancelRun (an adapter run id)", (s: Service) => s.cancelRun("run-1", BEARER)],
        ["listPublishers", (s: Service) => s.listPublishers("model-1", BEARER)],
        [
            "createPlan (data object and plan)",
            (s: Service) =>
                s.createPlan(
                    {
                        executor: "svo_adapter",
                        adapter_request: {
                            data_object: { label: "x", resource_uri: "y" },
                            target_contract: {}
                        }
                    },
                    BEARER
                )
        ]
    ])(
        "acts for the user on %s: user header, never the Ensemble Manager's",
        async (_name, call) => {
            const service = createUnifiedExecutionService(legacy as never);
            await call(service).catch(() => undefined);
            const sent = (global.fetch as jest.Mock).mock.calls;
            expect(sent.length).toBeGreaterThan(0);
            for (const request of sent) {
                expect(headersOf(request)[USER_HEADER]).toBe("service-only");
                expect(headersOf(request)).not.toHaveProperty(EM_HEADER);
            }
        }
    );

    it("sends no secret header at all when none is configured", async () => {
        const mint = jest.requireMock("@/classes/mint/mint-functions");
        const configured = mint.getConfiguration();
        mint.getConfiguration.mockReturnValue({
            svo_adapter_api: "http://adapter.local",
            unified_plan_secret: "test-secret"
        });
        try {
            await adapterRequest("/plans", { method: "POST", body: {}, asUser: true }, BEARER);
            const headers = lastHeaders();
            expect(headers).not.toHaveProperty(USER_HEADER);
            expect(headers).not.toHaveProperty(EM_HEADER);
        } finally {
            mint.getConfiguration.mockReturnValue(configured);
        }
    });
});

describe("a unified run is shown only to someone who can read its thread", () => {
    const store = (): UnifiedExecutionStore =>
        ({
            getById: jest.fn().mockResolvedValue({
                id: "parent-1",
                thread_id: "thread-9",
                plan_id: "not-decoded-before-the-check"
            })
        }) as unknown as UnifiedExecutionStore;

    beforeEach(() => {
        jest.clearAllMocks();
        global.fetch = jest.fn() as unknown as typeof fetch;
    });

    const reads = [
        ["getRun", (s: Service, auth?: string) => s.getRun("ue_parent-1", auth)],
        ["cancelRun", (s: Service, auth?: string) => s.cancelRun("ue_parent-1", auth)],
        ["resumeRun", (s: Service, auth?: string) => s.resumeRun("ue_parent-1", {}, auth)]
    ] as const;

    it.each(reads)(
        "%s: a thread the caller cannot read looks like a missing run",
        async (_n, call) => {
            (getThread as jest.Mock).mockResolvedValue(null);
            const service = createUnifiedExecutionService(legacy as never, { store: store() });
            await expect(call(service, BEARER)).rejects.toMatchObject({
                statusCode: 404,
                code: "RUN_NOT_FOUND"
            });
            expect(getThread).toHaveBeenCalledWith("thread-9", "user-token");
            expect(global.fetch).not.toHaveBeenCalled();
        }
    );

    it.each(reads)("%s: a Hasura refusal is the same as a missing run", async (_n, call) => {
        (getThread as jest.Mock).mockRejectedValue(new Error("permission denied"));
        const service = createUnifiedExecutionService(legacy as never, { store: store() });
        await expect(call(service, BEARER)).rejects.toMatchObject({ statusCode: 404 });
        expect(global.fetch).not.toHaveBeenCalled();
    });

    it.each(reads)("%s: no token is a 401 and Hasura is not asked", async (_n, call) => {
        const service = createUnifiedExecutionService(legacy as never, { store: store() });
        await expect(call(service, undefined)).rejects.toMatchObject({ statusCode: 401 });
        expect(getThread).not.toHaveBeenCalled();
        expect(global.fetch).not.toHaveBeenCalled();
    });
});
