import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import regionsRouter from "@/api/api-v1/paths/regions";
import regionsService, { canonicalizeGeometry } from "./regionsService";
import { insertRegionIfAbsent } from "@/classes/graphql/graphql_functions";

jest.mock("@/classes/mint/mint-functions", () => ({
    getConfiguration: jest.fn().mockReturnValue({
        auth: { public_key: "test-key", algorithms: ["HS256"] }
    })
}));
jest.mock("@/classes/graphql/graphql_functions", () => ({ insertRegionIfAbsent: jest.fn() }));
jest.mock("@/classes/graphql/graphql_functions_v2", () => ({ checkRegionExistsById: jest.fn() }));

const bearer = `Bearer ${jwt.sign({ "tapis/username": "alice" }, "test-key", { algorithm: "HS256" })}`;

// Counter-clockwise square with a clockwise hole.
const square = [
    [0, 0],
    [4, 0],
    [4, 4],
    [0, 4],
    [0, 0]
];
const hole = [
    [1, 1],
    [1, 2],
    [2, 2],
    [2, 1],
    [1, 1]
];

describe("canonicalizeGeometry", () => {
    const base = canonicalizeGeometry({ type: "Polygon", coordinates: [square, hole] });

    it("gives the same id however the ring is rotated", () => {
        const rotated = [square[2], square[3], square[0], square[1], square[2]];
        const other = canonicalizeGeometry({ type: "Polygon", coordinates: [rotated, hole] });
        expect(other.id).toBe(base.id);
    });

    it("gives the same id for either winding order", () => {
        const reversedOuter = [...square].reverse();
        const reversedHole = [...hole].reverse();
        const other = canonicalizeGeometry({
            type: "Polygon",
            coordinates: [reversedOuter, reversedHole]
        });
        expect(other.id).toBe(base.id);
    });

    it("rounds coordinates to six decimals", () => {
        const noisy = square.map(([x, y]) => [x + 0.00000012, y - 0.00000012]);
        const other = canonicalizeGeometry({ type: "Polygon", coordinates: [noisy, hole] });
        expect(other.id).toBe(base.id);
    });

    it("treats a repeated closing vertex like an absent one and stores a closed ring", () => {
        const stored = base.geometry.coordinates as number[][][];
        expect(stored[0][0]).toEqual(stored[0][stored[0].length - 1]);
        expect(stored[0]).toHaveLength(5);
        expect(stored[0][0]).toEqual([0, 0]);
    });

    it("orients outer rings counter-clockwise and holes clockwise", () => {
        const [outer, inner] = base.geometry.coordinates as number[][][];
        const area = (ring: number[][]) =>
            ring.slice(0, -1).reduce((sum, [x1, y1], i, all) => {
                const [x2, y2] = all[(i + 1) % all.length];
                return sum + (x1 * y2 - x2 * y1);
            }, 0);
        expect(area(outer)).toBeGreaterThan(0);
        expect(area(inner)).toBeLessThan(0);
    });

    it("sorts MultiPolygon parts", () => {
        const far = square.map(([x, y]) => [x + 10, y]);
        const a = canonicalizeGeometry({ type: "MultiPolygon", coordinates: [[square], [far]] });
        const b = canonicalizeGeometry({ type: "MultiPolygon", coordinates: [[far], [square]] });
        expect(a.id).toBe(b.id);
        expect(a.geometry.type).toBe("MultiPolygon");
    });

    it.each([
        ["a Point", { type: "Point", coordinates: [0, 0] }],
        [
            "an open ring",
            {
                type: "Polygon",
                coordinates: [
                    [
                        [0, 0],
                        [1, 0],
                        [1, 1],
                        [0, 1]
                    ]
                ]
            }
        ],
        [
            "out-of-range coordinates",
            {
                type: "Polygon",
                coordinates: [
                    [
                        [0, 0],
                        [200, 0],
                        [200, 1],
                        [0, 0]
                    ]
                ]
            }
        ],
        [
            "a ring with too few positions",
            {
                type: "Polygon",
                coordinates: [
                    [
                        [0, 0],
                        [1, 1],
                        [0, 0]
                    ]
                ]
            }
        ],
        [
            "a zero-area ring",
            {
                type: "Polygon",
                coordinates: [
                    [
                        [0, 0],
                        [1, 1],
                        [2, 2],
                        [0, 0]
                    ]
                ]
            }
        ],
        ["a non-object", "not geojson"]
    ])("rejects %s as REGION_INVALID", (_label, geojson) => {
        expect(() => canonicalizeGeometry(geojson)).toThrow(
            expect.objectContaining({ statusCode: 422, code: "REGION_INVALID" })
        );
    });

    it("rejects more vertices than the cap", () => {
        process.env.REGION_MAX_VERTICES = "4";
        try {
            expect(() => canonicalizeGeometry({ type: "Polygon", coordinates: [square] })).toThrow(
                expect.objectContaining({ code: "REGION_INVALID" })
            );
        } finally {
            delete process.env.REGION_MAX_VERTICES;
        }
    });

    it("rejects a geometry over the byte cap", () => {
        process.env.REGION_MAX_BYTES = "50";
        try {
            expect(() => canonicalizeGeometry({ type: "Polygon", coordinates: [square] })).toThrow(
                expect.objectContaining({ code: "REGION_INVALID" })
            );
        } finally {
            delete process.env.REGION_MAX_BYTES;
        }
    });
});

describe("regionsService.createRegion and POST /regions", () => {
    const insert = insertRegionIfAbsent as jest.Mock;
    const app = express().use(express.json()).use("/regions", regionsRouter(regionsService));

    beforeEach(() => insert.mockReset());

    it("stores one row for the same shape twice and reports created only the first time", async () => {
        const rows = new Map<string, any>();
        insert.mockImplementation(async (object) => {
            if (rows.has(object.id)) return false;
            rows.set(object.id, object);
            return true;
        });
        const body = { name: "Waco", geojson: { type: "Polygon", coordinates: [square] } };
        const first = await request(app).post("/regions").set("Authorization", bearer).send(body);
        const redrawn = {
            name: "Waco again",
            geojson: {
                type: "Polygon",
                coordinates: [[square[2], square[3], square[0], square[1], square[2]]]
            }
        };
        const second = await request(app)
            .post("/regions")
            .set("Authorization", bearer)
            .send(redrawn);

        expect(first.status).toBe(200);
        expect(first.body.created).toBe(true);
        expect(first.body.region_id).toMatch(/^aoi-[0-9a-f]{16}$/);
        expect(second.body).toEqual({ region_id: first.body.region_id, created: false });
        expect(rows.size).toBe(1);
    });

    it("inserts the region with its geometry, default category and no parent", async () => {
        insert.mockResolvedValue(true);
        await request(app)
            .post("/regions")
            .set("Authorization", bearer)
            .send({ name: "Waco", geojson: { type: "Polygon", coordinates: [square] } });
        const object = insert.mock.calls[0][0];
        expect(object.category_id).toBe("subsidence_aoi");
        expect(object.parent_region_id).toBeNull();
        expect(object.geometries.data).toHaveLength(1);
        expect(JSON.parse(object.geometries.data[0].geometry).type).toBe("Polygon");
    });

    it("passes an optional parent and category through", async () => {
        insert.mockResolvedValue(true);
        await request(app)
            .post("/regions")
            .set("Authorization", bearer)
            .send({
                name: "Waco",
                category_id: "custom",
                parent_region_id: "texas",
                geojson: { type: "Polygon", coordinates: [square] }
            });
        expect(insert.mock.calls[0][0]).toMatchObject({
            category_id: "custom",
            parent_region_id: "texas"
        });
    });

    it("answers 422 REGION_INVALID for a bad geometry and writes nothing", async () => {
        const response = await request(app)
            .post("/regions")
            .set("Authorization", bearer)
            .send({ name: "Bad", geojson: { type: "Point", coordinates: [0, 0] } });
        expect(response.status).toBe(422);
        expect(response.body.code).toBe("REGION_INVALID");
        expect(insert).not.toHaveBeenCalled();
    });

    it("requires a valid bearer token", async () => {
        const none = await request(app)
            .post("/regions")
            .send({ name: "x", geojson: { type: "Polygon", coordinates: [square] } });
        const forged = await request(app)
            .post("/regions")
            .set("Authorization", "Bearer not-a-token")
            .send({ name: "x", geojson: { type: "Polygon", coordinates: [square] } });
        expect(none.status).toBe(401);
        expect(forged.status).toBe(401);
        expect(insert).not.toHaveBeenCalled();
    });
});
