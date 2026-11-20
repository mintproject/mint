import * as k8s from "@kubernetes/client-node";
import { WriteStream } from "fs";
import * as stream from "stream";

const kc = new k8s.KubeConfig();

// FIXME: Should this be loaded from MINT config ?
kc.loadFromDefault();

const k8sApi = kc.makeApiClient(k8s.CoreV1Api);
const batchV1Api = kc.makeApiClient(k8s.BatchV1Api);
const k8sLogApi = new k8s.Log(kc);

async function get_ensemble_manager_node_name(namespace) {
    try {
        let em_podname = null;
        if (process.env.POD_NAME) {
            em_podname = process.env.POD_NAME;
        } else {
            const pods = await k8sApi.listNamespacedPod(namespace);
            for (const i in pods.body.items) {
                const pod = pods.body.items[i];
                const podname = pod.metadata.name;
                if (podname.match("ensemble-manager")) {
                    em_podname = podname;
                }
            }
        }
        if (em_podname != null) {
            const res = await k8sApi.readNamespacedPod(em_podname, namespace);
            return res.body.spec.nodeName;
        } else {
            console.error("Cannot get ensemble manager pod");
            return null;
        }
    } catch (err) {
        console.error("Error fetching pod info:", err);
        return null;
    }
}

function add_node_affinity(jobSpec, node_name) {
    if (!jobSpec.spec.template.spec.affinity) {
        jobSpec.spec.template.spec.affinity = {};
    }

    jobSpec.spec.template.spec.affinity.nodeAffinity = {
        requiredDuringSchedulingIgnoredDuringExecution: {
            nodeSelectorTerms: [
                {
                    matchExpressions: [
                        {
                            key: "kubernetes.io/hostname",
                            operator: "In",
                            values: [node_name]
                        }
                    ]
                }
            ]
        }
    };
    return jobSpec;
}

async function get_volumes_and_mounts(
    namespace,
    jobname,
    mountPath = null
): Promise<[Array<k8s.V1Volume>, Array<k8s.V1VolumeMount>]> {
    const volumes = [];
    const mounts = [];

    let ensemble_manager_pvc_name = "mint-ensemble-manager";
    let ensemble_manager_pvc_mount = "/home/node/app/data";
    if (mountPath) {
        ensemble_manager_pvc_mount = mountPath;
    } else if (process.env.ENSEMBLE_MANAGER_PVC_MOUNT) {
        ensemble_manager_pvc_mount = process.env.ENSEMBLE_MANAGER_PVC_MOUNT;
    }

    if (process.env.ENSEMBLE_MANAGER_PVC) {
        ensemble_manager_pvc_name = process.env.ENSEMBLE_MANAGER_PVC;
    } else {
        const pvcs = await k8sApi.listNamespacedPersistentVolumeClaim(namespace);
        for (const i in pvcs.body.items) {
            const pvc = pvcs.body.items[i];
            const pvcname = pvc.metadata.name;
            if (pvcname.match("ensemble-manager")) {
                ensemble_manager_pvc_name = pvcname;
            }
        }
    }

    const volume_name = jobname + "-volume";
    volumes.push({
        name: volume_name,
        persistentVolumeClaim: {
            claimName: ensemble_manager_pvc_name
        }
    });
    mounts.push({
        name: volume_name,
        mountPath: ensemble_manager_pvc_mount
    });
    return [volumes, mounts];
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const runKubernetesPod = async (
    namespace: string,
    jobname: string,
    cmd: string[],
    image: string,
    logstream: WriteStream,
    workingDirectory: string,
    use_node_affinity: boolean = false,
    cpu_limit: string = "200m",
    memory_limit: string = "2048Mi"
) => {
    const container_name = jobname + "-container";
    const [volumes, mounts] = await get_volumes_and_mounts(namespace, jobname);

    // Create the Job
    let jobManifest = {
        apiVersion: "batch/v1",
        kind: "Job",
        metadata: {
            name: jobname
        },
        spec: {
            template: {
                spec: {
                    volumes: volumes,
                    containers: [
                        {
                            name: container_name,
                            image: image,
                            command: cmd,
                            workingDir: workingDirectory,
                            resources: {
                                limits: {
                                    cpu: cpu_limit, // Limit the CPU usage to cpu_limit millicores
                                    memory: memory_limit // Limit the memory usage to memory_limit MiB
                                },
                                requests: {
                                    cpu: "100m", // Request at least 100 millicores of CPU
                                    memory: "64Mi" // Request at least 64 MiB of memory
                                }
                            },
                            volumeMounts: mounts
                        }
                    ],
                    restartPolicy: "Never"
                }
            },
            backoffLimit: 0
        }
    };

    if (use_node_affinity) {
        const em_node_name = await get_ensemble_manager_node_name(namespace);
        if (em_node_name) {
            jobManifest = add_node_affinity(jobManifest, em_node_name);
        }
    }

    let statusCode = 0;

    try {
        // Create Job
        await batchV1Api.createNamespacedJob(namespace, jobManifest);

        // Wait for a second, and check Pods for the Job
        await delay(1000);
        const jobpods = await k8sApi.listNamespacedPod(
            namespace,
            undefined,
            false,
            undefined,
            undefined,
            "job-name=" + jobname
        );

        // Get Pod Name
        let podname = null;
        for (const i in jobpods.body.items) {
            const pod = jobpods.body.items[i];
            podname = pod.metadata.name;
            break;
        }

        if (podname != null) {
            // Create logstream to write pod log
            const pod_log_stream = new stream.PassThrough();
            pod_log_stream.on("data", (chunk) => {
                logstream.write(chunk);
            });
            let started_log = false;

            let wait_for = 1000;
            try {
                await delay(wait_for);

                // Wait until the Pod is finished (Failed or Succeeded)
                for (;;) {
                    await delay(wait_for);

                    // Check the status of Pod
                    const res = await k8sApi.readNamespacedPodStatus(podname, namespace);
                    const status = res.body.status.phase;

                    if (status != "Pending" && !started_log) {
                        // Start logging
                        await k8sLogApi.log(namespace, podname, container_name, pod_log_stream, {
                            follow: true
                        });
                        started_log = true;
                    }

                    if (status == "Running") {
                        // If it is still running, then we wait again (for a bit longer time time)
                        wait_for = wait_for * 2;
                        if (wait_for > 60000) {
                            wait_for = 60000;
                        }
                    } else if (status == "Failed") {
                        statusCode = 1;
                        break;
                    } else if (status == "Succeeded") {
                        statusCode = 0;
                        break;
                    }
                }

                // Pod is finished. Delete Pod
                await k8sApi.deleteNamespacedPod(podname, namespace);
            } catch (err2) {
                logstream.write("StatusCode 2: Error: " + err2);
                statusCode = 2;
            }
        } else {
            logstream.write("StatusCode 4: Error: Could not find Pod for Job");
            statusCode = 4;
        }

        // Job is finished, delete Job
        await batchV1Api.deleteNamespacedJob(jobname, namespace);
    } catch (err) {
        logstream.write("StatusCode 3: Error: Could not create Job " + err);
        statusCode = 3;
    }
    // Return status code
    return statusCode;
};
