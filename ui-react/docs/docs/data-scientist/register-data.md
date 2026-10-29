# Register data

Prepare stable resource locations, source and license information, file formats, scientific variables, units, spatial extent, and temporal coverage. Distinguish registering metadata from uploading or moving files.

The current source guide places general dataset publishing outside the React UI. The application’s CKAN/SVO runbook describes resource-level scientific-variable annotations and a synchronization step before discovery. Publishing a CKAN dataset alone does not establish DYNAMO discoverability.

## Why the annotations matter

Registering the dataset is not enough on its own. From the CKAN/SVO runbook, DYNAMO does not query CKAN live. A sync copies each **resource** into the catalog's own index, and it skips a resource unless it has both a URL and a non-empty `mint_standard_variables` value. Each variable name must also map to a registered standard variable, and an unmapped name is skipped with a warning. The resource's `format` is mapped to the format the adapter understands, and an unrecognised format is dropped without an error.

In practice that means:

- **Standard variables are what make data discoverable.** A resource with no usable `mint_standard_variables` never appears in the catalog, however good its description is.
- **One resource can declare several variables**, as a comma-separated list. Declare every variable the resource really contains, so it can match every model input that needs one.
- **Format and coverage decide fit.** A resource with the right variable but a missing or unknown format looks usable and is not. Spatial extent and time range let people filter to data that covers their region and period.
- **The sync must run.** A dataset published to CKAN is invisible to DYNAMO until the sync does, so ask the operator to run it after you publish and then confirm the dataset appears under **Datasets → Browse**.

![A dataset card showing its description, standard variable tags, source, coverage, and format](../assets/images/dataset-detail.png)

The tags on the card are the standard variables. They are what let the catalog offer this dataset for a model input. See [Why metadata matters](../reference/why-metadata.md).

Planned walkthrough: use the supported catalog workflow to register the dataset and resources, annotate meaning and coverage, arrange the required synchronization through the appropriate operator, and confirm discovery and model-input compatibility. Exact fields, permissions, and environment-specific steps remain to be verified. Do not infer a dataset-registration button in DYNAMO.
