# Register a Tapis application from the model form

## Status

Implemented (2026-10-29). Deviations are listed under Decisions. The live end-to-end check on the dev tenant is still to do, and needs approval at run time.

## Objective

Let a model author create the Tapis application their model runs as without
leaving DYNAMO, by pasting or uploading an `app.json`, from inside the model
configuration form. The created application is made public so other users can
run the model. After creation, it is selected and, if the author agrees, its
inputs and parameters fill the form.

## User need

Model authors publish a cookbook in a separate tool (the Cookbook UI), then
return to DYNAMO and find it in a list. That is two tools, a copy-and-paste of
`app.json`, and a "why is my app not in the list" support path. The guide now
documents this flow ([Make a model runnable](../../ui-react/docs/docs/data-scientist/make-model.md));
the goal is to remove the middle step.

## Current code/system summary

- `ComponentLocationSection` offers two modes: **Tapis application**
  (`TapisAppPicker`) and **Any URL**. Picking an app stores its canonical URL
  `https://{tenant}.tapis.io/v3/apps/{id}/{version}`. `buildSeedFromTapisApp`
  fills inputs from `fileInputs` and parameters from `appArgs`, skipping `FIXED`
  entries and entries with no `name` (`ui-react/src/lib/tapis-apps.ts`).
- Today the picker lists and reads apps through two model catalog API routes that
  proxy to Tapis. This change does not use or modify those routes.
- The deployment uses the `portals` tenant. `getTapisTenant()` derives it from
  `AUTH_SERVER` in runtime config, so the tenant is configuration, not user input.
- The signed-in user already holds a Tapis access token in the browser
  (`token-store`), used today for Hasura and the Ensemble Manager.
- Tapis allows browser calls from any origin: a preflight for `POST /v3/apps` with
  `x-tapis-token` and `content-type` returns `access-control-allow-origin: *`
  (checked 2026-10-29 against `portals.tapis.io`). This is how the Cookbook UI,
  hosted on github.io, works.
- The run path matches model input labels to `fileInput.name` and parameter labels
  to `appArgs.name`, exactly or case-insensitively (`TapisJobService.ts`).
- `TapisAppPicker` fetches its list once per tenant. Nothing re-fetches it.

## Proposed design

All of it is in the UI. No model catalog API, Hasura or database change.

### Tapis client (`tapis-apps.ts`)

One client for every Tapis app call, with the base URL `https://{tenant}.tapis.io`
built from the configured tenant and the header `X-Tapis-Token` set from the
stored token:
- `listTapisApps`, `getTapisApp`: the existing list and read, moved from the API
  routes to Tapis directly (`GET /v3/apps`, `GET /v3/apps/{id}/{version}`), so the
  dialog's duplicate check and read-back use the same path as the picker and there
  is one failure mode, not two.
- `createTapisApp(definition)`: `POST /v3/apps`. Returns `{ tenant, id, version }`
  from Tapis's response, falling back to the posted values.
- `shareTapisAppPublic(id)`: `POST /v3/apps/share_public/{id}`. Tapis shares an app
  by id, so this covers every version of that id, not only the new one. It is
  allowed from the browser (checked 2026-10-29).
- An error parser that reads Tapis's JSON error body and returns its `message`.
  Today's `getJson` discards the body. Path segments go through
  `encodeURIComponent`.
- `parseTapisAppDefinition(text)`: returns the parsed reference and a summary (id,
  version, image, input files, settings, time, memory and cores), or an error. It
  reuses `buildSeedFromTapisApp`, so the review step shows exactly what will fill
  the form. It is unit-tested without the DOM.

**Checks before sending** (Tapis remains the validator, these make errors fast and
clear):
- A JSON object with string `id`, `version` and `containerImage`; length caps.
- `id` and `version` must not contain `/`, and `id` must not be `share`, because
  the stored URL would not parse.
- No top-level `owner`, `tenant`, `isPublic` or `deleted`, so the form cannot set
  another owner or bypass the public-sharing step below.
- A non-empty `parameterSet.envVariables` is flagged, because the definition will
  be visible to everyone once public. It tells the author not to put secrets in it.
- `containerImage` must carry a tag or digest. `:latest` and untagged images are
  refused, which keeps runs reproducible.
- A non-`FIXED` input or setting with no `name` is warned about, because the app
  would not run in DYNAMO. All-`FIXED` inputs say "no inputs to fill".
- A file over a small size, or a non-JSON file, is rejected.

### List and reload

A small `useTapisApps()` hook with a `reload()` replaces the list state inside
`TapisAppPicker`. The picker and the dialog share it.

### Dialog (`RegisterTapisAppDialog`)

Presentational. Props: `existingApps`, `onCreated(ref)`. All form writes stay in
`ComponentLocationSection`.
1. Provide the definition by upload or paste.
2. Review: the summary, with the image, any `execSystemId` and unknown top-level
   keys highlighted. Invalid or incomplete definitions block Create. A likely
   duplicate id and version is advisory, and Tapis's 409 is the authority.
3. Create, disabled while the request is in flight, with a line stating this
   creates a real application under the author's account **and makes it public,
   so anyone signed in to Tapis can see its definition and run it**, that DYNAMO
   cannot edit or remove it afterwards, and that it exists even if the model form
   is not saved. Nothing is sent before this click.
4. Errors show Tapis's message and keep the pasted text. No automatic retry. After
   a timeout, reload the list before allowing another Create.

### Create, then share

Create runs as two Tapis calls in order: `POST /v3/apps`, then
`POST /v3/apps/share_public/{id}`. They are separate, so the second can fail after
the first succeeds.
- If sharing fails, the app exists and is private. The dialog says so plainly
  ("created, but could not make it public, so only you can run it"), selects the
  app, and offers a **Make public** retry that repeats only the share call. It
  never reports the create as failed and never re-creates.
- Sharing is by id, so a later version of an already-public id is public already
  and the share call is harmless. If Tapis answers that it is already public, treat
  that as success.

### After create (`ComponentLocationSection`)

On `onCreated(ref)`: set the component location to the canonical URL built from
Tapis's returned id and version, `reload()` the list, then read the app back with
`getTapisApp(ref)` so the seed reflects what Tapis stored.
- If the form already has input or parameter rows, the success step asks
  **Replace** or **Keep my rows** before changing anything.
- If the read-back fails, the app is still selected and the dialog says "created,
  but could not read it back; use Fill inputs". It never reports the create as
  failed.

The button appears only in Tapis mode when Tapis components are in use.

### Guide

Update **Make a model runnable** so step 5 becomes "Create the application in
DYNAMO", with the Cookbook UI as an alternative, and add a dialog screenshot.

## Files likely affected

- `ui-react/src/lib/tapis-apps.ts`: direct client, parse, checks, error parser
- `ui-react/src/hooks/useTapisApps.ts` (new)
- `ui-react/src/components/registration/RegisterTapisAppDialog.tsx` (new),
  `ComponentLocationSection.tsx`, `TapisAppPicker.tsx`
- `ui-react/src/test/msw/handlers.ts` and component and library tests
- `ui-react/docs/docs/data-scientist/make-model.md`, `troubleshooting.md`, one image
- DSO-Architecture: the model-form integration notes for the UI (the UI now calls
  Tapis apps directly). No service page changes, because no API changes.

## API/schema changes

None. The model catalog API's two Tapis routes stay in place and unused by this
feature. They are not modified.

## Data flow

```text
Dialog (paste/upload) -> parse + review (browser, no network)
  -> POST https://portals.tapis.io/v3/apps   (X-Tapis-Token = user's token)
  -> 201 {tenant,id,version}
  -> UI: set component location, reload list, GET app, confirm, seed form
```

## Risks and tradeoffs

- **A write to an external system.** It acts as the user and is limited by what
  Tapis already allows that user, the same as the Cookbook UI. DYNAMO adds no
  privilege and holds no extra credential.
- **Public means public.** Once shared, every user in the Tapis tenant can see the
  full definition and run the app on their own allocation. A definition can carry
  an environment variable, a path or an image reference the author did not mean to
  expose. The review step flags `envVariables`, `execSystemId` and the image, and
  the Create line says the app becomes public. DYNAMO cannot make an app private
  again. That needs Tapis (owner or administrator).
- **Two calls can half-succeed.** Create and share are separate. A failed share
  leaves a private app. The dialog handles this explicitly (see above).
- **Pasted definitions are powerful.** A definition can name any image and run on
  any system the user can reach. The real new risk is social: an author pastes a
  definition from a tutorial and unknowingly creates a runnable app. The review
  step highlights image, system and unknown fields.
- **Browser holds the token.** It already does, for Hasura and the Ensemble
  Manager. This adds one more place the token is sent, to `portals.tapis.io` only,
  taken from configuration. Nothing in a pasted definition or the URL can change
  the destination, and the token is never logged or shown.
- **Checks are client-side only.** There is no server to enforce them, so they are
  guidance. Tapis is the authority. Refusing `:latest` images and `owner` keys
  helps honest users and does not stop a determined one, who could use the Cookbook
  UI anyway.
- **No in-DYNAMO edit or delete.** A mistaken app is corrected as a new version or
  disabled in Tapis. Tapis has no hard delete for versions.
- **Orphaned apps.** The form is saved separately, so an abandoned model form can
  leave a created app behind. The dialog says the app is created immediately.
- **Raw `app.json` is easy to get wrong.** The review step and Tapis's messages
  are the safety net.
- **Read-after-write lag.** Tapis may not list a new app immediately. The UI
  selects by the known reference and does not retry silently.
- **The existing API routes keep their own flaw.** They build the Tapis address
  from an unchecked `tenant` in the URL, so a crafted value could send a token to
  another host. This feature no longer touches them. It is recorded here as a
  separate issue to raise, not fixed in this change.

## Alternatives considered

- **Through the model catalog API.** The first choice. Dropped: the API should not
  be involved, and it added a server route, validation, logging and CORS work for
  something Tapis already permits from the browser.
- **Guided form from the two templates.** Easier for authors, more UI, and it
  would drop Tapis fields advanced users need. Deferred.
- **A separate Register Application page.** More navigation for the same result.
- **Link out to the Cookbook UI.** No write, but keeps the two-tool step.
- **Registry restriction.** Left to Tapis. A browser-side allowlist is trivially
  bypassed.

## Test plan

- Library (unit): parse and summary; every pre-send check including the
  `envVariables` flag; error-message extraction from a Tapis error body; path
  segments encoded; `shareTapisAppPublic` calls the right path with the id encoded
  and treats "already public" as success.
- UI (MSW):
  - Invalid or oversized JSON blocked; upload and paste both work.
  - The review summary is correct, including the unnamed-input warning, the
    all-`FIXED` message and a duplicate flag.
  - No request before Create; Create disabled while in flight; cancel sends
    nothing.
  - The request goes to the configured tenant with the `X-Tapis-Token` header and
    nothing else carries the token.
  - Success selects the app, reloads the list so it includes the new app, and
    seeds from the read-back app.
  - Replace or Keep choice appears when rows exist.
  - Success calls create then share, in that order, and the dialog states the app is public.
  - A failing share after a successful create leaves the app selected, says it is
    private, offers Make public, and Make public sends only the share call.
  - The `envVariables` warning appears in the review step.
  - A failing read-back after a successful create leaves the app selected and does
    not report a create failure.
  - A Tapis error shows its message and keeps the pasted text.
  - The picker still lists and reads apps through the direct client.
- Manual, dev only, with the user's confirmation at run time because it writes
  (the user agreed on 2026-10-29, and I will name the app and ask once more
  first): create one clearly named throwaway app (`dynamo-ui-test-<date>`),
  confirm it appears, is public and seeds a form, then ask an owner or administrator
  to make it private and disable it in Tapis. Because it is public, it will be
  visible to the whole tenant until then, so use a harmless definition (for example
  the command template).

## Documentation plan

Update the guide pages and screenshot above, and the DSO-Architecture notes for
the model form's Tapis integration.

## Rollout/rollback plan

UI only, no deploy ordering. Rollback is reverting the UI change. Applications
already created in Tapis stay in place, and the owner or an administrator
disables them in Tapis.

## Open questions

None. Both earlier questions were answered by the user on 2026-10-29 (see Decisions).

## Decisions

- 2026-10-29: Create the app inside the model form, not on a separate page or via a link out.
- 2026-10-29: Author pastes or uploads `app.json`. A guided form is deferred.
- 2026-10-29: Writes go directly from the UI to Tapis with the user's own token. The model catalog API is not involved. This replaces the earlier choice to go through the API.
- 2026-10-29: The deployment tenant is `portals`, taken from configuration.
- 2026-10-29: Seed from a read-back of the created app, and ask before replacing existing rows.
- 2026-10-29: No registry restriction (left to Tapis).
- 2026-10-29: Manual dev test creating one throwaway app was agreed in principle by the user.
- 2026-10-29: The picker's existing list and read calls also move to Tapis directly, so there is one path.
- 2026-10-29: The line "this creates a real application under your account" is enough as the confirmation. No typed confirmation. The line also states the app becomes public.
- 2026-10-29: The created app is made public through Tapis's public-share call, as a second step after create, per the user.

- 2026-10-29 (deviation): `owner` is allowed when it is exactly `${apiUserId}`, and any other value is refused. The security review proposed rejecting `owner` outright, but the official Tapis templates carry `"owner": "${apiUserId}"`, which Tapis resolves to the requester, so rejecting it would have refused the templates this feature exists for.
- 2026-10-29 (deviation, behaviour change): the picker now lists with `listType=ALL&limit=-1`. Tapis lists only the caller's own apps by default, so an app made public by someone else would never appear. On the dev tenant that moves the list from 31 apps to 164. `limit=-1` is needed because `listType=ALL` alone stops at 100 and silently drops the rest. Checked live with a signed-in token on 2026-10-29.
- 2026-10-29 (deviation): the dialog shows the "creates a real application ... and makes it public" notice and the Create button together on the review step, and `envVariables` produce a warning but do not block Create.
- 2026-10-29: The model catalog API's two Tapis routes were left unchanged, and the unchecked-tenant flaw in them is still open as a separate issue.

## Implementation notes

- `ui-react/src/lib/tapis-apps.ts`: direct Tapis client (`listTapisApps`, `getTapisApp`, `createTapisApp`, `shareTapisAppPublic`) and `parseTapisAppDefinition`.
- `ui-react/src/hooks/useTapisApps.ts`: shared list with `reload()`. It reads nothing when the deployment does not use Tapis.
- `ui-react/src/components/registration/RegisterTapisAppDialog.tsx`: the dialog.
- `ComponentLocationSection.tsx` and `TapisAppPicker.tsx`: button, reload, and a picker that takes its list as a prop.
- Tests: 13 dialog tests, library tests for every pre-send check and request, and the existing section tests moved to the direct Tapis URLs. The full suite passes (131 files, 1251 tests), and typecheck and lint are clean. A deliberate break in the share step is caught by exactly the two share tests.
- Not yet done: guide update (waits on the cookbook guide PR), a dialog screenshot (needs the deployed dev site), DSO-Architecture note, and the live check.

## User feedback / decisions

Scope and input method chosen by the user on 2026-10-29. The user then directed
that the API must not be involved and that the UI should call Tapis directly,
with `portals` as the tenant. The user then approved implementation. The user confirmed moving the picker's list and read
calls to Tapis, that the "creates a real application" line is enough, and that the
created app must be public. Awaiting explicit approval to implement.
