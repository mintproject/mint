# Research: what is a scenario in RAS Commander and HEC-RAS

Issue: [#331](https://github.com/mintproject/monorepo/issues/331). Part of [#330](https://github.com/mintproject/monorepo/issues/330). Blocks [#335](https://github.com/mintproject/monorepo/issues/335).

Date: 2026-10-10.

## Answer

1. Neither HEC-RAS nor RAS Commander defines "scenario". It is not a defined term in either one.
2. The unit that HEC-RAS defines is the **plan**. A plan is one geometry file plus one flow file plus run options.
3. RAS Commander uses "scenario" as an informal word for a plan variant. It makes a variant with `RasPlan.clone_plan`.

For MINT: if a MINT "scenario" must map to HEC-RAS, map it to a **plan**. Do not expect a `scenario` object in either API.

## How the terms relate

| Term | Meaning | Source |
|---|---|---|
| Project | One `.prj` file. It lists the title, the units and all project files. | [HEC-RAS manual, Working with Projects](https://www.hec.usace.army.mil/confluence/rasdocs/rasum/6.3/working-with-projects) |
| Geometry file | `.g01` to `.g99`. It holds the model geometry. | Same page |
| Steady flow file | `.f01` to `.f99`. | Same page |
| Unsteady flow file | `.u01` to `.u99`. | Same page |
| Plan file | `.p01` to `.p99`. It holds a description, a short ID, run options, and a list of the geometry and flow files it uses. | Same page |
| Output file | `.o01` to `.o99`, and `.p01.hdf` to `.p99.hdf`. The number matches the plan number. | Same page |

The manual says a plan is formed by choosing a flow file and a geometry file. The manual page does not use the word "scenario".

So the relation is:

- One project has many plans.
- One plan points to exactly one geometry file.
- One plan points to exactly one flow file (steady or unsteady).
- Many plans can share one geometry file or one flow file.
- Results belong to the plan, by number.

## What the sources say

### HEC-RAS manual (USACE)

- [Working with Projects](https://www.hec.usace.army.mil/confluence/rasdocs/rasum/6.3/working-with-projects) defines project, plan, geometry and flow files. This is the primary source for the table above.
- This page does not contain the word "scenario".
- I read the 6.3 page. I did not search the full manual for the word. Other pages may use it in passing.

### RAS Commander documentation

- [Documentation home](https://rascommander.info/ras/) has no definition of "scenario". The word does not appear on the page.
- [Plan Execution](https://rascommander.info/user-guide/plan-execution/) describes variants through plans. It says to clone a plan, edit it, and run the clone. It does not say "scenario".
- [Workflows and patterns](https://github.com/gpt-cmdr/ras-commander/blob/462e325098271d7f1bdc7dc32161375f3b152a6a/docs/user-guide/workflows-and-patterns.md) uses "scenario" as plain English. Its text says "Run multiple scenarios with different parameters". The code clones plan `01` once for each scenario. Here, one scenario is one cloned plan.
- [Architecture notes](https://github.com/gpt-cmdr/ras-commander/blob/462e325098271d7f1bdc7dc32161375f3b152a6a/docs/development/architecture.md) use "Scenario" as a column heading for run cases, such as "Single plan". This is not a data term.
- The site address `https://ras-commander.readthedocs.io` returns HTTP 404 (checked 2026-10-10). The live docs are at `rascommander.info/ras/`. The README of the repository links there.

### RAS Commander source code

Repository: [gpt-cmdr/ras-commander](https://github.com/gpt-cmdr/ras-commander). Commit read: `462e325`.

- `RasPlan.clone_plan` has the parameters `template_plan`, `new_shortid`, `new_title`, `geometry`, `unsteady_flow`, `steady_flow`, `num_cores`, `intervals`, `run_flags` and `description`. See [RasPlan.py](https://github.com/gpt-cmdr/ras-commander/blob/462e325098271d7f1bdc7dc32161375f3b152a6a/ras_commander/RasPlan.py). It makes a new plan from a template. It can point the new plan at other geometry and flow files. This is the main way to make a variant.
- `RasPlan` also has `clone_geom`, `clone_steady`, `clone_unsteady`, `set_geom`, `set_steady` and `set_unsteady`. They edit the pieces of a plan.
- `RasCmdr` has `compute_plan`, `compute_parallel` and `compute_test_mode`. They take plan numbers. See [RasCmdr.py](https://github.com/gpt-cmdr/ras-commander/blob/462e325098271d7f1bdc7dc32161375f3b152a6a/ras_commander/RasCmdr.py). They never take a scenario.
- A text search of `ras_commander/` finds no function or parameter named `scenario`. The word appears only in doc strings, as plain English. One example is the Flow Title text in `RasUnsteady.py`, which says it names "unsteady flow scenarios".
- The word "scenario ensembles" appears in the remote execution doc strings (`remote/PsexecWorker.py`, `remote/Execution.py`). It means a set of plans that share one preprocessed geometry.
- In DSS path names, the F-part is called "scenario" (`dss/RasDss.py`). That is a DSS term. It is not a plan term.
- A doc string in `dss/RasDss.py` and `docs/api/dss.md` mention a `RasScenario` class. They say it existed in a "source PR workflow". It is **not** in the repository at this commit. Treat it as unpublished.

## Caveats

- The [CivilGEO knowledge base](https://knowledge.civilgeo.com/understanding-hec-ras-scenarios) calls a plan a scenario. It is a vendor page, not a primary source. I did not use it for the answer. It agrees with the mapping above.
- RAS Commander changes often. Check `clone_plan` again before you build on it.
- I did not read the RAS Commander "DataFrame Reference" page or the full API page. The API page is long and the fetch was cut at 100,000 characters.

## Open points for #335

- Decide if a MINT scenario maps to one plan, or to a set of plans.
- If one scenario needs a new geometry or flow file, the variant needs `clone_geom` or `clone_unsteady` first. Then `clone_plan` with those numbers.
