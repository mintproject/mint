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
 *             properties:
 *               input_etl:
 *                 type: boolean
 *                 description: >
 *                   Tapis plans automatically ask the SVO adapter to plan input-side
 *                   ETL for model inputs bound to a Tapis file input (the catalog's
 *                   app_input_name), using the thread region as the source. Set to
 *                   false to opt out; true forces the composite path. Ignored for
 *                   non-Tapis engines unless true (which is rejected).
 *               strict_inputs:
 *                 type: boolean
 *                 description: >
 *                   When true, any input warning (see `input_warnings` in the
 *                   response) fails plan creation with 422 INPUT_WARNINGS.
 *               publish:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: >
 *                   Catalog tokens (for example `ckan`, `stac`) the run's model
 *                   output is published to after the model finishes. The tokens
 *                   must be offered by GET /plans/publishers for the model, else
 *                   422 PUBLISH_CATALOG_UNKNOWN (details list `requested` and
 *                   `available`). The post-model target contract gets
 *                   `catalog` set to the tokens joined with `+`, and the plan's
 *                   `parameters` list the publisher's arguments. Needs a
 *                   post-model stage (422 PUBLISH_REQUIRES_POST_MODEL
 *                   otherwise). Publication runs as the submitting user; the
 *                   outcome is `output_handoff.publication` on the run (status
 *                   `published`, `failed` or `awaiting_owner`) and a failed
 *                   publication does not fail the run.
 *     responses:
 *       200:
 *         description: >
 *           Unified plan created. When the bridge planned input ETL, the plan
 *           carries `input_steps` (a preview of the planned steps), `input_sources`
 *           and `filled_app_inputs` (as previewed; submit re-derives both from the
 *           thread so a changed region is refused), and `steps_digest` (the
 *           bridge rejects a submit whose steps differ with 409 INPUT_PLAN_CHANGED).
 *           `input_warnings` lists inputs that could not be planned: registry
 *           missing, unbound model inputs, optional inputs with no transform path,
 *           optional app inputs that match no model input. 422 codes include
 *           NO_INPUT_TRANSFORM_PATH (a required input has no path), INPUT_WARNINGS,
 *           AOI_REGION_UNAVAILABLE and AOI_REGION_GEOMETRY_INVALID; the adapter
 *           also returns its own 422s for oversized regions. 502
 *           ADAPTER_CAPABILITY_MISSING means the adapter lacks
 *           POST /plans/model-inputs.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               additionalProperties: true
 *               properties:
 *                 input_steps:
 *                   type: array
 *                   items:
 *                     type: object
 *                     additionalProperties: true
 *                 input_sources:
 *                   type: array
 *                   items:
 *                     type: object
 *                     additionalProperties: true
 *                 filled_app_inputs:
 *                   type: array
 *                   items:
 *                     type: string
 *                 steps_digest:
 *                   type: string
 *                 input_warnings:
 *                   type: array
 *                   items:
 *                     type: string
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
 * /plans/publishers:
 *   get:
 *     summary: List the catalogs a model's output can be published to.
 *     description: Proxies the SVO adapter's GET /publishers for the model configuration.
 *     operationId: listUnifiedPlanPublishers
 *     security:
 *       - BearerAuth: []
 *       - oauth2: []
 *     parameters:
 *       - in: query
 *         name: model_id
 *         required: true
 *         schema:
 *           type: string
 *         description: The model configuration id (the plan's model_id).
 *     responses:
 *       200:
 *         description: >
 *           Publishers reachable from the model output, each with its
 *           `transform_spec_id`, `name`, `catalog_tokens`, user-facing
 *           `parameters` and `can_publish` (`ok`, `reason`).
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               additionalProperties: true
 *       400:
 *         description: model_id is missing.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/UnifiedExecutionError'
 *       default:
 *         description: The adapter could not list publishers.
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

    router.get("/publishers", async (req, res) => {
        try {
            const result = await service.listPublishers(
                req.query.model_id,
                req.headers.authorization
            );
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

    /**
     * @openapi
     * /plans/runs/{runId}/cancel:
     *   post:
     *     summary: Cancel a unified execution's adapter workflow and model job.
     *     description: The SVO adapter terminates the Tapis Workflows run as the calling user, who must be the submitter or a configured cancel admin.
     *     operationId: cancelUnifiedRun
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
     *         description: Unified execution state after cancellation.
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               additionalProperties: true
     *       403:
     *         description: Caller may not cancel this run.
     *         content:
     *           application/json:
     *             schema:
     *               $ref: '#/components/schemas/UnifiedExecutionError'
     *       409:
     *         description: Nothing active to cancel.
     *         content:
     *           application/json:
     *             schema:
     *               $ref: '#/components/schemas/UnifiedExecutionError'
     *       default:
     *         description: Cancellation failed or was only partly applied.
     *         content:
     *           application/json:
     *             schema:
     *               $ref: '#/components/schemas/UnifiedExecutionError'
     */
    router.post("/runs/:runId/cancel", async (req, res) => {
        try {
            const result = await service.cancelRun(req.params.runId, req.headers.authorization);
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
