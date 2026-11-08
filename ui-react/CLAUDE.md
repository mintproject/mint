# CLAUDE.md — ui-react

Context file for AI coding agents working inside `ui-react/`. Read this before generating code or making changes.

## Project Overview

MINT Model Catalog UI — a React 18 rewrite of the legacy LitElement app (`ui/`). Part of the MINT monorepo (`mintproject/mint`). The primary goal is to simplify model configuration for domain scientists on the SUBSIDE project: a user should be able to configure a model input (variable, standard variable, unit) in a single form submission rather than the current 5-level, 3-modal workflow.

This project lives at `ui-react/` alongside the legacy `ui/` (LitElement). The two coexist; do NOT port LitElement patterns (Redux, Webpack, LitElement decorators, `@lit/reactive-element`) into this app.

## Technology Stack

- React 18 + TypeScript (strict mode, `noUncheckedIndexedAccess`)
- Vite 5 — dev server port 3000, sourcemaps enabled
- Tailwind CSS 3 + shadcn/ui components (Radix UI primitives, CVA, clsx, tailwind-merge)
- Apollo Client 3 for GraphQL against a Hasura backend
- React Router 6 — client-side routing
- React Hook Form + Zod for form validation
- GraphQL Code Generator — typed hooks and operations
- Vitest 2 + Testing Library + MSW 2 for unit/integration tests
- ESLint 9 (flat config) + Prettier (with tailwindcss plugin)
- Node >= 20 required

## Development Commands

Run these from inside `ui-react/`:

```
npm run dev              # Vite dev server (port 3000, auto-opens browser)
npm run build            # TypeScript check (tsc -b) + Vite build -> dist/
npm run preview          # Serve the dist/ build locally
npm test                 # Vitest single run
npm run test:watch       # Vitest watch mode
npm run test:coverage    # V8 coverage (30% threshold: statements/branches/functions/lines)
npm run lint             # ESLint (flat config, eslint.config.js)
npm run format           # Prettier write on src/**/*.{ts,tsx,css,json}
npm run format:check     # Prettier check (CI-safe)
npm run codegen          # GraphQL Code Generator -> src/graphql/generated/graphql.ts
```

For codegen to succeed you need a running Hasura instance. Set env vars:
```
HASURA_ENDPOINT=https://graphql.mint.isi.edu/v1/graphql
HASURA_ADMIN_SECRET=<secret>
```
Or export them before running `npm run codegen`.

## Project Structure

```
ui-react/
  src/
    App.tsx                       # Route declarations, top-level providers
    main.tsx                      # ReactDOM.createRoot, provider tree
    vite-env.d.ts                 # window.__MINT_CONFIG__ type declaration

    components/
      ui/                         # shadcn/ui primitives (Button, Card, Dialog,
                                  # Input, Label, Form, Tabs, Toast, Badge, etc.)
      common/                     # Shared utility components:
                                  #   ErrorBoundary, LoadingSpinner, EmptyState,
                                  #   ConfirmDialog, ProtectedRoute
      layout/                     # AppShell, Header, Sidebar, BrandingStrip, Footer
      home/                       # Landing-page lanes: ExploreCard,
                                  #   explore-destinations, DecidePanel
      model-tree/                 # ModelTree, TreeNode
                                  #   (Software -> Version -> Config -> Setup)
      configuration/              # PLACEHOLDER (.gitkeep) — flattened config form
      registration/               # PLACEHOLDER (.gitkeep) — model registration
      autocomplete/               # PLACEHOLDER (.gitkeep) — StandardVariable/Unit typeahead

    pages/
      AppHome.tsx                 # / — Explore lane + Decide lane, no map
      AboutPage.tsx               # /about — the DYNAMO description
      ModelsPage.tsx              # /models
      ConfigurePage.tsx           # /models/configure/:id
      RegisterPage.tsx            # /models/register
      NotFoundPage.tsx            # * (404)
      OAuth2CallbackPage.tsx      # OAuth2 redirect callback
      modeling/
        ModelingHome.tsx          # /modeling
        ProblemStatementsList.tsx # /modeling/problem-statements
        MintProblemStatement.tsx  # /modeling/problem-statement/:id
        MintThread.tsx            # /modeling/thread/:id
      datasets/
        DatasetsHome.tsx          # /datasets
        DatasetsBrowse.tsx        # /datasets/browse
        DatasetsSearch.tsx        # /datasets/search
        DatasetDetail.tsx         # /datasets/detail/:id
      regions/
        RegionsHome.tsx           # /regions
        RegionsEditor.tsx         # /regions/editor
        RegionDatasets.tsx        # /regions/:id/datasets
        RegionModels.tsx          # /regions/:id/models
      variables/
        VariablesHome.tsx         # /variables

    contexts/
      ModelSelectionContext.tsx   # Selected node in the model tree

    hooks/
      useModelTree.ts             # Tree state: search, expand/collapse
      useReferenceData.ts         # Reference data (standard variables, units)
      useDebouncedValue.ts        # Generic debounce
      useCatalogCounts.ts         # Explore-card counts (Hasura aggregates +
                                  #   CKAN); every count independently optional

    lib/
      apollo-client.ts            # ApolloClient with auth link + cache type policies
      mutation-builder.ts         # Helpers for building Hasura mutation objects
      uri.ts                      # URI helpers for model catalog IDs
      utils.ts                    # cn() (clsx + tailwind-merge)
      modeling/
        recent-problem-statements.ts  # Reduce a provenance feed to the
                                      #   statements a user touched last
      auth/
        AuthProvider.tsx          # AuthContext provider — isAuthenticated, user, login, logout
        useAuth.ts                # useContext(AuthContext)
        oauth2-adapter.ts         # authorize() / logout() redirects to IdP
        token-store.ts            # localStorage token persistence + decode

    graphql/
      queries/model-catalog.graphql    # Read operations
      queries/catalog-counts.ts        # Hand-authored: aggregate counts
      mutations/model-catalog.graphql  # Write operations
      fragments/model-catalog.graphql  # Shared fragments
      generated/graphql.ts             # DO NOT EDIT — generated by codegen

    schemas/                      # PLACEHOLDER (.gitkeep) — Zod validation schemas

    styles/
      globals.css                 # Tailwind @base / @components / @utilities imports

    test/
      setup.ts                    # Vitest setup (jest-dom matchers, MSW lifecycle)
      msw/
        handlers.ts               # MSW request handlers
        server.ts                 # MSW server setup
      utils/
        render.tsx                # renderWithProviders() — wraps with Apollo + Auth + Router
        auth-mocks.ts             # Mock AuthContext values
        apollo-mocks.ts           # MockedProvider helpers
        mint-config.ts            # setMintConfig() — window.__MINT_CONFIG__ for tests

    __tests__/                    # Cross-cutting integration tests
```

## Architecture Patterns

### Path aliases

`@/*` maps to `./src/*`. Configured in both `tsconfig.json` (paths) and `vite.config.ts` (resolve.alias) and `vitest.config.ts`. Always use `@/` imports — never relative `../../`.

### Runtime configuration

`scripts/generate-env-config.mjs` is the single source of truth for the config
shape. It is invoked in three contexts, and a new key must be added there:

- Vercel build (`npm run build`, gated on `VERCEL`) — rewrites `dist/env-config.js`
- Container startup (`docker/entrypoint.sh`) — same module with an explicit
  output path argument, which is what puts it in runtime mode
- Local development — the committed `public/env-config.js` is served as-is, and
  `npm run config:local` regenerates it from a `.env` (see `.env.example`)

`window.__MINT_CONFIG__` is what the app reads. `import.meta.env.VITE_*` is a
whole-object fallback that fires only when `window.__MINT_CONFIG__` is absent —
i.e. in the jsdom tests, **not** under `npm run dev`, where `index.html` always
loads `public/env-config.js`. Setting a `VITE_*` var does not change the dev
server; edit `public/env-config.js`. `generate-env-config.mjs` defaults target
`*.mint.local` (in-cluster) and `public/env-config.js` targets the repository's
compose stack — `localhost:8080` for Hasura, `localhost:3001` for Ensemble
Manager — so `npm run dev` needs `docker compose up -d` first and never writes
to a deployment by default. The shape is shared, the values deliberately are
not.

Keys:
- `HASURA_ENDPOINT` — Hasura GraphQL endpoint URL
- `AUTH_SERVER` — OAuth2 issuer base URL
- `AUTH_CLIENT_ID` — OAuth2 client ID
- `AUTH_REALM` — Keycloak realm (Keycloak only)
- `AUTH_PROVIDER` — `'keycloak'` | `'tapis'`
- `GOOGLE_MAPS_KEY`, `WELCOME_MESSAGE`
- `DATA_CATALOG_API`, `DATA_CATALOG_BROWSE_URL`, `ENSEMBLE_MANAGER_API`
- `MODEL_CATALOG_API` — model catalog REST API base, version prefix included.
  The app reads the catalog through Hasura and calls this base only for the
  routes Hasura cannot serve: today the Tapis application proxy behind the
  component location picker (`src/lib/tapis-apps.ts`)
- `EXECUTION_ENGINE` — `'tapis'` | `'localex'` | `'wings'`; the backend the
  deployment's Ensemble Manager runs. Selects the run-submission route, which
  differs per backend (see `executionEnginePath` in `src/lib/ensemble-manager.ts`)
- `BRANDING` — `'tacc'` | `'none'`; which co-branding the chrome shows. Names a
  preset in `src/lib/branding.ts`; the logo files, link targets and alt text are
  not configurable. Defaults to `'none'` — an unbranded deployment must be a
  default, not an accident
- `AUTH_CALLBACK_ORIGIN`, `AUTH_PREVIEW_ORIGIN_ALLOWLIST`

Each key accepts a bare or `VITE_`-prefixed env var name; empty string is
treated as unset; optional keys are omitted rather than emitted empty. See the
README for defaults. Type declarations are in `vite-env.d.ts` and
`scripts/generate-env-config.d.ts` — keep both in step.

### Authentication

OAuth2 PKCE flow. Supports both Keycloak and Tapis providers (selected by `AUTH_PROVIDER`).

- `AuthProvider` — React context provider. Reads `accessToken` from `token-store`, exposes `login()` and `logout()` actions.
- `useAuth()` — hook, consumes `AuthContext`.
- `token-store.ts` — persists tokens in `localStorage`. Provides `getAccessToken()` used by the Apollo auth link.
- `oauth2-adapter.ts` — `authorize()` redirects to IdP, `logout()` clears tokens and redirects to IdP logout.
- `ProtectedRoute` — wraps routes that require authentication; redirects to login when unauthenticated.
- `OAuth2CallbackPage` — handles the redirect-back URL from the IdP, exchanges the code for tokens.

### GraphQL

Apollo Client is initialised in `src/lib/apollo-client.ts`:
- Auth link reads `getAccessToken()` per-request (no stale tokens baked in at creation time).
- Anonymous reads (no token) use the Hasura anonymous role (SELECT only).
- Authenticated writes forward the JWT with `x-hasura-*` claims (user role, full CRUD).
- `InMemoryCache` type policies are defined for all modelcatalog entity and junction tables. Junction tables use composite `keyFields` to avoid Apollo cache collisions.
- Default fetch policy is `cache-and-network`.

Generated types live in `src/graphql/generated/graphql.ts`. Run `npm run codegen` to regenerate after adding/changing `.graphql` files. Never hand-edit the generated file.

### State management

React Context + Apollo cache. No Redux. The legacy `ui/` used Redux — do not reintroduce it.

- `ModelSelectionContext` — tracks the selected node in the model tree (software / version / config / setup).
- Feature-local state: `useState` / `useReducer`.
- Server state: Apollo cache (`useQuery`, `useMutation` hooks from generated code).

### UI components

Follow the shadcn/ui pattern:
- Primitives live in `src/components/ui/` — thin wrappers around Radix UI, styled with Tailwind + CVA.
- Feature components in `src/components/<feature>/` compose the primitives.
- `cn()` utility (`src/lib/utils.ts`) merges class names: `cn(clsx(...), tailwind-merge(...))`.

### Forms

React Hook Form + Zod. Schema-first: define Zod schemas in `src/schemas/` (currently placeholder), derive TypeScript types with `z.infer<>`, pass schema to `zodResolver()` from `@hookform/resolvers/zod`.

## Testing Patterns

- Vitest 2 with `jsdom` environment. Globals enabled — no need to import `describe`/`it`/`expect`.
- `@testing-library/react` + `@testing-library/user-event` for component tests.
- MSW 2 for API mocking — handlers in `src/test/msw/handlers.ts`, server in `src/test/msw/server.ts`.
- Custom render utility: `renderWithProviders()` from `src/test/utils/render.tsx` — wraps the component under test with `MockedProvider` (Apollo), `AuthProvider` (or mock), and `MemoryRouter`.
- Auth mocks: `src/test/utils/auth-mocks.ts` — pre-built `AuthContext` values for authenticated / unauthenticated states.
- Apollo mocks: `src/test/utils/apollo-mocks.ts` — `MockedProvider` and typed mock factory helpers.

Test file placement:
- Co-located: `src/components/<name>/__tests__/<Name>.test.tsx`
- Cross-cutting: `src/__(tests)__/<Name>.test.tsx`

Every new component needs a test. Tests must pass before a PR is mergeable.

Run tests: `npm test` (single run) or `npm run test:watch` (watch mode).
Coverage: `npm run test:coverage` — enforces 30% threshold on all four metrics.

## GraphQL Integration

- Hasura endpoint: resolved at runtime from `window.__MINT_CONFIG__.HASURA_ENDPOINT`.
- Operations live in `src/graphql/`:
  - `queries/model-catalog.graphql`
  - `mutations/model-catalog.graphql`
  - `fragments/model-catalog.graphql`
- Generated output: `src/graphql/generated/graphql.ts` — typed hooks (`useGetModelTreeQuery`, etc.).
- Codegen config: `codegen.ts` — uses `typescript`, `typescript-operations`, `typescript-react-apollo` plugins. Generates React hooks (`withHooks: true`).
- **Aggregate counts** need `allow_aggregations: true` on the role's select
  permission in `graphql_engine/metadata/tables.yaml`. It is set for `region`,
  `modelcatalog_software` and `modelcatalog_standard_variable` (both roles), and
  is **not** set for the rest -- `GetModelCategoryOptions` and friends still omit
  counts for that reason. A metadata change only takes effect after
  `hasura metadata apply`; until then the aggregate field does not exist and any
  document selecting it fails validation whole. Keep aggregates in their own
  query so a deployment that has not applied the metadata loses a number, not a
  page.
- Database schema prefix: `modelcatalog_`. 4-level hierarchy: Software > SoftwareVersion > Configuration > Configuration (setup/child).
- Junction tables use composite PKs — Apollo cache type policies are pre-configured in `apollo-client.ts`.

## Routing

All routes are declared in `src/App.tsx`. Current routes:

| Path | Component |
|------|-----------|
| `/` | AppHome |
| `/about` | AboutPage |
| `/models` | ModelsPage |
| `/models/configure/:id` | ConfigurePage |
| `/models/register` | RegisterPage |
| `/configure` | Redirects to `/models` |
| `/modeling` | ModelingHome |
| `/modeling/problem-statements` | ProblemStatementsList |
| `/modeling/problem-statement/:id` | MintProblemStatement |
| `/modeling/thread/:id` | MintThread |
| `/datasets` | DatasetsHome |
| `/datasets/browse` | DatasetsBrowse |
| `/datasets/search` | DatasetsSearch |
| `/datasets/detail/:id` | DatasetDetail |
| `/regions` | RegionsHome |
| `/regions/editor` | RegionsEditor |
| `/regions/:id/datasets` | RegionDatasets |
| `/regions/:id/models` | RegionModels |
| `/regions/:id` | Redirects to `/regions/:id/models` |
| `/variables` | VariablesHome |
| `*` | NotFoundPage |

Provider tree in `main.tsx` (outermost first): `StrictMode > BrowserRouter > ApolloProvider > AuthProvider > App`.

## Known Placeholders

These directories contain only `.gitkeep` and have not been implemented yet. They are the next areas of active development:

- `src/components/configuration/` — flattened single-form model I/O configuration (SOW Task 2.0 acceptance criterion)
- `src/components/registration/` — model registration workflow
- `src/components/autocomplete/` — StandardVariable and Unit typeahead (backed by Hasura)
- `src/schemas/` — Zod validation schemas

## Git Guidelines

- Base branch: `develop`. Never branch off `main` — `main` is release-only.
- Per-card branches: `git worktree add .worktrees/<task-id> -b <type>/<task-id>-<slug> origin/develop`
  where type is one of: feat, fix, chore, refactor, docs.
- PRs target `develop` (not `main`).
- Commit messages: clean and simple, no emoji. Never mention Claude or Anthropic as author or co-author in commit messages or code comments.
- All edits must be done inside the worktree; never edit files in the main checkout while a worktree is active on the same branch.
