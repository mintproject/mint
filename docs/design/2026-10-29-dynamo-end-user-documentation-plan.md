# DYNAMO end-user documentation plan

## Status

Implementing — user approved bundling the Material for MkDocs guide with MINT React UI. Local integration is complete; verified task procedures and publication remain outstanding.

## Objective

Turn the [DYNAMO role guide](../dynamo-facilitator-data-scientist-guide.md) into a maintained, task-oriented user manual for facilitators and data scientists. Deliver a usable first release explaining how to make a model runnable, register a model, register data, use a model, and inspect results. Document the supported tools needed to complete those tasks, including workflows outside the React UI.

This document plans documentation work only. It does not authorize application changes, model execution, catalog writes, GitHub writes, or deployment.

## User need

Facilitators need to move from a scientific or decision question to a reproducible model setup and understand its results. Data scientists need to register and curate model metadata and transformations so another person can discover and use them.

Organize navigation around facilitators and data scientists/model authors, with practical tasks beneath each role and shared discovery/reference pages. “Make a model” means preparing or adapting scientific model code into a runnable component, with defined inputs, outputs, parameters, and an execution contract. Distinguish this from registering metadata and configuring a scenario. Teaching the development of a scientific model from first principles is outside the first release.

Both audiences need clear prerequisites, familiar terminology, actionable recovery advice, and an explanation of the boundaries between DYNAMO and external systems.

## Current code/system summary

- The source guide is a working draft containing user journeys, role descriptions, UI recommendations, and unresolved product questions. It is an outline and input to this work, not an independently verified manual.
- `ui-react/src/App.tsx` defines routes for models, datasets, variables, regions, ETL, and modeling. Workflow components and focused tests live under `ui-react/src/pages/modeling/`.
- The repository README identifies `ui-react/` as the current frontend and links to `mintproject/MINT_USERGUIDE` as the separately maintained user-documentation repository.
- Existing `docs/` content includes design decisions, operational runbooks, and deployment instructions. `knowledge-base/wiki/` contains domain explanations. These are supporting references rather than a substitute for user tasks.
- The local DSO Architecture service page provides system context but still references removed legacy directories. Current repository code takes precedence where they conflict.
- The external manual has not been audited. It is a potential source of reusable content; the user selected `ui-react/docs/` as the canonical documentation home.
- The source guide reports that general dataset registration is outside the current React UI. Verify the supported CKAN/data-publishing workflow before documenting its steps; do not invent an in-app registration flow.
- Planning baseline: local branch `feat/em-per-run-logical-queue`, after refreshing remote refs on 2026-10-29, is one commit behind `origin/develop`. The role guide is currently untracked. No branch changes or existing-file edits were made for this plan.

## Proposed design

### Scope and publishing home

Use DYNAMO as the user-facing product name, explaining its relationship to MINT on the introduction page. Confirm final branding during review.

Canonical source home: `ui-react/docs/` in the MINT monorepo. Use MkDocs with Material, following Upstream's static-documentation build pattern. Markdown content lives in `ui-react/docs/docs/`, preserving existing `docs/superpowers/` planning documents outside the published content root. The UI Dockerfile builds the site in a separate Python stage and copies it into the existing Nginx image under `/docs/`. Use Material's built-in search; Pagefind is unnecessary for this initial guide.

Nginx redirects `/docs` to `/docs/`, serves real files and directory indexes below `/docs/`, and returns 404 for missing documentation instead of the React shell. Existing application routes, runtime configuration, and asset caching remain intact. Container builds include docs automatically. Vercel and Vite-only previews continue building the React application; a separate MkDocs command previews documentation locally. No live deployment is part of this work.

Supersedes the separate repository architecture. Reuse its 14 starter pages, retain the sibling scaffold untouched, and make the monorepo copy canonical. Do not reuse Upstream-specific screenshots as evidence of DYNAMO UI behavior.

The first release covers complete user tasks across the React UI and supported model-preparation, execution-registration, and data-publishing tools. Include packaging, execution contracts, storage/resource references, and semantic metadata where users need them to make their resources usable. Platform deployment, database administration, and exhaustive API/ontology reference remain in technical docs and are linked as needed.

### Proposed information architecture

Navigation is role-based, with practical tasks under each role:

1. **Start here** — introduction, access prerequisites, shared concepts, and choosing a role.
2. **Find models and data** — shared discovery and compatibility guidance.
3. **Facilitator** — frame a question; use a model (select models/data, set parameters, submit and monitor); review results and history.
4. **Data scientist / model author** — make a model runnable; register a model; register data; transformations and curation.
5. **Troubleshooting** — missing matches, permissions/access, invalid inputs, failed runs, and missing outputs.
6. **Reference** — glossary and shared concepts.

Make/register/use workflows remain first-release scope, including supported external-tool workflows. Model preparation distinguishes executable packaging, execution-application registration, catalog metadata registration, and scenario configuration. Data registration covers the external catalog workflow and synchronization needed for discovery; it does not imply an in-app registration form.

The reused scaffold contains 14 Markdown pages, `mkdocs.yml`, `requirements.txt`, `.gitignore`, and a contributor/preview README. Task outlines are explicitly labeled as incomplete. A consistent verified example remains to be selected.

### Page standard

Each task page must include:

- The user goal and intended audience.
- Prerequisites: sign-in, ownership/permissions, required catalog resources, and any external access.
- Numbered steps using labels verified in the supported UI.
- Expected result and a clear way to recognize success.
- Common failures with safe next actions.
- Links to the next task and relevant concepts.
- A recorded verification date and application revision/environment, using existing site metadata conventions where possible.

Use screenshots only when they clarify a choice or location. Capture them from the verified environment, provide alt text, and remove credentials and private information. Text must remain usable when screenshots change.

### Convert the draft into publishable content

Classify each source-guide statement as verified behavior, a known limitation, a UI recommendation, or an open question. Only verified behavior becomes procedural instruction. Record recommendations and unresolved questions in the planning backlog; do not imply that proposed controls exist.

Validate registration-field persistence, ownership/visibility behavior, readiness checks, output presentation, and comparison capabilities before making claims. A visible field or button alone is not evidence of persistence or a successful workflow.

### Implementation sequence and deliverables

**Phase 1 — Audit and agree on the manual structure**

- Inspect monorepo conventions and relevant model-preparation, execution-registration, and dataset-publishing tools. Audit the external guide for reusable material without making it the publishing destination.
- Use `ui-react/docs/` for content, Material configuration, and contributor instructions. Bundle the generated guide in the existing UI container at `/docs/`.
- Compare existing pages with the proposed structure; identify pages to retain, revise, redirect, or retire.
- Choose the supported application revision/environment, canonical terminology, destination paths, and one reproducible example.
- Deliver a content checklist with proposed pages, existing destinations, priority, evidence sources, dependencies, and verification status. Keep it in the existing docs contribution/planning location.
- Exit condition: navigation, publishing home, example, and scope are approved before authoring the manual.

**Phase 2 — Core task guides: make, register, and use resources**

- Write Start here and the four core guides: make a model runnable, register a model, register data, and use a model.
- Verify the model-author/execution-operator handoff and the data-catalog/DYNAMO handoff. Include prerequisites, sample metadata, and a success check for each.
- Use one consistent scientific question and resource set across the walkthrough. A MODFLOW example is a candidate, subject to availability and reproducibility checks; do not invent a dataset or successful output.
- Cover results and failure recovery alongside the successful path.
- Deliver a local rendered preview and a walkthrough verification record. Any actual model execution requires separate explicit authorization.
- Exit condition: a reviewer can follow the documented journey in an approved test environment, or specific unexecuted steps are clearly recorded as unverified and withheld from release.

**Phase 3 — Curation, transformations, and reference**

- Complete resource editing/versioning, semantic contracts, ETL, region curation, and validation tasks.
- Complete troubleshooting, glossary, and known limitations.
- Verify examples with existing tests, source inspection, and an authorized disposable environment when writes are necessary.
- Exit condition: covered tasks have verified prerequisites, expected results, ownership boundaries, and recovery guidance.

**Phase 4 — Review, release, and maintenance**

- Obtain a domain review and a fresh-reader usability review, using the minimum relevant reviewers.
- Run the site's documented build/link checks and inspect the rendered navigation and images.
- Prepare the release and application README link changes for review. Pushes, PR creation, and deployment require explicit approval.
- Establish a maintenance rule: UI labels, workflow steps, permissions, or catalog-contract changes trigger review of affected manual pages in the same change cycle.
- Exit condition: approved content is published at the confirmed canonical location, entry links work, and a maintainer accepts responsibility for future verification.

No delivery dates or named owners are assumed. Assign them after the initial audit establishes the size of the existing manual.

## Files likely affected

- This file: plan, approval record, and significant decisions.
- `docs/dynamo-facilitator-data-scientist-guide.md`: source material; preserve until replacement pages are accepted, then add a pointer rather than silently deleting it.
- `README.md`: eventual link to the canonical DYNAMO manual.
- `ui-react/docs/`: task pages, navigation, assets, build/preview configuration, and contribution/verification guidance.
- `ui-react/Dockerfile`, `ui-react/docker/nginx.conf`, ignore rules, and README: build, serve, and explain the integrated guide.
- External `mintproject/MINT_USERGUIDE`: read-only reference for reusable material; no changes or retirement assumed.
- Existing operational and domain docs: links only where relevant; revise technical documentation only if a verified discrepancy is within approved scope.

Application TypeScript logic does not change; container build and Nginx routing change to include the guide. In-app help links remain a separate scoped proposal.

## API/schema changes

None. This plan does not change endpoints, schemas, permissions, or application behavior.

## Data flow

Source guide and existing manual → classification and gap audit → current UI/code evidence → task pages → rendered preview → user walkthrough and review → approved publication.

Documentation examples use public or explicitly approved resources. Any test runs and catalog mutations remain separately authorized activities.

## Risks and tradeoffs

- The source guide mixes current behavior and desired behavior. Resolve this through statement-level verification before writing instructions.
- Local and deployed versions may differ. Record the supported revision/environment and avoid promising capabilities verified only on another version.
- The external manual may overlap with the new guide. Identify reusable content and label the new canonical source clearly; coordinate any external retirement separately.
- Model preparation and data publishing span tools beyond the UI. Verify execution/storage contracts and access requirements before presenting an end-to-end recipe.
- Live examples can require compute, authentication, or writes. Prefer existing safe evidence and authorized test fixtures; record any verification gaps honestly.
- Task guides can duplicate concepts. Use shared reference pages and link to them.
- Branding and documentation ownership remain unresolved. Confirm both before release.

## Alternatives considered

- **Publish the existing draft unchanged:** quick, but leaves UI proposals mixed with instructions and lacks testable task outcomes.
- **Keep the external manual as the canonical source:** superseded by the user’s selection of a guide bundled with MINT React UI. Reuse verified content where useful.
- **Nested Git repository/submodule:** not proposed; it introduces a separate version lifecycle and conflicts with the current no-submodules convention. Keep documentation versioned with the application.
- **Separate documentation hosting:** avoids coupling releases but adds an independent deployment; user chose the established Upstream pattern instead.

## Test plan

For the plan itself, check required sections, relative links, source references, scope boundaries, and whether every phase has a concrete deliverable and exit condition.

For documentation implementation:

- Run the confirmed site's build and link checks; all internal links and navigation must resolve.
- Inspect rendered pages at desktop and narrow widths; verify image legibility and alt text.
- Trace procedural labels and behavior to the supported UI revision. Record limitations rather than guessing.
- Have a fresh reader follow the linked make/register/data/use example and one representative maintenance task in an explicitly authorized test environment. Do not perform external writes merely to validate documentation.
- Verify documented failures and recovery steps against relevant code/tests or approved observations.
- Release only when every published task has prerequisites, steps, expected result, recovery guidance, and verification evidence. Record excluded or unverified tasks as remaining work.

## Documentation plan

The deliverable is the manual described above, plus a contribution/verification checklist in its existing documentation conventions. Keep this plan updated with approvals, destination paths, completed phases, and deviations. Retain operational documentation in its established home and link to it instead of copying it.

## Rollout/rollback plan

Draft locally, render a preview using the existing site tooling, and obtain content approval before publishing. Preserve existing URLs or add redirects using the framework's supported mechanism. Publish through the current workflow only after explicit authorization. If a release is incorrect, restore the prior documentation revision through an approved change; no application or database rollback is involved.

## Open questions

- Is DYNAMO the preferred title throughout, with MINT explained as the underlying project name?
- Which application environment/release should the manual describe?
- Which reproducible model and dataset should anchor the make/register/data/use walkthrough?
- Which supported model-packaging and data-publishing paths should the first release teach?
- Which supported release should first publish the bundled guide at `/docs/`?
- Who will own content maintenance and provide facilitator/data-scientist review?

These questions affect implementation choices; they do not prevent review of this draft plan.

## Decisions

### 2026-10-29 — Use the role guide as planning input

- **Decision:** Build a documentation plan from the facilitator/data-scientist draft, retaining both audiences and the Explore/Decide distinction.
- **Reason:** The draft identifies user goals and workflows but does not define implementation deliverables or publishing criteria.
- **Alternatives rejected:** Treating the source draft as an already approved manual or implementation plan.
- **User feedback:** The user requested building the documentation plan from that guide. This authorizes drafting the plan; implementation and publication are not yet approved.
- **Impact on implementation:** Audit and verify source statements before authoring procedures; propose the existing manual as the canonical destination pending review.

### 2026-10-29 — Dedicated monorepo guide and task-based scope (superseded)

- **Decision:** Place the guide in a dedicated `user-guide/` project inside the monorepo. Center the first release on making a model runnable, registering models, registering data, and using models.
- **Reason:** The user requested a guide within the monorepo focused on practical resource creation, registration, and use.
- **Alternatives rejected:** The earlier external-manual publishing recommendation is superseded. Restricting coverage to current React UI workflows would omit essential user tasks.
- **User feedback:** “Its own user guide repo within monorepo,” focused on “register a model, make a model, use a model, register data.”
- **Impact on implementation:** Propose a self-contained `user-guide/` project without nested Git metadata; include supported external-tool procedures. Exact toolchain and hosting remain open. This records scope feedback, not approval of the full implementation plan.

### 2026-10-29 — Separate MkDocs repository with role navigation (superseded)

- **Decision:** Use a separate `dynamo-user-guide` Git repository and MkDocs with role-based navigation. The preceding in-monorepo and task-first navigation decisions are superseded.
- **Reason:** User selected a separate MkDocs repository while retaining the original role structure, then instructed implementation.
- **User feedback:** “We can do mkdocs as a separate repo. but like that structure of roles”; followed by “do it.”
- **Impact on implementation:** Scaffold locally beside `modflow-suite`. Use the built-in MkDocs theme; Material was suggested previously but not selected. No GitHub repository, push, or deployment. Full manual implementation remains pending verified procedures.
- **Validation:** Initial staged site passed `mkdocs build --strict` with MkDocs 1.6.1. Specialist review confirmed role/task coverage and highlighted external dataset registration and verification requirements.

### 2026-10-29 — Bundle guide with the MINT React UI

- **Decision:** Adopt the Upstream architecture in MINT: Material for MkDocs source in `ui-react/docs/`, static build packaged in the UI container, served at `/docs/` with role navigation.
- **User feedback:** User asked whether the same architecture could be used with MINT UI, then instructed “lets do that.” This approves the architecture and its local implementation.
- **Alternatives rejected:** The separate `dynamo-user-guide` repository proposal is superseded; keep its local files intact as source material.
- **Files affected:** UI Dockerfile and Nginx config; `ui-react/docs/{mkdocs.yml,requirements.txt,README.md,docs/}`; UI/root README links and ignore rules; this plan; DSO MINT service documentation.
- **Tests:** strict Material build, Nginx syntax and HTTP checks for docs redirect, page/assets, missing docs and existing SPA fallback; inspect image build configuration. Record unavailable checks.
- **Rollout:** existing image pipeline will include docs on a future authorized release. No push, deployment, or catalog/model writes now.
- **Implementation outcome:** copied 14 starter pages into `ui-react/docs/docs/`, configured Material, added an isolated Docker build stage and Nginx routes, and updated contributor and DSO service documentation. The separate scaffold remains untouched.
- **Validation outcome:** strict Material build and whitespace checks passed; generated nested role pages, CSS, and search index were verified and internal planning content excluded. Final specialist review found no blocking configuration/security issues. Full image build, Nginx syntax, and HTTP route tests could not run because Docker Desktop is paused; run these before deployment. The manual remains incomplete pending verified task procedures.

## User feedback / decisions

- 2026-10-29: User requested a documentation plan based on the role guide.
- 2026-10-29: User selected an in-monorepo user-guide project and practical make/register/use model and data tasks. Plan revised accordingly.
- User approved integrating the role-based guide into MINT React UI, following Upstream. Worked example, supported release, verified procedures, and live publication remain outstanding.
