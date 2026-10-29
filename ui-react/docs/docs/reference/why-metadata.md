# Why metadata matters

DYNAMO does not read your model code or open your data files to decide what fits together. It matches the **descriptions** you register: the standard variable, unit, format, region and a few plain-language fields. Good descriptions are what let a facilitator find your model, and what let the catalog suggest your data for a model's inputs.

Think of every form field as answering one question for a future user who has never met you.

| What you fill in | The question it answers | What happens if it is missing |
|---|---|---|
| Name and description | "Is this the thing I am looking for?" | People cannot recognise it in a list of similar models, and may pick the wrong one. |
| Standard variable and unit on an input | "What data does this model need?" | The data step cannot offer matching datasets, so the user has to search by hand. |
| Standard variable and unit on an output | "What question can this model answer?" | The output still publishes, but it cannot match a modeling task until it has a variable. |
| Format | "Can the data I found be read by this model?" | A dataset with the right variable but the wrong format looks compatible and then fails. |
| Region | "Where is this valid?" | Too narrow hides a model that works everywhere; too broad suggests it where it is not calibrated. |
| Version | "Will my result be reproducible?" | A changed model or transformation silently alters old results. |
| Keywords, family, license, website | "Who made this, and may I use it?" | Searches by topic miss it, and users cannot judge whether they may reuse it. |

## Standard variables are the shared language

A **standard variable** is a name from a shared vocabulary, such as `land_surface__elevation`. Two things that use the same standard variable can be connected: a dataset that provides it, a model input that needs it, a transformation that converts it. Free-text labels such as "DEM" or "elevation raster" cannot do this, because the catalog cannot know they mean the same thing.

Pick the standard variable that describes what the data **is**, not what you named your file. If none fits, the picker offers "Can't find it? Create a new standard variable". Check the [Variables](../discovery.md#find-a-standard-variable) page first, because a new variable nobody else uses will not connect to anything.

![The standard variable picker, searching for "elevation"](../assets/images/register-model-variable-picker.png)

## What a good record looks like

A registered dataset shows how the pieces appear to a user. The description explains what it contains and what it is for. The tags are its standard variables. The source, coverage, time range and format let someone judge fit without opening a file.

![A dataset card showing its description, standard variable tags, source, coverage, and format](../assets/images/dataset-detail.png)

## A short checklist

Before you submit any registration form:

1. Could someone who has never heard of your project tell, from the name and description alone, what this is for?
2. Does every input and output that matters have a standard variable and a unit?
3. Is the format the one the file really has?
4. Did you limit the region only if the model or data really is limited to it?
5. If this replaces an earlier version, did you change the version?
