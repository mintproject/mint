# Flow settings with choices, explanations and author defaults

## Status

In Review (2026-11-20). Nothing implemented.

Checked against `origin/develop` at the time of writing, and against the dev catalog
(`mintdevgraphql`) with read-only queries. Paths are relative to the monorepo root unless they
name the `Semantic-Sensemaking` library. Items marked **[unverified]** were not confirmed in code
or data.

## Objective

Make a flow's settings as clear to configure as a Tapis app's `app.json` arguments. Each setting
gets a readable title, an explanation, a type, a default, and, when it has a fixed set of
values, a dropdown where every choice carries its own explanation. The flow's author, a data
scientist, sets the flow's own defaults. The author can also fix a value so runners cannot
change it, and keep rarely changed settings out of the way. The mechanism must work for any
piece and any flow, not only Semantic Sensemaking.

## User need

- **Primary user:** a domain scientist running a flow from a thread. Knows the subject, does not
  know the pieces' code.
- **Secondary user:** the flow's author, a data scientist, who builds the flow from pieces and
  decides its defaults.
- **Current pain, seen on dev:**
  - The thread's settings form shows every flow setting as a free-text box labelled with the raw
    name, for example "match mode".
  - The choices are hidden in a sentence ("How terms are counted: auto, word_boundary or
    longest_match.") and are checked only after the user types a value.
  - No setting on the three Sensemaking flows has a default. Every parameter row has
    `has_default_value` and `has_accepted_values` set to null.
  - The meaning of each choice is written nowhere.
- **Definition of success:**
  - A runner opening a Sensemaking flow sees readable titles, and dropdowns for `match_mode`,
    `mapping_method`, `unmapped_groups`, `embedding_kind`, `chat_kind` and `grounding`, each
    choice explained.
  - Each setting is filled with the flow's default.
  - Settings marked advanced are hidden behind an "Advanced settings" toggle.
  - An author can change a default or fix a value in the flow builder without code.

## Current code/system summary

- **Pieces.**
  - A piece (`modelcatalog_etl_process`) describes its settings as JSON Schema in
    `runtime_json.parameters_schema_json`.
  - On dev each property has only `type` and `description`. For example, map-and-project has
    `match_mode`, `output_uri`, `taxonomy_uri`, `mapping_method` and `unmapped_groups`.
  - The schema is produced by `Semantic-Sensemaking/src/semantic_sensemaking/pieces/flow_catalog.py`
    from a `{name: description}` map (`SCORING`, `EMBEDDING`, `CHAT`, and per-piece arguments).
  - A piece is never changed in place. A changed declaration is registered under a new id
    (`REVISION` in `flow_catalog.py`).
- **The adapter's piece summary.** `_piece_summary` in `svo-adapter-service/app/main.py` (around
  line 2786) passes `type`, `default` and `description` of each setting to the UI as
  `setting_details`. It drops every other schema key.
- **The flow builder.**
  - `ui-react/src/components/flows/StepCard.tsx` lists a step's settings as "the flow's
    defaults; a runner can change them", one text box each, with the piece default as the
    placeholder.
  - Values are saved as the step's `settings_json` (`ui-react/src/lib/flow-authoring.ts`).
  - Each distinct setting name becomes one flow parameter row named
    `{configurationId}_setting_{name}` (`docs/design/2026-11-20-flow-authoring-in-the-ui.md`).
- **Catalog parameter rows.** `modelcatalog_parameter` has `has_data_type`, `has_default_value`,
  `has_fixed_value`, `has_accepted_values` (a string list), `has_minimum_accepted_value` and
  `has_maximum_accepted_value`. It has no field for a title separate from `label`, which is the
  key a run binds to, and none for per-choice explanations.
- **The run form** (`ui-react/src/pages/modeling/thread/MintParameters.tsx`):
  - It renders text inputs only.
  - `has_accepted_values` is used only to reject a value ("Accepted values: …").
  - Min, max and default show as a grey hint.
  - Parameters with a fixed value appear in a read-only table, "Expert modeler has selected the
    following parameters". So locking already has a display.
  - It has two parameter tables: catalog parameters, and adapter-plan parameters. **[unverified]**
    which of the two renders a flow's settings in every case. The implementation must confirm
    this and make both read the same setting description.

## Proposed design

### 1. A setting description in the piece's schema (no new catalog column)

Each property in `parameters_schema_json` may carry these keys. All of them are standard JSON
Schema except `x-advanced`.

| Key | Meaning | `app.json` equivalent |
|---|---|---|
| `title` | readable name shown instead of the key | `notes.label` |
| `description` | what the setting does | `description` |
| `type` | `string`, `integer`, `number`, `boolean` | `inputMode`/type |
| `default` | the piece's default | `arg` default |
| `oneOf: [{const, title, description}]` | the choices, each explained | `notes.enum_values` |
| `minimum`, `maximum` | numeric bounds | — |
| `x-advanced: true` | hidden behind "Advanced settings" unless set | — |

A plain `enum` without `oneOf` stays valid. It renders as a dropdown without per-choice
explanations.

### 2. The library describes its settings properly

`flow_catalog.py` replaces the prose maps with structured specs. The titles, defaults, choices
and choice meanings are taken from the library code, never guessed. Each must be traced to the
function that reads the argument (for example, how `match_mode` is applied in `score_lexicon`).
The pieces are registered again as new revisions, because their declaration changes.

### 3. The adapter passes the description through

`_piece_summary` keeps `title`, `oneOf`, `enum`, `minimum`, `maximum` and `x-advanced` in
`setting_details`, alongside the keys it keeps today. The adapter's flow-plan parameter list,
which the run form reads, carries the same keys. **[unverified]** where that list is built; the
implementation finds it first.

### 4. The flow's author sets defaults, fixes values, and shows advanced settings

Each setting in the flow builder's step card renders from the description: a dropdown with
explanations, or a number box with bounds. Next to each setting, the author picks one of:

- **Default:** the runner sees this value and can change it. It is saved in the step's
  `settings_json` (as today) and copied to the flow parameter row's `has_default_value`.
- **Fixed:** the runner sees the value read-only, in the existing "selected by the expert"
  table. It is copied to `has_fixed_value`.
- **Show always:** an advanced setting the author wants runners to see. It is stored on the flow
  parameter row **[open question: which field; see Open questions]**.

When a run starts, a setting takes the first value found in this order:

1. a fixed value from the flow's author;
2. the runner's value;
3. the flow author's default;
4. the piece's default.

The adapter already rejects a run value for a setting wired from an earlier step. That rule
stays.

### 5. The run form renders the description

In `MintParameters.tsx`, for flows:

- A setting with choices is a `<select>`, filled with the default. The chosen choice's
  explanation shows under it.
- Numbers use number inputs with min and max.
- Titles replace raw names.
- `x-advanced` settings are inside a collapsed "Advanced settings" section.

Models keep their comma-separated multi-value text boxes, where several values mean several
runs. A model parameter with `has_accepted_values` may later get a multi-select, but that is
outside this spec.

### 6. Re-register the Sensemaking flows

Re-register the three Sensemaking flows' settings with the new pieces and with author defaults
chosen with the user. This is a dev catalog write, and waits for "we are testing".

## Files likely affected

- `Semantic-Sensemaking/src/semantic_sensemaking/pieces/flow_catalog.py` and its tests
- `svo-adapter-service/app/main.py` (`_piece_summary`), and the flow-plan parameter list
  **[unverified location]**
- `svo-adapter-service/app/flow_graph.py`, if precedence is resolved there **[unverified]**
- `ui-react/src/components/flows/StepCard.tsx`, `ui-react/src/lib/flow-authoring.ts`,
  `ui-react/src/lib/flow-authoring-api.ts` (copy defaults and fixed values to the parameter rows)
- `ui-react/src/pages/modeling/thread/MintParameters.tsx`, plus a new setting-input component
- Tests beside each of these

## API/schema changes

- No database migration.
- `parameters_schema_json` gains optional keys. Older pieces without them render as they do
  today.
- `setting_details` in the adapter's piece summary gains optional keys. This is additive.
- The flow parameter rows start using `has_default_value`, `has_fixed_value` and
  `has_accepted_values`, which already exist.

## Data flow

```
library spec ──register──▶ piece parameters_schema_json
                                   │ _piece_summary.setting_details
                                   ▼
flow builder (author: default / fixed / show) ──save──▶ step settings_json
                                                    + flow parameter rows
                                                      (default, fixed, accepted values)
                                   │
thread settings form ◀─────────────┘ renders dropdowns, titles, advanced
        │ runner values
        ▼
run: fixed > runner > author default > piece default
```

## Risks and tradeoffs

- **Per-choice explanations live only in the piece schema.** The form has to reach the piece
  for each step, not only the flow parameter row. That is one more lookup, but no schema change.
- **Two places hold an author default** (step `settings_json` and the parameter row). They must
  be written together by one save path, or they drift.
- **New piece revisions** need approval again before they run, as for r2.
- **A setting name used by several steps** (for example `match_mode` in score-lexicon and
  map-and-project) becomes one flow parameter. Its choices must be identical in both pieces, or
  the builder must say they differ.
- **Choice meanings written wrongly** would mislead runners. Each one is traced to code and
  reviewed.

## Alternatives considered

- **A new catalog column for per-choice explanations,** for example JSON on
  `modelcatalog_parameter`. Rejected for now: it adds a migration, and pieces already carry JSON
  Schema, which expresses choices with explanations natively. Revisit if models (not flows) need
  per-choice explanations.
- **Encoding explanations into `has_accepted_values` strings** ("auto — …"). Rejected: run values
  would carry the prose.
- **Hard-coding Sensemaking choices in the UI.** Rejected: it doesn't generalise, against the
  flows-must-be-general rule.

## Test plan

- **Library:** the schema of each piece has a title and description for every setting, and
  `oneOf` where there are choices. Defaults match the code's defaults; a test reads both.
- **Adapter:** `_piece_summary` passes the new keys and still works on a schema without them.
- **UI:**
  - The builder shows a dropdown with explanations, and saves default and fixed values to both
    places.
  - The run form shows dropdowns, titles and default values, and hides advanced settings.
  - A fixed value appears read-only and cannot be overridden.
  - An old piece with prose-only settings renders as before.
- **Live on dev (after "we are testing"):** run Dictionary with a changed `match_mode` from the
  dropdown, and confirm the run used it from its parameter bindings.

## Documentation plan

- In-app User Guide: update `ui-react/docs/build-a-flow.md` (defaults, fixed, advanced) and
  `ui-react/docs/run-a-flow.md` (dropdowns), with new screenshots.
- The library README: how to describe a piece's settings.

## Rollout/rollback plan

The work ships as three PRs, none merged until "we are testing":

1. the library (pieces and tests), on the Semantic-Sensemaking PR branch;
2. the adapter and the UI;
3. a dev registration of the new piece revisions and the flows' settings.

The old pieces stay registered, so rolling back means pointing the flows back at them.

## Open questions

1. Where to store "show this advanced setting" for a flow. One option is `parameter_type`
   (today null for flow settings). Another is the step's `settings_json` under a reserved key.
2. Should the author be able to hide a setting entirely, beyond fixing it?
3. Which defaults should the three Sensemaking flows use? To be chosen with the user once the
   library defaults are traced.
4. Should models' parameters also get dropdowns from `has_accepted_values` now, or later?

## Decisions

- 2026-11-20: Per-choice explanations go in the piece's JSON Schema (`oneOf`), not in a new
  catalog column. The reason: no migration, and the schema already exists on every piece.

## User feedback / decisions

- 2026-11-20: the user asked for settings "similar to how app.jsons are configured with optional
  dropdowns and actual explanations of what each mean", and for "the data scientist" to "be able
  to configure defaults for the flow".
