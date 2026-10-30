# Sub-task Thread Wizard — Atomic Steps Redesign

**Date:** 2026-06-06
**Area:** `ui-react/src/pages/modeling/thread/`
**Status:** Design approved (brainstorming) — pending implementation plan

## Problem

The sub-task thread workflow (`/modeling/thread/:id`) presents an 8-tab horizontal
strip — Configure, Variables, Models, Datasets, Parameters, Runs, Results, Summary —
as if all tabs were equal, independent choices. In reality the work is a **linear
filtering chain** where each stage narrows the next:

```
Framing (region + time) ─┐
                         ├─► Datasets are filtered by region + dates
Variables ──► Models ────┘        and by each model's inputs
   │            │
   │            └─► models expose inputs that datasets must satisfy
   └─► variables filter which models are relevant
Models ──► Datasets ──► Parameters ──► Runs ──► Results ──► Summary
```

Two concrete problems today:

1. **Configure does three jobs.** The current `Configure` step crams "General framing"
   (region + time), "Select models", and "Select datasets" into one accordion screen —
   while standalone `Models` and `Datasets` tabs also exist. Selection logic is duplicated
   and the screen is a mini-dashboard rather than one clear task.
2. **The dependency chain is invisible.** Nothing on screen tells the scientist that
   variables filter models, or that the region/dates they picked in Framing are what
   narrows the dataset list. They cannot see "what filters what."

## Goal

Redesign the thread workflow as a **guided, atomic-step wizard** where:

- Each step does exactly one thing.
- The dependency chain is always visible (left vertical rail replacing the tab strip).
- Each step shows **what filtered its options and where that filter came from**.
- Steps are **gated**: a step is locked until its prerequisites are complete.

This targets the SUBSIDE goal of making model+dataset configuration legible to domain
scientists.

## Approved Decisions

| Decision          | Choice                                                                                                                                                                                                                                                  |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Navigation model  | **Left vertical rail** (replaces horizontal tab strip), content pane on the right                                                                                                                                                                       |
| Step granularity  | **Atomic** — Configure shrinks to "Framing" only; Models/Datasets/Parameters become real steps                                                                                                                                                          |
| Gating            | **Lock until ready** — a step unlocks when the previous step's required Continue is satisfied. Only Framing (Goal), Models (≥1 model), Datasets (all inputs) are required; optional steps never lock the next. Models unlocks as soon as a Goal exists. |
| Rail detail       | **Name + one-line summary** of the choice made (e.g. "Texas Gulf · 2000–2026")                                                                                                                                                                          |
| Datasets scope    | **Isolated per model** — each selected model has its own dataset assignments                                                                                                                                                                            |
| Partial-date data | **Selectable**, flagged with an amber "partial" tag (not disabled)                                                                                                                                                                                      |
| Build scope       | **Full flow redesign** (rail + all atomic step screens)                                                                                                                                                                                                 |

## Step Model

| #   | Step           | One job                                            | Required to leave (own Continue) | Filters its options by                                    | Thread field(s)                               |
| --- | -------------- | -------------------------------------------------- | -------------------------------- | --------------------------------------------------------- | --------------------------------------------- |
| 1   | **Framing**    | Set name + optional region/time scope              | **Goal non-empty**               | —                                                         | `name`, `region_id`, date range               |
| 2   | **Variables**  | Choose a response variable and optionally a driver | **nothing (skippable)**          | —                                                         | `response_variable_id`, `driving_variable_id` |
| 3   | **Models**     | Choose one or more models                          | **≥1 model selected**            | **response variable** (if set; else all)                  | model selections                              |
| 4   | **Datasets**   | Assign a dataset to every input, **per model**     | **all inputs assigned**          | model **inputs** + **region** + **dates** (whichever set) | dataset bindings per model input              |
| 5   | **Parameters** | Set parameter values per selected model            | per-model params valid           | —                                                         | parameter values                              |
| 6   | **Runs**       | Execute the generated run matrix                   | —                                | —                                                         | execution records                             |
| 7   | **Results**    | View outputs                                       | —                                | —                                                         | —                                             |
| 8   | **Summary**    | Review the whole sub-task                          | — (always viewable)              | —                                                         | —                                             |

"Framing" is the renamed `Configure` step — name + optional region/time only. The model and
dataset accordions move out of it into steps 3 and 4. The **gate to _enter_ a step is "the
previous step's Continue was satisfied"** — not a per-step required-field list. Only Framing,
Models, and Datasets have required selections; everything else is optional.

## Components

New, reusable, each with one clear purpose:

### `WizardRail`

Vertical stepper that replaces `ThreadBreadcrumb`.

- **Props:** `steps` (id, label, status, summary, locked), `currentStep`, `onSelect`.
- Renders each step with a status glyph (`✓` done / `●` active / `○` upcoming / `🔒` locked),
  the step name, and a one-line summary of the choice made.
- Locked steps are non-interactive (no `onSelect`). Active step uses the existing
  blue highlight (`bg-blue-600 text-white`); done uses green `✓` (`text-green-600`),
  matching today's `STATUS_CLASS`/`STATUS_ICON` palette.
- **Depends on:** step status derived from thread state (see Data flow).

### `StepShell`

Frame around each step's content: title, optional description, the content slot, and a
footer with **Back** + **Continue** buttons. Continue is disabled until the step's
completion predicate is satisfied; it shows a live progress hint (e.g. "1 of 3 inputs
assigned"). This generalizes today's `MintConfigure` "Select & Continue" footer.

### `FilteredByBanner`

The blue provenance banner shown at the top of filtered steps (Models, Datasets).

- **Props:** `chips` — each `{ icon, label, value, source? }`. `source` (e.g. "from Framing")
  renders as muted suffix text. Optional `onEdit` link jumps back to the source step.
- Communicates _why_ the list is narrowed and offers one-click return to the filter source.

### Step components (one per step) — see per-step detail sections below

- `FramingStep` — Goal (required) + optional region/time toggles (refactor of
  `ThreadExpansionConfigure`, variable fields removed).
- `VariablesStep` — refactor of `MintVariables`; optional response variable + potential driver
  via catalog autocomplete, with a live model-count preview.
- `ModelsStep` — refactor of `MintModels`; adds `FilteredByBanner`
  ("Showing N of M models that produce <variable>") and surfaces each model's inputs.
- `DatasetsStep` — refactor of `MintDatasets`; **one card per selected model**, each
  card listing that model's inputs with per-input dataset assignment. `FilteredByBanner`
  shows input + region + dates. Datasets are isolated per model — Model B's dataset for an
  input is independent of Model A's.
- `ParametersStep`, `RunsStep`, `ResultsStep` — new (Parameters/Runs/Results were
  placeholders); may be staged after the chain shell lands.
- `SummaryStep` — wraps existing `MintSummary`.

> Note: `MintModels.tsx` and `MintDatasets.tsx` already exist but are not wired into
> `MintThread`'s `renderStep()` (it still renders `StepPlaceholder` for them). The redesign
> wires them in via the step components above, refactoring their internals to the per-model
> / banner patterns.

## Framing Step — detail

Renamed from `Configure`. One job: set the **scope** of the sub-task. Refactor of
`ThreadExpansionConfigure`, with the variable fields removed.

**Goal (name) is the only required field.** Region and time period are **optional scope
filters** — symmetric: each narrows the dataset list when set, and means "any" when unset.

| Field                                      | Required | Control                                                     | Validation                             | Downstream effect                                                  |
| ------------------------------------------ | -------- | ----------------------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------ |
| **Goal** (`name`)                          | **yes**  | text input                                                  | non-empty                              | sub-task label, shown in rail summary                              |
| **Region** (`region_id`)                   | no       | **toggle** → reveals searchable region picker + map preview | —                                      | when enabled+set, filters datasets to those covering the region    |
| **Time period** (`start_date`, `end_date`) | no       | **toggle** → reveals two date inputs                        | start < end **only when both present** | when enabled+set, filters datasets to those overlapping the window |

**Optional-filter pattern (toggle).** Region and dates live in a "Narrow the data —
optional" subsection. Each is gated by a **toggle**:

- **Off** (default): constraint not applied; row collapsed, reads "off · any region/period".
- **On**: reveals the control. Turning the toggle on signals intent; the value completes it.
  A toggle that is on but left blank applies no filter (treated as not-yet-set).
- Dates support **open-ended ranges** — start-only ("from 2010 onward"), end-only
  ("until 2020"), or both.

- **Variable fields move out.** Today `ThreadExpansionConfigure` also edits
  `response_variable_id` ("Indicator") and `driving_variable_id` ("Driving Variable").
  These duplicate the Variables step and are **removed from Framing** — Framing is purely
  name + when + where. The Variables step owns those fields.
- **Region becomes a real picker.** Today region is a free-text "Region ID" string. Since
  region drives the dataset spatial filter, replace it with a searchable dropdown of known
  regions plus a small map preview of the selected extent. (Region data already exists —
  see `pages/regions/`.)
- **Inline filter hints.** Below the time and region fields, a blue one-liner states what
  each constrains ("🗓 Datasets will be filtered to those overlapping this window",
  "⌖ Datasets will be filtered to those covering this region") — making the chain visible
  from step 1.
- **Completion predicate:** **Goal non-empty** → Continue enables. Region and dates are
  optional and never block Continue. (This loosens today's `getConfigureStatus`, which
  required `name && region_id`.) When dates are both present, validate start < end.
- **Downstream behavior:** the Datasets "filtered by" banner renders a chip _only_ for
  filters that are set (the model input variable is always present). With no region → no
  spatial filter; with no dates → no date filter and no partial-date warnings. Rail summary
  reflects what's set ("Flood extent · Texas Gulf", "Flood extent · any region").

Save still uses `useUpdateThreadMutation` + `useInsertThreadProvenanceMutation`
(provenance `UPDATE` event), then `onUpdated` → `refetch`.

## Variables Step — detail

Refactor of `MintVariables`. The response variable is the primary framing choice; the driver is
secondary and is informed by the inputs of the selected models. **Both fields are optional — the
whole step is skippable.**

| Field                                                            | Required | Control                                                         | Downstream effect                                               |
| ---------------------------------------------------------------- | -------- | --------------------------------------------------------------- | --------------------------------------------------------------- |
| **Desired outcome / response variable** (`response_variable_id`) | no       | **catalog-backed autocomplete** (standard variable name + unit) | when set, filters Models to those that produce it               |
| **Potential driver** (`driving_variable_id`)                     | no       | same autocomplete, plus shortcuts from selected model inputs    | marks an input the user intends to vary; does not filter Models |

- **Free-text → autocomplete.** Today both are raw text inputs (typo-prone). Replace with a
  searchable typeahead over standard MINT variables (the `components/autocomplete/`
  placeholder). Each option shows the standard variable name and unit.
- **Live filter preview.** Below the response variable, show the consequence before the user leaves:
  - response variable set → models will be filtered to those that produce the selected outcome.
  - response variable empty → "No desired outcome selected — **all M models** will be available next" (neutral).
- **Model-informed drivers.** Once model inputs are known, show them as one-click driver
  candidates. Choosing a driver does not narrow the model list; it marks an input for later
  scenario or parameter exploration.
- **Completion predicate:** none. Continue is always enabled; the step can be skipped.
- **Single vs. multiple:** matches today's data model — **one** indicator + **one** adjustable
  variable. (Multi-select would require a thread schema change; out of scope unless raised.)

## Models Step — detail

Refactor of `MintModels`. Lets the user pick one or more calibrated model configurations
from the catalog, filtered by the response variable (if set) and grouped by region.

- **Table → cards.** Each model renders as a card carrying variable chips:
  green **`Produces: <output var>`** and blue **`Model inputs (N): <input vars>`**. The input
  chips preview exactly what the Datasets step will request and which variables can become
  drivers. If catalog I/O metadata is incomplete, the card says so instead of implying that the
  model has no inputs or outputs.
- **Stale selections stay visible.** If a response variable changes or a previously selected
  model no longer matches it, the model is called out with an explicit remove action and Continue
  remains disabled until the selection is resolved.
- **`FilteredByBanner`** at the top:
- response variable set → "Showing **N of M** models that produce **<outcome>**" + "edit outcome".
- response variable unset → "Showing **all M** models" plus an explanation that the full model list is available.
- **Region grouping (kept).** Models matching the Framing region show first; a
  "Show N models calibrated for other regions" disclosure reveals the rest (existing
  `regionRows`/`otherRows` logic). With no region set, all show.
- **Kept from today:** multi-select, **Compare** dialog (requires 2+), search by
  name/region/description, and notes (now collapsible/optional). Save via
  `useSetThreadModelsMutation` (`SELECT_MODELS` provenance event).
- **Completion predicate:** ≥1 model selected → Continue to Datasets enables.
- **Data dependency (prerequisite):** filtering by indicator and the input/output chips
  require the model catalog query (`GetModelTreeWithRegions`) to also return each
  configuration's **input and output variables** (standard-variable bindings). Today it
  returns regions only. This query extension is a prerequisite for the indicator filter and
  for driving the Datasets step; see Open items.

## Datasets Step — detail

For each **selected model**, render a card:

```
┌ MODEL A · PIHM — Flood Inundation v4               2 / 3 inputs ┐
│ precipitation   GPM IMERG Daily      [🗓 full ✓]      [Change]  │
│ elevation (DEM) USGS 3DEP 10m        [🗓 partial]      [Change]  │
│ land-cover      ⚠ no dataset assigned            [Choose · 2]   │
└────────────────────────────────────────────────────────────────┘
```

- A row per model input: input name → assigned dataset + date-coverage tag → Change.
- Unassigned input → amber `⚠ no dataset assigned` + blue "Choose · N options".
- Dataset options are filtered by the model **input** variable, plus — **whichever are set in
  Framing** — the **region** (spatial coverage) and **date range**. The `FilteredByBanner`
  shows a chip only for the filters actually applied (input always; region/dates if set).
- Date coverage tag (only when a date range is set): green `🗓 full ✓` when the dataset spans
  the whole requested range, amber `🗓 partial` when it covers only part (still selectable).
- **Continue disabled** until every input across every model is assigned.

## Parameters Step — detail

The thread Parameters step is distinct from the model-authoring `ParameterRow`/
`ParameterSection` in `components/configuration/` (those _define_ a parameter's metadata).
Here the scientist **assigns values** to the parameters a selected model exposes, optionally
**sweeping** several values; the combinations generate the run ensemble.

- **Per-model card** (isolated, mirroring Datasets). Each card lists the model's adjustable
  parameters, each pre-filled with its **default** (`has_default_value`).
- **Constraints from metadata.** Value entry is validated against the parameter's
  `parameter_type`/`has_data_type`, `has_minimum_accepted_value`/
  `has_maximum_accepted_value`, and `has_accepted_values` (the `ParameterFields` fragment).
- **Sweep.** "+ sweep values" turns a single input into a chip list; each added value is
  validated. A swept parameter contributes its value-count to the run matrix.
- **Fixed parameters** (`has_fixed_value`) render **locked / read-only** — shown for
  transparency, not editable.
- **Run matrix (live).** Run count = **cartesian product**, per model, of every swept
  parameter's value-count × the dataset combinations for that model; summed across models.
  Surfaced in the rail summary, each card header, and a green total. This ensemble is what
  the Runs step executes (maps to the ensemble-manager execution-creation cartesian product).
- **Completion predicate:** all entered values valid (defaults give a valid 1-run-per-model
  baseline) → Continue to Runs enables.
- **Assumption:** full cartesian product of swept params × datasets (not paired/zipped
  sweeps). Revisit if the engine needs zipped combinations.

## Runs Step — detail

Launch and monitor the run ensemble produced by Parameters. Presentation over the existing
ensemble-manager execution flow — no new engine logic.

- **Summary bar** from `ExecutionSummary` (`total_runs`, `submitted_runs`,
  `successful_runs`, `failed_runs`): counts per status + a segmented progress bar, plus a
  **"Re-run failed"** action.
- **Per-model run table** (isolated per model). Each row = one `Execution`: **status badge**
  (SUCCESS / RUNNING / WAITING / FAILURE), the run's **bindings** (parameter values + dataset
  that define it), a **progress bar** (`run_progress` 0–100), and a "view log" link for
  failures.
- **Auto-refresh** while any run is RUNNING/WAITING (poll the summary); stop when terminal.
- **Completion predicate:** ≥1 successful run → Continue to Results enables.

## Results Step — detail

**Kept simple for v1:** list successful runs and let the user **download** their outputs.
No comparison/chart/map.

- Per model, list successful runs. Each run shows its **bindings** (params + dataset) and its
  **output files** with a **download** link.
- **Completion predicate:** none required (review step); Continue to Summary always
  available. Summary itself is always viewable (existing `MintSummary`).

> **Deferred — indicator comparison / key-metrics post-processing.** Comparing the indicator
> across the ensemble (sortable bindings→outcome table, indicator-vs-parameter chart, spatial
> map preview) is valuable but needs metric-extraction over ingested outputs and more UI
> work. Tracked as **mintproject/mint#35**, out of scope here.

## Data flow

`MintThread` remains the container. Changes:

1. Replace `ThreadBreadcrumb` with `WizardRail`.
2. Extend the status derivation (today `getConfigureStatus` / `getVariablesStatus`) into a
   single `deriveStepStates(thread)` that returns, per step: `status`, `summary` string,
   and `locked` boolean (locked = the previous step's required Continue is unsatisfied; see
   Gating rules).
3. `renderStep()` dispatches to the new step components inside a `StepShell`.
4. Each step reads/writes thread state via existing Apollo hooks/mutations; on save it calls
   the existing `onThreadUpdated` → `refetch`, which recomputes step states and unlocks the
   next step.

No new global state; thread state (Apollo cache) stays the single source of truth. Rail
status is a pure function of thread state.

## Gating rules

- **Gate definition:** a step is reachable when **the previous step's required-Continue
  predicate is satisfied**. Only three steps have a required Continue: **Framing** (Goal
  non-empty), **Models** (≥1 model), **Datasets** (all inputs assigned). Optional steps
  (Variables, and the optional region/date filters) have no predicate, so they pass through
  instantly and never lock what follows.
- **Consequence for Models:** Models is gated _only_ by Framing's Goal — not by Variables.
  On a fresh thread with no Goal, Models is locked; **as soon as a Goal is set, Models
  unlocks** and the user may click straight to it, skipping the optional Variables step.
  (Chosen over "never locked" and "require Variables visit": a sub-task must at least be
  named before models are chosen, but nothing optional should force a click.)
- Locked steps are not selectable in the rail and cannot be reached via Continue.
- Summary is always viewable (read-only review).
- Completing a step (passing its predicate + Save) flips the next step from `locked` to
  available and is reflected immediately after `refetch`.

## Out of scope

- Backend/GraphQL schema changes — this is a UI restructure over existing thread data.
- The legacy LitElement `ui/` app — React `ui-react/` only.
- Run execution engine changes — Runs step wires to existing execution flow.

## Testing

Per `ui-react` conventions (Vitest + Testing Library + MSW), co-located
`__tests__/<Name>.test.tsx`:

- `WizardRail` — renders status glyphs/summaries; locked steps are non-interactive;
  active step highlighted.
- `StepShell` — Continue disabled until predicate true; Back/Continue callbacks fire.
- `FilteredByBanner` — renders chips + source suffix; `onEdit` fires.
- `FramingStep` — Goal required (Continue gated on it); region/date toggles optional;
  date validation only when both present.
- `VariablesStep` — both fields optional; Continue always enabled; response preview explains
  the model filter, and selected model inputs can be promoted to driver shortcuts.
- `ModelsStep` — response-variable filter (banner count) when set vs "all models" when unset;
  multi-select; Compare needs 2+; region disclosure; Continue gated on ≥1 model.
- `DatasetsStep` — one card per selected model; per-input assignment independent across
  models; partial-date selectable; Continue gated on all-inputs-assigned.
- `ParametersStep` — defaults pre-filled; sweep adds validated chips; fixed params locked;
  run-matrix count = cartesian product of swept params × datasets per model.
- `RunsStep` — summary counts from `ExecutionSummary`; per-run status badge + progress +
  bindings; "Re-run failed"; Continue gated on ≥1 success; auto-refresh while non-terminal.
- `ResultsStep` — lists successful runs with output files + download; Continue to Summary
  always available. (Indicator comparison deferred → monorepo#35.)
- `MintThread` integration — completing a step unlocks the next; Models unlocks once Goal
  set (Variables skippable); locked step not reachable.

## Open items for the implementation plan

- **Model I/O variables in the catalog query (implemented).** `GetModelTreeWithRegions` now
  returns each configuration's input and output standard variables. The wizard uses them for the
  response-variable filter, Produces/Input chips, and model-informed driver candidates.
- Exact shape of dataset-binding mutations per model input (reuse `MintDatasets` logic).
- Whether Parameters/Runs/Results ship in the same PR or follow the rail + Framing +
  Models + Datasets core (full flow is in scope, but may be sequenced across PRs).
- Whether to support multiple indicators / adjustable variables (needs thread schema change).
