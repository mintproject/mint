import {
    Execution,
    Thread,
    Model,
    ModelIO,
    DataResource,
    MintPreferences,
    ModelParameter,
    Wcm,
    Region
} from "@/classes/mint/mint-types";
import {
    Component,
    ComponentSeed,
    ComponentParameterBindings,
    ComponentDataBindings,
    ComponentParameterTypes
} from "./local-execution-types";

import path from "path";
import fs from "fs-extra";
import request from "request";
import yauzl from "yauzl";
import yaml from "js-yaml";

import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";

import Queue from "bull";
import { EXECUTION_QUEUE_NAME, REDIS_URL } from "@/config/redis";
import { Md5 } from "ts-md5";
import { getConfiguration } from "@/classes/mint/mint-functions";
import { Readable } from "stream";

const prefs = getConfiguration();

const executionQueue =
    prefs.execution_engine === "localex" ? new Queue(EXECUTION_QUEUE_NAME, REDIS_URL) : null;

if (prefs.execution_engine === "localex") {
    executionQueue.process(prefs.localex.parallelism, __dirname + "/execution.js");
}

// You can listen to global events to get notified when jobs are processed
/*executionQueue.on('global:completed', (jobId, result) => {
    console.log(`Job completed with result ${result}`);
});*/

const _downloadS3File = (url: string, filepath: string, prefs: MintPreferences): Promise<void> => {
    const bucket = prefs.data_server_extra["bucket"];
    const access_key = prefs.data_server_extra["access_key"];
    const secret_key = prefs.data_server_extra["secret_access_key"];
    const region = prefs.data_server_extra["region"];

    const fileKey = url.substring(5 + bucket.length + 1);

    const client = new S3Client({
        region: region,
        credentials: {
            accessKeyId: access_key,
            secretAccessKey: secret_key
        }
    });
    const cmd = new GetObjectCommand({
        Bucket: bucket,
        Key: fileKey
    });

    return new Promise<void>(async (resolve, reject) => {
        const data = await client.send(cmd);
        if (data.Body instanceof Readable) {
            data.Body.pipe(fs.createWriteStream(filepath))
                .on("error", (err) => reject(err))
                .on("close", () => resolve());
        }
    });
};

const _downloadFile = (url: string, filepath: string): Promise<void> => {
    const file = fs.createWriteStream(filepath);
    return new Promise<void>((resolve, reject) => {
        if (url.toLowerCase().startsWith("http")) {
            request.get(url).on("response", (res) => {
                res.pipe(file);
                res.on("end", function () {
                    resolve();
                });
            });
        } else if (url.toLowerCase().startsWith("s3://")) {
            // Make a call to store the data to filepath (or to the file stream)
        }
    });
};

// TODO: Unzip the wcm zip file
const _unzipFile = (zipfilename: string, dirname: string): Promise<string> => {
    return new Promise<string>((resolve, reject) => {
        if (!fs.existsSync(dirname)) {
            fs.mkdirsSync(dirname);
        }
        yauzl.open(zipfilename, { lazyEntries: true }, function (err, zipfile) {
            if (err) {
                console.log(err);
                reject();
                return;
            }
            zipfile.readEntry();
            zipfile.on("entry", function (entry) {
                // Ignore some files/directories
                if (entry.fileName.match(/__MACOSX/) || entry.fileName.match(/.DS_Store/i)) {
                    zipfile.readEntry();
                    return;
                }
                // If this is a directory, then copy its contents to dirname
                if (entry.fileName.indexOf("/") >= 0) {
                    const filename = entry.fileName.substr(entry.fileName.indexOf("/") + 1);
                    if (!filename) {
                        zipfile.readEntry();
                        return;
                    }
                    if (/\/$/.test(filename)) {
                        // Directories
                        zipfile.readEntry();
                        if (!fs.existsSync(dirname + "/" + filename))
                            fs.mkdirsSync(dirname + "/" + filename);
                    } else {
                        // Files
                        zipfile.openReadStream(entry, function (err, readStream) {
                            if (err) throw err;
                            readStream.on("end", function () {
                                zipfile.readEntry();
                            });
                            const filepath = dirname + "/" + filename;
                            const outstream = fs.createWriteStream(filepath);
                            readStream.pipe(outstream);
                            readStream.on("end", () => {
                                // Make it executable
                                outstream.close();
                                if (fs.existsSync(filepath)) fs.chmodSync(filepath, "755");
                            });
                        });
                    }
                }
            });
            zipfile.once("end", function () {
                resolve(dirname);
                zipfile.close();
            });
        });
    });
};

const _downloadAndUnzipToDirectory = (url: string, modeldir: string, compname: string) => {
    const zipfile = modeldir + ".zip";
    console.log("Downloading .." + zipfile);
    return new Promise<void>((resolve, reject) => {
        _downloadFile(url, zipfile).then(() => {
            // Unzip file
            if (fs.existsSync(zipfile)) {
                console.log("Unzipping..");
                _unzipFile(zipfile, modeldir)
                    .then(() => {
                        resolve();
                    })
                    .catch((e) => {
                        console.log(e);
                        reject();
                    });
            } else {
                reject();
            }
        });
    });
};

const _downloadCwlToDirectory = (url: string, modeldir: string) => {
    const cwlfile = modeldir + "/run.cwl";
    return new Promise<void>((resolve, reject) => {
        _downloadFile(url, cwlfile).then(() => {
            // Unzip file
            if (fs.existsSync(cwlfile)) {
                resolve();
            } else {
                reject();
            }
        });
    });
};

const _downloadWCM = async (url: string, prefs: MintPreferences) => {
    const hashdir = Md5.hashStr(url).toString();

    // Get zip file name from url
    const plainurl = url.replace(/\?.*$/, "");
    const component_file = plainurl.replace(/.+\//, "");
    const extension = path.extname(component_file);
    const compname = path.basename(component_file, extension);

    const codedir = prefs.localex.codedir + "/" + hashdir;
    console.log("Downloading .. " + url + " .. to .. " + codedir);

    if (!fs.existsSync(codedir)) fs.mkdirsSync(codedir);

    const modeldir = codedir + "/" + compname;
    const src_dir = modeldir + "/" + "src";
    if (!fs.existsSync(src_dir)) {
        if (extension == ".zip") await _downloadAndUnzipToDirectory(url, modeldir, compname);
        else if (extension == ".cwl") {
            if (!fs.existsSync(modeldir)) fs.mkdirsSync(modeldir);
            fs.mkdirsSync(src_dir);
            await _downloadCwlToDirectory(url, src_dir);
        }
    }
    return modeldir;
};

const _getModelDetailsFromYAML = (modeldir: string) => {
    const wcmYamlFileName = modeldir + "/wings-component.yml";
    const wcmYamlFileNameAlternative = modeldir + "/wings-component.yaml";

    if (fs.existsSync(wcmYamlFileName)) {
        const wcmYamlFile = wcmYamlFileName;
    } else if (fs.existsSync(wcmYamlFileName)) {
        const wcmYamlFile = wcmYamlFileNameAlternative;
    } else {
        throw new Error("The component is not a valid WINGS component.");
    }

    const comp: Component = {
        rundir: modeldir + "/src",
        inputs: [],
        outputs: []
    };
    const yml = yaml.safeLoad(fs.readFileSync(wcmYamlFileName, "utf8")) as Wcm;
    const wings = yml["wings"];
    wings.inputs.map((input: any) => {
        comp.inputs.push(input);
    });
    wings.outputs.map((output: any) => {
        comp.outputs.push(output);
    });
    return comp;
};

const _getModelIODetails = (io: ModelIO, iotype: string) => {
    if (!io.position) {
        return null;
    }
    const pfx = iotype == "input" ? "-i" : "-o";
    return {
        id: io.id,
        role: io.name,
        prefix: pfx + io.position,
        isParam: false,
        format: io.format,
        type: io.type
    };
};

const _getModelParamDetails = (param: ModelParameter) => {
    if (!param.position) {
        return null;
    }
    return {
        id: param.id,
        role: param.name,
        prefix: "-p" + param.position,
        isParam: true,
        type: param.type
    };
};

const _getModelDetails = (model: Model, modeldir: string) => {
    const comp: Component = {
        rundir: modeldir + "/src",
        softwareImage: model.software_image,
        inputs: [],
        outputs: []
    };
    let okinput = true;
    let okparam = true;
    let okoutput = true;
    model.input_files.map((input) => {
        const details = _getModelIODetails(input, "input");
        if (!details) {
            okinput = false;
            console.error("Input file missing position: " + input.id);
        } else comp.inputs.push(details);
    });
    model.input_parameters.map((param) => {
        const details = _getModelParamDetails(param);
        if (!details) {
            okparam = false;
            console.error("Input parameter missing position: " + param.id);
        } else comp.inputs.push(details);
    });
    model.output_files.map((output) => {
        const details = _getModelIODetails(output, "output");
        if (!details) {
            okoutput = false;
            console.error("Output file missing position: " + output.id);
        } else comp.outputs.push(details);
    });
    if (okoutput) return comp;
    else return null;
};

export const getModelCacheDirectory = (url: string, prefs: MintPreferences) => {
    const hashdir = Md5.hashStr(url).toString();

    // Get zip file name from url
    const plainurl = url.replace(/\?.*$/, "");
    const zipfile = plainurl.replace(/.+\//, "");
    const compname = zipfile.replace(/\.zip/i, "");

    const codedir = prefs.localex.codedir;
    const modeldir = codedir + "/" + hashdir + "/" + compname;
    return modeldir;
};

export const loadModelWCM = async (url: string, model: Model, prefs: MintPreferences) => {
    const modeldir = await _downloadWCM(url, prefs);
    console.log("Model dir.. " + modeldir);
    // if (model.software_image != null) {
    //     // Pull docker image if needed
    //     await pullImage(model.software_image);
    // }
    let details = _getModelDetails(model, modeldir);
    // If we cannot get the details from just the model cache, then try to get it from the yaml
    if (!details) {
        details = _getModelDetailsFromYAML(modeldir);
    }
    return details;
};

const _getRegionGeoJson = (region: Region) => {
    const geojson = { type: "FeatureCollection", features: [] };
    region.geometries.map((geom) => {
        const feature = { type: "Feature", geometry: geom };
        geojson["features"].push(feature);
    });
    return JSON.stringify(geojson);
};

// Create Jobs (Seeds) and Queue them
export const queueModelExecutionsLocally = async (
    thread: Thread,
    modelid: string,
    component: Component,
    region: Region,
    executions: Execution[],
    prefs: MintPreferences
): Promise<Queue.Job<any>[]> => {
    const seeds: ComponentSeed[] = [];
    const registered_resources: any = {};
    const downloadInputPromises = [];

    const model = thread.models[modelid];
    const thread_model_id = thread.model_ensembles[modelid].id;

    // Get all input dataset bindings and parameter bindings
    executions.map((execution) => {
        const bindings = execution.bindings;
        const datasets: ComponentDataBindings = {};
        const parameters: ComponentParameterBindings = {};
        const paramtypes: ComponentParameterTypes = {};

        // Get input datasets
        model.input_files.map((io: ModelIO) => {
            let resources: DataResource[] = [];
            let dsid = null;
            if (bindings[io.id]) {
                // We have a dataset binding from the user for it
                resources = [bindings[io.id] as DataResource];
            } else if (io.value) {
                // There is a hardcoded value in the model itself
                dsid = io.value.id;
                resources = io.value.resources;
            }
            if (resources.length > 0) {
                const type = io.type.replace(/^.*#/, "");
                const newresources: any = {};
                resources.map((res) => {
                    let resid = res.id;
                    let resname = res.name;
                    if (res.url) {
                        resname = res.url.replace(/^.*(#|\/)/, "");
                        resname = resname.replace(/^([0-9])/, "_$1");
                        if (!resid) resid = resname;
                    }
                    newresources[resid] = {
                        id: resid,
                        url: res.url,
                        name: resname,
                        time_period: res.time_period,
                        spatial_coverage: res.spatial_coverage
                    } as DataResource;
                    registered_resources[resid] = [resname, type, res.url];
                });
                datasets[io.id] = resources.map((res) => newresources[res.id]);
            }
        });

        // Get Input parameters
        model.input_parameters.map((ip) => {
            if (ip.value) {
                parameters[ip.id] = ip.value.toString();
            } else if (bindings[ip.id]) {
                const value = bindings[ip.id];
                parameters[ip.id] = value.toString();
            }
            // HACK: Replace region geojson
            if (parameters[ip.id].match(/__region_geojson:(.+)/)) {
                const region_geojson = _getRegionGeoJson(region);
                parameters[ip.id] = region_geojson;
            }

            paramtypes[ip.id] = ip.type;
        });

        seeds.push({
            component: component,
            execution: execution,
            datasets: datasets,
            parameters: parameters,
            paramtypes: paramtypes
        } as ComponentSeed);
    });

    // Add Download Job to Queue (if it doesn't already exist)
    for (const resid in registered_resources) {
        const args = registered_resources[resid];
        const inputpath = prefs.localex.datadir + "/" + args[0];
        const inputurl = args[2];
        if (!fs.existsSync(inputpath)) {
            console.log("Downloading " + inputpath + " ...");
            if (inputurl.toLowerCase().startsWith("http")) {
                downloadInputPromises.push(_downloadFile(inputurl, inputpath));
            } else if (inputurl.toLowerCase().startsWith("s3://")) {
                downloadInputPromises.push(_downloadS3File(inputurl, inputpath, prefs));
            }
        }
    }

    // Download all datasets
    if (downloadInputPromises.length > 0) await Promise.all(downloadInputPromises);

    // Once all Downloads are finished, Add all execution jobs (seeds) to queue
    const numseeds = seeds.length;
    const priority =
        numseeds < 10 ? 1 : numseeds < 50 ? 2 : numseeds < 200 ? 3 : numseeds < 500 ? 4 : 5;

    return Promise.all(
        seeds.map((seed) =>
            executionQueue.add(
                {
                    seed: seed,
                    prefs: prefs.localex,
                    thread_id: thread.id,
                    thread_model_id: thread_model_id
                },
                {
                    priority: priority
                    //jobId: seed.execution.id,
                    //removeOnComplete: true,
                    //attempts: 2
                }
            )
        )
    );
};

export const fetchLocalRunLog = (executionid: string, prefs: MintPreferences) => {
    const logstdout = prefs.localex.logdir + "/" + executionid + ".log";
    if (fs.existsSync(logstdout)) return fs.readFileSync(logstdout).toString();
    return "Job not yet started running";
};
