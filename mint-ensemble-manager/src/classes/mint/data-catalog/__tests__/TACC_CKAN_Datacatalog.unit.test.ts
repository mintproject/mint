import { MintPreferences } from "../../mint-types";
import { TACC_CKAN_DataCatalog } from "../TACC_CKAN_Datacatalog";

const preferences = {
    data_catalog_api: "",
    data_catalog_key: ""
} as MintPreferences;

describe("TACC_CKAN_DataCatalog temporal coverage", () => {
    it("reads dataset-level temporal start and end fields", () => {
        const catalog = new TACC_CKAN_DataCatalog(preferences) as any;
        const dataset = catalog.transformCKANPackage({
            id: "dataset-id",
            name: "dataset",
            title: "Dataset",
            temporal_coverage_start: "1980-01-01",
            temporal_coverage_end: "2012-12-31",
            resources: []
        });

        expect(dataset.time_period.start_date).toEqual(new Date("1980-01-01"));
        expect(dataset.time_period.end_date).toEqual(new Date("2012-12-31"));
    });

    it("keeps reading the legacy temporal coverage extra", () => {
        const catalog = new TACC_CKAN_DataCatalog(preferences) as any;
        const dataset = catalog.transformCKANPackage({
            id: "dataset-id",
            name: "dataset",
            title: "Dataset",
            extras: [
                {
                    key: "temporal_coverage",
                    value: JSON.stringify({
                        start_time: "1980-01-01T00:00:00",
                        end_time: "2012-12-31T00:00:00"
                    })
                }
            ],
            resources: []
        });

        expect(dataset.time_period.start_date).toEqual(new Date("1980-01-01T00:00:00"));
        expect(dataset.time_period.end_date).toEqual(new Date("2012-12-31T00:00:00"));
    });

    it("reads canonical dataset spatial coverage before the legacy extra", () => {
        const catalog = new TACC_CKAN_DataCatalog(preferences) as any;
        const spatial = JSON.stringify({
            type: "Polygon",
            coordinates: [
                [
                    [0, 0],
                    [1, 0],
                    [1, 1],
                    [0, 0]
                ]
            ]
        });
        const dataset = catalog.transformCKANPackage({
            id: "dataset-id",
            name: "dataset",
            title: "Dataset",
            spatial,
            extras: [{ key: "spatial", value: "legacy" }],
            resources: []
        });

        expect(dataset.spatial_coverage).toBe(spatial);
    });
});
