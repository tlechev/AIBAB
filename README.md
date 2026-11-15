# AIBAB — AI Business Assistant

A multi-tenant SaaS that gives small service businesses an AI assistant: it handles customer inquiries, answers questions in the customer's language, creates appointment requests and keeps customer information organized. The initial market is Bulgaria (Bulgarian UI by default, English supported); the architecture is market-agnostic.

> **Status:** Stage 2 — task 1 (project foundation) done, task 2 (database foundation) in review. Features are added step by step. Architecture and decisions: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Requirements

- Node.js **24+** (tested with Node 26)
- npm 11+
- Docker Desktop (running) — the local Supabase stack runs in containers

## Getting started

```bash
npm install
cp .env.example .env.local      # Windows PowerShell: Copy-Item .env.example .env.local
npm run db:start                # local Supabase (first start downloads images) + local aibab_app password
npm run db:reset                # apply all migrations + local seed from scratch + local aibab_app password
npm run dev
```

Open http://localhost:3000. Health check: http://localhost:3000/api/health.

The `TEST_*` values in `.env.example` are the public, fixed defaults of the Supabase CLI's local stack (check with `npx supabase status` if your ports differ). The `aibab_app` password is **not** in the repository: on first `db:start`/`db:reset`, `npm run db:local-password` replaces the `CHANGE_ME_LOCAL_ONLY` placeholder in `.env.local` with a random password and applies it to the local database only.

### Local credentials — read this

> [!WARNING]
> **Never run `supabase db push --include-seed`, and never put credentials in `supabase/seed.sql` or in a migration.** Seed files are applied to the target database when `--include-seed` is used, including hosted projects. Role passwords are therefore never set by SQL files in this repository (a unit test enforces it).
>
> - The local `aibab_app` password is set by [`scripts/set-local-db-password.ts`](scripts/set-local-db-password.ts). It refuses to run unless the target is the local Supabase Docker container (loopback host, the port Docker publishes for `supabase_db_<project_id>`, and the admin connection's backend process verified inside that container).
> - The password is read from `DATABASE_URL` (environment or `.env.local`), never from command-line arguments, and only a SCRAM-SHA-256 verifier is sent to the server, so it does not appear in shell history or database logs.
> - Local passwords and the Supabase CLI defaults (`postgres:postgres`, the demo JWT secret and keys) are for your machine only. Never reuse them in a hosted environment.

## Scripts

| Command                     | Description                                                                   |
| --------------------------- | ----------------------------------------------------------------------------- |
| `npm run dev`               | Development server                                                            |
| `npm run build`             | Production build                                                              |
| `npm run start`             | Serve the production build                                                    |
| `npm run typecheck`         | Generate route types, then run TypeScript                                     |
| `npm run lint`              | ESLint (zero warnings allowed)                                                |
| `npm run test`              | Unit tests (Vitest, no database needed)                                       |
| `npm run test:watch`        | Unit tests in watch mode                                                      |
| `npm run test:db`           | Database integration tests against local Supabase (RLS, isolation, drift)     |
| `npm run format`            | Format the code with Prettier                                                 |
| `npm run format:check`      | Check formatting                                                              |
| `npm run check`             | typecheck + lint + format:check + test (run before push)                      |
| `npm run db:start`          | Start local Supabase (Postgres, Auth, REST gateway only)                      |
| `npm run db:stop`           | Stop local Supabase                                                           |
| `npm run db:reset`          | Rebuild the local database from migrations + `supabase/seed.sql`              |
| `npm run db:local-password` | Set the local `aibab_app` password from `DATABASE_URL` (local container only) |
| `npm run db:snapshot`       | Update `supabase/schema.snapshot.json` after an **intentional** schema change |

Before pushing: `npm run check` and `npm run test:db`.

## Database

- **Migrations** live in `supabase/migrations/` and are the single source of truth. Create one with `npx supabase migration new <name>`, then run `npm run db:reset`, `npm run test:db` and, if the security catalog changed on purpose, `npm run db:snapshot` (review the diff of `supabase/schema.snapshot.json`). Never change the schema through the Supabase dashboard.
- **Drizzle** (`src/server/db/schema/`) mirrors the schema for typed queries; update it together with the migration — the drift test fails otherwise.
- **Access** goes through `withUserTx(db, userId, fn)` only. The runtime role `aibab_app` has no privileges of its own; RLS policies apply to `aibab_user`. See [Multi-tenant isolation](docs/ARCHITECTURE.md#7-multi-tenant-isolation-d9) and the [trust boundary](docs/ARCHITECTURE.md#71-trust-boundary-of-withusertx).
- **Hosted environments** (Stage 7): apply migrations with `supabase db push` — **without** `--include-seed`. The `aibab_app` password is provisioned once from the `AIBAB_APP_DB_PASSWORD` secret as a SCRAM-SHA-256 verifier (never as plaintext SQL, which could end up in logs); the exact procedure is defined in Stage 7. `DATABASE_URL` is a master secret — server-only, never logged.

## Environment variables

Documented in [.env.example](.env.example) and validated with Zod ([src/lib/env.ts](src/lib/env.ts)): a missing or invalid value stops the app with a clear error that names the variable but never prints its value. Real secrets are **never** committed to the code or to git. `TEST_*` variables are for `npm run test:db` only and must never be set in hosted environments.

## Project structure

```
docs/              architecture and decisions
messages/          UI message catalogs (bg — default, en — supported)
src/app/           routes (pages and API)
src/components/    UI components (ui/ = shadcn/ui)
src/i18n/          locale configuration
src/lib/           env, money (integer cents), booking time windows, helpers
src/server/auth/   VerifiedUserId (session handling in task 3)
src/server/db/     database client, withUserTx, Drizzle schema mirror
supabase/          migrations, local seed, config, security catalog snapshot
tests/db/          real-Postgres integration tests
tests/shared/      cases shared by unit and database tests
```

Unit tests are colocated with the code they test (`*.test.ts(x)`).

## Tech stack

Next.js 16 (App Router, Cache Components) · React 19 · TypeScript (strict) · Tailwind CSS 4 · shadcn/ui (Base UI) · next-intl · Zod 4 · PostgreSQL 17 (Supabase) · Drizzle ORM · Vitest + Testing Library · ESLint · Prettier.

## Conventions

- **Language:** code, identifiers, comments, database names, technical docs and commit messages are in English. User-facing text lives only in `messages/*.json` — never hard-code UI strings in components.
- **Regional settings:** country, locale, time zone and currency are organization data; business logic never assumes a specific market (ADR-006).
- **Money:** integer minor units plus an explicit currency (ADR-003).
- **Security boundaries** (enforced by ESLint): `VerifiedUserId` is created only from a verified session; the raw `postgres` client is used only in `src/server/db/client.ts`; unsafe SQL APIs (`sql.raw`, `.unsafe`, `.execute()` with anything but a direct `` sql`...` `` template, aliases of `sql`) are forbidden in `src/` — build queries with `` sql`...` `` parameters or the query builder; compose dynamic queries as ``tx.execute(sql`${fragment}`)``.

## Known limitations

- ESLint is on v9 because `eslint-config-next` does not support ESLint 10 yet (ADR-002).
- `npm audit --omit=dev` (production): **0 vulnerabilities**. The full `npm audit` reports 12 (10 moderate, 2 low) in **development tooling only** (shadcn CLI, typescript-eslint), which is not shipped to production. The suggested fix is a major shadcn downgrade, so we wait for upstream updates.
- The client-bundle scan for database credentials currently has little to inspect, because no client code exists yet that could import database modules; `import "server-only"` in those modules makes such an import fail the build.
