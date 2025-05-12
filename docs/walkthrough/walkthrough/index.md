# Prepare Data

This guide explains how to add data to MINT. There are two main options for adding datasets:

1. [MINT Data Catalog](03-1-preparing-data-mint-catalog.md) - Add data directly through the MINT platform's integrated interface
2. [CKAN - TACC Deployment](03-1-preparing-data-ckan.md) - Use the open-source data management system to host and share datasets

## Key Requirements

Regardless of which method you choose, there are some important requirements to keep in mind:

### Spatial Coverage

Each dataset must include a spatial coverage field as a GeoJSON object describing the geographic area covered by the dataset.

### MINT Standard Variables

Each resource must specify at least one MINT Standard Variable to ensure interoperability and consistency across datasets.

For more information about standard variables, refer to the [list of standard variables](https://w3id.org/mint/modelCatalog#Variable) and the MINT documentation.
