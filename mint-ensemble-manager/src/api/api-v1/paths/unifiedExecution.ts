import { Router } from "express";
import { UnifiedExecutionError } from "@/api/api-v1/services/unifiedExecutionService";

/**
 * @openapi
 * /plans:
 *   post:
 *     summary: Create a unified Ensemble Manager or SVO adapter plan.
 *     operationId: createUnifiedPlan
 *     security:
 *       - BearerAuth: []
 *       - oauth2: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             additionalProperties: true
 *     responses:
 *       200:
 *         description: Unified plan created.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               additionalProperties: true
 *       400:
 *         description: Invalid plan request.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/UnifiedExecutionError'
 *       default:
 *         description: Plan creation failed.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/UnifiedExecutionError'
 */

/**
 * @openapi
 * /plans/{planId}:
 *   get:
 *     summary: Retrieve a unified plan.
 *     operationId: getUnifiedPlan
 *     security:
 *       - BearerAuth: []
 *       - oauth2: []
 *     parameters:
 *       - in: path
 *         name: planId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Unified plan.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               additionalProperties: true
 *       404:
 *         description: Plan not found.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/UnifiedExecutionError'
 *       default:
 *         description: Plan lookup failed.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/UnifiedExecutionError'
 */

/**
 * @openapi
 * /plans/runs/{runId}:
 *   get:
 *     summary: Retrieve and reconcile a unified execution.
 *     operationId: getUnifiedRun
 *     security:
 *       - BearerAuth: []
 *       - oauth2: []
 *     parameters:
 *       - in: path
 *         name: runId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Unified execution state.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               additionalProperties: true
 *       404:
 *         description: Run not found.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/UnifiedExecutionError'
 *       default:
 *         description: Run lookup failed.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/UnifiedExecutionError'
 */

/**
 * @openapi
 * /plans/submit:
 *   post:
 *     summary: Submit a unified plan for execution.
 *     operationId: submitUnifiedPlan
 *     security:
 *       - BearerAuth: []
 *       - oauth2: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - plan_id
 *             properties:
 *               plan_id:
 *                 type: string
 *               parameter_values:
 *                 type: object
 *                 additionalProperties: true
 *               max_minutes:
 *                 type: integer
 *                 minimum: 1
 *                 description: Maximum model batch-job wall time in minutes. Defaults to 60.
 *               queue:
 *                 type: string
 *                 description: Tapis logical queue for the model batch job (for example `development`). Defaults to the model app's own queue.
 *               adapter_parameter_values:
 *                 type: object
 *                 additionalProperties: true
 *             additionalProperties: true
 *     responses:
 *       202:
 *         description: Unified execution accepted.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               additionalProperties: true
 *       400:
 *         description: Invalid execution request.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/UnifiedExecutionError'
 *       422:
 *         description: Adapter parameters were rejected.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/UnifiedExecutionError'
 *       default:
 *         description: Execution submission failed.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/UnifiedExecutionError'
 */

function sendError(res: any, error: unknown) {
    if (error instanceof UnifiedExecutionError) {
        return res.status(error.statusCode).json({
            message: error.message,
            code: error.code,
            details: error.details
        });
    }
    const message = error instanceof Error ? error.message : String(error);
    return res.status(500).json({ message });
}

/**
 * Public plan/submit boundary for both ordinary Ensemble Manager runs and
 * SVO-adapter-backed runs. The adapter URL and credentials stay server-side.
 */
export default function (service: any) {
    const router = Router();

    router.post("/", async (req, res) => {
        try {
            const result = await service.createPlan(req.body, req.headers.authorization);
            return res.status(200).json(result);
        } catch (error) {
            return sendError(res, error);
        }
    });

    router.get("/runs/:runId", async (req, res) => {
        try {
            const result = await service.getRun(req.params.runId, req.headers.authorization);
            return res.status(200).json(result);
        } catch (error) {
            return sendError(res, error);
        }
    });

    router.get("/:planId", async (req, res) => {
        try {
            const result = await service.getPlan(req.params.planId, req.headers.authorization);
            return res.status(200).json(result);
        } catch (error) {
            return sendError(res, error);
        }
    });

    router.post("/submit", async (req, res) => {
        try {
            const result = await service.submit(req.body, req.headers.authorization);
            return res.status(202).json(result);
        } catch (error) {
            return sendError(res, error);
        }
    });

    return router;
}
