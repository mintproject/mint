import { Router, type Response } from "express";
import { UnifiedExecutionError } from "@/classes/common/errors";
import type { AdapterFrontService } from "@/api/api-v1/services/adapterFrontService";

function sendError(res: Response, error: unknown) {
    if (error instanceof UnifiedExecutionError) {
        return res.status(error.statusCode).json({
            message: error.message,
            code: error.code,
            details: error.details
        });
    }
    // Never echo the request: the secret routes carry credential values.
    console.error("Adapter front route failed:", error instanceof Error ? error.message : "error");
    return res.status(502).json({ message: "The SVO adapter request failed" });
}

/**
 * @openapi
 * /spatial/layers:
 *   get:
 *     summary: Known backend spatial sources for ETL and map selection.
 *     description: >
 *       Served by the SVO adapter, which is not called by the browser. A public
 *       reference list; no token is needed.
 *     operationId: listSpatialLayers
 *     responses:
 *       200:
 *         description: The layers.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               additionalProperties: true
 *               properties:
 *                 layers:
 *                   type: array
 *                   items:
 *                     type: object
 *                     additionalProperties: true
 *       default:
 *         description: The adapter is not configured or could not be reached.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/UnifiedExecutionError'
 */
export function spatialRouter(service: AdapterFrontService) {
    const router = Router();

    router.get("/layers", async (req, res) => {
        try {
            const result = await service.spatialLayers(req.headers.authorization);
            return res.status(200).json(result);
        } catch (error) {
            return sendError(res, error);
        }
    });

    return router;
}

/**
 * @openapi
 * /secrets:
 *   get:
 *     summary: List the caller's own secrets.
 *     description: >
 *       Names, field names and dates. Never values. The SVO adapter checks the
 *       token and returns only the caller's own secrets.
 *     operationId: listUserSecrets
 *     security:
 *       - BearerAuth: []
 *       - oauth2: []
 *     responses:
 *       200:
 *         description: The caller's secrets.
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 additionalProperties: true
 *       default:
 *         description: Refused, or the adapter could not be reached.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/UnifiedExecutionError'
 * /secrets/{name}:
 *   put:
 *     summary: Store or replace one of the caller's own secrets.
 *     description: >
 *       Returns names and dates, never values. Refused with 409 while the caller
 *       has a run in progress.
 *     operationId: putUserSecret
 *     security:
 *       - BearerAuth: []
 *       - oauth2: []
 *     parameters:
 *       - in: path
 *         name: name
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             additionalProperties: true
 *             properties:
 *               fields:
 *                 type: object
 *                 additionalProperties:
 *                   type: string
 *     responses:
 *       200:
 *         description: The stored secret's name, field names and dates.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               additionalProperties: true
 *       default:
 *         description: Refused, or the adapter could not be reached.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/UnifiedExecutionError'
 *   delete:
 *     summary: Delete one of the caller's own secrets.
 *     operationId: deleteUserSecret
 *     security:
 *       - BearerAuth: []
 *       - oauth2: []
 *     parameters:
 *       - in: path
 *         name: name
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: The deleted secret's name, field names and dates.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               additionalProperties: true
 *       default:
 *         description: Refused (404 when there is none by that name), or the adapter could not be reached.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/UnifiedExecutionError'
 */
export function secretsRouter(service: AdapterFrontService) {
    const router = Router();
    // A response that names someone's secrets is never cached.
    router.use((_req, res, next) => {
        res.set("Cache-Control", "no-store");
        next();
    });

    router.get("/", async (req, res) => {
        try {
            return res.status(200).json(await service.listSecrets(req.headers.authorization));
        } catch (error) {
            return sendError(res, error);
        }
    });

    router.put("/:name", async (req, res) => {
        try {
            const result = await service.putSecret(
                req.params.name,
                req.body,
                req.headers.authorization
            );
            return res.status(200).json(result);
        } catch (error) {
            return sendError(res, error);
        }
    });

    router.delete("/:name", async (req, res) => {
        try {
            const result = await service.deleteSecret(req.params.name, req.headers.authorization);
            return res.status(200).json(result);
        } catch (error) {
            return sendError(res, error);
        }
    });

    return router;
}
