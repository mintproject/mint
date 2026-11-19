# Flows in the MINT web app

## Status

In Review

## Objective

Let a person find a flow, run it from a modeling thread and see its results in the MINT
web app (`ui-react`), without using the API by hand. This is phase C of
[flows as models](2026-11-19-flows-as-models.md), planned against the UI code as it is.

Building a flow in the browser (phase D) is not in this document.

## User need

- "We have the ETL pieces and we should allow it thorugh the UI as well."
- "we've accounted for the ui?" and "Ok so we need to plan to account for th eui"
  (2026-11-19), after phases A and B were checked through the API only.
- It must stay general: any flow, not only the sensemaking ones.

## Current code/system summary

Checked by reading the code on 2026-11-19. Nothing here was tried in a browser.

**What already works for a flow**

- The thread screen plans, submits, follows and cancels through the same Ensemble Manager
  routes a flow uses (`lib/ensemble-manager.ts`). A 202 answer is treated as success.
- A flow has a model family and version, so the thread's picker
  (`wizard/ModelsStep.tsx`) and the model browser list it like any model.
- The Parameters step (`thread/MintParameters.tsx`) shows every setting that is not fixed
  or secret, so `output_uri` can be typed. The Ensemble Manager reads the thread's values
  itself when it runs a flow, so they do reach the run.
- Region and dates are optional in the wizard.
- Logs and files are opened by the execution's id, which a flow run has.

**What does not**

| Where | What happens with a flow today |
|---|---|
| Picker (`ModelsStep.tsx:684-688`) | A flow is hidden when the catalog has no dataset for one of its inputs, or its outputs lack the thread's indicator. |
| Data step (`wizard/DatasetsStep.tsx`) | Datasets come only from a CKAN search. There is no way to point at a folder in Tapis storage. A flow whose input is a folder of documents cannot be bound. |
| Parameters step (`MintThread.tsx:547-736`) | With the adapter switched on, the step asks the Ensemble Manager for a plan per input and output. That would plan the flow many times. |
| Submit (`MintThread.tsx:771-888`) | The plan's status and the flow's own settings are ignored. `accept_flow_settings` is never sent, so a flow whose author set defaults is refused. A refusal shows as "Ensemble manager returned 422", without the reason or the details. |
| Runs (`thread/MintRuns.tsx:396`, `:688`) | The drawing has fixed boxes: adapter inputs, one model, hand-off, outputs. A flow's steps are not drawn at all. `adapter_running` is shown as pending. |
| Results (`thread/MintResults.tsx:38`, `:555`) | A result's `tapis://` location becomes a plain link the browser cannot open. A folder and a file are not told apart. |
| Browser and model page | Nothing says a configuration is a flow, and its steps are not shown. |
| Credentials | There is no account or settings page. Secret settings are hidden from users. |
| Upload | The web app has no upload to Tapis storage. |

## Proposed design

Four parts, in build order. Each is one pull request, checked in a browser on dev before
the next starts.

### C1. Run a flow from a thread

The smallest set that makes the Dictionary flow usable by a person.

1. **Types** (`lib/ensemble-manager.ts`): the flow fields of a plan and a run
   (`flow_steps`, `flow_settings`, `default_source`, the `flow_step` stage with its name
   and `depends_on`, `model_result.outputs`), and `accept_flow_settings` on submit.
2. **Knowing a configuration is a flow.** The thread's model query gains
   `flow { configuration_id }`. Everything below keys on that, not on a name or a missing
   Tapis app.
3. **Picker.** A flow shows a "Flow" badge. It is no longer hidden when the catalog has
   no dataset for an input; the card says "bind a location in the data step". The
   indicator filter stays as it is for models and flows alike.
4. **Data step: bind a location.** Beside the catalog search, an input can be bound to a
   location the user pastes: `tapis://system/path`, a folder or a file. It is stored as a
   dataset with one resource, as a catalog dataset is. The web app checks the form of the
   location and, with the user's token, that Tapis can list it, and says so when it
   cannot. Nothing is uploaded in this part.
5. **Parameters step.** For a flow, the per-input and per-output planning is skipped.
   The step asks for one plan and shows:
   - the settings the run must supply, marked required;
   - **what the flow's author chose** (defaults and linked settings), in its own block,
     with the sentence "These were chosen by the flow's author and will be used with your
     account" and a checkbox to accept them. A value the user types replaces a default
     and needs no acceptance, as the API already works.
6. **Submit.** Sends `accept_flow_settings` from that checkbox. Each flow refusal gets its
   own sentence and shows its details:

   | Code | What the user sees |
   |---|---|
   | `FLOW_INPUT_UNBOUND` | which input has no dataset |
   | `FLOW_FANOUT_UNSUPPORTED` | this input takes one dataset |
   | `FLOW_SETTINGS_NOT_ACCEPTED` | the list of the author's settings, and the checkbox |
   | `FLOW_ALREADY_RUNNING` | a link to the run in progress |
   | `FLOW_PLAN_NOT_YOURS`, `FLOW_ARGUMENT_FIXED` | plan again |
   | `STORED_SOURCE_REFUSED` | which piece is not approved for you |
   | `FLOW_DOES_NOT_CHECK_OUT` | the problems, each with its step |

7. **Runs.** For a flow, the drawing is built from the run's stages: one box per step,
   joined by `depends_on`, steps that run together side by side, each with its status,
   time and error. It reuses `components/modeling/WorkflowCanvas.tsx`. The fixed model and
   hand-off rows are not shown. `adapter_running` reads as running. Cancel is unchanged.
8. **Results.** One row per flow output, by its name. A `tapis://` file gets a download
   button, which fetches it from Tapis Files with the user's token. A folder opens the
   existing files dialog on that folder. A location that is not `tapis://` is shown as
   text, never as a link.

#### C1 after the architecture review

The review checked the plan against the code and asked for a revision. Where this
differs from the steps above, this stands.

- **C1 is four pull requests, not one:**
  (a) types, refusal messages, submit with acceptance, and the settings fixes below;
  (b) binding a location in the data step;
  (c) the runs drawing;
  (d) results download.
  The Dictionary flow is usable in a browser after (b); (c) and (d) make it readable.
- **Plan once, at submit.** Planning a flow registers its datasets with the adapter and
  makes a plan each time, and a plan can be run only once. So the Parameters step does
  not plan. It shows the flow's settings from the catalog, as it does for a model.
  Pressing Run plans once. If the plan carries settings chosen by the flow's author, a
  dialog lists them with the accept checkbox, and the same plan is then submitted.
- **A flow's setting is one value.** The Parameters step splits what is typed on commas,
  for sweeps. For a flow only the first part would be used, so a title with a comma would
  be cut short without a word. A flow's settings use the single-value field.
- **Values go in `parameter_values`.** The flow path ignores the field the web app sends
  adapter values in today.
- **Saving the Parameters step is still required** before Runs opens: the step's save is
  what creates the record the gate looks for.
- **Binding a location writes the whole binding**: the dataset, its one resource, and the
  link from the flow's input to it. The dataset's id is derived from the location, so
  binding the same location twice does not make two.
- **Files go through the Ensemble Manager, not straight to Tapis.** Its files route
  already serves a flow run and uses the user's token, which removes the question of
  whether the browser may call Tapis. Two changes there: a download route, and a fix for
  a result that is a folder (today it lists the folder's parent).
- **The run view refreshes the thread's record when a run settles.** Today that happens
  only in the first ten minutes after submit, so a longer run would leave the results
  step stale.
- The canvas component is general and can draw a flow's steps. How well its automatic
  layout places steps side by side is unchecked; that is the first thing (c) finds out.

### C2. Find a flow

1. **Browser** (`models-browse`): a "Flow" badge on the row and a facet "Models / Flows".
2. **Model page** (`ConfigurationDetail.tsx`): a "Steps" section after the settings. It
   draws the steps and their links with the same canvas, and lists for each step its
   piece, the piece's owner and whether an admin approved it.
3. **Unavailable flows.** A flow with a deleted piece, or with a piece this user may not
   run, is shown greyed with the reason and cannot be picked. This needs one small API
   addition: `POST /flows/check` already answers this for a flow being registered; the
   Ensemble Manager gets `GET /flows/{id}/availability`, which asks the adapter as the
   caller.

### C3. Saved credentials (after the secret store is built)

Needs the adapter routes in
[a runner's own secrets](2026-11-19-user-secrets-for-flows.md).

1. A new page "Saved credentials", linked from the header's account menu: list (name,
   fields, last changed), add, replace, delete. A value is typed into a password field,
   sent once, and never shown again.
2. The Parameters step shows which credentials the flow needs and whether each is stored,
   with a link to that page. Submit is disabled until all are.
3. The web app never puts a credential in a thread setting. A setting marked secret stays
   hidden, as today.

### C4. Getting data in, and a notice

1. **Upload.** The data step can upload files into a folder in the user's Tapis storage
   and bind that folder. First a check that the browser can post to Tapis Files from the
   app's address (an open question since phase 0). If it cannot, the upload goes through
   the Ensemble Manager, or this stays "paste a location".
2. **Outside services.** Before the first run of a flow whose piece sends data to an
   outside service, the screen says which service. A piece declares this in its catalog
   row. Needs a small addition to the piece's metadata.

### Build order with the secret store

1. C1, then C2. The Dictionary flow needs no secret, so it is usable after C1.
2. The secret store (adapter and Ensemble Manager), as approved.
3. C3. Narrative and Formulation become usable.
4. C4.

## Files likely affected

| Part | Files |
|---|---|
| C1 | `ui-react/src/lib/ensemble-manager.ts`; `pages/modeling/thread/MintThread.tsx`, `MintParameters.tsx`, `MintRuns.tsx`, `MintResults.tsx`; `thread/wizard/ModelsStep.tsx`, `DatasetsStep.tsx`; `graphql/generated/thread-execution.ts`, `modeling.ts`; `lib/thread-datasets.ts`; a new `lib/flow-errors.ts` and `lib/tapis-files.ts`; tests beside each |
| C2 | `components/models-browse/*`, `lib/modelBrowseFilters.ts`, `components/configuration/ConfigurationDetail.tsx`, `graphql/fragments/model-catalog.graphql` and codegen; Ensemble Manager route for availability |
| C3 | a new page and route in `App.tsx`, `components/layout/Header.tsx`, `MintParameters.tsx` |
| C4 | `DatasetsStep.tsx`, `lib/tapis-files.ts`; piece metadata in the catalog and adapter |

## API/schema changes

- C1: a download route on the Ensemble Manager's files API, and its folder fix. Nothing
  else: it uses what phases A and B built.
- C2: `GET /flows/{id}/availability` on the Ensemble Manager.
- C3: none beyond the secret store's own.
- C4: a field on a piece for the outside service it calls.

## Data flow

Unchanged from phase B. The web app reads the thread through Hasura as the user, and
plans, submits and follows through the Ensemble Manager with the user's token. In C1 it
also calls Tapis Files directly with the user's token, to check a pasted location and to
download a result.

## Risks and tradeoffs

- **A pasted location is read with the runner's own token**, so a user cannot reach
  anything through it that they could not already read. It does let a thread point at
  storage the catalog knows nothing about, so a second person opening the thread may not
  be able to read the input. The screen says so.
- **Downloading through the browser** holds the file in memory. Large results get a
  "copy location" button and no download above a size limit.
- **The runs drawing has two forms**, the model one and the flow one. They share the
  canvas and the status colours, not the layout code.
- **Calling Tapis Files from the browser** depends on Tapis allowing it from the app's
  address. If it does not, C1's check and download go through the Ensemble Manager's
  existing files route, which is a small change to the plan, found on the first day.
- **Generated GraphQL types** need a live Hasura to regenerate. C1 touches only the
  hand-written thread queries. C2 needs the regeneration.

## Alternatives considered

- **A separate "flows" screen.** Rejected earlier by the user's choice that flows are
  models: the thread wizard is where a model is run.
- **Require every input to be a catalog dataset.** Then a folder of documents must be
  registered in CKAN before a flow can read it. Kept as possible, but it puts a
  publishing step in front of a first run.
- **Show a flow's steps inside the existing fixed drawing** as extra boxes. The fixed
  drawing assumes one model in the middle, which a flow does not have.

## Test plan

- Unit tests beside each changed component, in the existing style (Vitest, Testing
  Library, mocked `fetch`): the picker shows a flow with no catalog dataset; a pasted
  location is bound; the Parameters step shows the author's settings and sends acceptance;
  each refusal code shows its sentence and details; the runs drawing shows steps from
  stages, including two that run together; a result file downloads and a folder opens the
  files dialog; a non-`tapis://` location is not a link.
- In a browser, on dev, after each part: the Dictionary flow from an empty thread to
  downloaded results, as the owner; then as the second account. The run is a real run.
- C2: an unavailable flow shows its reason and cannot be picked.
- C3: store, replace and delete a credential; the value is not in the page, the network
  log after the one send, or local storage.

## Documentation plan

- `ui-react/docs/`: a page "Run a flow" (pick, bind a location, settings, run, results).
- The user guide repository gets the same page after C1 is on dev.
- DSO-Architecture: the MINT platform page, UI section.

## Rollout/rollback plan

- Each part is one pull request against `develop`, deployed to dev by the merge.
- Everything is keyed on "this configuration is a flow". A thread whose model is not a
  flow takes the code paths it takes today. Rollback is reverting the pull request.

## Open questions

1. **Paste a location, or catalog datasets only?** The plan above lets a user paste a
   `tapis://` location in the data step.
2. **Should a flow be hidden when its outputs lack the thread's indicator?** The plan
   keeps today's rule for models and flows alike.
3. **May I drive a browser on dev with your token** for the checks? The alternative is
   that you click through and I read the results.
4. Answered by the review: files go through the Ensemble Manager, so the browser does
   not call Tapis for C1. The question returns for upload in C4.

## Decisions

- 2026-11-19: written from a reading of the UI code. Build order: C1, C2, the secret
  store, C3, C4.

- 2026-11-19: architecture review, verdict revise. Its changes are in "C1 after the
  architecture review". All were adopted.

## User feedback / decisions

- 2026-11-19: "Ok so we need to plan to account for th eui".
