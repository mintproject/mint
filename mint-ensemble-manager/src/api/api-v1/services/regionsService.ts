import { createHash } from "crypto";
import { UnprocessableEntityError } from "@/classes/common/errors";
import { insertRegionIfAbsent } from "@/classes/graphql/graphql_functions";
import { checkRegionExistsById } from "@/classes/graphql/graphql_functions_v2";
import { getTokenFromAuthorizationHeader, usernameFromToken } from "@/utils/authUtils";

/**
 * User-drawn areas of interest. A region's id is a hash of its canonical
 * geometry, so drawing the same shape twice yields the same region and the
 * insert needs no lookup (see canonicalizeGeometry).
 *
 * The validation follows model-catalog-api/src/region-import.ts (geometry
 * type, WGS84 bounds, closed rings, size caps) narrowed to Polygon and
 * MultiPolygon. It is not shared code: the two services do not import each
 * other. Unlike a curated import there is no curator gate; these are user AOIs.
 */

export const DEFAULT_CATEGORY_ID = "subsidence_aoi";
const DEFAULT_MAX_VERTICES = 10000;
const DEFAULT_MAX_BYTES = 1024 * 1024;
const MAX_NAME_LENGTH = 200;
const DEFAULT_MAX_SPAN_DEGREES = 25;
const COORDINATE_DECIMALS = 1e6;

type Position = [number, number];
type Ring = Position[];
type Polygon = Ring[];

export interface CreateRegionRequest {
    name: string;
    /** A Polygon or MultiPolygon, or a Feature/FeatureCollection holding them. */
    geojson: unknown;
}

export interface CreateRegionResult {
    region_id: string;
    created: boolean;
}

export interface CanonicalRegion {
    id: string;
    /** GeoJSON geometry: rings closed again, Polygon for one part else MultiPolygon. */
    geometry: { type: "Polygon" | "MultiPolygon"; coordinates: unknown };
}

const invalid = (message: string) => new UnprocessableEntityError(message, "REGION_INVALID");

const envNumber = (name: string, fallback: number): number => {
    const value = Number(process.env[name]);
    return Number.isFinite(value) && value > 0 ? value : fallback;
};

const isFiniteNumber = (value: unknown): value is number =>
    typeof value === "number" && Number.isFinite(value);

const round6 = (value: number): number =>
    Math.round(value * COORDINATE_DECIMALS) / COORDINATE_DECIMALS + 0;

const parsePosition = (value: unknown): Position => {
    if (
        !Array.isArray(value) ||
        (value.length !== 2 && value.length !== 3) ||
        !value.every(isFiniteNumber)
    ) {
        throw invalid("Coordinates must be [longitude, latitude] numbers");
    }
    const [lon, lat] = value as number[];
    if (lon < -180 || lon > 180 || lat < -90 || lat > 90) {
        throw invalid("Coordinates must be WGS84 longitude (-180..180) and latitude (-90..90)");
    }
    return [round6(lon), round6(lat)];
};

/** A GeoJSON ring: at least 4 positions, closed. Returns it without the closing vertex. */
const parseRing = (value: unknown): Ring => {
    if (!Array.isArray(value) || value.length < 4) {
        throw invalid("A ring needs at least four positions");
    }
    const first = value[0];
    const last = value[value.length - 1];
    if (
        !Array.isArray(first) ||
        !Array.isArray(last) ||
        first[0] !== last[0] ||
        first[1] !== last[1]
    ) {
        throw invalid("A ring must be closed (first and last position equal)");
    }
    const ring: Ring = [];
    for (const position of value.slice(0, -1)) {
        const point = parsePosition(position);
        const previous = ring[ring.length - 1];
        // Rounding can merge neighbours; a repeated vertex adds nothing.
        if (!previous || previous[0] !== point[0] || previous[1] !== point[1]) ring.push(point);
    }
    if (ring.length >= 2) {
        const head = ring[0];
        const tail = ring[ring.length - 1];
        if (head[0] === tail[0] && head[1] === tail[1]) ring.pop();
    }
    if (ring.length < 3) throw invalid("A ring needs at least three distinct positions");
    return ring;
};

/** Twice the signed area; positive for counter-clockwise rings. */
const signedArea = (ring: Ring): number => {
    let sum = 0;
    for (let i = 0; i < ring.length; i++) {
        const [x1, y1] = ring[i];
        const [x2, y2] = ring[(i + 1) % ring.length];
        sum += x1 * y2 - x2 * y1;
    }
    return sum;
};

const byJson = (a: unknown, b: unknown): number => {
    const left = JSON.stringify(a);
    const right = JSON.stringify(b);
    return left < right ? -1 : left > right ? 1 : 0;
};

const comparePositions = (a: Position, b: Position): number => a[0] - b[0] || a[1] - b[1];

const canonicalRing = (ring: Ring, counterClockwise: boolean): Ring => {
    const area = signedArea(ring);
    if (area === 0) throw invalid("A ring must enclose an area");
    const oriented = area > 0 === counterClockwise ? ring : [...ring].reverse();
    let start = 0;
    for (let i = 1; i < oriented.length; i++) {
        if (comparePositions(oriented[i], oriented[start]) < 0) start = i;
    }
    return [...oriented.slice(start), ...oriented.slice(0, start)];
};

const canonicalPolygon = (rings: unknown): Polygon => {
    if (!Array.isArray(rings) || rings.length === 0) {
        throw invalid("A polygon needs at least one ring");
    }
    const [outer, ...holes] = rings.map(parseRing);
    return [
        canonicalRing(outer, true),
        ...holes.map((hole) => canonicalRing(hole, false)).sort(byJson)
    ];
};

const closeRing = (ring: Ring): Ring => [...ring, ring[0]];

/**
 * The polygon parts of a geometry, Feature or FeatureCollection, as a single
 * Polygon or MultiPolygon geometry. Features that are not polygons are
 * ignored; no polygon at all is invalid. Parts are collected, not merged.
 */
const polygonGeometryOf = (geojson: unknown): unknown => {
    const parts: unknown[] = [];
    const collect = (node: any, depth = 0) => {
        if (!node || typeof node !== "object" || depth > 4) return;
        if (node.type === "FeatureCollection" && Array.isArray(node.features)) {
            node.features.forEach((feature: unknown) => collect(feature, depth + 1));
        } else if (node.type === "Feature") {
            collect(node.geometry, depth + 1);
        } else if (node.type === "Polygon" && Array.isArray(node.coordinates)) {
            parts.push(node.coordinates);
        } else if (node.type === "MultiPolygon" && Array.isArray(node.coordinates)) {
            parts.push(...node.coordinates);
        }
    };
    const type = (geojson as { type?: unknown } | null)?.type;
    if (type === "Polygon" || type === "MultiPolygon") return geojson;
    if (type !== "Feature" && type !== "FeatureCollection") {
        throw invalid("geojson must be a Polygon, MultiPolygon, Feature or FeatureCollection");
    }
    collect(geojson);
    if (parts.length === 0) throw invalid("geojson contains no Polygon or MultiPolygon");
    return parts.length === 1
        ? { type: "Polygon", coordinates: parts[0] }
        : { type: "MultiPolygon", coordinates: parts };
};

/**
 * Validate a GeoJSON Polygon or MultiPolygon and reduce it to its canonical
 * form: coordinates rounded to six decimals, outer rings counter-clockwise and
 * holes clockwise, each ring starting at its smallest vertex, no closing
 * vertex, MultiPolygon parts sorted. The id hashes that form.
 */
export const canonicalizeGeometry = (geojson: unknown): CanonicalRegion => {
    if (!geojson || typeof geojson !== "object" || Array.isArray(geojson)) {
        throw invalid("geojson must be a GeoJSON geometry object");
    }
    const maxBytes = envNumber("REGION_MAX_BYTES", DEFAULT_MAX_BYTES);
    if (Buffer.byteLength(JSON.stringify(geojson), "utf8") > maxBytes) {
        throw invalid(`geojson exceeds the ${maxBytes} byte limit`);
    }
    const geometry = polygonGeometryOf(geojson) as { type?: unknown; coordinates?: unknown };
    let parts: unknown[];
    if (geometry.type === "Polygon") {
        parts = [geometry.coordinates];
    } else if (geometry.type === "MultiPolygon") {
        if (!Array.isArray(geometry.coordinates) || geometry.coordinates.length === 0) {
            throw invalid("A MultiPolygon needs at least one polygon");
        }
        parts = geometry.coordinates;
    } else {
        throw invalid("geojson must be a Polygon or MultiPolygon");
    }
    const maxVertices = envNumber("REGION_MAX_VERTICES", DEFAULT_MAX_VERTICES);
    const countVertices = (poly: unknown): number =>
        Array.isArray(poly)
            ? poly.reduce((sum, ring) => sum + (Array.isArray(ring) ? ring.length : 0), 0)
            : 0;
    if (parts.reduce<number>((sum, poly) => sum + countVertices(poly), 0) > maxVertices) {
        throw invalid(`geojson exceeds the ${maxVertices} vertex limit`);
    }

    const polygons = parts.map(canonicalPolygon).sort(byJson);
    const maxSpan = envNumber("REGION_MAX_SPAN_DEGREES", DEFAULT_MAX_SPAN_DEGREES);
    const positions = polygons.flat(2);
    const lons = positions.map(([lon]) => lon);
    const lats = positions.map(([, lat]) => lat);
    if (
        Math.max(...lons) - Math.min(...lons) > maxSpan ||
        Math.max(...lats) - Math.min(...lats) > maxSpan
    ) {
        throw invalid(`region too large (more than ${maxSpan} degrees across)`);
    }
    const hash = createHash("sha256").update(JSON.stringify(polygons)).digest("hex");
    const closed = polygons.map((polygon) => polygon.map(closeRing));
    return {
        id: `aoi-${hash.slice(0, 16)}`,
        geometry:
            closed.length === 1
                ? { type: "Polygon", coordinates: closed[0] }
                : { type: "MultiPolygon", coordinates: closed }
    };
};

// Control characters are removed rather than rejected: a pasted name should not fail.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/g;

const validateName = (body: any): string => {
    const name =
        typeof body?.name === "string" ? body.name.replace(CONTROL_CHARACTERS, "").trim() : "";
    if (!name || name.length > MAX_NAME_LENGTH) {
        throw invalid(`name is required (at most ${MAX_NAME_LENGTH} characters)`);
    }
    return name;
};

export interface RegionsService {
    createRegion(
        body: CreateRegionRequest,
        authorizationHeader?: string
    ): Promise<CreateRegionResult>;
    regionExists(regionId: string, authorizationHeader?: string): Promise<boolean>;
}

const regionsService: RegionsService = {
    async createRegion(body, authorizationHeader) {
        usernameFromToken(getTokenFromAuthorizationHeader(authorizationHeader));
        const name = validateName(body);
        const { id, geometry } = canonicalizeGeometry(body?.geojson);
        // The row is written with service credentials, so the caller does not
        // choose its category or parent: category_id and parent_region_id in
        // the request are ignored.
        const created = await insertRegionIfAbsent({
            id,
            name,
            category_id: DEFAULT_CATEGORY_ID,
            parent_region_id: null,
            // region-import stores each geometry as a JSON string.
            geometries: { data: [{ geometry: JSON.stringify(geometry) }] }
        });
        return { region_id: id, created };
    },

    async regionExists(regionId, authorizationHeader) {
        return checkRegionExistsById(
            regionId,
            getTokenFromAuthorizationHeader(authorizationHeader)
        );
    }
};

export default regionsService;
