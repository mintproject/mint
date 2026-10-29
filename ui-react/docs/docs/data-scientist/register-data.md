# Register data

Datasets are added to DYNAMO through your organisation's data catalog, not through a form in DYNAMO. Ask your data catalog administrator to publish the dataset, and give them the details below. These details decide whether people can find your data and match it to a model, so send them together with the files.

For each file, provide:

- **What it measures.** One or more standard variables, from the [Variables](../discovery.md#look-up-a-variable) page. Without a variable the file cannot be matched to a model input, and it will not appear in DYNAMO at all.
- **The unit** each variable is measured in, so people can tell the data fits the model.
- **The file format.** An unrecognised or missing format can make a file look usable when it is not.
- **Where and when it applies.** Give the area it covers and the time range, so people can filter to data that fits their place and period.
- **Where it came from and who may use it.** State the source and license, so users can judge whether to trust and reuse it.
- **A description.** Say what the data contains and what it is for, in plain words.

If a file holds several variables, list all of them. Each one you list lets the data match another model input.

## Check it appeared

New data is not visible straight away. After it is published, the catalog needs to be refreshed before DYNAMO shows it. Ask your administrator to arrange that, then open **Datasets → Browse** and search for your dataset to confirm it is there.

![A dataset card showing its description, standard variable tags, source, coverage, and format](../assets/images/dataset-detail.png)

Check the card against what you supplied. The tags are your standard variables, and they are what let DYNAMO offer the dataset for a model input. If a tag is missing, the dataset will not be offered for that input, so ask your administrator to correct it. See [Why the details you enter matter](../reference/why-metadata.md).
