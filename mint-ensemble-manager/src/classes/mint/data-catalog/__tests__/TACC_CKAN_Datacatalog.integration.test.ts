import { TACC_CKAN_DataCatalog } from "../TACC_CKAN_Datacatalog";
import { MintPreferences, Dataset } from "../../mint-types";

describe("TACC_CKAN_DataCatalog Integration Tests", () => {
    let dataCatalog: TACC_CKAN_DataCatalog;
    const testPreferences: MintPreferences = {
        data_catalog_api: "http://ckan.tacc.cloud:5000",
        data_catalog_key:
            "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJqdGkiOiJNS2RlNS1INXZQSWtfakJmYWU3Q2hJUDdUbUVibEJHU3BMcVExUkJMempCc0ZKdTY4U1QteDJrTko0TFV0TkV3MkE4bDg3R0xhd19PRktJYyIsImlhdCI6MTc1MTAzMjM5OH0.Z6c0iQZDYCwCOgTGUzBKYlR-4Br4fE4U3E1dJljlACE",
        ensemble_manager_api: "http://localhost:3000",
        ingestion_api: "http://localhost:3001",
        visualization_url: "http://localhost:3002",
        auth_server: "http://localhost:8080",
        auth_realm: "mint",
        auth_client_id: "mint-client"
    };
    let datasetId: string;

    beforeAll(() => {
        // Setup test preferences with the provided credentials
    });

    beforeEach(async () => {
        // Create fresh instance for each test
        dataCatalog = new TACC_CKAN_DataCatalog(testPreferences);

        // Add small delay to prevent overwhelming the server
        await new Promise((resolve) => setTimeout(resolve, 100));
    });

    describe("Connection Testing", () => {
        it("should successfully connect to CKAN server", async () => {
            const isConnected = await dataCatalog.testConnection();
            expect(isConnected).toBe(true);
        });

        it("should return correct catalog type", () => {
            const catalogType = dataCatalog.getCatalogType();
            expect(catalogType).toBe("TACC_CKAN");
        });
    });

    describe("Dataset Registration", () => {
        const testDataset: Dataset = {
            name: "test-dataset-integration",
            region: "test-region",
            variables: ["temperature", "precipitation"],
            time_period: {
                start_date: new Date("2020-01-01"),
                end_date: new Date("2020-12-31")
            },
            description: "Integration test dataset for TACC CKAN",
            version: "1.0.0",
            limitations: "Test data only",
            source: {
                name: "Test Source",
                url: "http://test.source.com",
                type: "CKAN"
            },
            is_cached: false,
            resource_count: 2,
            datatype: "climate",
            categories: ["climate", "test"],
            spatial_coverage: "Test Region"
        };

        it("should register a new dataset successfully", async () => {
            datasetId = await dataCatalog.registerDataset(testDataset, "test");
            expect(datasetId).toBeDefined();
        }, 30000); // Increased timeout for network operations
    });

    describe("Dataset Retrieval", () => {
        it("should retrieve a specific dataset by ID", async () => {
            const dataset = await dataCatalog.getDataset(datasetId);

            expect(dataset).toBeDefined();
            expect(dataset.id).toBe(datasetId);
            expect(dataset.name).toBe("test-dataset-integration");
            expect(dataset.description).toBe("Integration test dataset for TACC CKAN");
            expect(dataset.resources).toHaveLength(0);
        }, 30000);

        it("should handle non-existent dataset gracefully", async () => {
            await expect(dataCatalog.getDataset("non-existent-dataset")).rejects.toThrow();
        }, 30000);
    });

    describe("Resource Registration", () => {
        const testResources = [
            {
                id: "test-resource-1",
                name: "Temperature Data CSV",
                url: "tapis://ls6/test/temperature.csv",
                type: "CSV",
                time_period: {
                    start_date: new Date("2020-01-01"),
                    end_date: new Date("2020-12-31")
                },
                spatial_coverage: null,
                selected: true
            },
            {
                id: "test-resource-2",
                name: "Precipitation Data JSON",
                url: "https://example.com/precipitation-data.json",
                type: "JSON",
                time_period: {
                    start_date: new Date("2020-01-01"),
                    end_date: new Date("2020-12-31")
                },
                spatial_coverage: null,
                selected: true
            },
            {
                id: "test-resource-3",
                name: "Metadata XML",
                url: "https://example.com/metadata.xml",
                type: "XML",
                time_period: {
                    start_date: new Date("2020-01-01"),
                    end_date: new Date("2020-12-31")
                },
                spatial_coverage: null,
                selected: true
            }
        ];

        it("should register multiple resources to a dataset successfully", async () => {
            // Register resources to the existing dataset
            await dataCatalog.registerResources(datasetId, testResources);

            // Verify resources were registered by retrieving the dataset
            const updatedDataset = await dataCatalog.getDataset(datasetId);

            expect(updatedDataset.resources).toHaveLength(3);
            expect(updatedDataset.resource_count).toBe(3);

            // Verify each resource was registered correctly
            const resourceNames = updatedDataset.resources.map((r) => r.name);
            expect(resourceNames).toContain("Temperature Data CSV");
            expect(resourceNames).toContain("Precipitation Data JSON");
            expect(resourceNames).toContain("Metadata XML");

            // Verify resource URLs
            const resourceUrls = updatedDataset.resources.map((r) => r.url);
            expect(resourceUrls).toContain("https://example.com/temperature-data.csv");
            expect(resourceUrls).toContain("https://example.com/precipitation-data.json");
            expect(resourceUrls).toContain("https://example.com/metadata.xml");

            // Verify resource types
            const resourceTypes = updatedDataset.resources.map((r) => r.type);
            expect(resourceTypes).toContain("CSV");
            expect(resourceTypes).toContain("JSON");
            expect(resourceTypes).toContain("XML");
        }, 30000);

        it("should register a single resource successfully", async () => {
            const singleResource = [
                {
                    id: "single-test-resource",
                    name: "Single Test Resource",
                    url: "https://example.com/single-resource.txt",
                    type: "TXT",
                    time_period: {
                        start_date: new Date("2020-01-01"),
                        end_date: new Date("2020-12-31")
                    },
                    spatial_coverage: null,
                    selected: true
                }
            ];

            await dataCatalog.registerResources(datasetId, singleResource);

            // Verify the resource was registered
            const updatedDataset = await dataCatalog.getDataset(datasetId);
            const newResource = updatedDataset.resources.find(
                (r) => r.name === "Single Test Resource"
            );

            expect(newResource).toBeDefined();
            expect(newResource?.url).toBe("https://example.com/single-resource.txt");
            expect(newResource?.type).toBe("TXT");
        }, 30000);

        it("should handle resource registration with minimal required fields", async () => {
            const minimalResource = [
                {
                    id: "minimal-resource",
                    name: "Minimal Resource",
                    url: "https://example.com/minimal.txt",
                    selected: true
                }
            ];

            await dataCatalog.registerResources(datasetId, minimalResource);

            // Verify the resource was registered
            const updatedDataset = await dataCatalog.getDataset(datasetId);
            const newResource = updatedDataset.resources.find((r) => r.name === "Minimal Resource");

            expect(newResource).toBeDefined();
            expect(newResource?.url).toBe("https://example.com/minimal.txt");
        }, 30000);

        it("should handle resource registration to non-existent dataset", async () => {
            const testResource = [
                {
                    id: "test-resource",
                    name: "Test Resource",
                    url: "https://example.com/test.txt",
                    selected: true
                }
            ];

            await expect(
                dataCatalog.registerResources("non-existent-dataset", testResource)
            ).rejects.toThrow();
        }, 30000);

        it("should retrieve individual resource by ID", async () => {
            // First register a resource
            const testResource = [
                {
                    id: "individual-test-resource",
                    name: "Individual Test Resource",
                    url: "https://example.com/individual-resource.csv",
                    type: "CSV",
                    selected: true
                }
            ];

            await dataCatalog.registerResources(datasetId, testResource);

            // Get the dataset to find the resource ID
            const dataset = await dataCatalog.getDataset(datasetId);
            const resource = dataset.resources.find((r) => r.name === "Individual Test Resource");

            expect(resource).toBeDefined();
            expect(resource?.id).toBeDefined();

            // Retrieve the individual resource by ID
            const retrievedResource = await dataCatalog.getResource(resource!.id);

            expect(retrievedResource).toBeDefined();
            expect(retrievedResource.id).toBe(resource!.id);
            expect(retrievedResource.name).toBe("Individual Test Resource");
            expect(retrievedResource.url).toBe("https://example.com/individual-resource.csv");
            expect(retrievedResource.type).toBe("CSV");
            expect(retrievedResource.selected).toBe(true);
        }, 30000);

        it("should handle retrieving non-existent resource", async () => {
            await expect(dataCatalog.getResource("non-existent-resource-id")).rejects.toThrow();
        }, 30000);
    });

    //     it("should transform CKAN dataset with temporal coverage", async () => {
    //         // This test verifies the transformation logic works correctly
    //         const dataset = await dataCatalog.getDataset("test-dataset-integration");

    //         expect(dataset.time_period).toBeDefined();
    //         expect(dataset.spatial_coverage).toBeDefined();
    //         expect(dataset.categories).toBeDefined();
    //         expect(Array.isArray(dataset.categories)).toBe(true);
    //         expect(dataset.resources).toBeDefined();
    //         expect(Array.isArray(dataset.resources)).toBe(true);
    //     }, 30000);
    // });

    describe("Error Handling", () => {
        it("should handle network errors gracefully", async () => {
            const invalidPreferences: MintPreferences = {
                ...testPreferences,
                data_catalog_api: "http://invalid-url-that-does-not-exist.com"
            };

            const invalidCatalog = new TACC_CKAN_DataCatalog(invalidPreferences);

            await expect(invalidCatalog.testConnection()).rejects.toThrow();
        }, 30000);

        // it("should handle invalid API key", async () => {
        //     const invalidKeyPreferences: MintPreferences = {
        //         ...testPreferences,
        //         data_catalog_key: "invalid-key"
        //     };

        //     const invalidKeyCatalog = new TACC_CKAN_DataCatalog(invalidKeyPreferences);

        //     // This should fail but not throw an unhandled error
        //     await expect(invalidKeyCatalog.testConnection()).rejects.toThrow();
        // }, 30000);
    });

    describe("Cleanup", () => {
        it("should clean up test data", async () => {
            // Note: In a real integration test, you might want to clean up
            // the test datasets that were created. However, this would require
            // additional methods in the data catalog interface for deletion.
            // For now, we'll just verify the tests completed successfully.
            await dataCatalog.deleteDataset("test-dataset-integration");
        });
    });
});
