import { Region } from "@/classes/mint/mint-types";
import {
    deriveRegionSource,
    MAX_INLINE_GEOMETRY_BYTES,
    RegionGeometryError,
    unionRegionGeometry
} from "./inputStepDerivation";

const square = (x: number, y: number) => ({
    type: "Polygon",
    coordinates: [
        [
            [x, y],
            [x + 1, y],
            [x + 1, y + 1],
            [x, y + 1],
            [x, y]
        ]
    ]
});

const region = (geometries: any[]): Region =>
    ({ id: "region-1", name: "r", category_id: "c", geometries }) as Region;

describe("inputStepDerivation", () => {
    test("unions Polygon and MultiPolygon geometries into one MultiPolygon", () => {
        const union = unionRegionGeometry(
            region([square(0, 0), { type: "MultiPolygon", coordinates: [square(5, 5).coordinates] }])
        );
        expect(union.geometry.type).toBe("MultiPolygon");
        expect(union.geometry.coordinates).toHaveLength(2);
        expect(union.vertices).toBe(10);
        expect(union.bbox).toEqual([0, 0, 6, 6]);
    });

    test("rejects non-polygon and empty regions", () => {
        expect(() =>
            unionRegionGeometry(region([{ type: "Point", coordinates: [0, 0] }]))
        ).toThrow(RegionGeometryError);
        expect(() => unionRegionGeometry(region([]))).toThrow(RegionGeometryError);
    });

    test("a small region is sent as geometry with its derivation recorded", () => {
        const { source, derivation } = deriveRegionSource(region([square(0, 0)]));
        expect(source.kind).toBe("geojson");
        expect(derivation).toMatchObject({
            method: "region_geometry",
            region_id: "region-1",
            vertices_in: 5
        });
        expect(derivation.bytes).toBeLessThanOrEqual(MAX_INLINE_GEOMETRY_BYTES);
    });

    test("a geometry over the byte budget falls back to the bounding box", () => {
        const ring = Array.from({ length: 3000 }, (_, i) => [
            Math.cos(i / 3000) * 0.5 + 100,
            Math.sin(i / 3000) * 0.5 + 30
        ]);
        ring.push(ring[0]);
        const { source, derivation } = deriveRegionSource(
            region([{ type: "Polygon", coordinates: [ring] }])
        );
        expect(source.kind).toBe("bbox");
        expect(derivation).toMatchObject({
            method: "region_bbox",
            region_id: "region-1",
            vertices_in: 3001
        });
        expect(derivation.bytes).toBeLessThan(MAX_INLINE_GEOMETRY_BYTES);
    });

    test("records the approximate bbox area and rejects regions over the cap", () => {
        const { derivation } = deriveRegionSource(region([square(0, 0)]));
        expect(derivation.area_km2).toBeGreaterThan(12000);
        expect(derivation.area_km2).toBeLessThan(12500);
        const big = { type: "Polygon", coordinates: [[[0, 0], [20, 0], [20, 20], [0, 20], [0, 0]]] };
        expect(() => deriveRegionSource(region([big]))).toThrow(
            expect.objectContaining({ statusCode: 422, code: "AOI_REGION_TOO_LARGE" })
        );
    });
});
