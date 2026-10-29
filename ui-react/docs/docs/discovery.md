# Find models and data

Look at models and data before you commit to a setup. A model that fits your question needs inputs you can actually supply, and a dataset that fits needs to cover your place, period and variable. You do not need to sign in to browse.

## Search for models

1. Open **Models → Browse Models**.
2. Type part of a name in the filter box, or narrow the list with **Region**, **Category** and **Output variable**. Use the output variable when you know what you need to produce.
3. Select a model to open its configurations, then select a configuration to read its details.

![Animation: typing "hand" into the model filter, then selecting the HAND model configuration to see its inputs and outputs](assets/images/model-search.gif)

On a configuration's details, check three things before you choose it. Read the description to see what it was built for. Read the **Inputs** to see what data it needs, in which format and unit, and whether each input is required. Read the **Outputs** to confirm it produces what you want. Mismatched inputs are the most common reason a setup fails later, so it is worth checking now.

![The Models page with a configuration selected, showing its description, authors, and inputs](assets/images/models-detail.png)

## Search for datasets

1. Open **Datasets → Browse**.
2. Type a phrase such as "groundwater", or the name of a variable.
3. Narrow the results with the **Temporal coverage** sliders, or select **Draw box** and draw an area on the map to keep only data that overlaps it.

![Animation: typing "groundwater" into the dataset search box on the Datasets page](assets/images/dataset-search.gif)

Use the time and map filters, because a dataset that does not cover your place and period cannot answer your question, however well it matches the topic. The count above the results tells you how many datasets remain.

![The Datasets page, with the search box, temporal coverage sliders, and spatial coverage map](assets/images/datasets-browse.png)

Each result lists the source, the coverage, the format and a set of tags. The tags are the standard variables in the data. Match them against the inputs of the model you plan to use.

You can also open **Datasets → Search Datasets** to search by source name, keyword or variable name.

![The Search Datasets page, with a search box and a Dataset names selector](assets/images/datasets-search.png)

## Look up a variable

If a term is unfamiliar, open **Variables**. It lists the shared variable names with their categories and units. Search by name or filter by category. Use it when you need to know exactly what a model input or a dataset tag means.

![The Explore Variables page with a searchable table of standard variables](assets/images/variables.png)

## Browse by region

Open **Regions** to see the geographic areas DYNAMO knows about, grouped by category such as agricultural or hydrological regions. Models and datasets can be linked to a region, so choosing a region is a quick way to see only what applies to your place.

![The Regions overview page, listing region categories](assets/images/regions.png)

The **Region Editor** shows the same regions on a map, grouped by administrative level. Open it if you need to check exactly where a region is.

![The Region Editor, with the administrative levels and a map of existing regions](assets/images/region-editor.png)

Before you decide that two things fit together, check the model's full list of inputs and the dataset's coverage, not just the topic.
