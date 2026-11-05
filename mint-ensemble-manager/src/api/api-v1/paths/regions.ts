import { Router } from "express";
import { HttpError, UnifiedExecutionError } from "@/classes/common/errors";
import { RegionsService } from "@/api/api-v1/services/regionsService";

/**
 * @openapi
 * /regions:
 *   post:
 *     summary: Create or find a region from GeoJSON.
 *     description: >
 *       Stores a user-drawn area of interest. The region id is derived from the
 *       canonical geometry (coordinates rounded to six decimals, outer rings
 *       counter-clockwise, holes clockwise, rings starting at their smallest
 *       vertex, MultiPolygon parts sorted), so the same shape always returns the
 *       same `region_id` and `created` is false on a repeat.
 *     operationId: createRegion
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
 *               name:
 *                 type: string
 *               geojson:
 *                 type: object
 *                 additionalProperties: true
 *                 description: A GeoJSON Polygon or MultiPolygon in WGS84.
 *               category_id:
 *                 type: string
 *                 description: Defaults to `subsidence_aoi`.
 *               parent_region_id:
 *                 type: string
 *                 nullable: true
 *     responses:
 *       200:
 *         description: The region id and whether this call created it.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               additionalProperties: true
 *               properties:
 *                 region_id:
 *                   type: string
 *                 created:
 *                   type: boolean
 *       401:
 *         description: Missing or invalid bearer token.
 *       422:
 *         description: The geometry or request was rejected (code REGION_INVALID).
 *       default:
 *         description: Region creation failed.
 */
export default function (service: RegionsService) {
    const router = Router();

    router.post("/", async (req, res) => {
        try {
            const result = await service.createRegion(req.body, req.headers.authorization);
            return res.status(200).json(result);
        } catch (error) {
            if (error instanceof HttpError) {
                return res
                    .status(error.statusCode)
                    .json({ message: error.message, code: error.code });
            }
            if (error instanceof UnifiedExecutionError) {
                return res
                    .status(error.statusCode)
                    .json({ message: error.message, code: error.code, details: error.details });
            }
            const message = error instanceof Error ? error.message : String(error);
            return res.status(500).json({ message });
        }
    });

    return router;
}
