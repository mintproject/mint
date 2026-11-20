import yaml from "js-yaml";
import fetch from "node-fetch";
import { basename } from "path";
import fs from "fs-extra";
import { Md5 } from "ts-md5";
import child_process from "child_process";
import {
    incrementThreadModelSubmittedRuns,
    incrementThreadModelSuccessfulRuns,
    incrementThreadModelFailedRuns,
    updateExecutionStatusAndResults
} from "../graphql/graphql_functions";
import { Component, ComponentSeed, ComponentArgument } from "./local-execution-types";
import { runImage } from "./docker-functions";
import { runKubernetesPod } from "./kubernetes-functions";
import { Container } from "dockerode";
import { DEVMODE } from "@/config/app";
import {
    LocalExecutionPreferences,
    DataResource,
    DateRange,
    MintPreferences
} from "@/classes/mint/mint-types";

import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

import { KeycloakAdapter } from "@/config/keycloak-adapter";
import { fetchMintConfig } from "@/classes/mint/mint-functions";
import { uuidv4 } from "@/classes/graphql/graphql_adapter";

const _uploadS3File = (
    filepath: string,
    filekey: string,
    prefs: MintPreferences
): Promise<void> => {
    const bucket = prefs.data_server_extra["bucket"];
    const access_key = prefs.data_server_extra["access_key"];
    const secret_key = prefs.data_server_extra["secret_access_key"];
    const region = prefs.data_server_extra["region"];

    const client = new S3Client({
        region: region,
        credentials: {
            accessKeyId: access_key,
            secretAccessKey: secret_key
        }
    });
    const cmd = new PutObjectCommand({
        Bucket: bucket,
        Key: filekey,
        Body: fs.createReadStream(filepath)
    });

    return new Promise<void>(async (resolve, reject) => {
        const data = await client.send(cmd);
        console.log(data);
        resolve();
    });
};

module.exports = async (job: any) => {
    // Run the model seed (model config + bindings)

    // Clone the job data object
    job.data = JSON.parse(JSON.stringify(job.data));

    const seed: ComponentSeed = job.data.seed;
    const localex: LocalExecutionPreferences = job.data.prefs;
    const thread_model_id: string = job.data.thread_model_id;

    const prefs = await fetchMintConfig();
    await KeycloakAdapter.signIn(prefs.graphql.username, prefs.graphql.password);

    // Only increment submitted runs if this isn't a retry
    if (seed.execution.status != "FAILURE" && !DEVMODE)
        incrementThreadModelSubmittedRuns(thread_model_id);

    seed.execution.start_time = new Date();

    // Initialize log file
    if (!fs.existsSync(localex.logdir)) fs.mkdirsSync(localex.logdir);
    const logstdout = localex.logdir + "/" + seed.execution.id + ".log";
    fs.removeSync(logstdout);

    // Setup execution
    let error = null;
    const comp: Component = seed.component;
    const inputdir = localex.datadir;
    let outputdir = localex.datadir;

    // Create temporary directory
    const ostmp = localex.tempdir;
    if (!fs.existsSync(ostmp)) fs.mkdirsSync(ostmp);
    const tmpprefix = ostmp + "/" + seed.execution.modelid.replace(/.*\//, "");
    const tempdir = fs.mkdtempSync(tmpprefix);
    console.log(tempdir);

    try {
        // Copy component run directory to tempdir
        fs.copySync(comp.rundir, tempdir);

        // Set the execution engine used for this execution
        seed.execution.execution_engine = "localex";

        // Data/Parameter arguments to the script (will be setup below)
        const args: string[] = [];
        const plainargs: string[] = [];

        // Default invocation is via Bash
        let command = "bash";

        // The entry point of the component (run script)
        args.push("./run");

        // Set the Input file/parameter arguments for the command
        let time_period: DateRange = null;
        let spatial_coverage: any = null;
        comp.inputs.map((input: ComponentArgument) => {
            args.push(input.prefix);
            plainargs.push(input.prefix);
            if (input.isParam) {
                //let paramtype = seed.paramtypes[input.id];
                let paramvalue = seed.parameters[input.id];
                if (!paramvalue) paramvalue = input.paramDefaultValue;
                args.push(paramvalue);
                plainargs.push(paramvalue);
            } else {
                const datasets = seed.datasets[input.id] || [];
                datasets.map((ds: DataResource) => {
                    // Copy input files to tempdir
                    const ifile = inputdir + "/" + ds.name;
                    const newifile = tempdir + "/" + ds.name;
                    if (!fs.existsSync(newifile)) {
                        fs.symlinkSync(ifile, newifile);
                        // fs.copyFileSync(ifile, newifile);
                    }
                    args.push(ds.name);
                    plainargs.push(ds.name);

                    // Copy over spatio-temporal metadata from inputs
                    if (ds.time_period) time_period = ds.time_period;
                    if (ds.spatial_coverage) spatial_coverage = ds.spatial_coverage;
                });
            }
        });

        // Set the output file arguments for the command
        // Create the output file suffix based on a hash of inputs
        const opsuffix = "-" + Md5.hashAsciiStr(seed.execution.modelid + plainargs.join());
        const results: any = {};
        comp.outputs.map((output: ComponentArgument) => {
            args.push(output.prefix);
            const opid = output.id + opsuffix;
            let opfilename = output.role + opsuffix;
            if (output.format) {
                opfilename += "." + output.format;
            }
            const opfilepath = outputdir + "/" + opfilename;
            args.push(opfilename);
            const opfileurl = opfilepath.replace(localex.datadir, localex.dataurl);
            results[output.id] = {
                id: opid,
                name: opfilename,
                url: opfileurl,
                role: output.role,
                time_period: time_period ?? {},
                spatial_coverage: spatial_coverage
            } as DataResource;
        });

        // Check if this component requires a docker image via the model definition
        // - or via the older pegasus job properties file

        const softwareImage = comp.softwareImage;
        let statusCode = 0;

        const cwl_file = comp.rundir + "/run.cwl";
        let cwl_outputs: any = {};
        let is_cwl = false;
        let relative_outputdir = null;

        if (!fs.existsSync(tempdir)) fs.mkdirsSync(tempdir);

        const logstream = fs.createWriteStream(logstdout);
        logstream.write("Logging... [" + tempdir + "]\n");
        logstream.close();

        // If There is a CWL File, run that
        // --------------------------------
        if (fs.existsSync(cwl_file)) {
            console.log("Running cwl:");
            is_cwl = true;

            // Create cwl output directory
            relative_outputdir = Md5.hashAsciiStr(seed.execution.modelid + plainargs.join());
            outputdir = outputdir + "/" + relative_outputdir;
            if (!fs.existsSync(outputdir)) {
                fs.mkdirsSync(outputdir);
            }

            const use_kubernetes = prefs.kubernetes?.use || true;
            if (use_kubernetes) {
                // If Running as a Kubernetes Pod, then extract I/O from CWL file and run that way
                console.log("Running as a Kubernetes Job:");
                const logstream = fs.createWriteStream(logstdout, { flags: "a" });

                // Run command in docker image
                const details = get_details_from_cwl(comp, seed, results, cwl_file);

                const image = details["image"];
                const cmd_args = get_commandline_for_cwl_details(details);
                cwl_outputs = get_cwl_outputs(details, tempdir);

                const jobname = "execution-" + uuidv4();
                const namespace = prefs.kubernetes?.namespace || "default";
                const use_node_affinity = prefs.kubernetes?.node_affinity || false;
                const cpu_limit = prefs.kubernetes?.cpu_limit || null;
                const memory_limit = prefs.kubernetes?.memory_limit || null;

                statusCode = await runKubernetesPod(
                    namespace,
                    jobname,
                    cmd_args,
                    image,
                    logstream,
                    tempdir,
                    use_node_affinity,
                    cpu_limit,
                    memory_limit
                );

                // Clean up
                logstream.close();
            } else {
                // Otherwise run using cwlool
                const cwl_values_file = write_cwl_values(comp, seed, results, tempdir);
                const cwl_args: string[] = [];
                const cwl_command = "cwltool";
                cwl_args.push("--no-read-only");
                cwl_args.push("--copy-outputs");
                cwl_args.push("--no-match-user");
                //cwl_args.push("--user-space-docker-cmd")
                //cwl_args.push("docker")
                cwl_args.push(cwl_file);
                cwl_args.push(cwl_values_file);
                console.log("running a new execution " + logstdout);
                console.log("temporary directory " + tempdir);

                console.log(cwl_command + " " + cwl_args.join(" ") + "\n");

                const logstream = fs.createWriteStream(logstdout, { flags: "a" });
                const spawnResult = child_process.spawn(cwl_command, cwl_args, {
                    cwd: tempdir,
                    shell: true
                });

                let stdout = "";
                const promise = new Promise<void>(async (resolve, reject) => {
                    spawnResult.on("close", (code) => {
                        statusCode = code;
                        resolve();
                    });
                    spawnResult.stdout.on("data", (message) => {
                        logstream.write(message);
                        stdout += message;
                    });
                    spawnResult.stderr.on("data", (message) => {
                        logstream.write(message);
                    });
                });
                await Promise.all([promise]);
                logstream.close();

                if (statusCode == 0) {
                    cwl_outputs = JSON.parse(stdout);
                }
            }
        }
        // If there is only a docker image, run the container
        // --------------------------------------------------
        else if (softwareImage != null) {
            const use_kubernetes = prefs.kubernetes?.use || true;
            if (use_kubernetes) {
                console.log("Running as a Kubernetes Job:");
                const logstream = fs.createWriteStream(logstdout, { flags: "a" });

                const jobname = "execution-" + uuidv4();
                const namespace = prefs.kubernetes?.namespace || "default";
                const cpu_limit = prefs.kubernetes?.cpu_limit || null;
                const memory_limit = prefs.kubernetes?.memory_limit || null;
                const use_node_affinity = prefs.kubernetes?.node_affinity || false;

                statusCode = await runKubernetesPod(
                    namespace,
                    jobname,
                    args,
                    softwareImage,
                    logstream,
                    tempdir,
                    use_node_affinity,
                    cpu_limit,
                    memory_limit
                );

                // Clean up
                logstream.close();
            } else {
                console.log("Running as a Docker Image:");
                const logstream = fs.createWriteStream(logstdout, { flags: "a" });

                // Run command in docker image
                const folderBindings = [
                    `${tempdir}:${tempdir}`,
                    `${localex.datadir}:${localex.datadir}`
                ];
                const data = await runImage(
                    args,
                    softwareImage,
                    logstream,
                    tempdir,
                    folderBindings
                );
                const output = data[0];
                const container: Container = data[1];
                statusCode = output.StatusCode;

                // Clean up
                logstream.close();
                await container.remove({ force: true });
            }
        } else {
            // If there is a Pegasus Job file, run as a singularity command
            console.log("Running as a Singularity Information");
            const pegasus_jobprops_file = comp.rundir + "/__pegasus-job.properties";
            if (fs.existsSync(pegasus_jobprops_file)) {
                const jobprops = fs.readFileSync(pegasus_jobprops_file);
                const matches: RegExpMatchArray = jobprops
                    .toString()
                    .match(/SingularityImage = "(.+)"/);
                if (matches.length > 1) {
                    command = "singularity";
                    args.push("exec");
                    args.push(matches[1]);
                }
            }

            // Default Behaviour: Run as a shell command
            // -----------------------------------------

            // Spawn the process & pipe stdout and stderr
            const spawnResult = child_process.spawnSync(command, args, {
                cwd: tempdir,
                shell: true,
                maxBuffer: 1024 * 1024 * 50 // 50 MB of log cutoff
            });

            // Write log file
            const logstream = fs.createWriteStream(logstdout, { flags: "a" });
            logstream.write("\n------- STDOUT ---------\n");
            logstream.write(spawnResult.stdout);
            if (spawnResult.error) logstream.write(spawnResult.error.message);
            logstream.write("\n------- STDERR ---------\n");
            logstream.write(spawnResult.stderr);
            logstream.close();
            if (spawnResult.error) {
                error = spawnResult.error.message;
            }
            statusCode = spawnResult.status;
        }

        // Check for Errors & Process Results
        if (statusCode != 0) {
            error = "Execution returned with non-zero status code";
        } else {
            // Process Results
            const uploadOutputPromises = [];

            Object.values(results).map((result: any) => {
                // Rename temporary output files to desired output name
                let desired_output_file = null;
                let tmp_output_file = null;
                let relative_output_file = null;
                if (is_cwl) {
                    result.name = result.role;
                    if (result.role !== undefined && result.role in cwl_outputs) {
                        const cwl_output = cwl_outputs[result.role];
                        desired_output_file = outputdir + "/" + cwl_output["basename"];
                        relative_output_file =
                            (relative_outputdir ? relative_outputdir + "/" : "") +
                            cwl_output["basename"];
                        tmp_output_file = cwl_output["path"];
                    }
                } else {
                    tmp_output_file = tempdir + "/" + result.name;
                    desired_output_file = outputdir + "/" + result.name;
                    relative_output_file =
                        (relative_outputdir ? relative_outputdir + "/" : "") + result.name;
                }
                // Copy over the tempfile to desired output file
                if (tmp_output_file && desired_output_file) {
                    if (fs.existsSync(tmp_output_file)) {
                        if (prefs.data_server_type == "S3") {
                            uploadOutputPromises.push(
                                _uploadS3File(tmp_output_file, relative_output_file, prefs)
                            );
                        } else {
                            fs.copyFileSync(tmp_output_file, desired_output_file);
                        }
                    }
                    const url = desired_output_file.replace(localex.datadir, localex.dataurl);
                    result.url = url;
                }
            });

            // Upload all datasets
            if (uploadOutputPromises.length > 0) await Promise.all(uploadOutputPromises);

            seed.execution.results = results;
        }
    } catch (e) {
        error = "ERROR: " + e;
        const logstream = fs.createWriteStream(logstdout, { flags: "a" });
        logstream.write("ERROR in Execution: \n");
        logstream.write(error + "\n");
        logstream.close();
    }

    try {
        // Remove temporary directory
        fs.removeSync(tempdir);
    } catch (e) {
        console.log("Error removing temporary directory: " + tempdir);
    }

    // Set the execution status
    seed.execution.status = "SUCCESS";
    seed.execution.end_time = new Date();
    seed.execution.run_progress = 1;
    if (error) {
        seed.execution.status = "FAILURE";
    }

    // Update execution status and results in backend
    if (!DEVMODE) await updateExecutionStatusAndResults(seed.execution);

    // Return job execution or error
    if (seed.execution.status == "SUCCESS") {
        if (!DEVMODE) await incrementThreadModelSuccessfulRuns(thread_model_id);
        return Promise.resolve(seed.execution);
    } else {
        if (!DEVMODE) await incrementThreadModelFailedRuns(thread_model_id);
        return Promise.reject(new Error(error));
    }
};

const get_details_from_cwl = (comp: Component, seed: any, results: any, cwl_file: string) => {
    const file = fs.readFileSync(cwl_file, "utf8");
    const cwl = yaml.load(file);
    const image = cwl["hints"]["DockerRequirement"]["dockerImageId"];
    const command = cwl["baseCommand"];

    const input_values = get_input_values(comp, seed);
    const output_values = {};
    Object.values(results).map((result: any) => {
        output_values[result.role] = { class: "File", location: result.name };
    });

    const inputs = {};
    const outputs = {};
    for (const input_id in cwl["inputs"]) {
        const input_cwl = cwl["inputs"][input_id];
        const input_value = input_values[input_id];
        const prefix = input_cwl["inputBinding"]["prefix"];
        inputs[input_id] = {
            prefix: prefix,
            value: input_value
        };
    }
    for (const output_id in cwl["outputs"]) {
        const output_cwl = cwl["outputs"][output_id];
        const output_value = output_values[output_id];
        const output_glob = output_cwl["outputBinding"]["glob"];
        outputs[output_id] = {
            glob: output_glob,
            value: output_value
        };
    }
    return {
        image: image,
        command: command,
        inputs: inputs,
        outputs: outputs
    };
};

const get_input_values = (comp: Component, seed: any) => {
    interface CwlValueFile {
        class: string;
        location: string;
    }
    const data: Record<string, string | CwlValueFile> = {};
    comp.inputs.map((input: any) => {
        if (input.isParam) {
            const paramtype = seed.paramtypes[input.id];
            let paramvalue = seed.parameters[input.id];
            if (!paramvalue) paramvalue = input.paramDefaultValue;
            if (paramtype == "int") paramvalue = parseInt(paramvalue);
            else if (paramtype == "float") paramvalue = parseFloat(paramvalue);
            else if (paramtype == "boolean")
                paramvalue = paramvalue.toString().toLowerCase() == "true";
            else paramvalue = paramvalue.toString();
            data[input.role] = paramvalue;
        } else {
            const datasets = seed.datasets[input.id] || [];
            datasets.map((ds: string) => {
                // Copy input files to tempdir
                data[input.role] = { class: "File", location: ds["name"] };
            });
            // console.log(datasets)
        }
    });
    return data;
};

const write_cwl_values = (comp: Component, seed: any, results: any, tempdir: string) => {
    interface CwlValueFile {
        class: string;
        location: string;
    }
    const data: Record<string, string | CwlValueFile> = get_input_values(comp, seed);
    // Set output file names
    Object.values(results).map((result: any) => {
        data[result.role] = { class: "File", location: result.name };
    });

    const valuesFile = tempdir + "/values.yml";
    const ymlStr = yaml.safeDump(data);
    fs.writeFileSync(valuesFile, ymlStr, "utf8");
    console.log("writing the values file " + valuesFile);
    return valuesFile;
};

const get_commandline_for_cwl_details = (details: any) => {
    const cmd = [];
    cmd.push(details["command"]);
    for (const input_id in details["inputs"]) {
        const input = details["inputs"][input_id];
        const input_value = input["value"];
        const input_prefix = input["prefix"];
        cmd.push(input_prefix);
        if (typeof input_value == "object") {
            const input_type = input_value["class"];
            if (input_type == "File") {
                cmd.push(input_value["location"]);
            }
        } else {
            cmd.push("" + input_value);
        }
    }
    return cmd;
};

const get_cwl_outputs = (details: any, tempdir: string) => {
    const cwl_outputs = {};
    for (const output_id in details["outputs"]) {
        const output = details["outputs"][output_id];
        const output_value = output["value"];
        const output_temp_file = output["glob"];
        if (typeof output_value == "object") {
            const output_type = output_value["class"];
            if (output_type == "File") {
                const output_file = output_value["location"];
                cwl_outputs[output_id] = {
                    basename: output_file,
                    path: tempdir + "/" + output_temp_file
                };
            }
        }
    }
    return cwl_outputs;
};
