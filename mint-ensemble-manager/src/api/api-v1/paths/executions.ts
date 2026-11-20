// ./api/api-v1/paths/executions.ts

import { Router } from "express";
import executionsService from "@/api/api-v1/services/executionsService";
import logsService from "../services/logsService";
import executionFilesService from "../services/executionFilesService";
import { HttpError } from "@/classes/common/errors";

export default function (service: typeof executionsService) {
    const router = Router();

    /**
     * @swagger
     * /executions:
     *   post:
     *     summary: Submit modeling thread for execution.
     *     operationId: submitExecution
     *     security:
     *       - BearerAuth: []
     *       - oauth2: []
     *     requestBody:
     *       description: Modeling thread scenario/subgoal/id
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             $ref: '#/components/schemas/ModelThread'
     *     responses:
     *       202:
     *         description: Successful response
     *       default:
     *         description: An error occurred
     */
    router.post("/", async (req, res) => {
        try {
            const result = await service.submitExecution(req.body);
            if (result.result === "error") {
                res.status(406).json(result);
            } else {
                res.status(202).json(result);
            }
        } catch (error) {
            res.status(500).json({ result: "error", message: error.message });
        }
    });

    /**
     * @swagger
     * /executions/{executionId}/logs:
     *   get:
     *     summary: Get Execution Logs
     *     description: Get the logs of an execution.
     *     tags: [Executions]
     *     security:
     *       - BearerAuth: []
     *       - oauth2: []
     *     parameters:
     *       - in: path
     *         name: executionId
     *         required: true
     *         schema:
     *           type: string
     *         example: "9bc5bbfb-d76c-4d0b-87cc-f89e945a062e-007"
     *     responses:
     *       200:
     *         description: Execution Logs
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 result:
     *                   type: string
     *                   example: "success"
     *                 message:
     *                   type: string
     *                   description: "The log content or success message"
     *                   example: "Execution logs fetched successfully"
     *       default:
     *         description: Default error response
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 result:
     *                   type: string
     *                   example: "error"
     *                 message:
     *                   type: string
     *                   example: "Internal server error"
     */
    router.get("/:executionId/logs", async (req, res) => {
        try {
            const log = await logsService.fetchLog(
                req.params.executionId,
                req.headers.authorization
            );
            res.status(200).send(log);
        } catch (error) {
            if (error instanceof HttpError) {
                res.status(error.statusCode).json({ result: "error", message: error.message });
            } else {
                res.status(500).json({ result: "error", message: error.message });
            }
        }
    });

    /**
     * @swagger
     * /executions/{executionId}/files:
     *   get:
     *     summary: List the files that an execution archived
     *     description: >
     *       Lists the files in the Tapis archive of an execution. MINT does not
     *       store these files. The endpoint reads them live, and it forwards the
     *       token of the user. A file that matches no declared output is a raw
     *       artifact. The user promotes it to an output before MINT publishes it.
     *     operationId: listExecutionFiles
     *     tags: [Executions]
     *     security:
     *       - BearerAuth: []
     *       - oauth2: []
     *     parameters:
     *       - in: path
     *         name: executionId
     *         required: true
     *         schema:
     *           type: string
     *         example: "9bc5bbfb-d76c-4d0b-87cc-f89e945a062e-007"
     *     responses:
     *       200:
     *         description: >
     *           The archived files. The list is empty when the execution
     *           archived nothing.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 files:
     *                   type: array
     *                   items:
     *                     $ref: '#/components/schemas/ExecutionFile'
     *                 results:
     *                   type: array
     *                   description: >
     *                     The results of the execution that point at Tapis
     *                     storage, each marked as a file or a folder by Tapis.
     *                   items:
     *                     $ref: '#/components/schemas/ExecutionResultLocation'
     *               required: [files, results]
     *       400:
     *         description: The instance does not run Tapis
     *         content:
     *           application/json:
     *             schema:
     *               $ref: '#/components/schemas/ExecutionFilesError'
     *       401:
     *         description: The authorization header is absent or is not correct
     *         content:
     *           application/json:
     *             schema:
     *               $ref: '#/components/schemas/ExecutionFilesError'
     *       404:
     *         description: The execution does not exist
     *         content:
     *           application/json:
     *             schema:
     *               $ref: '#/components/schemas/ExecutionFilesError'
     *       default:
     *         description: Default error response
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 result:
     *                   type: string
     *                   example: "error"
     *                 message:
     *                   type: string
     *                   example: "Internal server error"
     */
    router.get("/:executionId/files", async (req, res) => {
        try {
            const { files, results } = await executionFilesService.list(
                req.params.executionId,
                req.headers.authorization
            );
            res.status(200).json({ files, results });
        } catch (error) {
            if (error instanceof HttpError) {
                res.status(error.statusCode).json({ result: "error", message: error.message });
            } else {
                res.status(500).json({ result: "error", message: error.message });
            }
        }
    });

    /**
     * @swagger
     * /executions/{executionId}/files/content:
     *   get:
     *     summary: Download one file of an execution's results
     *     description: >
     *       Streams one file from Tapis storage, with the token of the user. The
     *       file must be a result file of the execution, lie inside a result
     *       folder, or sit in the folder that the file listing shows for a file
     *       result. Tapis decides whether the user may read the file.
     *     operationId: downloadExecutionFile
     *     tags: [Executions]
     *     security:
     *       - BearerAuth: []
     *       - oauth2: []
     *     parameters:
     *       - in: path
     *         name: executionId
     *         required: true
     *         schema:
     *           type: string
     *       - in: query
     *         name: path
     *         required: true
     *         description: The path of the file, as the file listing shows it
     *         schema:
     *           type: string
     *       - in: query
     *         name: systemId
     *         required: false
     *         description: >
     *           The Tapis system of the file. It may be absent when all results
     *           of the execution are on one system.
     *         schema:
     *           type: string
     *     responses:
     *       200:
     *         description: The bytes of the file
     *         content:
     *           application/octet-stream:
     *             schema:
     *               type: string
     *               format: binary
     *       400:
     *         description: The path or the system is not valid (FILE_PATH_INVALID)
     *         content:
     *           application/json:
     *             schema:
     *               $ref: '#/components/schemas/ExecutionFilesError'
     *       401:
     *         description: The authorization header is absent or is not correct
     *         content:
     *           application/json:
     *             schema:
     *               $ref: '#/components/schemas/ExecutionFilesError'
     *       403:
     *         description: Tapis refuses the user this file
     *         content:
     *           application/json:
     *             schema:
     *               $ref: '#/components/schemas/ExecutionFilesError'
     *       404:
     *         description: >
     *           The execution does not exist, the file is not one of its results
     *           (FILE_NOT_IN_RESULTS), or Tapis has no such file
     *         content:
     *           application/json:
     *             schema:
     *               $ref: '#/components/schemas/ExecutionFilesError'
     *       502:
     *         description: Tapis storage failed or could not be reached
     *         content:
     *           application/json:
     *             schema:
     *               $ref: '#/components/schemas/ExecutionFilesError'
     */
    router.get("/:executionId/files/content", async (req, res) => {
        try {
            const query = req.query as Record<string, unknown>;
            const file = await executionFilesService.openFile(
                req.params.executionId,
                req.headers.authorization,
                query.path as string,
                typeof query.systemId === "string" ? query.systemId : undefined
            );
            res.status(200);
            res.setHeader("Content-Type", file.contentType || "application/octet-stream");
            res.setHeader(
                "Content-Disposition",
                `attachment; filename="${file.filename}"; filename*=UTF-8''${encodeURIComponent(file.filename)}`
            );
            res.setHeader("Cache-Control", "no-store");
            res.on("close", () => file.stream.destroy());
            file.stream.on("error", () => res.destroy());
            file.stream.pipe(res);
        } catch (error) {
            if (error instanceof HttpError) {
                res.status(error.statusCode).json({
                    result: "error",
                    message: error.message,
                    ...(error.code ? { code: error.code } : {})
                });
            } else {
                res.status(500).json({ result: "error", message: "Could not read the file." });
            }
        }
    });

    return router;
}
