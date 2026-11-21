# Flow settings with choices, explanations and author defaults

## Status

Implemented (2026-11-20). Deployed to dev in #482 (flow settings), #484 (optional credential
fields), #485 (settings kept on a Datasets save) and #489/#490 (Runs and Results). The Sensemaking
flows were registered on the described pieces the same day. Deviations are recorded under
"Implementation deviations" and "After deploy" below.

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

### 4. The flow's author sets defaults, fixes values, and chooses what runners see

Each setting in the flow builder's step card renders from the description: a dropdown with
explanations, or a number box with bounds. For each setting the author gives a **value** and a
**visibility**.

The value is one of:

- **Default:** the runner sees this value and can change it. It is saved in the step's
  `settings_json` (as today) and copied to the flow parameter row's `has_default_value`.
- **Fixed:** the runner cannot change it. It is copied to `has_fixed_value`.

The visibility is one of:

- **Shown:** in the main settings list.
- **Advanced:** inside "Advanced settings". The piece's `x-advanced` gives the initial choice.
- **Hidden:** not shown to the runner at all. The run uses the fixed value, else the author's
  default, else the piece's default. A hidden setting with none of these, and required by the
  piece, is refused by the flow check.

Visibility is stored per flow in a new column, `modelcatalog_configuration_flow.settings_json`
(jsonb, default `{}`), as `{"<setting name>": {"visibility": "shown" | "advanced" | "hidden"}}`.
It sits on the flow, not on a step, because one setting name used by several steps is one
flow parameter. `parameter_type` is not reused: it already holds `adjustment`, `model_param`,
`secret` and `standard`.

When a run starts, a setting takes the first value found in this order:

1. a fixed value from the flow's author;
2. the runner's value (refused for a fixed or hidden setting);
3. the flow author's default;
4. the piece's default.

The refusal in step 2 is enforced by the adapter's flow-run check, not only by the form.
Otherwise fixed and hidden settings could still be overridden through the API. The adapter
already rejects a run value for a setting wired from an earlier step, and that rule stays.

### 5. The run form renders the description

In `MintParameters.tsx`, for flows:

- A setting with choices is a `<select>`, filled with the default. The chosen choice's
  explanation shows under it.
- Numbers use number inputs with min and max.
- Titles replace raw names.
- `x-advanced` settings are inside a collapsed "Advanced settings" section.

For models:

- A parameter with `has_accepted_values` becomes a multi-select. Picking several values still
  means several runs, as comma-separated values do today.
- Its default is pre-selected.
- Choices show without per-choice explanations, because a model parameter row has nowhere to
  hold them (see Alternatives).
- Parameters without accepted values keep their comma-separated text boxes.

### 6. Re-register the Sensemaking flows

Re-register the three Sensemaking flows' settings with the new pieces and with author defaults
chosen with the user. This is a dev catalog write, and waits for "we are testing".

The library's own defaults, read from `Semantic-Sensemaking/src/semantic_sensemaking/core/config.py`,
are the starting proposal:

| Setting | Library default | Choices / bounds | Proposed visibility |
|---|---|---|---|
| `match_mode` | `auto` | `auto`, `word_boundary`, `longest_match` | shown |
| `mapping_method` | `legacy` | `legacy`, `subdiscipline_aware`, `embedding` | shown |
| `unmapped_groups` | `drop` | `drop`, `keep` | advanced |
| `max_files` | 200 | ≥ 1 | advanced |
| `min_chars` | 200 | ≥ 0 | advanced |
| `segment_words` (Narrative) | 200 | ≥ 10 | advanced |
| `max_frames` (Narrative) | 12 | ≥ 1 | shown |
| `grounding` (Formulation) | `keyword` | `keyword`, `semantic`, `none` | shown |
| `embedding_kind`, `chat_kind` | none set (`kind: "none"`) | see library | advanced |
| `embedding_model`, `chat_model` | none set | free text | advanced |
| `output_uri` | set by DYNAMO | — | hidden |
| `problem_statement` (Formulation) | — | free text | shown |

Choice meanings already traced in the code:

- **`match_mode` (`MatchMode`):**
  - `auto` counts terms containing a space or hyphen as substrings, and other terms on word
    boundaries. Every term counts independently, so "land subsidence" also counts as
    "subsidence".
  - `longest_match` stops that double counting.
  - `word_boundary`: **[unverified]**, to be traced in the scoring code.
- **`mapping_method` (`taxonomy/mapping.py`):**
  - `legacy` gives every subdiscipline of a matching domain the domain's score, then keeps the
    top 3 pairs. Usually that is one domain's first three subdisciplines.
  - `subdiscipline_aware` keeps the top domains and splits each domain's score across its
    subdisciplines, favouring names that overlap the terms.
  - `embedding` maps by embedding similarity and needs an embedding backend. On map-and-project
    that means the `model_server` credential, which r1 does not declare (see the backbone gap
    noted 2026-11-20).

`unmapped_groups`, `grounding` and the backend kinds are traced the same way during
implementation.

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

- One additive migration: `modelcatalog_configuration_flow.settings_json jsonb NOT NULL DEFAULT
  '{}'`. The Hasura metadata exposes it to the same roles and columns as `thread_bindings_json`.
  The flow-authoring save and the adapter's flow read include it.
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
  for each step, not only the flow parameter row. That is one more lookup, and it avoids a
  column for explanations (the only migration is the visibility column).
- **Hidden settings hide mistakes.** A wrong hidden default affects every run without anyone
  seeing it. The run's parameter bindings record the value used, and the flow page lists hidden
  settings with their values for whoever can edit the flow.
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
2. the migration, the adapter and the UI (one PR per the one-PR-per-phase rule);
3. a dev registration of the new piece revisions and the flows' settings.

The old pieces stay registered, so rolling back means pointing the flows back at them.

## Open questions

1. Are the proposed defaults and visibilities for the Sensemaking flows (section 6) right?
2. Should `output_uri` stay hidden on every flow? DYNAMO sets it today. **[unverified]** whether a
   runner ever needs to change it.

## Implementation deviations

Recorded 2026-11-20, after review.

- The catalog API (`model-catalog-api/src/flows.ts`) writes `settings_json` and mirrors the
  defaults, fixed values, choices and bounds onto the parameter rows; the UI sends the step
  settings and the flow `settings` only. The run form reads settings through a new
  `GET /flows/{id}/settings` (adapter, relayed by the catalog API), and falls back to the
  parameter rows.
- A value left at the flow default on the run form is not bound, so the default is still
  listed for acceptance. Every author value is listed in that dialog whatever its visibility.
- New codes: `FLOW_SETTING_REFUSED` (submit), `FLOW_SETTING_HIDDEN_WITHOUT_VALUE`,
  `FLOW_SETTING_FIXED_WITHOUT_VALUE`, `FLOW_SETTING_INVALID`, `FLOW_SETTING_LOOKS_SECRET`,
  `FLOW_THREAD_BINDING_FIXED`, `FLOW_SETTING_CONFLICT` (check), `FLOW_SETTINGS_UNAVAILABLE`
  (catalog relay).
- Hidden is not secret. The check refuses values for credential-like setting names.
- **Thread-bound settings (review item 4).** Chosen: refuse at author time. A setting the
  thread fills in (a date) that is also fixed or hidden is a check problem
  (`FLOW_THREAD_BINDING_FIXED`), at save (the catalog sends `thread_settings`, and the form
  sends it to the live check) and at plan. The runtime exemption for thread-bound names stays
  only as a safety net for a flow saved before the check, compared through aliases. Reason: a
  fixed or hidden setting then never depends on who supplies the thread's value, and the EM's
  own thread values need no special case.
- Pieces that share a setting name must agree on type, choices and bounds
  (`FLOW_SETTING_CONFLICT`); titles and explanations may differ.
- A model multi-select keeps a bound or default value that is not an accepted value, flagged
  "not an accepted value", so the existing validation names it instead of the save losing it.

## Decisions

- 2026-11-20: Per-choice explanations go in the piece's JSON Schema (`oneOf`), not in a new
  catalog column. The schema already exists on every piece.
- 2026-11-20 (user): an author can hide a setting entirely. Hidden and fixed settings are
  enforced by the adapter, not only by the form.
- 2026-11-20 (user): model parameters get dropdowns now, from `has_accepted_values`, as a
  multi-select so that several values still mean several runs.
- 2026-11-20: visibility is stored in a new `modelcatalog_configuration_flow.settings_json`
  column. Rejected: `parameter_type`, which is already used for other meanings, and step
  `settings_json`, because one setting can span several steps.
- 2026-11-20 (user): the `openai_compatible` choice of `embedding_kind` and `chat_kind` is
  titled "Tejas". The stored value is unchanged, because the library reads it.

### Implementation deviations (2026-11-20, monorepo commits 9994104, 3f9a750, f22c7a3; library 98bd2dd, 760c3ff)

- **The run form reads the catalog parameter rows, not adapter plans,** because a flow is planned
  only at Run. A new adapter route, `GET /flows/{id}/settings`, is relayed by the catalog API like
  `/availability`. It returns per setting the title, choices, bounds, advanced flag, resolved
  default, fixed flag and visibility, plus the thread-filled names. The form merges it onto the
  rows. With the adapter down, the rows alone still give dropdowns, numbers and defaults. One
  resolver, `flow_settings.resolve`, serves plan, submit and this route.
- **The parameter rows are mirrored by the catalog API's `POST /flows` (`buildRows`), not the
  UI.** This keeps one writer.
- **A pre-filled value equal to the flow default is not saved as a runner binding.** Fixed or
  hidden values already bound in a thread are dropped on save.
- **Thread-filled settings (for example dates) are exempt from the runner-value refusal, not
  from the flow check.** An author who hides one must give it a value.
- **Hidden wins over fixed in the UI:** a hidden fixed setting is not listed read-only.
- **Error codes:**
  - `FLOW_SETTING_REFUSED` (422 at submit)
  - `FLOW_SETTING_HIDDEN_WITHOUT_VALUE`, `FLOW_SETTING_FIXED_WITHOUT_VALUE` and
    `FLOW_SETTING_INVALID` (flow check)
  - `FLOW_SETTINGS_UNAVAILABLE` (502 from the relay)
- **Migration:** `1771300000047_configuration_flow_settings`.
- **Resolved (was open):** draft-lexicon `grounding=semantic` and map-and-project
  `mapping_method=embedding` could not run, because the adapter made every declared secret
  required. The user chose separate variants. Embedding mapping is now its own piece,
  `map-and-project-embedding` (r1), which declares `model_server`, while map-and-project stays
  credential-free and no longer offers `embedding`. draft-lexicon already declared
  `model_server`; it gained the embedding settings, and #484 lets a declaration mark
  `embedding_base_url` optional, so keyword grounding needs no embedding address.
- **Verified after deploy:** the migration and metadata applied on dev, the `text[]`
  accepted-values write works, and the run form shows explained dropdowns for the Sensemaking
  flows and multi-selects for the WERC model.

### After deploy (2026-11-20)

- **Piece revisions on dev** (library `wmobley/Semantic-Sensemaking` `feat/setting-schemas`; the
  code that runs is still upstream `6f586c7`, fetched by each piece's wrapper):
  - ingest-corpus r3
  - score-lexicon, map-and-project, render-report and render-frames-report r2
  - discover-frames r3
  - draft-lexicon r4
  - map-and-project-embedding r1
- **draft-lexicon r4** requires `problem_statement` and `chat_kind`, so a Formulation run
  without them is refused before it starts instead of failing in the step.
- **ingest-corpus r3** fails the step when it keeps no documents, naming how many were skipped and
  the minimum length. Before, a run whose documents were all too short was reported as completed
  with an empty report.
- **Author defaults.** Narrative and Formulation default to Tejas (`openai_compatible`), with
  `Meta-Llama-3.3-70B-Instruct` for chat and `E5-Mistral-7B-Instruct` for embeddings. These are
  the stack's `CKAN_LLM_MODEL` and the earlier runs' embedding model. They are author values on
  the flows, not library defaults, because they belong to this deployment.
- **Deviation: the ingest r3 swap was made in place.** The three flows' ingest step was pointed
  at r3 directly in the catalog (one transaction), instead of registering three more flow
  versions. A new version would have meant duplicate flows in the list, or deleting runs that
  hold real results. Each past run's adapter plan records the pieces it actually ran, so history
  stays accurate. Flows remain insert-only for users. This was an operator change.
- **Old flow versions** (seven, all tests) were deleted with their 11 test runs, at the user's
  request.

## User feedback / decisions

- 2026-11-20: the user asked for settings "similar to how app.jsons are configured with optional
  dropdowns and actual explanations of what each mean", and for "the data scientist" to "be able
  to configure defaults for the flow".
- 2026-11-20: asked whether an author can hide a setting entirely: "yes". Asked whether models
  get dropdowns now or later: "yes now".
- 2026-11-20: "ok lets do it": spec approved.
- 2026-11-20: embedding choices that could not run: the user chose separate variants ("a is fine
  for now"). Asked that `openai_compatible` be shown as "Tejas".
- 2026-11-20: "we need to default to the CKAN_LLM_MODEL … and the embedding model": the Tejas
  model defaults on Narrative and Formulation.
- 2026-11-20: a run that kept no documents: "both solutions are fine" (fail the ingest step;
  rebind the RGV thread to the RGV transcripts).
