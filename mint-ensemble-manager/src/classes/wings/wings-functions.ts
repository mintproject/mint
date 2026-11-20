import { getResource, postFormResource, postJSONResource } from "./xhr-requests";
import {
    IdMap,
    MintPreferences,
    Execution,
    Thread,
    Model,
    DataResource
} from "@/classes/mint/mint-types";
import {
    WingsComponent,
    WingsTemplatePackage,
    WingsTemplate,
    WingsDataBindings,
    WingsParameterBindings,
    WingsTemplateMetadata,
    WingsPort,
    WingsPortRole,
    WingsDataVariable,
    WingsParameterVariable,
    WingsNode,
    WingsComponentVariable,
    WingsTemplateSeed,
    WingsParameterTypes,
    WingsQueueStep,
    WingsRunFile,
    WingsRunStatuses,
    WingsRunStep
} from "./wings-types";

export const loginToWings = async (config: MintPreferences): Promise<void> => {
    const config_wings = config.wings;
    return new Promise<void>((resolve, reject) => {
        getResource({
            url: config_wings.server + "/login",
            onLoad: function (e) {
                const txt = e.target.responseText;
                if (txt.match(/j_security_check/)) {
                    const data = {
                        j_username: config_wings.username,
                        j_password: config_wings.password
                    };
                    postFormResource(
                        {
                            url: config_wings.server + "/j_security_check",
                            onLoad: function (e2) {
                                getResource({
                                    // Try to access the login page again
                                    url: config_wings.server + "/login",
                                    onLoad: function () {
                                        const txt2 = e2.target.responseText;
                                        if (txt2.match(/j_security_check/)) {
                                            reject();
                                        } else {
                                            // Success: Logged in
                                            resolve();
                                            //console.log("Success !! Logged in");
                                        }
                                    },
                                    onError: function () {
                                        console.log("Cannot login");
                                        reject();
                                    }
                                });
                            },
                            onError: function () {
                                console.log("Cannot login");
                                getResource({
                                    url: config_wings.server + "/login",
                                    onLoad: function (e2) {
                                        const match = /USER_ID\s*=\s*"(.+)"\s*;/.exec(
                                            e2.target.responseText
                                        );
                                        if (match) {
                                            resolve();
                                            //console.log("Logged in as " + userid + " !");
                                        }
                                    },
                                    onError: function () {
                                        reject();
                                    }
                                });
                            }
                        },
                        data
                    );
                } else {
                    const match = /USER_ID\s*=\s*"(.+)"\s*;/.exec(txt);
                    if (match) {
                        resolve();
                        //console.log("Already Logged in as " + userid + " !");
                    }
                }
            },
            onError: function () {
                reject();
                console.log("Cannot connect to wings");
            }
        });
    });
};

export const fetchWingsComponent = async (
    cname: string,
    config: MintPreferences
): Promise<WingsComponent> => {
    const config_wings = config.wings;
    return new Promise<WingsComponent>((resolve, reject) => {
        const purl =
            config_wings.server + "/users/" + config_wings.username + "/" + config_wings.domain;
        const exurl =
            config_wings.export_url +
            "/export/users/" +
            config_wings.username +
            "/" +
            config_wings.domain;
        const cid = exurl + "/components/library.owl#" + cname;

        getResource({
            url: purl + "/components/getComponentJSON?cid=" + escape(cid),
            onLoad: function (e) {
                const comp = JSON.parse(e.target.responseText) as WingsComponent;
                resolve(comp);
            },
            onError: function () {
                reject("Could not get component");
            }
        });
    });
};

export const logoutFromWings = async (config: MintPreferences): Promise<void> => {
    const config_wings = config.wings;
    return new Promise<void>((resolve, reject) => {
        getResource({
            url: config_wings.server + "/jsp/login/logout.jsp",
            onLoad: function () {
                resolve();
                //console.log("Logged out");
            },
            onError: function () {
                reject("Could not logout !");
                //console.log("Could not logout !");
            }
        });
    });
};

export const fetchWingsTemplatesList = async (config: MintPreferences): Promise<string[]> => {
    const config_wings = config.wings;
    return new Promise<string[]>((resolve, reject) => {
        const purl =
            config_wings.server + "/users/" + config_wings.username + "/" + config_wings.domain;
        getResource({
            url: purl + "/workflows/getTemplatesListJSON",
            onLoad: function (e) {
                const list = JSON.parse(e.target.responseText);
                resolve(list);
            },
            onError: function () {
                reject("Could not get templates list");
            }
        });
    });
};

export const fetchWingsTemplate = async (
    tid: string,
    config: MintPreferences
): Promise<WingsTemplatePackage> => {
    const config_wings = config.wings;
    return new Promise<WingsTemplatePackage>((resolve, reject) => {
        const purl =
            config_wings.server + "/users/" + config_wings.username + "/" + config_wings.domain;
        //var exurl = config_wings.export_url + "/export/users/" + config_wings.username + "/" + config_wings.domain;
        //var tid = exurl + "/workflows/" + tname + ".owl#" + tname;

        getResource({
            url: purl + "/workflows/getEditorJSON?template_id=" + escape(tid),
            onLoad: function (e) {
                const tpl = JSON.parse(e.target.responseText) as WingsTemplatePackage;
                resolve(tpl);
            },
            onError: function () {
                reject("Could not get template");
            }
        });
    });
};

export const saveWingsTemplate = async (
    tpl: WingsTemplatePackage,
    config: MintPreferences
): Promise<void> => {
    //TODO: Get a MD5 Hash for template to check if it is already saved.
    // - To avoid cluttering up template library

    const config_wings = config.wings;
    // Get url prefix for operations
    return new Promise<void>((resolve, reject) => {
        const purl =
            config_wings.server + "/users/" + config_wings.username + "/" + config_wings.domain;
        const data = {
            template_id: tpl.template.id,
            constraints_json: JSON.stringify(tpl.constraints),
            json: JSON.stringify(tpl.template)
        };
        postFormResource(
            {
                url: purl + "/workflows/saveTemplateJSON",
                onLoad: function () {
                    resolve();
                },
                onError: function () {
                    reject("Cannot save");
                }
            },
            data
        );
    });
};

export const layoutWingsTemplate = async (
    tpl: WingsTemplate,
    config: MintPreferences
): Promise<WingsTemplatePackage> => {
    const config_wings = config.wings;
    return new Promise<WingsTemplatePackage>((resolve, reject) => {
        // Get url prefix for operations
        const purl =
            config_wings.server + "/users/" + config_wings.username + "/" + config_wings.domain;
        postJSONResource(
            {
                url: purl + "/workflows/layoutTemplate",
                onLoad: function (e) {
                    const ntpl = JSON.parse(e.target.responseText) as WingsTemplatePackage;
                    resolve(ntpl);
                },
                onError: function () {
                    reject("Cannot layout template");
                }
            },
            tpl
        );
    });
};

export const elaborateWingsTemplate = async (
    tpl: WingsTemplatePackage,
    config: MintPreferences
): Promise<WingsTemplate> => {
    const config_wings = config.wings;
    return new Promise<WingsTemplate>((resolve, reject) => {
        // Get url prefix for operations
        const purl =
            config_wings.server + "/users/" + config_wings.username + "/" + config_wings.domain;
        const data = {
            template_id: tpl.template.id,
            constraints_json: JSON.stringify(tpl.constraints),
            json: JSON.stringify(tpl.template)
        };
        postFormResource(
            {
                url: purl + "/plan/elaborateTemplateJSON",
                onLoad: function (e) {
                    const ntpl = JSON.parse(e.target.responseText) as WingsTemplate;
                    resolve(ntpl);
                },
                onError: function () {
                    reject("Cannot elaborate template");
                }
            },
            data
        );
    });
};

const _getComponentBindings = (tpl: WingsTemplatePackage) => {
    const cbindings: Record<string, string> = {};
    for (const nid in tpl.template.Nodes) {
        const c = tpl.template.Nodes[nid].componentVariable;
        cbindings[c.id] = c.binding.id;
    }
    return cbindings;
};

export const expandAndRunWingsWorkflow = async (
    tpl: WingsTemplatePackage,
    dataBindings: WingsDataBindings,
    parameterBindings: WingsParameterBindings,
    parameterTypes: WingsParameterBindings,
    config: MintPreferences
): Promise<string> => {
    const config_wings = config.wings;
    return new Promise<string>((resolve, reject) => {
        // Get url prefix for operations
        const purl =
            config_wings.server + "/users/" + config_wings.username + "/" + config_wings.domain;
        const data = {
            templateId: tpl.template.id,
            parameterBindings: parameterBindings,
            parameterTypes: parameterTypes,
            componentBindings: _getComponentBindings(tpl),
            dataBindings: dataBindings
        };
        postJSONResource(
            {
                url: purl + "/executions/expandAndRunWorkflow",
                onLoad: function (e) {
                    const runid = e.target.responseText;
                    if (runid) {
                        resolve(runid);
                    } else {
                        reject("Could not run workflow");
                    }
                },
                onError: function () {
                    reject("Cannot run workflow");
                }
            },
            data
        );
    });
};

export const fetchWingsRunsStatuses = (
    template_name: string,
    start_time: number,
    total_runs: number,
    config: MintPreferences
): Promise<WingsRunStatuses> => {
    return new Promise<WingsRunStatuses>((resolve) => {
        let statuses: WingsRunStatuses = {};
        const promises = [];
        for (let i = 0; i < total_runs; i += 500) {
            promises.push(_fetchWingsRunsStatuses(template_name, start_time, i, 500, config));
        }
        Promise.all(promises).then((vals) => {
            vals.map((val) => {
                statuses = Object.assign({}, statuses, val);
            });
            resolve(statuses);
        });
    });
};

const _fetchWingsRunsStatuses = (
    template_name: string,
    start_time: number,
    start: number,
    limit: number,
    config: MintPreferences
): Promise<WingsRunStatuses> => {
    const config_wings = config.wings;
    return new Promise<WingsRunStatuses>((resolve, reject) => {
        const purl =
            config_wings.server + "/users/" + config_wings.username + "/" + config_wings.domain;
        getResource({
            url:
                purl +
                "/executions/getRunListSimple?pattern=" +
                template_name +
                "&start=" +
                start +
                "&limit=" +
                limit +
                "&sort=startTime&dir=ASC&started_after=" +
                start_time,
            onLoad: function (e) {
                const runsjson = JSON.parse(e.target.responseText);
                if (runsjson.success) {
                    const statuses: WingsRunStatuses = {};
                    const runslist: Array<{ id: string; runtimeInfo: WingsRunStatuses[string] }> =
                        runsjson.rows;
                    runslist.map((runjson) => {
                        const runid = runjson.id;
                        statuses[runid] = runjson.runtimeInfo;
                    });
                    resolve(statuses);
                }
            },
            onError: function () {
                reject("Cannot fetch runs");
            }
        });
    });
};

export const fetchWingsRunResults = (
    execution: Execution,
    config: MintPreferences
): Promise<Record<string, WingsRunFile>> => {
    const config_wings = config.wings;
    return new Promise<Record<string, WingsRunFile>>((resolve, reject) => {
        const purl =
            config_wings.server + "/users/" + config_wings.username + "/" + config_wings.domain;
        if (!execution.runid) {
            reject();
            return;
        }

        const data = {
            run_id: execution.runid
        };
        postFormResource(
            {
                url: purl + "/executions/getRunPlan",
                onLoad: function (e) {
                    const ex = JSON.parse(e.target.responseText);
                    if (execution.status == "SUCCESS") {
                        // Look for outputs that aren't inputs to any other steps
                        const outputfiles: Record<string, WingsRunFile> = {};
                        ex.plan.steps.map((step: WingsRunStep) => {
                            step.outputFiles.map((file) => {
                                outputfiles[file.id] = file;
                            });
                        });
                        ex.plan.steps.map((step: WingsRunStep) => {
                            step.inputFiles.map((file) => {
                                delete outputfiles[file.id];
                            });
                        });
                        resolve(outputfiles);
                    }
                },
                onError: function () {
                    reject("Cannot get run details");
                }
            },
            data
        );
    });
};

export const fetchWingsRunLog = (runid: string, config: MintPreferences): Promise<string> => {
    const config_wings = config.wings;
    return new Promise<string>((resolve, reject) => {
        const purl =
            config_wings.server + "/users/" + config_wings.username + "/" + config_wings.domain;
        const data = {
            run_id: runid
        };
        postFormResource(
            {
                url: purl + "/executions/getRunDetails",
                onLoad: function (e) {
                    try {
                        const response = JSON.parse(e.target.responseText);
                        const ex = response.execution;
                        let log = ex.runtimeInfo.log;
                        log += "\n----------------------------------------------\n";
                        ex.queue.steps.map((step: WingsQueueStep) => {
                            log += step.id.replace(/.*#/, "") + "\n";
                            log += step.runtimeInfo.log;
                            log += "\n----------------------------------------------\n";
                        });
                        resolve(log);
                    } catch (e) {
                        reject();
                    }
                },
                onError: function () {
                    reject("Cannot get run details");
                }
            },
            data
        );
    });
};

export const createSingleComponentTemplate = (
    comp: WingsComponent,
    config: MintPreferences
): WingsTemplate => {
    const config_wings = config.wings;
    const cname = comp.id.replace(/^.+#/, "");
    const exurl =
        config_wings.export_url +
        "/export/users/" +
        config_wings.username +
        "/" +
        config_wings.domain;
    const tname = "workflow_" + cname;
    const tns = exurl + "/workflows/" + tname + ".owl#";
    const tid = tns + tname;

    const storage = config_wings.storage;
    const dotpath = config_wings.dotpath;
    const ontpfx = config_wings.onturl;

    const clibns = exurl + "/components/library.owl#";
    const usfx = "/users/" + config_wings.username + "/" + config_wings.domain;
    const pdir = storage + usfx;

    const tpl: WingsTemplate = {
        id: tid,
        Nodes: {},
        Links: {},
        Variables: {},
        inputRoles: {},
        outputRoles: {},
        onturl: ontpfx + "/workflow.owl",
        wflowns: ontpfx + "/workflow.owl#",
        version: 0,
        subtemplates: {},
        metadata: {
            documentation: "",
            contributors: []
        } as WingsTemplateMetadata,
        rules: {},
        props: {
            "lib.concrete.url": exurl + "/components/library.owl",
            "lib.domain.execution.url": exurl + "/executions/library.owl",
            "lib.domain.code.storage": pdir + "/code/library",
            "domain.workflows.dir.url": exurl + "/workflows",
            "user.id": config_wings.username,
            "tdb.repository.dir": storage + "/TDB",
            "viewer.id": config_wings.username,
            "domain.executions.dir.url": exurl + "/executions",
            "lib.domain.data.url": exurl + "/data/library.owl",
            "ont.domain.data.url": exurl + "/data/ontology.owl",
            "lib.abstract.url": exurl + "/components/abstract.owl",
            "lib.provenance.url": config_wings.export_url + "/export/common/provenance/library.owl",
            "ont.data.url": ontpfx + "/data.owl",
            "lib.domain.data.storage": pdir + "/data",
            "lib.domain.workflow.url": exurl + "/workflows/library.owl",
            "lib.resource.url": config_wings.export_url + "/export/common/resource/library.owl",
            "ont.component.url": ontpfx + "/component.owl",
            "ont.workflow.url": ontpfx + "/workflow.owl",
            "ont.dir.url": ontpfx,
            "dot.path": dotpath,
            "ont.domain.component.ns": clibns,
            "ont.execution.url": ontpfx + "/execution.owl",
            "ont.resource.url": ontpfx + "/resource.owl"
        }
    };

    const nodeid = tns + cname + "_node";
    const inputPorts: IdMap<WingsPort> = {};
    const outputPorts: IdMap<WingsPort> = {};

    comp.inputs.map((arg) => {
        const portid = nodeid + "_" + arg.role;
        inputPorts[portid] = {
            id: portid,
            role: {
                type: arg.isParam ? 2 : 1,
                roleid: arg.role,
                dimensionality: arg.dimensionality,
                id: portid + "_role"
            } as WingsPortRole
        };
        const varid = tns + arg.role;
        tpl.Variables[varid] = {
            id: varid,
            type: arg.isParam ? 2 : 1
        } as WingsDataVariable | WingsParameterVariable;

        tpl.inputRoles[varid] = {
            type: arg.isParam ? 2 : 1,
            roleid: portid,
            dimensionality: arg.dimensionality,
            id: varid + "_trole"
        };

        const linkid = portid + "_input";
        tpl.Links[linkid] = {
            id: linkid,
            toNode: { id: nodeid },
            toPort: { id: portid },
            variable: { id: varid }
        };
    });
    comp.outputs.map((arg) => {
        const portid = nodeid + "_" + arg.role;
        outputPorts[portid] = {
            id: portid,
            role: {
                type: arg.isParam ? 2 : 1,
                roleid: arg.role,
                dimensionality: arg.dimensionality,
                id: portid + "_role"
            } as WingsPortRole
        };
        const varid = tns + arg.role;
        tpl.Variables[varid] = {
            id: varid,
            type: arg.isParam ? 2 : 1
        } as WingsDataVariable | WingsParameterVariable;

        tpl.outputRoles[varid] = {
            type: arg.isParam ? 2 : 1,
            roleid: portid,
            dimensionality: arg.dimensionality,
            id: varid + "_trole"
        };

        const linkid = portid + "_output";
        tpl.Links[linkid] = {
            id: linkid,
            fromNode: { id: nodeid },
            fromPort: { id: portid },
            variable: { id: varid }
        };
    });

    const node: WingsNode = {
        id: nodeid,
        componentVariable: {
            id: nodeid + "_comp",
            isConcrete: true,
            binding: {
                id: comp.id,
                type: "uri"
            },
            type: 3
        } as WingsComponentVariable,
        inputPorts: inputPorts,
        outputPorts: outputPorts,
        crule: {
            type: "WTYPE"
        },
        prule: {
            type: "STYPE"
        }
    };
    tpl.Nodes[nodeid] = node;

    return tpl;
};

/* WCM API based Wings calls */
export const registerWingsComponent = async (
    name: string,
    uri: string,
    config: MintPreferences
): Promise<string> => {
    const config_wings = config.wings;
    const data = {
        id: name,
        model_catalog_uri: uri,
        wings_instance: {
            server: config_wings.server,
            export_url: config_wings.export_url,
            domain: config_wings.domain,
            username: config_wings.username,
            password: config_wings.password
        }
    };
    return new Promise<string>((resolve, reject) => {
        postJSONResource(
            {
                url: config.wings_api + "/components",
                onLoad: function (e) {
                    const compjson = JSON.parse(e.target.responseText);
                    resolve(compjson.id);
                },
                onError: function () {
                    reject("Cannot create component");
                }
            },
            data
        );
    });
};

export const registerWingsDataset = async (
    dcid: string,
    name: string,
    type: string,
    uri: string,
    config: MintPreferences
): Promise<void> => {
    const config_wings = config.wings;
    const data = {
        data_catalog_id: dcid,
        id: name,
        type: type,
        url: uri,
        wings_instance: {
            server: config_wings.server,
            export_url: config_wings.export_url,
            domain: config_wings.domain,
            username: config_wings.username,
            password: config_wings.password
        }
    };
    return new Promise<void>((resolve, reject) => {
        postJSONResource(
            {
                url: config.wings_api + "/datasets",
                onLoad: function () {
                    resolve();
                },
                onError: function () {
                    reject("Cannot create component");
                }
            },
            data
        );
    });
};

const _createModelTemplate = (cname: string, prefs: MintPreferences): Promise<string> => {
    return new Promise((resolve) => {
        const config = prefs.wings;
        const expfx = config.export_url + "/export/users/" + config.username + "/" + config.domain;

        const tname = "workflow_" + cname;
        const tns = expfx + "/workflows/" + tname + ".owl#";
        const tid = tns + tname;

        fetchWingsTemplatesList(prefs).then((list) => {
            if (list.indexOf(tid) >= 0) {
                //console.log(tid + " template already exists");
                resolve(tid);
            } else {
                // Create template
                fetchWingsComponent(cname, prefs).then((comp) => {
                    const tpl = createSingleComponentTemplate(comp, prefs);
                    layoutWingsTemplate(tpl, prefs).then((tpl_package) => {
                        saveWingsTemplate(tpl_package, prefs).then(() => {
                            console.log("Template saved as " + tpl.id);
                            resolve(tpl.id);
                        });
                    });
                });
            }
        });
    });
};

const _runModelTemplates = (
    seeds: WingsTemplateSeed[],
    tpl_package: WingsTemplatePackage,
    prefs: MintPreferences
): Promise<string[]> => {
    const config = prefs.wings;
    const expfx = config.export_url + "/export/users/" + config.username + "/" + config.domain;
    return Promise.all(
        seeds.map((seed) => {
            const tns = seed.tid.replace(/#.*$/, "#");

            const dataBindings = {} as WingsDataBindings;
            const parameterBindings = {} as WingsParameterBindings;
            const parameterTypes = {} as WingsParameterTypes;
            for (const varname in seed.datasets) {
                const varid = tns + varname;
                dataBindings[varid] = seed.datasets[varname].map(
                    (ds: string) => expfx + "/data/library.owl#" + ds
                );
            }
            for (const varname in seed.parameters) {
                const varid = tns + varname;
                parameterBindings[varid] = seed.parameters[varname];
                parameterTypes[varid] =
                    "http://www.w3.org/2001/XMLSchema#" + seed.paramtypes[varname];
            }

            return expandAndRunWingsWorkflow(
                tpl_package,
                dataBindings,
                parameterBindings,
                parameterTypes,
                prefs
            );
        })
    );
};

export const setupModelWorkflow = async (model: Model, thread: Thread, prefs: MintPreferences) => {
    const cname = model.model_configuration;
    const compid = await registerWingsComponent(cname, model.code_url, prefs);
    const compname = compid.replace(/^.*#/, "");
    const templateid = await _createModelTemplate(compname, prefs);
    return templateid;
};

export const runModelExecutions = async (
    thread: Thread,
    executions: Execution[],
    existing_registered_resources: Record<string, string[]>,
    tpl_package: WingsTemplatePackage,
    prefs: MintPreferences
) => {
    const registerDatasetPromises = [];
    const seeds: WingsTemplateSeed[] = [];
    const registered_resources: Record<string, string[]> = {};

    // Get all input dataset bindings and parameter bindings
    executions.map((execution) => {
        const model = thread.models[execution.modelid];
        const bindings = execution.bindings;
        const datasets: WingsTemplateSeed["datasets"] = {};
        const parameters: WingsTemplateSeed["parameters"] = {};
        const paramtypes: WingsTemplateSeed["paramtypes"] = {};

        // Get input datasets
        model.input_files.map((io) => {
            let resources: DataResource[] = [];
            if (bindings[io.id]) {
                // We have a dataset binding from the user for it
                resources = [bindings[io.id] as DataResource];
            } else if (io.value) {
                // There is a hardcoded value in the model itself
                resources = io.value.resources;
            }
            if (resources.length > 0) {
                const type = io.type.replace(/^.*#/, "");
                resources.map((res) => {
                    if (res.url) {
                        res.name = res.url.replace(/^.*(#|\/)/, "");
                        res.name = res.name.replace(/^([0-9])/, "_$1");
                        if (!res.id) res.id = res.name;
                    }
                    if (!existing_registered_resources[res.id]) {
                        registered_resources[res.id] = [res.name, type, res.url];
                    }
                });
                datasets[io.name] = resources.map((res) => res.name);
            }
        });

        // Get Input parameters
        model.input_parameters.map((ip) => {
            if (ip.value) {
                parameters[ip.name] = ip.value;
            } else if (bindings[ip.id]) {
                const value = bindings[ip.id];
                parameters[ip.name] = value as string;
            }
            paramtypes[ip.name] = ip.type;
        });

        seeds.push({
            tid: tpl_package.template.id,
            datasets: datasets,
            parameters: parameters,
            paramtypes: paramtypes
        } as WingsTemplateSeed);
    });

    // Register any datasets that need to be registered
    for (const resid in registered_resources) {
        const args = registered_resources[resid];
        existing_registered_resources[resid] = args;
        registerDatasetPromises.push(registerWingsDataset(resid, args[0], args[1], args[2], prefs));
    }

    // Register all datasets
    if (registerDatasetPromises.length > 0) await Promise.all(registerDatasetPromises);

    const runids = await _runModelTemplates(seeds, tpl_package, prefs);
    return runids;
};

export const matchVariables = (variables1: string[], variables2: string[], fullmatch: boolean) => {
    let matched = fullmatch ? true : false;
    variables1.map((var1compound) => {
        var1compound.split(/\s*,\s/).map((var1) => {
            if (!fullmatch && variables2.indexOf(var1) >= 0) {
                matched = true;
            }
            if (fullmatch && variables2.indexOf(var1) < 0) {
                matched = false;
            }
        });
    });
    return matched;
};
