# Glossary

- **Model configuration:** a ready-to-run description of a model, with its inputs, outputs, settings and where it runs.
- **Dataset:** a source of data, described by what it measures, where, when, and in what format. One dataset can contain several files, called resources.
- **Standard variable:** a shared name for a measured quantity, used so a dataset and a model can be matched.
- **Unit:** the unit a variable is measured in, such as metres. Matching variables must also match in unit.
- **Region:** a named geographic area used to find models and data that apply to a place.
- **Transformation (ETL process):** a reusable step that converts data from one form to another, such as metres to feet.
- **Problem statement:** the larger question or decision you want to work on.
- **Task:** a focused piece of work under a problem statement.
- **Thread:** the working space for one task, where you choose models and data, set values, run, and review results.
- **Run:** one execution of a model with the data and settings you chose.
- **Run history (Previous runs & provenance):** the record of earlier runs, with what was used and what came out.
- **Flow:** a model made of linked steps. Each step is a piece, and the output of one step can feed the next. A flow shows a **Flow** badge.
- **Piece:** one step of work in a flow, or a transformation, whose code is pinned to a commit of a public GitHub repository. A piece that is shared or public needs an administrator's approval before others can run it.
- **Collection:** several files that are read together as one input, so the run is one run and not one per file. An input that takes a collection is marked "Takes a collection".
- **Pause:** a point where a flow stops after a step so that a person can download the output, edit it, upload the edited copy and resume. The run shows "Waiting for your edit".
- **Credential (saved credential):** a key or password for an outside service, stored once under your account. A flow step fetches it when the step starts. Its value is never shown again and never appears in a thread or a run.
