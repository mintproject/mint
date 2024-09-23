# Kubernetes

MINT can run models as job on Kubernetes clusters. This guide explains how to set up a Kubernetes cluster for MINT execution.

Configure the Kubernetes cluster in the `values.yaml`.

```yaml
external_services:
  kubernetes:
    # -- Enable or disable Kubernetes service to run jobs used by Ensemble Manager
    enabled: true
    # -- Kubernetes namespace
    namespace: 'default'
    # -- Job CPU limit
    cpu_limit: '256m'
    # -- Job memory limit
    memory_limit: '512Mi'
    # -- Toggle for node affinity. The job will be scheduled on the same node as the Ensemble Manager
    node_affinity: true
```
