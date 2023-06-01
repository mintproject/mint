# MINT

This repository provides an entry point to the services and tools included in the MINT framework, including a pointer to their latest release or DOI. This page can also be browsed at [https://mintproject.github.io/mint](https://mintproject.github.io/mint).

More detailed information about the features and servicesin MINT can be found in the project website: [http://mint-project.info/](http://mint-project.info/)

## Documentation

All the documentation for the MINT framework can be found in the [MINT documentation page](https://mintproject.readthedocs.io/en/latest/).

## Developer documentation

This repository contains the helm charts for the MINT services. The helm charts are used to deploy the services in a Kubernetes cluster. The helm charts are organized in the following folders:

- `helm`: contains the helm templates for the MINT services
- `charts`: contains the helm charts for the MINT services

To release a new version of the MINT charts, follow the following steps:

1. Edit the `helm/Chart.yaml` file and update the `version` field.

2. Run the following command to package the helm charts:

```bash
make release
```

3. Commit the changes and push them to the repository.
