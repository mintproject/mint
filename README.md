# MINT

This repository provides an entry point to the services and tools included in the MINT framework, including a pointer to their latest release or DOI. This page can also be browsed at [https://mintproject.github.io/mint](https://mintproject.github.io/mint).

More detailed information about the features and servicesin MINT can be found in the project website: [http://mint-project.info/](http://mint-project.info/)

## Documentation

All the documentation for the MINT framework can be found in the [MINT documentation page](https://mintproject.readthedocs.io/en/latest/).

## Testing on local machine

To test the MINT services on your local machine, we **strongly** recommend using the [microk8s](https://microk8s.io/) Kubernetes distribution. Follow the instructions in the [microk8s documentation](https://microk8s.io/#install-microk8s) to install microk8s on your machine.

### Microk8s Installation and Setup

Tested on MacOS (arm64) and microk8s 1.28/stable.
Tested on Ubuntu 22.04 (amd64) and microk8s 1.28/stable.

#### Before starting, ensure you have

Sudo/Administrator access on the target machine.

Snapd (for Linux) or Multipass/Docker Desktop (for Windows/macOS).

Helm 3 (Included in MicroK8s).

### Microk8s installation

Install the microk8s using the following command:

#### Linux (Ubuntu/Debian/CentOS)

MicroK8s runs natively on Linux. This is the recommended environment for production-like testing.

```bash
# Install MicroK8s
sudo snap install microk8s --classic --channel=1.35

# Fix Permissions (replace $USER if necessary)
sudo usermod -a -G microk8s $USER
mkdir -p ~/.kube
chmod 0700 ~/.kube
sudo chown -R $USER ~/.kube

# Apply group changes without logging out
newgrp microk8s
```

#### MacOS (Intel & Apple Silicon)

MicroK8s uses a lightweight VM via Multipass.

Download the MicroK8s Installer for macOS.

For Apple Silicon (M1/M2/M3), ensure you follow the ARM instructions in the "MINT Services" section.


#### Windows 10/11

Download the [MicroK8s Installer for Windows](https://canonical.com/microk8s/docs/install-windows).

Ensure WSL2 is enabled.

Use PowerShell to run commands (prefixing with microk8s if not aliased).



### Cluster Setup & Addons

Enable the core components required for MINT to route traffic and manage storage:

```console
microk8s enable dns
microk8s enable dashboard
microk8s enable hostpath-storage
microk8s enable ingress
```

### Test Microk8s

To test, list the existing resources. It should be list multiple services, deployments, and pods. Please wait until all the resources are up and running.

```bash
microk8s kubectl get all --all-namespaces
```

Verify the node status

```bash
microk8s kubectl get nodes
```


### Install Portainer for MicroK8s (Optional)

Portainer serves as a supervisor of your pods, where you can see and configure them graphically. 

```bash
microk8s enable community
microk8s enable portainer
```
To see the status:

```bash
microk8s status --wait-ready
microk8s kubectl get svc -n portainer
```

+ Access: `https://<YOUR_SERVER_IP>:30779`

+ Default Port: `30779` (NodePort)

--- 

### MINT services installation

Use the following commands to install the MINT services:

#### Option A: Standard x86_64 (Intel/AMD)

```bash
microk8s helm repo add mint https://mintproject.github.io/mint
microk8s helm repo update
microk8s helm install testing-mint mint/MINT --namespace mint --create-namespace
```


#### Option B: ARM64 (Apple Silicon / ARM Servers)

```bash
microk8s helm repo add mint https://mintproject.github.io/mint
microk8s helm repo update
microk8s helm install testing-mint mint/MINT --namespace mint --create-namespace --set arm_support=true
```

If you using MacOS Silicon, you need to install the `arm64` version of the postgresql database.

**WARNING:** The arm64 image has not been tested and may not work as expected. Please use it at your own risk.

---

### Networking & Remote Access

Helm will returns the URL to access the MINT services after installation.

```bash
The MINT system has been installed!

Please remember to edit your `/etc/hosts/`

After that, you can access to the MINT services


http://mint.local
http://ensemble-manager.mint.local
http://cromo.mint.local
http://mic.mint.local
http://datacatalog.mint.local
```

Since MINT uses subdomains (e.g., mint.local), you must map the server's IP to these hostnames on your local computer's host file.


1. Identify Server IP


If you are using microk8s on a VM, need to get the IP address of the VM to access the MINT services. You can use the following command to get the IP address of the VM:

```bash
microk8s kubectl get node -o json | jq '.items[].status.addresses[] | select(.type=="InternalIP") | .address'
```

If accessing via Public IP (Cloud), use that IP instead.

2. Update Hosts File (On your Personal Computer)

| OS | Path | Command |
| --- | --- | --- |
| Linux/macOS | /etc/hosts | sudo nano /etc/hosts |
| Windows | C:\Windows\System32\drivers\etc\hosts | Open Notepad as Administrator |


```bash
sudo vim /etc/hosts
```


Add the following block (Replace `10.211.59.16` with your Server/VM IP):

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

### MINT services removal & reset

To remove the MINT services, use the following command:

```bash
microk8s helm uninstall testing-mint -n mint
microk8s kubectl delete pvc --all -n mint
```

Full MicroK8s Reset (Destructive):

```bash
microk8s reset
```

or

```bash
bash uninstall.sh
```

### Available Services

Once the pods are "Running" (check via Portainer or microk8s kubectl get pods -n mint), you can access:


+ Main Interface: http://mint.local

+ Data Catalog: http://datacatalog.mint.local

+ Model Catalog (MIC): http://mic.mint.local

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
