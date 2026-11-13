# AIBAB — AI Business Assistant

A multi-tenant SaaS that gives small service businesses an AI assistant: it handles customer inquiries, answers questions in the customer's language, creates appointment requests and keeps customer information organized. The initial market is Bulgaria (Bulgarian UI by default, English supported); the architecture is market-agnostic.

> **Status:** Stage 2, task 1 — project foundation. Features are added step by step. Architecture and decisions: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Requirements

- Node.js **24+** (tested with Node 26)
- npm 11+
- Docker Desktop (required from task 2 for local Supabase)

## Getting started

```bash
npm install
cp .env.example .env.local      # Windows PowerShell: Copy-Item .env.example .env.local
npm run dev
```

Open http://localhost:3000. Health check: http://localhost:3000/api/health.

## Scripts

| Command                | Description                                              |
| ---------------------- | -------------------------------------------------------- |
| `npm run dev`          | Development server                                       |
| `npm run build`        | Production build                                         |
| `npm run start`        | Serve the production build                               |
| `npm run typecheck`    | Generate route types, then run TypeScript                |
| `npm run lint`         | ESLint (zero warnings allowed)                           |
| `npm run test`         | Unit tests (Vitest)                                      |
| `npm run test:watch`   | Tests in watch mode                                      |
| `npm run format`       | Format the code with Prettier                            |
| `npm run format:check` | Check formatting                                         |
| `npm run check`        | typecheck + lint + format:check + test (run before push) |

## Environment variables

Documented in [.env.example](.env.example) and validated with Zod at startup ([src/lib/env.ts](src/lib/env.ts)): a missing or invalid value stops the app with a clear error. Real secrets are **never** committed to the code or to git.

## Project structure

```
docs/            architecture and decisions
messages/        UI message catalogs (bg — default, en — supported)
src/app/         routes (pages and API)
src/components/  UI components (ui/ = shadcn/ui)
src/i18n/        locale configuration
src/lib/         env, money (integer cents), helpers
tests/           test support files
```

Unit tests are colocated with the code they test (`*.test.ts(x)`).

## Tech stack

Next.js 16 (App Router, Cache Components) · React 19 · TypeScript (strict) · Tailwind CSS 4 · shadcn/ui (Base UI) · next-intl · Zod 4 · Vitest + Testing Library · ESLint · Prettier.

## Conventions

- **Language:** code, identifiers, comments, database names, technical docs and commit messages are in English. User-facing text lives only in `messages/*.json` — never hard-code UI strings in components.
- **Regional settings:** country, locale, time zone and currency are organization data; business logic never assumes a specific market (ADR-006).
- **Money:** integer minor units plus an explicit currency (ADR-003).

## Known limitations

- ESLint is on v9 because `eslint-config-next` does not support ESLint 10 yet (ADR-002).
- `npm audit --omit=dev` (production): **0 vulnerabilities**. The full `npm audit` reports 12 (10 moderate, 2 low) in **development tooling only** (shadcn CLI, typescript-eslint), which is not shipped to production. The suggested fix is a major shadcn downgrade, so we wait for upstream updates.
