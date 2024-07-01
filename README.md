# MINT

This repository provides an entry point to the services and tools included in the MINT framework, including a pointer to their latest release or DOI. This page can also be browsed at [https://mintproject.github.io/mint](https://mintproject.github.io/mint).

More detailed information about the features and servicesin MINT can be found in the project website: [http://mint-project.info/](http://mint-project.info/)

## Documentation

All the documentation for the MINT framework can be found in the [MINT documentation page](https://mintproject.readthedocs.io/en/latest/).

## Testing on local machine

To test the MINT services on your local machine, we recommend using the [microk8s](https://microk8s.io/) Kubernetes distribution. Follow the instructions in the [microk8s documentation](https://microk8s.io/#install-microk8s) to install microk8s on your machine.

### Microk8s installation

Tested on MacOS (arm64) and microk8s 1.28/stable.
Tested on Ubuntu 22.04 (amd64) and microk8s 1.28/stable.

Install the microk8s using the following command:

```bash
$ microk8s install --memory 8
Support for 'multipass' needs to be set up. Would you like to do that now? [y/N]: y
```

Enable required addons:

```console
$ microk8s enable dns
$ microk8s enable dashboard
$ microk8s enable hostpath-storage
$ microk8s enable ingress
```

To test, list the existing resources. It should be list multiple services, deployments, and pods. Please wait until all the resources are up and running.

```bash
$ microk8s kubectl get all --all-namespaces
```

Verify the node status

```bash
$ microk8s kubectl get nodes
```

### MINT services installation

If you using MacOS Silicon, you need to install the `arm64` version of the postgresql database. Add the following lines in the `values.yaml` file

**WARNING:** The arm64 image has not been tested and may not work as expected. Please use it at your own risk.

```
arm_support: true
```

Use the following commands to install the MINT services:

```bash
$ microk8s helm repo add mint https://mintproject.github.io/mint
$ microk8s helm repo update
$ microk8s helm install testing-mint mint/mint --namespace mint --create-namespace -f values.yaml
```

Or use the following command to install the MINT services:

```bash
$ microk8s helm install -f ./values.yaml mint ./helm --namespace mint --create-namespace
```

Helm will returns the URL to access the MINT services. You can use the following command to get the URL:

```txt
The MINT system has been installed!

Please remember to edit your `/etc/hosts/`

After that, you can access to the MINT services


http://mint.local
http://ensemble-manager.mint.local
http://cromo.mint.local
http://mic.mint.local
http://datacatalog.mint.local
```

If you are using microk8s on a VM, need to get the IP address of the VM to access the MINT services. You can use the following command to get the IP address of the VM:

```bash
$ microk8s kubectl get node -o json | jq '.items[].status.addresses[] | select(.type=="InternalIP") | .address'
10.211.59.16
```

Then, edit the `/etc/hosts` file and add the following lines:

```bash
$ sudo vim /etc/hosts
```

Add the following lines (replace the IP address with the IP address of the VM):

```text
10.211.59.16 mint.local
10.211.59.16 cromo.mint.local
10.211.59.16 mic.mint.local
10.211.59.16 api.mic.mint.local
10.211.59.16 datacatalog.mint.local
10.211.59.16 endpoint.models.mint.local
10.211.59.16 graphql.mint.local
10.211.59.16 models.mint.local
10.211.59.16 api.models.mint.local
10.211.59.16 endpoint.models.mint.local
```

### MINT services removal

To remove the MINT services, use the following command:

```bash
$ helm uninstall mint -n mint
$ kubectl delete pvc --all  -n mint
$ kubectl delete jobs --all -n mint
```

or

```bash
bash uninstall.sh
```

## Developer documentation

This repository contains the helm charts for the MINT services. The helm charts are used to deploy the services in a Kubernetes cluster. The helm charts are organized in the following folders:

- `charts`: contains the helm templates for the MINT services
- `releases`: contains the helm releases for the MINT services

To release a new version of the MINT charts, follow the following steps:

1. Edit the `helm/Chart.yaml` file and update the `version` field.

2. Run the following command to package the helm charts:

```bash
make release
```

3. Commit the changes and push them to the repository.
