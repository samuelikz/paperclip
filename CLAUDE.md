# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is Paperclip?

Paperclip is an open-source orchestration platform for AI-agent companies. It is a Node.js/Express REST API + React UI that manages org charts, budgets, goals, heartbeat scheduling, governance approvals, and multi-company isolation for teams of AI agents.

## Commands

```sh
pnpm install          # Install all workspace dependencies
pnpm dev              # Start API + UI in watch mode (http://localhost:3100)
pnpm dev:once         # Start without file watching
pnpm dev:server       # Server only
pnpm dev:ui           # UI only (Vite dev server)
pnpm build            # Build all packages
pnpm typecheck        # Type-check all packages (pnpm -r typecheck)
pnpm test:run         # Run all tests once
pnpm test             # Run tests in watch mode
pnpm db:generate      # Compile db package + generate Drizzle migration
pnpm db:migrate       # Apply pending migrations
```

Run a single test file:
```sh
pnpm vitest run path/to/file.test.ts
```

Full pre-handoff check:
```sh
pnpm -r typecheck && pnpm test:run && pnpm build
```

Reset local dev database:
```sh
rm -rf ~/.paperclip/instances/default/db
pnpm dev
```

## Architecture

### Monorepo Structure (pnpm workspaces)

- **`server/`** — Express 5 REST API (`@paperclipai/server`). Single process that embeds a PostgreSQL instance, serves the UI, and runs all orchestration services.
- **`ui/`** — React 19 + Vite + TailwindCSS v4 board UI (`@paperclipai/ui`). Served by the API server in dev (via Vite middleware) and from `ui-dist/` in production.
- **`packages/db/`** — Drizzle ORM schema, migrations, and DB client (`@paperclipai/db`). Schema files are in `packages/db/src/schema/*.ts`.
- **`packages/shared/`** — Cross-cutting TypeScript types, Zod validators, constants, and API path helpers (`@paperclipai/shared`).
- **`packages/adapters/*`** — Per-agent adapter packages (claude-local, codex-local, cursor-local, gemini-local, openclaw-gateway, opencode-local, pi-local). Each adapter knows how to spawn, communicate with, and manage one agent type.
- **`packages/adapter-utils/`** — Shared utilities for adapter packages.
- **`packages/plugins/sdk/`** — Stable public API for writing Paperclip plugins (`@paperclipai/plugin-sdk`).
- **`packages/plugins/examples/`** — Example plugin implementations.
- **`cli/`** — `paperclipai` CLI for onboarding, worktree management, issue commands, and config.
- **`tests/e2e/`** — Playwright end-to-end tests.

### Key Server Concepts

**Routes** (`server/src/routes/`) — one file per domain (agents, companies, issues, goals, approvals, etc.). All routes are mounted under `/api`.

**Services** (`server/src/services/`) — business logic layer. Notable services:
- `heartbeat.ts` — scheduled agent wake-up loop
- `issues.ts` / `issue-assignment-wakeup.ts` — issue checkout and assignment
- `plugin-*.ts` files — plugin lifecycle, worker management, job scheduling, tool dispatch

**Middleware** (`server/src/middleware/`) — auth (`better-auth`), board mutation guard, private hostname guard, error handler, logger (pino).

**Auth model**: Two actor types — board users (human operators, full control) and agents (bearer API keys from `agent_api_keys` table, hashed at rest). Agent keys are company-scoped.

**Plugin system**: Plugins run in isolated worker processes. The host services, lifecycle, job scheduler, tool registry, and stream bus files manage their lifecycle.

### Database

Uses Drizzle ORM with PostgreSQL. In dev, an embedded PostgreSQL instance starts automatically (no `DATABASE_URL` needed). Data persists at `~/.paperclip/instances/default/db`.

When changing the data model:
1. Edit `packages/db/src/schema/*.ts`
2. Export new tables from `packages/db/src/schema/index.ts`
3. Run `pnpm db:generate` (compiles db package then runs `drizzle-kit generate`)
4. Run `pnpm -r typecheck` to validate

### Core Invariants

Every change must preserve these control-plane invariants:
- **Company scoping** — every domain entity belongs to a company; routes enforce company access
- **Atomic issue checkout** — single-assignee task model; no double-checkout
- **Approval gates** — governed actions (hire, fire, budget changes) require board approval
- **Budget hard-stop** — agents pause automatically when monthly budget is exhausted
- **Activity log** — all mutating API actions write an activity log entry

### Contract Synchronization

When changing any behavior, keep all four layers in sync:
1. `packages/db` — schema + exports
2. `packages/shared` — types, constants, validators
3. `server` — routes + services
4. `ui` — API client calls + pages

### Lockfile Policy

Do **not** commit `pnpm-lock.yaml` in pull requests. GitHub Actions owns lockfile regeneration on pushes to `master`.

## Key Docs

- `doc/DEVELOPING.md` — detailed dev guide (Docker, worktrees, secrets, Tailscale)
- `doc/SPEC-implementation.md` — V1 build contract; source of truth for intended behavior
- `doc/GOAL.md` + `doc/PRODUCT.md` — product context
- `doc/DATABASE.md` — database design notes
- `doc/CLI.md` — full CLI reference
