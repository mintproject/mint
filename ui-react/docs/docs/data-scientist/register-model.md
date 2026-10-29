# Register a model

A model configuration is the record people find, compare and run. The form is short, but each section decides how your model is discovered. Read [Why metadata matters](../reference/why-metadata.md) first if you are new to standard variables.

Open **Models → Register Model Configuration**. You must be signed in. Anything you register is a description of your model, not the model itself: the executable lives where the component location points.

![The Register Model Configuration form, showing the name, description, and component location fields](../assets/images/model-register.png)

## Name and description

The name is required. Use one a facilitator would recognise next to similar models, with the place or purpose in it, for example "Modflow · Barton Springs" rather than "config2". The description should say what the configuration does, what it is calibrated for, and what it produces. These two fields are what people read in the model list before they open anything.

## Component location

Where the executable component lives: a Tapis application or any URL. Leave it empty to describe the model only. **A configuration with no component location cannot be run**, so it will be discoverable but not usable.

![The Component location and Region sections of the form](../assets/images/register-model-component.png)

When you choose a Tapis application, the form fills in that application's inputs and parameters for you. Then add a standard variable to each input, so the data step can offer datasets for it.

## Region

Off by default, and for good reason: most configurations work anywhere. Turn it on only if the configuration is calibrated for, or its inputs are fixed to, specific regions. The Models list can be filtered by region, so a limited model is only offered where it applies. Turning it on for a model that works anywhere can keep it from users working in other regions.

![The Region toggle and the Parameters section](../assets/images/register-model-region.png)

## Parameters

Parameters are the settings a user chooses when running the model. Give each a label, a data type (string, integer, float, boolean, url or datetime), a description and a default. **Lock to a fixed value** when the model must not be changed at run time; users then cannot override it. A clear description is what lets a facilitator choose a sensible value without asking you.

![A parameter row with label, data type, description, default, and a lock option](../assets/images/register-model-parameters.png)

## Inputs and outputs

For each input or output give a label, a format (such as CSV or NetCDF) and a description. Tick **Optional** for an input the model can run without. Then add variables.

![An input row with label, format, description, an Optional checkbox, and a variable chooser](../assets/images/register-model-inputs.png)

The **standard variable and unit** is the most important choice on the page.

- On an **input**, it tells the catalog what data to offer. Without it, the data step has nothing to match.
- On an **output**, it tells the catalog what question the model answers. The form says it directly: an output with no standard variable still publishes, but it cannot match a modeling task until you give it one.

![An output row; an output without a standard variable cannot match a modeling task](../assets/images/register-model-outputs.png)

Be specific about the unit and format. A dataset with the right variable but the wrong unit or format will look compatible and then fail or give wrong numbers.

## Optional details

Model family, license, website and keywords are all optional and can be added later from the configuration page.

![The Optional details section: model family, license, website, and keywords](../assets/images/register-model-optional.png)

They still matter. **Keywords** are how people searching by topic ("groundwater, karst") find the model. **Model family** groups configurations of the same model so versions sit together instead of looking like unrelated models. **License** tells users whether they may reuse it, and **website** tells them where to learn more.

## Before you submit

Check that the name makes sense on its own, the component location resolves, every input and output that matters has a variable and unit, and the region is limited only if it needs to be. Then select **Create model configuration**.

After saving, find it under **Models → Browse Models**, switch on **My models**, and check that its inputs and outputs read as you intended.

This page describes the form as it appears in the dev environment. Saving, editing and permissions have not yet been verified end to end.
