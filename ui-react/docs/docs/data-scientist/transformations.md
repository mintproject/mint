# Transformations and curation

Reusable ETL processes describe transformations between explicit input and output contracts. Record scientific variables, units, formats, runtime references, and versions so users can assess compatibility.

Planned walkthrough: register and inspect a transformation, verify compatibility, and maintain regional and semantic metadata where permitted. Permissions and exact form behavior remain to be verified.

## Browse existing transformations

**Models → Browse ETL Processes** lists registered transformations. Each card shows its version, runtime, and its input and output contracts, which are scientific variables and formats. Use **Register ETL process** to add one. You must be signed in to register.

![The ETL processes page listing transformations with their runtime, inputs, and outputs](../assets/images/etl-browse.png)

## The registration form, and why each field matters

Open **Models → Register ETL Process**. A transformation is only useful if the catalog can tell which data it accepts and which data it produces, so most of this form is about making those two things explicit.

![The top of the ETL registration form: stable ID, name, version, visibility, description, and runtime](../assets/images/register-etl-top.png)

- **Stable ID:** an optional permanent identifier that workflows use to refer to the process. Choose one you will never need to change, because things that reference it break if it moves.
- **Name:** use a name a scientist can recognise, such as "Convert water level from meters to feet", not a function name.
- **Version:** increase it whenever the code or the variable meaning changes, so workflows that already ran remain reproducible.
- **Visibility:** *private*, *shared* (every signed-in user) or *public* (also anonymous catalog readers). A transformation nobody can see cannot be discovered, so choose the widest visibility you are comfortable with.
- **Description:** what it does, what data it expects and what it produces. The catalog shows this to users.

### Runtime

Choose an **inline Python function** for a small reusable step, or a **Tapis app** when it needs a registered container, files or substantial compute. For an inline function give the function name the workflow calls (for example `transform`). For a Tapis app give its ID and pin the version so results can be reproduced. The Python source is stored as catalog metadata and run only by the configured Tapis workflow runtime.

![The runtime fields and Python source](../assets/images/register-etl-runtime.png)

### Input and output contract

This is what makes a transformation discoverable and chainable.

- The **input** variable tells the adapter which upstream data the process can consume, so it can offer the process when that data is selected.
- The **output** variable is what the process creates. The form notes that this output becomes discoverable as the next step's input, which is how steps connect into a workflow.
- **Unit** and **format** on each side stop mismatches: a step that expects CSV in metres should not be offered data in NetCDF in feet.

![The input and output contract sections](../assets/images/register-etl-contract.png)

If the variables are wrong or empty, the transformation registers but never appears where people need it. Use the same standard variables as the models and datasets it connects, as described in [Why metadata matters](../reference/why-metadata.md).

This page describes the form as it appears in the dev environment. Saving and editing have not yet been verified end to end.
