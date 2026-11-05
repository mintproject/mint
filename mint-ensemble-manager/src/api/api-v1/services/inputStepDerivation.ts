import { Region } from "@/classes/mint/mint-types";

/** Largest region geometry sent inline in a plan; above it the bounding box is used. */
export const MAX_INLINE_GEOMETRY_BYTES = 32 * 1024;

/**
 * A source the bridge plans input steps from (POST /plans/model-inputs). The
 * adapter validates it and completes `derivation`; the EM only shapes the
 * thread region to fit the request-size budget.
 */
export type InputSource = (
    | { kind: "geojson"; geometry: { type: "MultiPolygon"; coordinates: number[][][][] } }
    | { kind: "bbox"; bbox: [number, number, number, number] }
) & {
    derivation: {
        method: "region_geometry" | "region_bbox";
        region_id: string;
        vertices_in: number;
        bytes: number;
    };
};

export class RegionGeometryError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "RegionGeometryError";
    }
}

type Polygon = number[][][];

function polygonsOf(geometry: any): Polygon[] {
    const candidate = geometry?.type === "Feature" ? geometry.geometry : geometry;
    if (candidate?.type === "Polygon" && Array.isArray(candidate.coordinates)) {
        return [candidate.coordinates];
    }
    if (candidate?.type === "MultiPolygon" && Array.isArray(candidate.coordinates)) {
        return candidate.coordinates;
    }
    throw new RegionGeometryError(
        `region geometry must be a Polygon or MultiPolygon, got ${candidate?.type ?? "none"}`
    );
}

/**
 * Join the region's geometries into one MultiPolygon. This is a concatenation,
 * not a topological union; overlapping parts stay as separate polygons (the AOI
 * piece only collects them into one MultiPolygon on its default path).
 */
export function unionRegionGeometry(region: Region): {
    geometry: { type: "MultiPolygon"; coordinates: Polygon[] };
    vertices: number;
    bbox: [number, number, number, number];
} {
    const polygons = (region.geometries || []).flatMap(polygonsOf);
    if (polygons.length === 0) {
        throw new RegionGeometryError(`region ${region.id} has no polygon geometry`);
    }
    let vertices = 0;
    let [minx, miny, maxx, maxy] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const rings of polygons) {
        for (const ring of rings) {
            for (const position of ring) {
                const [x, y] = position;
                if (!Number.isFinite(x) || !Number.isFinite(y)) {
                    throw new RegionGeometryError("region geometry has a non-numeric coordinate");
                }
                vertices += 1;
                minx = Math.min(minx, x);
                miny = Math.min(miny, y);
                maxx = Math.max(maxx, x);
                maxy = Math.max(maxy, y);
            }
        }
    }
    return {
        geometry: { type: "MultiPolygon", coordinates: polygons },
        vertices,
        bbox: [minx, miny, maxx, maxy]
    };
}

/**
 * The source for a thread region: its geometry, or its bounding box when the
 * serialized geometry exceeds the inline budget. Size and area limits are the
 * bridge's to enforce; this only keeps the request small.
 */
export function deriveRegionSource(region: Region): InputSource {
    const { geometry, vertices, bbox } = unionRegionGeometry(region);
    const geometryBytes = Buffer.byteLength(JSON.stringify(geometry), "utf8");
    if (geometryBytes <= MAX_INLINE_GEOMETRY_BYTES) {
        return {
            kind: "geojson",
            geometry,
            derivation: {
                method: "region_geometry",
                region_id: region.id,
                vertices_in: vertices,
                bytes: geometryBytes
            }
        };
    }
    const bboxShape = { kind: "bbox" as const, bbox };
    return {
        ...bboxShape,
        derivation: {
            method: "region_bbox",
            region_id: region.id,
            vertices_in: vertices,
            bytes: Buffer.byteLength(JSON.stringify(bboxShape), "utf8")
        }
    };
}
