import axios, { AxiosResponse } from "axios";
import { DataResource, Dataset, MintPreferences } from "./mint-types";

const REGISTER_DATA: string = "/datasets/register_datasets";
const FIND_STDVARS: string = "/knowledge_graph/find_standard_variables";
const REGISTER_STDVARS: string = "/knowledge_graph/register_standard_variables";
const REGISTER_DSVARS: string = "/datasets/register_variables";
const REGISTER_RESOURCES: string = "/datasets/register_resources";
const RESOURCE_CHUNK_SIZE: number = 500;
const SYNC_DSMETA: string = "/datasets/sync_dataset_metadata";
const PROVENANCE_URL: string = "/provenance/register_provenance";

/** A spatial coverage as a dataset keeps it: a point, a bounding box or a polygon. */
interface SpatialCover {
    type: string;
    value?: {
        x?: unknown;
        y?: unknown;
        xmin?: unknown;
        xmax?: unknown;
        ymin?: unknown;
        ymax?: unknown;
    };
    coordinates?: unknown[];
}

/** A standard variable of the internal data catalog. */
interface StandardVariable {
    id?: string;
    name: string;
    record_id?: string;
}

/** A variable of a dataset, as it is registered with its standard variables. */
interface DatasetVariable {
    name: string;
    metadata: Record<string, never>;
    standard_variable_ids: string[];
    dataset_id?: string;
}

/** What the internal data catalog answers to the requests made here. */
interface CatalogResponse {
    result?: string;
    datasets?: Array<{ record_id: string }>;
    standard_variables?: StandardVariable[];
    variables?: unknown;
}

export const registerInternalDataset = async (
    dataset: Dataset,
    prefs: MintPreferences
): Promise<boolean> => {
    //console.log(dataset);

    const provid = prefs.data_catalog_extra.owner_provenance_id;
    await createProvenanceId(provid, prefs);

    let dsid: string | null = null;
    if (dataset.id) {
        dsid = dataset.id;
    } else {
        //console.log('Registering dataset');
        dsid = await createDataset(dataset, prefs);

        //console.log('Registering Variables');
        if (dataset.variables) {
            const dsvars = await createStandardVariables(dataset.variables, prefs);
            await createDatasetVariables(dsid, dsvars, prefs);
        }
    }

    //console.log('Registering Resources');
    const resources = dataset.resources;
    if (resources && resources.length > 0) {
        await createResources(dsid, dataset, resources, prefs);
    }
    syncDatasetMetadata(dsid, prefs);

    return true;
};

function convertSpatialCoverage(cover: SpatialCover) {
    const covertype: string = cover.type.toLowerCase();
    if (covertype === "point") {
        return {
            type: "Point",
            value: {
                x: parseFloat(String(cover.value?.x || cover.coordinates[0] || 0)),
                y: parseFloat(String(cover.value?.y || cover.coordinates[1] || 0))
            }
        };
    } else if (covertype === "boundingbox") {
        return {
            type: "BoundingBox",
            value: {
                xmin: parseFloat(String(cover.value?.xmin || cover.coordinates[0] || 0)),
                xmax: parseFloat(String(cover.value?.xmax || cover.coordinates[2] || 0)),
                ymin: parseFloat(String(cover.value?.ymin || cover.coordinates[1] || 0)),
                ymax: parseFloat(String(cover.value?.ymax || cover.coordinates[3] || 0))
            }
        };
    } else if (covertype === "polygon") {
        return cover;
    }
}

async function createDataset(dataset: Dataset, prefs: MintPreferences): Promise<string | null> {
    const dcat = prefs.data_catalog_api;
    const provid = prefs.data_catalog_extra.owner_provenance_id;
    const payload = {
        datasets: [
            {
                provenance_id: provid,
                name: dataset.name,
                description: dataset.description || dataset.name,
                metadata: {
                    spatial_coverage: convertSpatialCoverage(
                        JSON.parse(dataset.spatial_coverage || "{}")
                    ),
                    temporal_coverage: {
                        start_time: (dataset.time_period?.start_date || "0000-01-01") + "T00:00:00",
                        end_time: (dataset.time_period?.end_date || "9999-01-01") + "T00:00:00"
                    }
                }
            }
        ]
    };
    const result = await submitRequest(dcat + REGISTER_DATA, payload);
    if (result && result["datasets"].length > 0) {
        return result["datasets"][0]["record_id"];
    }
    return null;
}

async function createStandardVariables(
    variables: string[],
    prefs: MintPreferences
): Promise<DatasetVariable[]> {
    const dcat = prefs.data_catalog_api;
    const provid = prefs.data_catalog_extra.owner_provenance_id;

    if (!variables || variables.length === 0) {
        return [];
    }

    const stdvars = variables.map((dsvar: string) => {
        return {
            name: dsvar,
            ontology: "mint",
            uri: "http://mint.isi.edu/ontology/" + dsvar
        };
    }); //variablesDetails.flatMap((dsvar: any) => dsvar['standard_variables']);
    const names = variables; //stdvars.map((v: any) => v['name']);

    const findExistingJson = {
        name__in: names
    };
    const findResult = await submitRequest(dcat + FIND_STDVARS, findExistingJson);

    const curStdVars: { [key: string]: StandardVariable } = {};
    if (findResult && findResult["standard_variables"].length > 0) {
        findResult["standard_variables"].forEach((stdvar) => {
            curStdVars[stdvar["name"]] = stdvar;
        });
    }

    const newStdVars = stdvars.filter((stdvar) => !(stdvar["name"] in curStdVars));
    if (newStdVars.length > 0) {
        const registerJson = {
            standard_variables: newStdVars,
            provenance_id: provid
        };
        const registerResult = await submitRequest(dcat + REGISTER_STDVARS, registerJson);
        if (registerResult && registerResult["standard_variables"].length > 0) {
            registerResult["standard_variables"].forEach((stdvar) => {
                stdvar["id"] = stdvar["record_id"];
                curStdVars[stdvar["name"]] = stdvar;
            });
        }
    }

    const newDsVars = variables.map((dsvar) => {
        const newDsVar: DatasetVariable = {
            name: "ds_" + dsvar,
            metadata: {},
            standard_variable_ids: [curStdVars[dsvar]?.["id"]]
        };
        return newDsVar;
    });

    return newDsVars;
}

async function createDatasetVariables(
    datasetId: string,
    datasetVariables: DatasetVariable[],
    prefs: MintPreferences
): Promise<unknown> {
    const dcat = prefs.data_catalog_api;

    if (datasetId && datasetVariables && datasetVariables.length > 0) {
        datasetVariables.forEach((dsvar) => {
            dsvar["dataset_id"] = datasetId;
        });
        const response = await submitRequest(dcat + REGISTER_DSVARS, {
            variables: datasetVariables
        });
        return response ? response["variables"] : {};
    }
    return {};
}

async function createProvenanceId(provenanceId: string, prefs: MintPreferences): Promise<void> {
    const dcat = prefs.data_catalog_api;

    const provenanceDefinition = {
        provenance: {
            provenance_type: "user",
            record_id: provenanceId,
            name: "test_api_outside",
            metadata: {
                contact_information: {
                    email: "email@example.com"
                }
            }
        }
    };

    try {
        const response = await axios.post(dcat + PROVENANCE_URL, provenanceDefinition);
        response.data; // If needed, handle the response data
    } catch (error) {
        const failure = error as { response?: { data: unknown }; message?: string };
        if (failure.response) {
            // The server responded with a status code outside the 2xx range
            console.error("Error data:", failure.response.data);
        } else {
            // An error occurred in setting up the request
            console.error("Error:", failure.message);
        }
        throw error; // Re-throwing the error for the caller to handle
    }
}

async function createResources(
    datasetId: string,
    dataset: Dataset,
    resources: DataResource[],
    prefs: MintPreferences
): Promise<void> {
    const dcat = prefs.data_catalog_api;
    const provid = prefs.data_catalog_extra.owner_provenance_id;

    if (datasetId && resources && resources.length > 0) {
        const resourceChunks = divideChunks(resources, RESOURCE_CHUNK_SIZE);
        for (const chunk of resourceChunks) {
            //console.log(`Registering resource chunk ${chunkId}`);
            const chunkList = chunk.map((res) => {
                return {
                    provenance_id: provid,
                    dataset_id: datasetId,
                    resource_type: "file",
                    data_url: res["url"],
                    name: res["name"],
                    metadata: {
                        spatial_coverage: convertSpatialCoverage(
                            JSON.parse(dataset.spatial_coverage || "{}")
                        ),
                        temporal_coverage: {
                            start_time:
                                (dataset.time_period?.start_date || "1970-01-01") + "T00:00:00",
                            end_time: (dataset.time_period?.end_date || "2100-01-01") + "T00:00:00"
                        }
                    }
                };
            });
            await submitRequest(dcat + REGISTER_RESOURCES, {
                resources: chunkList
            });
        }
    }
}

async function syncDatasetMetadata(dsid: string, prefs: MintPreferences): Promise<void> {
    const dcat = prefs.data_catalog_api;
    const payload = {
        dataset_id: dsid,
        provenance_id: prefs.data_catalog_extra.owner_provenance_id
    };
    await submitRequest(dcat + SYNC_DSMETA, payload, true);
}

function* divideChunks<T>(array: T[], chunkSize: number): Generator<T[]> {
    for (let i = 0; i < array.length; i += chunkSize) {
        yield array.slice(i, i + chunkSize);
    }
}

async function submitRequest(
    url: string,
    payload: unknown,
    skipReturn: boolean = false
): Promise<CatalogResponse | null> {
    try {
        const fullUrl = url;
        const response: AxiosResponse = await axios.post(fullUrl, payload);

        if (response.status === 200 && !skipReturn) {
            const result = response.data;
            if (result["result"] === "success") {
                //console.log(result);
                return result;
            } else {
                console.error(`Response is not success: ${JSON.stringify(result)}`);
            }
        }
    } catch (error) {
        // Logging the error message
        console.error(error);
        throw error;
    }

    return null;
}
