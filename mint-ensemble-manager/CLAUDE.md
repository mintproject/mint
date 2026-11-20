# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

### Building and Running
- `npm run build` - Build the application using webpack
- `npm start` - Build and start the server (production mode)
- `npm run start:watch` - Start with nodemon for development

### Testing
- `npm test` - Run tests using Jest
- Jest configuration includes support for GraphQL file imports and TypeScript transforms
- Set `ENSEMBLE_MANAGER_CONFIG_FILE=src/config/config.json` for test configuration
- Test files follow pattern `*.test.ts` and use babel-jest transformer

### Code Quality
- `npm run lint` - Run ESLint over `src` and `scripts` (what CI runs; any error fails)
- `npm run format:check` - Check Prettier formatting of `src` and `scripts` (what CI runs)
- `npm run eslint:fix` - Run ESLint and fix issues
- `npm run prettier:fix` - Format code with Prettier
- Codegen output (`src/classes/graphql/graphql.ts`, `gql.ts`, `fragment-masking.ts`, `index.ts`, `types.ts`) is excluded from both; never hand-edit it

### GraphQL Code Generation
- `npm run codegen` - Generate TypeScript types from GraphQL schema and operations
- Uses `@graphql-codegen/cli` with client preset for type-safe document nodes
- Generates types in `src/classes/graphql/types.ts` from schema at `http://graphql.mint.local/v1/graphql`

## Architecture Overview

This is a **MINT Ensemble Manager** - a Node.js/Express API server for managing scientific modeling ensemble workflows. It provides REST APIs for problem statements, tasks, subtasks, and execution management.

### Core Architecture Components

**API Structure:**
- Express.js server with OpenAPI/Swagger documentation
- Layered architecture: Routes → Services → GraphQL adapters
- API versioning under `/v1` namespace
- Bull.js queues for background job processing

**Key Domain Concepts:**
- **Problem Statements**: High-level research questions and scope
- **Tasks**: Specific modeling objectives within problem statements
- **Subtasks**: Model configurations, parameters, and data inputs (formerly called "Threads")
- **Executions**: Job execution management across different backends

**Execution Backends:**
- **Tapis**: Primary execution backend for HPC job submission
- **Local**: Local Docker/Kubernetes execution
- **Queue Management**: Redis-backed Bull queues for job processing

**Data Layer:**
- GraphQL client for data persistence (Hasura backend)
- Model Catalog integration for scientific model metadata
- Data Catalog integration (CKAN) for dataset management

### Key File Structure

**Configuration:**
- `src/config/config.json` - Main configuration file with API endpoints, auth settings
- `src/config/app.ts` - Application configuration loader
- `src/config/redis.ts` - Redis queue configuration

**API Layers:**
- `src/api/api-v1/paths/` - Route handlers for each API endpoint
- `src/api/api-v1/services/` - Business logic services
- `src/classes/graphql/` - GraphQL queries and type definitions

**Core Classes:**
- `src/classes/mint/` - MINT platform integration (model catalog, data catalog)
- `src/classes/tapis/` - Tapis HPC backend integration
- `src/classes/localex/` - Local execution backend
- `src/classes/common/` - Shared execution logic

**GraphQL Integration:**
- `src/classes/graphql/queries/` - GraphQL queries organized by domain
- `codegen.ts` - GraphQL code generation configuration
- Auto-generated types in `src/classes/graphql/types.ts`

### Development Notes

**Path Aliases:**
- `@/api/*` maps to `src/api/*`
- `@/classes/*` maps to `src/classes/*`
- `@/config/*` maps to `src/config/*`
- `@/utils/*` maps to `src/utils/*`
- `@/interfaces/*` maps to `src/interfaces/*`

**Authentication:**
- JWT-based authentication with RS256 algorithm
- Keycloak integration for production environments
- Security enabled by default in v6.0.0+

**API Documentation:**
- Swagger UI available at `/{version}/ui` (e.g., `/v1/ui`)
- OpenAPI spec auto-generated from JSDoc comments in route files

**Background Processing:**
- Bull.js queues for execution management
- Bull Board dashboard at `/admin/queues`
- Redis backend for queue persistence

**Docker Support:**
- Dockerfile for containerized deployment
- `compose.yaml` at the repository root runs the whole MINT stack on a laptop. See `compose/README.md`
- Kubernetes manifests for cluster deployment