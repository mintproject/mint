# DYNAMO end-user guide: facilitators and data scientists

**Status:** Working draft for role and UI review  
**Audience:** People who use DYNAMO Model Catalog to frame questions, find model-ready resources, curate model metadata, and run model workflows.

This guide separates the two primary end-user perspectives requested for DYNAMO:

- **Facilitator:** frames a decision or scientific question and assembles a usable model run for a team.
- **Data scientist:** curates the scientific metadata that makes models, datasets, variables, regions, and transformations discoverable and executable.

The guide describes the current React UI and then identifies what each role needs the UI to make especially clear.

## Shared mental model

DYNAMO has two connected lanes:

```text
Explore: models · datasets · regions · variables · ETL processes
    |
    v
Decide: problem statement → task → sub-task/thread → models + datasets + parameters → runs → results
```

The **Explore** lane is where users inspect catalog content. The **Decide** lane is where a signed-in user turns a question into a reproducible modeling activity.

The main objects a user will encounter are:

- **Model configuration:** a runnable description of a model, including its inputs, outputs, parameters, component location, and regional scope.
- **Dataset:** a source of data with descriptive metadata, resources, variables, spatial coverage, temporal coverage, formats, and limitations.
- **Standard variable:** a shared scientific concept used to connect model inputs and outputs to datasets and transformations.
- **Region:** a named geographic scope used for discovery, filtering, and model applicability.
- **ETL process:** a reusable transformation that converts one standardized input contract into another standardized output contract.
- **Problem statement:** the larger decision or scientific question.
- **Task:** a focused piece of work under a problem statement.
- **Sub-task/thread:** the working space where models and data are selected, parameters are set, runs are submitted, and results are reviewed.
- **Run history/provenance:** the record of what was executed, with which inputs and parameters, and what outputs or failures were produced.

## Facilitator

### Role purpose

The facilitator helps a group move from a question to an answer. They may understand the domain and the decision context without being responsible for maintaining model code or catalog ontology. Their success is being able to explain:

- what question is being answered;
- why a model and dataset are appropriate;
- whether the setup is complete enough to run;
- what is happening during execution; and
- what result or next action the team should consider.

### Main UI journey

1. **Home / Decide — “Answer a question with models”**

   Start from the Decide panel, create a new problem statement, or reopen a recent one. The home page describes the intended sequence as framing the problem, breaking it into tasks, setting up a thread, and comparing results.

2. **Guided setup — “Start model setup”**

   When starting from a model or dataset, review the **Starting context** rather than treating it as a final selection. Describe the goal, optionally describe the desired outcome, choose a region, choose a start and end date, review suggested response variables/models/datasets, and choose whether to create a new problem statement or add a task to an existing one.

3. **Problem statement and task**

   Name the problem statement, set its region and time period, and add notes when useful. Use tasks to separate related questions, such as hydrology and crop yield, while keeping them under one decision context.

4. **Sub-task/thread — Framing**

   Describe the goal of the sub-task. Confirm the region and time period. These choices narrow the datasets shown later.

5. **Outcome & drivers**

   Select the desired outcome, or response variable, and optionally select a potential driver to vary or investigate. The UI may suggest variables from models and registered ETL transformations, but the facilitator confirms the choice.

6. **Models**

   Choose one or more calibrated model configurations. Review the model description, region, produced outputs, required inputs, model ports, and any visible ETL contract path. The model map helps explain how model and transformation outputs can connect.

7. **Datasets**

   Assign a dataset to every required model input, independently for each selected model. Search by dataset name, source, or variable. Review spatial and temporal coverage and whether coverage is full, partial, unknown, or outside the model window.

8. **Parameters**

   Review and enter the values needed by the selected model. Use defaults, accepted values, units, and region-related controls when they are provided. Treat this as the scenario definition: parameter choices should be understandable to the people who will interpret the result.

9. **Runs**

   Submit runs, set the maximum run time, refresh status, and inspect run records. Use the plain-language workflow status and stage information first. Open logs, files, or technical diagnostics only when a failure or reproducibility question requires them.

10. **Results and run history**

    Review available results for each selected model, open **Run history** to compare prior attempts, and use the technical diagnostics view when exact identifiers, stages, errors, artifacts, or raw provenance are needed.

### What the facilitator uses

- Home and About pages for orientation.
- Model browsing, model details, and model comparison.
- Dataset discovery, dataset detail, spatial and temporal coverage, and model compatibility.
- Regions and region-scoped model/dataset discovery.
- Standard-variable browsing when a scientific term needs clarification.
- Guided setup and problem-statement management.
- The thread steps: Framing, Outcome & drivers, Models, Datasets, Parameters, Runs, Results, and Summary.
- Run history, logs, files, results, and technical diagnostics.

### What the facilitator creates or changes

- A problem statement.
- Tasks and sub-tasks/threads under that problem statement.
- The question framing: goal, region, time period, outcome, and potential driver.
- Model selections and per-model dataset assignments.
- Parameter values and scenario choices.
- Run submissions and the resulting run/provenance records.
- Notes and collaborative activity associated with the modeling work.

The facilitator normally **uses** model configurations, datasets, standard variables, regions, and ETL processes rather than creating their catalog definitions.

### Facilitator UI needs to emphasize

- **Question-first language:** use “What are you trying to understand?” and “What should the model produce?” before exposing implementation terms.
- **Reason for recommendation:** explain why a model, dataset, or variable appears, using readable evidence such as outcome match, input coverage, region, and time period.
- **Readiness:** make missing model inputs, incomplete coverage, invalid parameters, and unavailable outputs obvious before submission.
- **Scenario clarity:** keep region, dates, datasets, and parameter values visible as a coherent run context.
- **Progress and next action:** show whether a run is waiting, running, completing, completed, or failed, and what the facilitator should do next.
- **Results over infrastructure:** show the answer, output availability, and interpretation-relevant metadata before Tapis IDs, workflow JSON, or provider-specific terms.
- **Team continuity:** make it easy to reopen recent problem statements and understand who changed what without requiring users to reconstruct the workflow.
- **Safe exploration:** recommendations must be reviewable and editable; selecting a suggestion must never silently start a run.

## Data scientist

### Role purpose

The data scientist makes the catalog scientifically useful and operationally connectable. Their success is that another user can discover a model or dataset, understand its meaning and limits, connect compatible inputs and outputs, and reproduce the setup later.

This role may include model curation, data curation, ontology/standard-variable work, ETL authoring, or regional metadata curation. Not every data scientist will perform every type of curation.

### Main UI journey

1. **Explore Variables**

   Search and filter standard variables by name and category. Inspect the variable meaning and the units in which it is used. Use the canonical variable identifier when connecting model inputs, outputs, datasets, and ETL contracts.

2. **Explore Models**

   Browse and filter model configurations by name, region, category, and output variable. Open a configuration to inspect inputs, outputs, parameters, authors, regions, formats, units, optional inputs, and descriptions. Signed-in owners can use **My models** and edit or delete configurations they own.

3. **Register Model Configuration**

   Create a model configuration with:

   - configuration name and description;
   - optional model family and version;
   - component location;
   - regional scope;
   - parameters, including data type, default, accepted values, minimum/maximum, fixed value, and position;
   - one or more inputs and outputs;
   - input/output labels, descriptions, formats, dimensionality, optional-input flags, standard variables, and units;
   - optional licensing, website, and keywords details where supported by the form.

   The registration form is the primary place to make a model discoverable and connectable. A configuration can be registered without linking it to a model family, but users should link the family and version when that metadata is available. The current form collects licensing, website, and keyword details, but the source notes that those fields are not yet persisted for standalone configurations.

4. **Edit a model configuration**

   Correct labels and descriptions, add or remove inputs/outputs/parameters, update standard-variable presentations and units, set optional inputs, and maintain authors and regional links. Treat edits as metadata changes that can affect discovery and workflow compatibility.

5. **Register ETL Process**

   Register a reusable transformation with a stable ID, name, version, description, visibility, runtime kind, Python entry point/source or Tapis application/version, and explicit input/output contracts. Each contract should identify the standard variable, expected or produced unit, and format.

   The input/output contract is not decoration: it is how DYNAMO can discover a compatible transformation and place it between a model output and a downstream input.

6. **Regions and region editor**

   When responsible for geographic curation, use the region editor to organize region categories/subcategories, load a remote GeoJSON or ArcGIS layer, choose stable name and identifier properties, and save searchable region features. Confirm that names and identifiers are stable before using them in model scope or workflow filters.

7. **Validate through a facilitator workflow**

   Use the modeling thread to check that the registered model exposes understandable inputs and outputs, that datasets can satisfy those inputs, that transformations are discoverable, and that a run produces inspectable provenance. The data scientist should be able to hand the workflow to a facilitator without requiring private implementation knowledge.

### What the data scientist uses

- Model browse, configuration detail, ownership filtering, and configuration editing.
- Model registration and family/version selection.
- Standard-variable search and unit lookup.
- Dataset discovery and detail to inspect variables, source, coverage, formats, resources, and limitations.
- ETL process browse and registration.
- Regions, region categories, region editor, and region-scoped model/data views.
- The modeling thread as an integration and metadata validation surface.
- Run history and technical diagnostics for provenance, failures, and artifact verification.

### What the data scientist creates or curates

- Model families, versions, and model configurations.
- Model input and output contracts.
- Standard-variable and unit associations on model presentations and ETL contracts.
- Model parameters and their accepted/default values.
- Model authors, descriptions, component locations, regional scope, and ownership metadata.
- Reusable ETL processes and their versioned input/output contracts.
- Region categories, subcategories, and imported region features when acting as a regional curator.

ETL processes have explicit visibility choices (private, shared, or public); model-configuration ownership is recorded for the signed-in creator.

The current UI is primarily a **dataset discovery and inspection** surface. It does not provide a general dataset-registration workflow in the React app; dataset publishing and raw-resource curation remain separate concerns.

### Data-scientist UI needs to emphasize

- **Metadata completeness:** every input/output should have a useful label, description, standard variable, unit, format, and position where applicable.
- **Semantic contracts:** distinguish a human label from the canonical standard-variable concept and make unit/format compatibility visible.
- **Versioning and reproducibility:** make model, ETL, and Tapis application versions easy to identify and update deliberately.
- **Scope and applicability:** show regional coverage, temporal assumptions, optional inputs, and limitations before a configuration is selected for a run.
- **Ownership and visibility:** make clear who can edit/delete a configuration or ETL process and who can discover it.
- **Validation before publishing:** provide a clear check that model ports, datasets, and ETL contracts can form a complete workflow.
- **Change impact:** warn when editing a contract, parameter, unit, or region could change downstream discovery or invalidate an existing setup.
- **Traceability:** preserve author, source, version, provenance, and technical details so a facilitator can explain where a result came from.

## Shared UI inventory by catalog area

### Models

**Facilitator priority:** Can this model answer the framed question in the selected region and produce the desired outcome?  
**Data scientist priority:** Is the model configuration complete, semantically annotated, versioned, scoped, and executable?

### Datasets

**Facilitator priority:** Does this dataset cover the needed variable, place, and time period, and can it satisfy a selected model input?  
**Data scientist priority:** Are source, resource, variable annotation, format, unit, spatial coverage, temporal coverage, version, and limitations understandable and trustworthy?

### Regions

**Facilitator priority:** Can I choose the place the decision concerns and see models/data that apply there?  
**Data scientist priority:** Are region names, identifiers, geometries, categories, and source acknowledgements stable enough for search and workflow filters?

### Variables

**Facilitator priority:** What does this scientific term mean, and is it the outcome or driver I care about?  
**Data scientist priority:** Is the canonical standard variable the correct concept, and are its presentations connected to the correct units and formats?

### ETL processes

**Facilitator priority:** Is there a known transformation that makes a model output usable as the next model’s input?  
**Data scientist priority:** Does the process have a stable version and explicit, compatible input/output contracts?

### Modeling and runs

**Facilitator priority:** Can I get from a question to a trustworthy answer without understanding workflow infrastructure?  
**Data scientist priority:** Can I verify that the catalog metadata produced a valid execution plan and that the output/provenance is reproducible?

## Role boundary and navigation implications

The current UI presents a shared navigation surface rather than enforcing separate facilitator and data-scientist personas. That is useful for collaboration, but the UI should still make the role boundary legible:

- Keep **Explore** oriented around discovery and inspection.
- Keep **Decide** oriented around framing, selection, execution, and interpretation.
- Place registration and curation actions near the catalog area they modify, with clear ownership and visibility language.
- Keep technical diagnostics available to data scientists and maintainers without making them the default facilitator view.
- Use the same names for model inputs, outputs, standard variables, datasets, regions, and runs across browse, setup, and diagnostics screens.

## Open questions for product/UI review

- Should DYNAMO eventually provide explicit role-based navigation, or should both roles continue to share the same menu with contextual actions?
- Is “data scientist” the preferred user-facing name, or should this role be split into model curator, data curator, and workflow/ETL author?
- Which users are allowed to register shared model configurations, ETL processes, and region layers, and how should those permissions be communicated?
- Should dataset registration/publishing be added to DYNAMO, or remain in the external data catalog workflow?
- What is the expected user-facing result: a scalar answer, downloadable artifacts, a comparison view, or a report-ready summary?
- Which metadata fields are mandatory before a model configuration or ETL process can be marked ready for facilitator use?

## Verification notes

This guide was checked against the current `ui-react` routes, navigation, page labels, registration forms, modeling wizard, run-history/diagnostics views, and the implemented design documents for guided setup, dataset discovery, and facilitator run presentation. It intentionally distinguishes current behavior from UI needs and open product decisions.
