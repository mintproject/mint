MINT supports CKAN as a data catalog. CKAN is a powerful data management system that makes data accessible by providing tools to streamline publishing, sharing, finding, and using data. CKAN is aimed at data publishers (national and regional governments, companies, and organizations) wanting to make their data open and available.

## Features

MINT CKAN provides the following features:

- Query and search for datasets
- View dataset metadata
- Publish datasets and resources from the execution of a workflow

## Configuration

The CKAN configuration is stored in the `values.yaml` file in the `mint` directory. The `values.yaml` file contains the following sections:

```yaml
external_services:
  ckan:
    # -- Enable or disable CKAN service
    enabled: true
    # -- CKAN url
    url: "http://localhost:5000"
    # -- CKAN service type
    type: "CKAN"
    extra:
      # -- Owner organization ID for CKAN service
      owner_organization_id: ""
      # -- Owner provenance ID for CKAN service
      owner_provenance_id: ""``
secrets:
  external_services:
    ckan:
      # -- API key for CKAN service. Used by Ensemble Manager to upload data
      api_key: CHANGEME
```
