import { Readable } from "stream";
import request from "supertest";
import express from "express";
import executionsRouter from "../executions";
import executionsService from "@/api/api-v1/services/executionsService";
import executionFilesService from "@/api/api-v1/services/executionFilesService";
import {
    BadRequestError,
    HttpError,
    NotFoundError,
    UnauthorizedError
} from "@/classes/common/errors";

jest.mock("@/api/api-v1/services/executionsService");
jest.mock("@/api/api-v1/services/executionFilesService");
// The Keycloak adapter reads the configuration when it loads. It reaches this
// module through logsService, so the mock answers an object from the start.
jest.mock("@/classes/mint/mint-functions", () => ({
    getConfiguration: jest.fn().mockReturnValue({}),
    fetchMintConfig: jest.fn().mockResolvedValue({})
}));

const AUTH = "Bearer test-token";
const URL = "/executions/execution-1/files";

describe("GET /executions/:executionId/files", () => {
    let app: express.Application;

    beforeEach(() => {
        app = express();
        app.use(express.json());
        app.use("/executions", executionsRouter(executionsService));
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    it("answers 200 with the archived files", async () => {
        const results = [{ name: "output", url: "tapis://ls6/archive/output.nc", kind: "file" }];
        const files = [
            {
                name: "output.nc",
                path: "/work/01234/user/ls6/archive/output.nc",
                size: 2048,
                url: "tapis://ls6/archive/output.nc"
            }
        ];
        (executionFilesService.list as jest.Mock).mockResolvedValue({ files, results });

        const response = await request(app).get(URL).set("Authorization", AUTH).expect(200);

        expect(response.body).toEqual({ files, results });
    });

    it("answers 200 with an empty list when the archive holds no file", async () => {
        (executionFilesService.list as jest.Mock).mockResolvedValue({ files: [], results: [] });

        const response = await request(app).get(URL).set("Authorization", AUTH).expect(200);

        expect(response.body).toEqual({ files: [], results: [] });
    });

    it("forwards the execution id and the authorization header to the service", async () => {
        (executionFilesService.list as jest.Mock).mockResolvedValue({ files: [], results: [] });

        await request(app).get(URL).set("Authorization", AUTH).expect(200);

        expect(executionFilesService.list).toHaveBeenCalledWith("execution-1", AUTH);
    });

    it("answers 404 when the execution does not exist", async () => {
        (executionFilesService.list as jest.Mock).mockRejectedValue(
            new NotFoundError("Execution not found")
        );

        const response = await request(app).get(URL).set("Authorization", AUTH).expect(404);

        expect(response.body.message).toBe("Execution not found");
    });

    it("answers 401 when the authorization header is absent", async () => {
        (executionFilesService.list as jest.Mock).mockRejectedValue(
            new UnauthorizedError("Invalid authorization header")
        );

        await request(app).get(URL).expect(401);
    });

    it("answers 400 when the instance does not run Tapis", async () => {
        (executionFilesService.list as jest.Mock).mockRejectedValue(
            new BadRequestError("Only a Tapis execution archives files")
        );

        await request(app).get(URL).set("Authorization", AUTH).expect(400);
    });

    it("answers 500 when Tapis fails", async () => {
        (executionFilesService.list as jest.Mock).mockRejectedValue(new Error("Tapis is down"));

        const response = await request(app).get(URL).set("Authorization", AUTH).expect(500);

        expect(response.body).toEqual({ result: "error", message: "Tapis is down" });
    });
});

describe("GET /executions/:executionId/files/content", () => {
    let app: express.Application;
    const CONTENT_URL = "/executions/execution-1/files/content";

    beforeEach(() => {
        app = express();
        app.use(express.json());
        app.use("/executions", executionsRouter(executionsService));
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    it("streams the bytes with attachment headers and no caching", async () => {
        (executionFilesService.openFile as jest.Mock).mockResolvedValue({
            stream: Readable.from([Buffer.from("hello "), Buffer.from("world")]),
            contentType: "text/markdown",
            filename: "summary.md"
        });

        const response = await request(app)
            .get(CONTENT_URL)
            .query({ path: "home/u/out/summary.md", systemId: "cloud.data" })
            .set("Authorization", AUTH)
            .expect(200);

        expect(response.text).toBe("hello world");
        expect(response.headers["content-type"]).toContain("text/markdown");
        expect(response.headers["content-disposition"]).toContain(
            'attachment; filename="summary.md"'
        );
        expect(response.headers["cache-control"]).toBe("no-store");
        expect(executionFilesService.openFile).toHaveBeenCalledWith(
            "execution-1",
            AUTH,
            "home/u/out/summary.md",
            "cloud.data"
        );
    });

    it("answers a typed error body", async () => {
        (executionFilesService.openFile as jest.Mock).mockRejectedValue(
            new HttpError(404, "That file is not one of this run's results.", "FILE_NOT_IN_RESULTS")
        );

        const response = await request(app)
            .get(CONTENT_URL)
            .query({ path: "x/y" })
            .set("Authorization", AUTH)
            .expect(404);

        expect(response.body).toEqual({
            result: "error",
            message: "That file is not one of this run's results.",
            code: "FILE_NOT_IN_RESULTS"
        });
    });

    it("answers 500 with a generic message for an unexpected failure", async () => {
        (executionFilesService.openFile as jest.Mock).mockRejectedValue(
            new Error("secret test-token leaked")
        );

        const response = await request(app)
            .get(CONTENT_URL)
            .query({ path: "x/y" })
            .set("Authorization", AUTH)
            .expect(500);

        expect(JSON.stringify(response.body)).not.toContain("test-token");
    });
});
