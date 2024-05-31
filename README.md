# MINT

This repository provides an entry point to the services and tools included in the MINT framework, including a pointer to their latest release or DOI. This page can also be browsed at [https://mintproject.github.io/mint](https://mintproject.github.io/mint).

More detailed information about the features and servicesin MINT can be found in the project website: [http://mint-project.info/](http://mint-project.info/)

## Documentation

All the documentation for the MINT framework can be found in the [MINT documentation page](https://mintproject.readthedocs.io/en/latest/).

## Testing on local machine

To test the MINT services on your local machine, we recommend using the [microk8s](https://microk8s.io/) Kubernetes distribution. Follow the instructions in the [microk8s documentation](https://microk8s.io/#install-microk8s) to install microk8s on your machine.

### Microk8s installation

Tested on MacOS (arm64) with microk8s 1.28/stable.

Install the microk8s using the following command:

```bash
$ microk8s install --memory 8
Support for 'multipass' needs to be set up. Would you like to do that now? [y/N]: y
```

Enable required addons:

```bash
$ microk8s enable dashboard hostpath-storage
```

Configure the kubectl to use the microk8s cluster

```bash
$ microk8s config > ~/.kube/config
```

To test, list the existing resources. It should be list multiple services, deployments, and pods. Please wait until all the resources are up and running.

```bash
$ kubectl get all --all-namespaces
```

Verify the node status

```bash
$ kubectl get nodes
```

### MINT services installation

If you using MacOS Silicon, you need to install the `arm64` version of the postgresql database. Add the following lines in the `values.yaml` file
WARNING: The arm64 image is not tested and may not work as expected. Please use it at your own risk.

```
arm_support: true
```

Use the following commands to install the MINT services:

````bash
$ helm install -f ./values.yaml mint ./helm --namespace mint --create-namespace
```

Helm will returns the URL to access the MINT services. You can use the following command to get the URL:

```bash
  export UI_PORT=$(kubectl get --namespace mint -o jsonpath="{.spec.ports[0].nodePort}" services mint-ui)
  export CROMO_PORT=$(kubectl get --namespace mint -o jsonpath="{.spec.ports[0].nodePort}" services mint-cromo)
  export DATA_CATALOG_PORT=$(kubectl get --namespace mint -o jsonpath="{.spec.ports[0].nodePort}" services mint-data-catalog)
  export HASURA_PORT=$(kubectl get --namespace mint -o jsonpath="{.spec.ports[0].nodePort}" services mint-hasura)
  export MODEL_CATALOG_API_PORT=$(kubectl get --namespace mint -o jsonpath="{.spec.ports[0].nodePort}" services mint-model-catalog)
  export MODEL_CATALOG_DATABASE_PORT=$(kubectl get --namespace mint -o jsonpath="{.spec.ports[1].nodePort}" services mint-model-catalog)
  export NODE_IP=$(kubectl get nodes --namespace mint -o jsonpath="{.items[0].status.addresses[0].address}")

  echo "MINT User Interface: http://$NODE_IP:$UI_PORT"
  echo "MINT Model Catalog API: http://$NODE_IP:$MODEL_CATALOG_API_PORT/v1.8.0/docs"
  echo "MINT Data Catalog: http://$NODE_IP:$DATA_CATALOG_PORT"
  echo "MINT Constraint Reasoning Over MOdels (CROMO): http://$NODE_IP:$CROMO_PORT"
  echo "MINT Database: http://$NODE_IP:$HASURA_PORT"
  echo "MINT Model Catalog Database: http://$NODE_IP:$MODEL_CATALOG_DATABASE_PORT"
```

### MINT services removal

To remove the MINT services, use the following command:

```bash
$ helm uninstall mint -n mint
$ kubectl delete pvc --all  -n mint
$ kubectl delete jobs --all -n mint
```

## Developer documentation

This repository contains the helm charts for the MINT services. The helm charts are used to deploy the services in a Kubernetes cluster. The helm charts are organized in the following folders:

- `helm`: contains the helm templates for the MINT services
- `charts`: contains the helm charts for the MINT services

To release a new version of the MINT charts, follow the following steps:

1. Edit the `helm/Chart.yaml` file and update the `version` field.

2. Run the following command to package the helm charts:

```bash
make release
````

3. Commit the changes and push them to the repository.
