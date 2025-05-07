# Prepare Data: MINT Data Catalog

This guide explains how to add data to MINT using the MINT Data Catalog.

## Adding Data via MINT Data Catalog

The MINT Data Catalog is an integrated interface within the MINT platform that allows you to upload, describe, and manage datasets for use in modeling and analysis workflows.

### 1. Spatial Coverage

Each dataset must include a spatial coverage field. This is typically a GeoJSON object describing the geographic area covered by the dataset. For example:

```json
{
  "type": "Polygon",
  "coordinates": [
    [
      [-98.0, 30.3],
      [-97.5255, 30.3],
      [-97.5255, 30.155],
      [-98.0, 30.155],
      [-98.0, 30.3]
    ]
  ]
}
```

### 2. MINT Standard Variables

Each resource in the dataset must specify at least one MINT Standard Variable. These are standardized variable names used within the MINT platform to ensure interoperability and consistency across datasets. For example:

```
groundwater__initial_head
```

## Implementation Steps

1. Log in to the MINT platform
2. Navigate to the Data Catalog section
3. Click "Add New Dataset"
4. Fill in the required metadata
5. Add the spatial coverage information
6. Upload your data files
7. Specify the MINT Standard Variables for each resource
8. Review and publish your dataset

For more information, refer to the [list of standard variables](https://w3id.org/mint/modelCatalog#Variable) and the MINT documentation.
