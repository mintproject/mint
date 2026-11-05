import { Region } from "@/classes/mint/mint-types";
import { UnifiedExecutionError } from "@/classes/common/errors";

/**
 * Catalog standard variable for "the polygon a model restricts its work to".
 * A model input typed with it gets an input-ETL step derived from the thread
 * region (see docs/design/2026-11-05-aoi-etl-piece.md).
 */
export const AOI_STANDARD_VARIABLE_URI = "https://w3id.org/okn/i/mint/area_of_interest__boundary";

/** Largest region geometry sent inline in a plan; above it the bounding box is used. */
export const MAX_INLINE_GEOMETRY_BYTES = 32 * 1024;

/**
 * Largest region (approximate bbox area, km2) accepted for an automatic area of
 * interest. Must match the SVO adapter AOI piece's `max_area_km2` default.
 */
export const MAX_AOI_AREA_KM2 = 160000;

export type InputStepSource =
    | { kind: "geojson"; geometry: { type: "MultiPolygon"; coordinates: number[][][][] } }
    | { kind: "bbox"; bbox: [number, number, number, number] };

export interface InputStepDerivation {
    method: "region_geometry" | "region_bbox";
    region_id: string;
    vertices_in: number;
    bytes: number;
    area_km2: number;
}

export interface InputStep {
    name: string;
    app_input_name: string;
    steps: unknown[];
    source: InputStepSource;
    params: Record<string, unknown>;
    derivation: InputStepDerivation;
}

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

/** Equirectangular bounding-box area in km2; adequate for a size cap. */
function approximateBboxAreaKm2(bbox: [number, number, number, number]): number {
    const [minx, miny, maxx, maxy] = bbox;
    const meanLat = ((miny + maxy) / 2) * (Math.PI / 180);
    return (maxx - minx) * Math.cos(meanLat) * 111.32 * ((maxy - miny) * 110.57);
}

/**
 * The AOI source for a thread region: its geometry, or its bounding box when
 * the serialized geometry exceeds the inline budget. `derivation` records which.
 */
export function deriveRegionSource(region: Region): {
    source: InputStepSource;
    derivation: InputStepDerivation;
} {
    const { geometry, vertices, bbox } = unionRegionGeometry(region);
    const areaKm2 = approximateBboxAreaKm2(bbox);
    if (areaKm2 > MAX_AOI_AREA_KM2) {
        throw new UnifiedExecutionError(
            422,
            `region too large for an automatic area of interest (${Math.round(areaKm2)} km² > ${MAX_AOI_AREA_KM2} km²); bind an AOI dataset or choose a smaller region`,
            "AOI_REGION_TOO_LARGE"
        );
    }
    const geometryBytes = Buffer.byteLength(JSON.stringify(geometry), "utf8");
    if (geometryBytes <= MAX_INLINE_GEOMETRY_BYTES) {
        return {
            source: { kind: "geojson", geometry },
            derivation: {
                method: "region_geometry",
                region_id: region.id,
                vertices_in: vertices,
                bytes: geometryBytes,
                area_km2: areaKm2
            }
        };
    }
    const source: InputStepSource = { kind: "bbox", bbox };
    return {
        source,
        derivation: {
            method: "region_bbox",
            region_id: region.id,
            vertices_in: vertices,
            bytes: Buffer.byteLength(JSON.stringify(source), "utf8"),
            area_km2: areaKm2
        }
    };
}
