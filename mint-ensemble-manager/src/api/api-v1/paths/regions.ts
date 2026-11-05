import { Router } from "express";
import { HttpError } from "@/classes/common/errors";
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
 *                 description: >
 *                   A GeoJSON Polygon or MultiPolygon in WGS84, or a Feature or
 *                   FeatureCollection holding them (non-polygon features are ignored).
 *                   At most 25 degrees across. The region is always stored in category
 *                   `subsidence_aoi` with no parent; any `category_id` or
 *                   `parent_region_id` in the body is ignored.
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
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/UnifiedExecutionError'
 *       422:
 *         description: The geometry or request was rejected (code REGION_INVALID).
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/UnifiedExecutionError'
 *       default:
 *         description: Region creation failed.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/UnifiedExecutionError'
 */
export default function (service: RegionsService) {
    const router = Router();

    router.post("/", async (req, res) => {
        try {
            const result = await service.createRegion(req.body, req.headers.authorization);
            return res.status(200).json(result);
        } catch (error) {
            // Messages are passed through only for the 4xx errors the service
            // raises itself; anything else is logged and reported generically.
            if (error instanceof HttpError && error.statusCode < 500) {
                return res
                    .status(error.statusCode)
                    .json({ message: error.message, code: error.code });
            }
            console.error("Region creation failed:", error);
            return res
                .status(500)
                .json({ message: "The region could not be saved", code: "REGION_WRITE_FAILED" });
        }
    });

    return router;
}
