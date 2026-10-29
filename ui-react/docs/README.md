# DYNAMO user documentation

Role-based Material for MkDocs guide bundled with the MINT React UI container. Content lives in `docs/`; existing `superpowers/` planning material is outside the published content root.

## Preview and build

From `ui-react/docs/`, using Python 3.11 or newer:

```sh
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
mkdocs serve
```

Open the address printed by MkDocs. Validate with `mkdocs build --strict`. Generated output is `site/` and must not be committed.

The UI Dockerfile builds the guide separately and includes it at `/docs/` in the Nginx container. `/docs` redirects to `/docs/`; missing documentation returns 404. Documentation changes therefore ship with the UI image. No runtime Python dependency is added. Vite and Vercel builds still build only the React application; use the separate MkDocs preview for documentation locally.

## Content and review

The initial 14 pages are introductory content and marked task outlines, not verified end-to-end procedures. Navigation covers shared discovery, facilitators, data scientists/model authors, troubleshooting, and reference. Complete tasks need prerequisites/permissions, verified steps, expected results, recovery guidance, next steps, verification date, and application revision/environment.

Source material: `../../docs/dynamo-facilitator-data-scientist-guide.md` and `../../docs/runbook-ckan-svo-dataset-registration.md`. The plan is `../../docs/design/2026-10-29-dynamo-end-user-documentation-plan.md`. The local standalone scaffold was copied here and left intact; this copy is now canonical.

Do not publish proposed UI behavior as implemented. Review examples and media for credentials/private data. Only place public user-facing material under `docs/`; do not copy internal planning documents there. DYNAMO-specific screenshots must reflect the supported UI rather than Upstream screens.
