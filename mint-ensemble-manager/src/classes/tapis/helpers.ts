import request from "request";
import {
    ComponentDataBindings,
    ComponentParameterBindings,
    ComponentParameterTypes,
    ComponentSeed
} from "@/classes/localex/local-execution-types";
import {
    DataResource,
    MintPreferences,
    Region,
    ModelIO,
    InputBindings,
    Model
} from "@/classes/mint/mint-types";
import fs from "fs-extra";

export function getInputDatasets(model: Model, bindings: InputBindings) {
    const datasets: ComponentDataBindings = {};
    model.input_files.map((input_file: ModelIO) => {
        //A resource can be selected by the user or hardcoded in the model
        const resources = obtainResourcesSelection(bindings, input_file);
        if (resources.length > 0) {
            const inputType = input_file.type.replace(/^.*#/, "");
            datasets[input_file.id] = resources.map((resource) => {
                const { resourceId, resourceName } = generateResourceIdAndName(
                    resource,
                    input_file.type
                );
                return {
                    id: resourceId,
                    url: resource.url,
                    name: resourceName,
                    time_period: resource.time_period,
                    spatial_coverage: resource.spatial_coverage,
                    type: inputType
                } as DataResource;
            });
        }
    });
    return datasets;
}

function generateResourceIdAndName(res: DataResource, inputFileType: string) {
    let resourceId = res.id;
    let resourceName = res.name;
    const resourceType = inputFileType.replace(/^.*#/, "");
    if (res.url) {
        resourceName = res.url.replace(/^.*(#|\/)/, "");
        resourceName = resourceName.replace(/^([0-9])/, "_$1");
        if (!resourceId) resourceId = resourceName;
    }
    return { resourceId, resourceName, resourceType };
}

export function getResourcesFromSeeds(seeds: ComponentSeed[]) {
    const registered_resources: RegisteredResource[] = [];
    for (const seed of seeds) {
        const resources = getResourcesFromDatasets(seed.datasets);
        registered_resources.push(...resources);
    }
    return registered_resources;
}

export type RegisteredResource = {
    name: string;
    type: string;
    url: string;
};

function getResourcesFromDatasets(dataBindings: ComponentDataBindings) {
    const registered_resources: RegisteredResource[] = [];
    for (const inputFile in dataBindings) {
        const resources = dataBindings[inputFile];
        resources.map((resource) => {
            registered_resources.push({
                name: resource.name,
                type: resource.type,
                url: resource.url
            });
        });
    }
    return registered_resources;
}

function obtainResourcesSelection(bindings: InputBindings, input_file: ModelIO) {
    if (bindings[input_file.id]) {
        // We have a dataset binding from the user for it
        return [bindings[input_file.id] as DataResource];
    } else if (input_file.value) {
        // There is a hardcoded value in the model itself
        return input_file.value.resources;
    }
    return [];
}

export function getInputsParameters(model: Model, bindings: InputBindings, region: Region) {
    /**
     * Get the parameters using the default values from the model and the bindings selected by the user
     * If the parameter is a region geojson, replace the value with the region geojson
     */
    const parameters: ComponentParameterBindings = {};
    const parameterTypes: ComponentParameterTypes = {};
    model.input_parameters.map((ip) => {
        if (ip.value) {
            parameters[ip.id] = ip.value.toString();
        } else if (bindings[ip.id]) {
            const value = bindings[ip.id];
            parameters[ip.id] = value.toString();
        }
        // HACK: Replace region geojson
        if (parameters[ip.id]?.match(/__region_geojson:(.+)/)) {
            const region_geojson = _getRegionGeoJson(region);
            parameters[ip.id] = region_geojson;
        }

        parameterTypes[ip.id] = ip.type;
    });
    return { parameters, parameterTypes };
}

export const _getRegionGeoJson = (region: Region) => {
    const geojson = { type: "FeatureCollection", features: [] };
    region.geometries.map((geom) => {
        const feature = { type: "Feature", geometry: geom };
        geojson["features"].push(feature);
    });
    return JSON.stringify(geojson);
};

export async function downloadInputsFile(resources: RegisteredResource[], prefs: MintPreferences) {
    const downloadInputPromises = resources.map((resource) => {
        const inputpath = prefs.tapis.datadir + "/" + resource.name;
        if (!fs.existsSync(inputpath)) {
            console.log("Downloading input file: ", resource.url, " to ", inputpath);
            return downloadInputPromises.push(_downloadFile(resource.url, inputpath));
        } else {
            console.log("Input file already exists: ", inputpath);
        }
    });
    if (downloadInputPromises.length > 0) await Promise.all(downloadInputPromises);
}

const _downloadFile = (url: string, filepath: string): Promise<void> => {
    const file = fs.createWriteStream(filepath);
    return new Promise<void>((resolve) => {
        request.get(url).on("response", (res) => {
            res.pipe(file);
            res.on("end", function () {
                resolve();
            });
        });
    });
};
