# Install

MINT can be easily deployed on large Kubernetes clusters using Helm. Useful for production instances.

## Pre-requisites

- A Kubernetes `v1.16.3` cluster or later.
- Helm `v3.2.x` or later.

If you don't have a Kubernetes cluster and you want to test MINT, we **strongly** recommend to use [Microk8s](https://microk8s.io/) to create a local cluster on your machine. Follow the instructions in the [MINT](https://github.com/mintproject/mint/?tab=readme-ov-file#mint) to install Microk8s on your machine.

## Install MINT

Add the MINT Helm repository:

```bash
$ helm repo add mint https://mintproject.github.io/mint
```

Update the Helm repository:

```bash
$ helm repo update
```

Install MINT:

```bash
$ helm install mint mint/mint --namespace mint --create-namespace
```

If you using MacOS Silicon, you need to install the `arm64` version of the postgresql database.

**WARNING:** The arm64 image has not been tested and may not work as expected. Please use it at your own risk.

```bash
$ helm install mint mint/mint --namespace mint --create-namespace --set arm_support=true
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

If you are using microk8s on a VM (macOS or windows) need to get the IP address of the VM to access the MINT services. You can use the following command to get the IP address of the VM:

```bash
$ kubectl get node -o json | jq '.items[].status.addresses[] | select(.type=="InternalIP") | .address'
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

Got to the URL returned by Helm to access the MINT services.

The default username and password are:

- Username: `mint@isi.edu`
- Password: `mint123!`
