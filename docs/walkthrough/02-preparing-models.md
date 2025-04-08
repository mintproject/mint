## Preparing models

In the **prepare models** section, you can explore the MINT model catalog using the browse and compare capabilities.
You can also add and edit your own models and configure them to work for specific regions and parameters.
![Prepare models](figures/walkthrough/07a.png "Prepare models")

Let's start exploring the model catalog by clicking on _Browse Models_

### Exploring models

The _model browser_ shows a preview of all models in the catalog and allows you to search for them by indicator, variable, region, and more.

The model preview shows the model icon and basic model information. Clicking on _More details_ will display the model's full information.
![Model explore](figures/walkthrough/08.png "Model explore")

This page shows all the information related to the model.
As default, it shows the latest model configuration, but you can change to a specific configuration and setup with the top selectors.

After that, we can see basic model metadata and below several tabs with more details.
![Model view](figures/walkthrough/09.png "Model view")

The _overview tab_ shows the model purpose, assumptions, and other non-configuration specific data.
![Overview](figures/walkthrough/10.png "Overview")

And a preview of the selected configuration and setup. Relevant information is presented for each case.
![Overview config and setup](figures/walkthrough/11.png "Overview config and setup")

The _Inputs and Outputs tab_ shows all the inputs and parameters necessary to run this configuration, and the outputs that this model generates.
If a setup is selected, this tab also shows the values pre-selected for that configuration setup.
![IO Tab - Parameters](figures/walkthrough/12.png "IO Tab - Parameters")
![IO Tab - Input Files](figures/walkthrough/13.png "IO Tab - Input Files")
![IO Tab - Output Files](figures/walkthrough/14.png "IO Tab - Output Files")

The _Variables tab_ shows all the variables that each file specification requires for this model configuration.
![Variables tab](figures/walkthrough/15.png "Variables tab")

Clicking on the input file name shows a table with all the variables for that file.
![Variables tab expanded](figures/walkthrough/16.png "Variables tab expanded")

The _Example tab_ shows an example written for this model configuration.
Examples are written in `markdown` and support the addition of images.
![Example tab](figures/walkthrough/17.png "Example tab")
![Example tab 2](figures/walkthrough/17a.png "Example tab 2")

The _Technical information tab_ collects all the information needed to run this model, configuration and setup.
This includes the direct command to run this model using DAME.
![Tech tab](figures/walkthrough/18.png "Tech tab")

### Comparing models

To compare models, go to the **prepare models** section and click on _compare models_.
![Prepare models 2](figures/walkthrough/07e.png "Prepare models 2")

A list of all models, versions, configurations, and setups of the MINT model catalog will be shown on the left.
Clicking on their names will add them to the comparison table.
![comparison 1](figures/walkthrough/40.png "comparison 1")

You can compare setup specific data too:
![comparison 2](figures/walkthrough/40a.png "comparison 2")

### Adding models and versions

To add new models and versions to your catalog, go to the **prepare models** section and click on _add models_.
![Prepare models 3](figures/walkthrough/07b.png "Prepare models 3")

The _add models_ page presents a form that can be filled out to add a new model to the catalog.
Some information should be provided as text, but more complex resources are defined through specific forms.
You will see an _edit button_ to the right of each model catalog resource.
!["Add models"](figures/walkthrough/19.png "Add models")

Clicking this edit button opens a new dialog. Here you can select resources already in the catalog or edit/create new ones.
![](figures/walkthrough/20.png)
When creating a new resource, a specific form with all necessary information will appear.
Fill it up to create a new resource. For this example, a new category only needs a name and description.
![](figures/walkthrough/21.png)

More complex resources have more detailed previews, but follow the same principles for creating, editing, and removing them.
![](figures/walkthrough/22.png)
Creating complex resources requires more information. This is the form to add a new grid specification to the model catalog.
![](figures/walkthrough/23.png)

Once a model has been created, you can edit it by going to the **prepare models** section and clicking on _edit models_:
![](figures/walkthrough/07c.png)

The _edit models_ page shows a tree on the left with all models and versions defined in the model catalog.
Versions are a way to group configurations that share the same software revision.
Models are organized by category and all versions are grouped under their corresponding model.

On the right you can see a preview of the model. Clicking on the edit button will make it editable.
![](figures/walkthrough/24.png)

In edit mode, you will see an interface very similar to the _add models_ page we have seen before.
![](figures/walkthrough/25.png)

### Adding model configurations and setups

To add new model configurations and setups, we need to go back to the **prepare models** section and click on
_configure models_:
![](figures/walkthrough/07d.png)

The _configure models_ page presents a tree similar to the one we have seen on _edit models_, but this time
two more levels are added: Model configurations (green) below versions and setups (blue) below configurations.
![](figures/walkthrough/26.png)

A configuration refers to a specific software running with a specific set of parameters and files.
You can click on the _expand button_ to better see the information this configuration provides.
![](figures/walkthrough/27.png)
For input parameters, a configuration provides their description, order, default values and other important metadata.
![](figures/walkthrough/28.png)
For input and output files, a description of all the variables that this file must contain is expected.
![](figures/walkthrough/29.png)

You can add a new configuration by clicking _add new configuration_ or edit an existing one by clicking _edit_.
![](figures/walkthrough/30.png)
You can add, edit or remove parameters for this configuration.
![](figures/walkthrough/31.png)
Clicking on the edit parameters button will display a specific form to add parameters for configurations.
![](figures/walkthrough/32.png)

The same applies to input and output files:
![](figures/walkthrough/33.png)
![](figures/walkthrough/34.png)
Once we have finished creating our configuration, we can create a _new setup_ for this configuration.

We call the most inner level of a configuration a **setup**.
A setup is a configuration with specific values for parameters and files.

You can create or select an existing setup by clicking on the left panel:
![](figures/walkthrough/35.png)
This page is similar to the one used to edit configurations, but changes what you can do with parameters and files.

In a setup, you can not add nor remove parameters nor files. You can only set specific values for each.
![](figures/walkthrough/36.png)
![](figures/walkthrough/37.png)
For parameters, you can set a pre-selected value or mark the parameter as adjustable for the user on the **modeling** step.
![](figures/walkthrough/38.png)
For input files, you can set a specific file or collections of files to be pre-selected for the **modeling** step.
![](figures/walkthrough/39.png)
