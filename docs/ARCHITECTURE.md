# AIBAB — Architecture

> Last updated: 2026-11-13. This is a living document: every architectural change is reflected here, with a short rationale under [Decisions](#15-decisions-adr-summary).

AIBAB (AI Business Assistant) is a multi-tenant SaaS that gives small service businesses an AI assistant for handling customer inquiries, answering questions, capturing leads and creating appointment requests. The initial market is Bulgaria; the architecture is market-agnostic.

## 1. Product decisions (approved by the product owner)

| #   | Decision                                                                                                                                                                                                                                           |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Pilot industries: **HVAC (air conditioning and heating), plumbing and electrical, renovation services**. Goal: 3–5 pilot companies.                                                                                                                |
| D2  | MVP channel: **web widget**. The architecture is **channel-independent** — Viber, Messenger and Voice AI are added as adapters without changes to the business logic.                                                                              |
| D3  | The AI assistant creates an **appointment request** (`requested`); a staff member confirms it. Auto-confirmation is a per-organization setting (`booking_settings.auto_confirm_appointments`, default `false`).                                    |
| D4  | Primary model candidate: **Claude Sonnet 5.5** (`claude-sonnet-5-5`). It is compared against **Claude Opus 5.5** (`claude-opus-5-5`) using realistic test scenarios and cost measurement. The model is switchable through configuration.           |
| D5  | Currency for the initial market: **EUR everywhere** — services, offers, subscription plans, reports.                                                                                                                                               |
| D6  | Each company **configures its own assistant** through an admin interface.                                                                                                                                                                          |
| D7  | **Real AI cost measurement** per organization and per conversation.                                                                                                                                                                                |
| D8  | Prepared for **self-service onboarding**: sign up → configure → install on the company website.                                                                                                                                                    |
| D9  | Security, GDPR and tenant isolation are the top priority.                                                                                                                                                                                          |
| D10 | **English** is the language of code, technical documentation and commits. **Bulgarian** is the primary UI language for the initial market; English is the second supported UI language. Business logic does not depend on any language or country. |

> **What "training" the assistant means:** we do not fine-tune the model. A company "trains" its assistant by filling in a structured knowledge base (services, prices, service areas, FAQ, rules), which is supplied as context in every conversation. This is cheaper and more predictable, changes take effect immediately, and one company's data never enters a model used by another.

## 2. Technology stack

| Layer           | Technology                                                               | Notes                                                            |
| --------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| Framework       | Next.js 16 (App Router, Cache Components), React 19, TypeScript (strict) | Server Actions + Route Handlers; no separate backend             |
| UI              | Tailwind CSS 4, shadcn/ui (`base-nova` preset, Base UI), lucide-react    | Light theme by default                                           |
| i18n            | next-intl (without i18n routing)                                         | Bulgarian is the default UI locale; English is supported         |
| Validation      | Zod 4                                                                    | Shared schemas for forms, API, env and AI tools                  |
| Database        | PostgreSQL 17 (Supabase; EU/Frankfurt region when hosted)                | Implemented (task 2). Local: Supabase CLI in Docker              |
| Migrations      | Versioned SQL files applied by the Supabase CLI                          | Single source of truth (ADR-007)                                 |
| ORM             | Drizzle (`postgres.js` driver)                                           | Typed queries only; mirror verified against the database (§ 9.7) |
| Auth            | Supabase Auth (`@supabase/ssr`)                                          | Task 3                                                           |
| AI              | Anthropic TypeScript SDK behind an `LlmProvider` interface               | Stage 5                                                          |
| Background jobs | `jobs` table + Vercel Cron                                               | v0.2                                                             |
| Testing         | Vitest + Testing Library; real-Postgres integration tests; Playwright    | Playwright from task 3                                           |
| Hosting         | Vercel (`fra1` region) + Supabase EU                                     |                                                                  |

## 3. Layers and dependencies

```
┌───────────────────────────── Channels (adapters) ─────────────────────────────┐
│  Web Widget  │  Admin Playground  │  Viber*  │  Messenger*  │  Voice (STT/TTS)* │
└──────┬─────────────────┬──────────────┬────────────┬───────────────┬─────────┘
       └─────────────────┴──── InboundMessage (normalized) ───────────┘
                                         │
                              ┌──────────▼──────────┐
                              │ ConversationService │  finds/creates the conversation
                              │                     │  and the contact identity
                              └──────────┬──────────┘
                              ┌──────────▼──────────┐
                              │   AssistantEngine   │  channel-agnostic AI orchestrator
                              │ (prompt + tools +   │  + usage/cost metering
                              │  usage metering)    │
                              └───┬────────────┬────┘
                     ┌────────────▼──┐     ┌───▼──────────────┐
                     │ LlmProvider   │     │ Tool Registry     │ zod validation, permissions,
                     │ (Anthropic)   │     │ (public/internal) │ scoping, audit, approvals
                     └───────────────┘     └───┬──────────────┘
                                       ┌───────▼────────┐
                                       │ Domain Services │ customers, leads,
                                       │ (tenant-scoped) │ appointments, offers…
                                       └───────┬────────┘
                                       ┌───────▼────────┐
                                       │ Postgres + RLS │
                                       └────────────────┘
                                                   * future adapters
```

**Dependency rule:** `app/` (UI, routes) → `server/services` → `server/db`. The AI layer calls **only** domain services, never the database directly. Domain services do not know which channel a request came from.

## 4. Channel-independent design (D2)

- Every channel is an **adapter** implementing:
  ```ts
  interface ChannelAdapter {
    channel: "web_widget" | "playground" | "viber" | "messenger" | "voice";
    capabilities: { richButtons: boolean; maxReplyChars: number; voice: boolean };
    toInbound(raw: unknown): Promise<InboundMessage>; // validates and normalizes
    send(out: OutboundMessage): Promise<void>; // delivers the reply
  }
  ```
- `InboundMessage` = `{ organizationId, channel, externalThreadId, senderExternalId, text, receivedAt }`.
- The `contact_identities (organization_id, channel, external_id) → customer_id` table links one customer across channels (e.g. the same phone number on Viber and on a voice call).
- `AssistantEngine` receives `capabilities` as a hint (e.g. short replies without lists for voice), but **the logic and the tools are identical** across channels.
- Voice AI is an adapter that wraps the same engine with speech-to-text (STT) and text-to-speech (TTS).

## 5. AI assistant

### 5.1 Assistant profile (D6)

Each organization has one `assistant_profiles` row (implemented; versioning may be added later):

- assistant name, greeting, tone (`formal` / `friendly`), custom instructions (≤ 4000 characters);
- handoff rules: keywords, handing off outside business hours;
- `is_enabled` (default `false`: the assistant stays off until the company activates it).

Together with the **knowledge base** (`services` with price ranges in the organization's currency, `business_hours`, `service_areas`, `faq_entries`) and `booking_settings` (time windows, capacity, notice, horizon), this is the context the assistant works from. Model choice and token limits are platform-controlled per plan, not company settings.

The admin interface includes a **Playground** where a company tests its assistant before enabling it on its website. The Playground is simply another channel adapter.

**Industry templates** (in code, not in the database): HVAC, plumbing/electrical, renovation. They pre-fill services and FAQ during onboarding; the company then edits them. Templates are keyed by industry **and locale**, so new markets get their own templates.

### 5.2 Conversation language

- The assistant replies in **the customer's language**. The organization's default locale (Bulgarian for Bulgarian companies) is used when the language is unclear.
- Customers often write Bulgarian in Latin script ("shlyokavitsa"); this is an explicit test case.
- The detected language is stored on the conversation (`conversations.locale`) and may update `customers.preferred_locale`.
- System instructions are written in English; customer-facing wording comes from the knowledge base, which the company writes in its own language.

### 5.3 Model and provider (D4)

- An `LlmProvider` interface; the first implementation is `AnthropicProvider`.
- The model is selected via configuration: `AI_MODEL` (default `claude-sonnet-5-5`), with possible overrides per plan/organization.
- Notes on Claude Sonnet 5.5 (checked against the API documentation):
  - pricing: $2 / $10 per 1M input/output tokens, cache reads $0.10;
  - `tool_choice` `any`/`tool` is not supported → use `auto` + `strict: true` tool schemas;
  - effort is configurable (`low` as the starting point for chat, to be measured);
  - refusals (`stop_reason: "refusal"`) are handled explicitly; the server-side fallback mechanism is enabled.
- Prompt caching: the stable parts (system rules + the organization's knowledge base) come first in the request and are cached.

### 5.4 Tools

| Profile                        | Tools                                                                                                                 | Access                                                                                    |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Public (customer, any channel) | `get_services`, `get_available_slots`, `upsert_lead_for_this_conversation`, `request_appointment`, `handoff_to_human` | Data of the **current** conversation only. No CRM read access at all.                     |
| Internal (staff)               | the above + `draft_offer`, `create_task`, `search_customers`                                                          | Role-based permissions; actions that commit the company → `ai_actions` (pending approval) |

The AI never executes SQL. Every tool is a typed function validated with Zod, with a permission check and an audit record.

### 5.5 Cost measurement (D7)

- Every LLM call records an `ai_usage_events` row: `organization_id`, `conversation_id`, `message_id`, `model`, `input_tokens`, `cache_read_tokens`, `cache_write_tokens`, `output_tokens`, `cost_usd_micros`, `cost_eur_micros`, `latency_ms`.
- Model prices live in `ai_model_prices` (versioned with `valid_from`); the USD→EUR rate lives in `fx_rates`. Historical costs therefore do not change when prices change.
- Aggregates: cost per conversation and per organization/month; a monthly cap per plan → once reached, the assistant hands off to a human instead of replying.
- **Eval harness** (stages 5/6): a set of realistic and synthetic scenarios in Bulgarian and in Latin-script Bulgarian → run on Sonnet 5.5 and Opus 5.5 → compare quality and cost per conversation.

## 6. Regional settings (D10)

The business logic is language- and country-agnostic. Market-specific values are **data**, not code:

| Setting           | Where it lives                                       | Initial value (Bulgaria)  |
| ----------------- | ---------------------------------------------------- | ------------------------- |
| Country           | `organizations.country_code` (ISO 3166-1 alpha-2)    | `BG`                      |
| Default locale    | `organizations.default_locale` (BCP 47)              | `bg`                      |
| Time zone         | `organizations.timezone` (IANA, validated)           | `Europe/Sofia`            |
| Currency          | `organizations.currency` (ISO 4217)                  | `EUR`                     |
| UI language       | `profiles.locale` (falls back to the org default)    | `bg`                      |
| Customer language | `customers.preferred_locale`, `conversations.locale` | detected per conversation |

MVP scope — deliberately small:

- One currency per organization; `country_code` and `currency` are fixed after creation (no UPDATE privilege), so existing prices never change meaning.
- Phone numbers are stored in E.164 format; parsing uses the organization's country as the default region.
- Company identifiers are a generic `registration_number` (EIK in Bulgaria), not a Bulgaria-specific column.
- `src/i18n/config.ts` holds UI-only fallbacks (`bg`, `Europe/Sofia`); business logic never reads them.
- Supported locales (`bg`, `en`) and currencies (`EUR`) are enforced in the database by CHECK constraints and in the app by `SUPPORTED_CURRENCIES` / `locales`. Supporting a new market = extending those lists (one migration), adding a message catalog and industry templates. No table changes.

## 7. Multi-tenant isolation (D9)

Isolation is enforced in layers; each would stop a cross-tenant access on its own.

1. **Application layer (task 3):** `requireTenant()` → `{ organizationId, userId, role }`, derived from the verified session and the membership. `organization_id` **never** comes from the client; filtering by another organization's id simply returns nothing.
2. **Data-access layer (implemented):** every user query runs inside `withUserTx(db, userId, fn)` (`src/server/db/user-tx.ts`), which sets the transaction's user and switches to the `aibab_user` role. Without it the runtime role has no privileges at all (fail closed).
3. **Database (implemented):** RLS on every table, policies keyed on the caller's memberships; column-level privileges for sensitive columns; composite foreign keys `(organization_id, id)` that hold even when RLS is bypassed; `organization_id` is immutable.
4. **Public widget (later):** identified by a public key plus an allow-list of domains (Origin check). The key grants access only to the organization's public assistant profile.
5. **Tests (implemented):** real-Postgres isolation tests for every table, plus catalog invariants that fail CI if a new table lacks RLS, a composite target or the immutability trigger (§ 9.6–9.7).

### 7.1 Trust boundary of `withUserTx`

`withUserTx` sets `app.current_user_id` for the transaction with `set_config(..., true)` and runs `SET LOCAL ROLE aibab_user`. **PostgreSQL does not authenticate this value.** Anyone holding `DATABASE_URL` can open a transaction, set any user id and act as that user (within RLS).

- `DATABASE_URL` is therefore a **master secret** equivalent to a service-role key: server-only, never prefixed `NEXT_PUBLIC_`, never logged (env validation reports only the variable name).
- The server is a **trusted boundary**. This design protects tenants from each other and from application bugs (a forgotten filter, a forged `organization_id` in a request). It is **not** a defense against a compromised server or a leaked `DATABASE_URL`; those are handled by secret management, least-privilege hosting access and monitoring.
- The user id passed to `withUserTx` must come only from a verified Supabase session (`supabase.auth.getUser()`, task 3). The `VerifiedUserId` branded type makes passing an arbitrary string a compile error, and ESLint forbids `as VerifiedUserId` outside `src/server/auth/session.ts`. Values are bound as parameters and validated as UUIDs.
- Both settings are transaction-local, so nothing leaks to the next transaction on a pooled connection (tested after COMMIT and after ROLLBACK).
- **SQL injection would cross tenants.** Inside a transaction, `aibab_user` can call `set_config('app.current_user_id', …)` and thereby act as any user; arbitrary SQL on the runtime connection is equivalent to holding `DATABASE_URL`. App code therefore builds queries only with parameterized Drizzle APIs. ESLint (`eslint.config.mjs`, tested by `tests/unit/eslint-sql-safety.test.ts`) rejects in `src/`: `sql.raw` (calls, references, `sql["raw"]`, destructuring), any `.unsafe` member (postgres.js), `.execute()` with anything other than a direct `` sql`...` `` template (strings, variables, function results, `sql.join`), any use of the imported `sql` other than as a template tag or `sql.<helper>` (no aliases, passing, re-exporting or shadowing), renaming the `sql` import, and namespace imports of drizzle-orm. Dynamically composed queries use ``tx.execute(sql`${fragment}`)``: Drizzle embeds SQL fragments as SQL and plain strings as bound parameters. Tests and scripts outside `src/` may use these APIs for fixtures and catalog inspection.
- **Low-level Drizzle SQL construction** (verified against the installed drizzle-orm 0.45.4 in `tests/unit/drizzle-sql-construction.test.ts`): `StringChunk` is emitted verbatim and is what `sql.raw` uses; chunks are recognized by the global `Symbol.for("drizzle:entityKind")`, so any class carrying it can impersonate `StringChunk`; and `template.queryChunks[n].constructor` leaks the `StringChunk` class. ESLint therefore also forbids in `src/` any reference to `StringChunk`, `entityKind`/`hasOwnEntityKind`, `Symbol.for`, `queryChunks`, `.inlineParams()` (inlines escaped literals instead of parameters) and dynamic `import()`/`require()` of drizzle-orm. Verified safe and allowed: `sql.join` (plain-string items **and** separators become parameters), `new SQL([...])`/`sql.fromList` with plain values (parameters), `sql.identifier` (double quotes escaped), `sql.param`, `sql.placeholder`.
- **Limits of the lint rules:** they are syntactic. Deliberate circumvention (dynamic property names such as `obj["query" + "Chunks"]`, `Reflect`/`Object.getOwnPropertySymbols`, `Object.defineProperty` with a symbol obtained elsewhere, `eslint-disable`) is not detectable this way and is a code-review concern; the rules target accidental unsafe SQL. They do not apply outside `src/`.

## 8. Self-service onboarding (D8) — groundwork

Flow: sign up → create organization (industry, country) → a template pre-fills services/FAQ → edit the assistant profile → test in the Playground → generate the widget snippet (`<script>` with the public key) → add allowed domains → activate.
`app.create_organization()` already creates the organization, the owner membership, default booking settings and the assistant profile atomically. The `onboarding_progress` table tracks the steps (later). Billing (Stripe or a local provider) comes after the pilot.

## 9. Database (implemented in task 2)

### 9.1 Schemas and roles

| Object          | Purpose                                                                                                                                               |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app` schema    | Application tables and `create_organization()`. **Not** exposed through the Supabase Data API or GraphQL.                                             |
| `app_private`   | Security helpers and trigger functions.                                                                                                               |
| `aibab_app`     | `LOGIN NOINHERIT`. The runtime connection role (`DATABASE_URL`). Owns nothing and has no privileges; it can only `SET ROLE aibab_user`.               |
| `aibab_user`    | `NOLOGIN`. All end-user queries run as this role inside `withUserTx`. Minimal table/column grants + RLS.                                              |
| `aibab_definer` | `NOLOGIN`, **no** `BYPASSRLS`. Owns every `SECURITY DEFINER` function and holds only the grants and policies those functions need (no UPDATE/DELETE). |

Supabase's `anon`, `authenticated` and `service_role` have **no** privileges on either schema, so the schemas are unreachable through the Data API and GraphQL regardless of configuration (verified with live HTTP calls). Supabase's `postgres` role has `BYPASSRLS`; that is why definer functions are not owned by it.

### 9.2 Tables

| Table                | Key points                                                                                                                                                                                                                                                            |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `organizations`      | Tenants. Name, unique slug (reserved words blocked), industry, regional settings (§ 6), contact fields. `country_code`/`currency` are not updatable.                                                                                                                  |
| `profiles`           | Created by trigger on `auth.users`. Only `full_name` and `locale` — no contact data. Visible to the user and to colleagues who share an organization.                                                                                                                 |
| `memberships`        | PK `(organization_id, user_id)`, role `owner`/`admin`/`staff`. No direct INSERT; only `role` is updatable. The last owner is protected.                                                                                                                               |
| `invitations`        | Stores only the SHA-256 of the token, generated by `app.create_invitation()`; `token_hash` is neither readable nor writable by `aibab_user`. Role `admin`/`staff` only. Composite FK to the inviter's membership. One pending invitation per email. Expiry ≤ 30 days. |
| `services`           | Name unique per organization (case-insensitive), price range in integer cents of the organization's currency, unit, duration, `requires_inspection`.                                                                                                                  |
| `faq_entries`        | Optional `service_id` with composite FK; deleting the service sets only `service_id` to NULL.                                                                                                                                                                         |
| `service_areas`      | Areas the company serves; name unique per organization.                                                                                                                                                                                                               |
| `business_hours`     | Local wall-clock intervals per ISO weekday; overlap-free via exclusion constraint (§ 9.4).                                                                                                                                                                            |
| `booking_settings`   | One row per organization: slot mode, `time_windows` (validated JSON), capacity, notice, horizon, `auto_confirm_appointments` (D3).                                                                                                                                    |
| `assistant_profiles` | One row per organization (§ 5.1).                                                                                                                                                                                                                                     |

Every tenant table has `organization_id`, a `(organization_id, id)` unique constraint (or `organization_id` as primary key) as a composite FK target, RLS, server-set `created_at`/`updated_at`, and an immutability trigger on `organization_id`.

### 9.3 Access rules

| Table                                                        | Read                                            | Write                                                                                                                             |
| ------------------------------------------------------------ | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `organizations`                                              | members                                         | owners/admins update (not country/currency); creation only via `create_organization()`                                            |
| `profiles`                                                   | self + colleagues                               | self only (`full_name`, `locale`)                                                                                                 |
| `memberships`                                                | members of the organization                     | owners: everything; admins: non-owner rows only and never grant `owner`; anyone may leave                                         |
| `invitations`                                                | owners/admins (all columns except `token_hash`) | create only via `app.create_invitation()`; owners/admins revoke (active → revoked, one-way) and delete; only `revoked_at` mutable |
| `services`, `faq_entries`, `service_areas`, `business_hours` | members                                         | owners/admins                                                                                                                     |
| `booking_settings`, `assistant_profiles`                     | members                                         | owners/admins update; rows created only by `create_organization()`                                                                |

### 9.4 Business hours, time windows and time zones

- `business_hours` and `booking_settings.time_windows` are **local wall-clock times** in the organization's time zone (`time`, no zone). `organizations.timezone` must be a valid IANA name (checked against `pg_timezone_names` by trigger).
- An interval never crosses midnight. `24:00` is a valid end (PostgreSQL stores it as `24:00:00` and orders it after `23:59`). Overnight work is two rows (e.g. Mon 22:00–24:00 and Tue 00:00–02:00); round-the-clock is 00:00–24:00.
- Overlaps are rejected by an exclusion constraint on `tsrange(date '2000-01-01' + opens_at, date '2000-01-01' + closes_at, '[)')`, which is safe under concurrent inserts; touching intervals (09:00–12:00, 12:00–13:00) are allowed.
- `time_windows` is a JSON array of up to 12 `{ "start": "HH:MM", "end": "HH:MM" }` objects, sorted and non-overlapping. It is validated by `app_private.is_valid_time_windows()` (CHECK) and by `timeWindowsSchema` (Zod, `src/lib/booking/time-windows.ts`); both run against the same shared test cases.
- Converting local times to instants happens in the application (slot generation, Appointments task) using the organization's time zone. Appointments will be stored as `timestamptz` (UTC). On DST changes, a non-existent local time (spring) is skipped and an ambiguous one (autumn) uses its first occurrence.

### 9.5 SECURITY DEFINER functions

All are owned by `aibab_definer`, have `search_path = ''`, an explicit ACL (no PUBLIC), and never take a user id parameter — the caller is always `app_private.current_user_id()`.

| Function                                        | Executable by | Purpose and safeguards                                                                                                                                                                                                                                                                                  |
| ----------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app.create_organization(...)`                  | `aibab_user`  | Creates organization + owner membership + settings atomically. Rejects a missing user (42501). Max 5 owned organizations, serialized per user with an advisory lock. Inputs validated by CHECK constraints and the timezone trigger.                                                                    |
| `app.create_invitation(org, email, role, days)` | `aibab_user`  | The only way to create an invitation. Caller must be owner/admin of `org` (42501 otherwise); `invited_by` is the caller. Generates the token from the server's strong RNG (two v4 UUIDs, 244 random bits), stores its SHA-256 and returns the plaintext token once. Expiry 1–30 days (22023 otherwise). |
| `app_private.my_organization_ids(roles)`        | `aibab_user`  | The caller's organization ids (optionally by role); used by RLS policies, evaluated once per statement.                                                                                                                                                                                                 |
| `app_private.shares_organization_with(uuid)`    | `aibab_user`  | Whether the caller shares an organization with a given user; answers only about the caller's own relationships.                                                                                                                                                                                         |
| `app_private.handle_new_user()`                 | trigger only  | Creates the profile; strips control characters and caps the user-controlled display name.                                                                                                                                                                                                               |
| `app_private.protect_last_owner()`              | trigger only  | Blocks removing/demoting the last owner; serialized per organization with an advisory lock (safe under concurrent transactions).                                                                                                                                                                        |

`aibab_definer` cannot create or replace functions (no CREATE on any schema); ownership is transferred in migrations with a temporary CREATE grant that is revoked in the same migration.

### 9.6 Migrations

- `supabase/migrations/*.sql` are the **single source of truth** (ADR-007), created with `supabase migration new` and applied by the Supabase CLI. `npm run db:reset` rebuilds the local database from scratch; hosted environments use `supabase db push` (Stage 7). No manual changes in the Supabase dashboard.
- **No credentials in SQL files.** `supabase/seed.sql` could be applied to a hosted project with `supabase db push --include-seed`, so neither seeds nor migrations set role passwords (enforced by a unit test). Locally, `scripts/set-local-db-password.ts` (run by `db:start`/`db:reset`) sets the `aibab_app` password from `DATABASE_URL`; it only runs against the local Supabase container (loopback host, Docker-published port, backend process verified inside the container) and sends only a SCRAM-SHA-256 verifier, so the password never appears in arguments or logs. In hosted environments the password is provisioned once from `AIBAB_APP_DB_PASSWORD`, also as a verifier (procedure defined in Stage 7).
- **Role attributes are enforced, not assumed.** Roles are cluster-wide and may pre-exist; the first migration resets their attributes (`NOINHERIT NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`, LOGIN only for `aibab_app`), revokes every unexpected membership, re-grants the intended ones and fails if anything (e.g. `SUPERUSER`, which `postgres` cannot change) is still wrong.
- **Invitation revocation is one-way.** RLS allows only "active → revoked"; a trigger sets `revoked_at = now()` and rejects any later change, even for roles that bypass RLS.
- **Revoked invitation tokens cannot be re-issued.** `aibab_user` has no table-level SELECT or INSERT on `invitations`: column-level SELECT excludes `token_hash`, and invitations are created only by `app.create_invitation()`, which generates the token itself. App code reads invitations with `invitationColumns` (`src/server/db/schema/invitations.ts`) and creates them with `createInvitation()` (`src/server/db/invitations.ts`).
- Drizzle (`src/server/db/schema`) mirrors the schema for typed queries. drizzle-kit is not used: it cannot express `FORCE ROW LEVEL SECURITY`, exclusion constraints, triggers, functions, role/column grants or `ON DELETE SET NULL (column)`, and its Supabase migration naming and custom-migration journaling are not documented.

### 9.7 Tests

`npm run test:db` runs against the local Supabase through the real `aibab_app` role:

- **User context:** fail-closed without `withUserTx`, missing/empty/malformed user id, no leak after COMMIT or ROLLBACK, `SET ROLE` restrictions from a real `aibab_app` login.
- **Privileges:** role attributes and memberships; USAGE/CREATE on schemas and the database; EXECUTE on every function; no access to `auth`, `vault` or `pg_authid`; live REST and GraphQL calls as `anon` and `authenticated`.
- **Isolation:** read/write isolation, untrusted `organization_id`, users without membership, role rules, last owner under concurrency, profile visibility, composite FKs (also with RLS bypassed), immutability, per-table matrix for the knowledge base.
- **Validation:** all `create_organization()` inputs, atomicity, the 5-organization limit under parallel calls, business hours and `24:00`, exclusion under concurrency, time windows, invitations.
- **Drift:** the Drizzle mirror vs. the database in both directions (tables, columns, types, nullability, defaults, PK, unique, FK, enums, indexes) and a reviewed **security catalog snapshot** (`supabase/schema.snapshot.json`: constraints, indexes, enums, RLS flags, policies, table/column grants, function owners/ACLs/settings, triggers). Intentional changes are recorded with `npm run db:snapshot` and reviewed as a diff.
- **Invariants** (independent of the snapshot): RLS on every table, policies only for AIBAB roles, no grants to PUBLIC/API roles, every definer function owned by `aibab_definer`, every tenant table has a composite FK target and the immutability trigger.

The critical protections were mutation-tested during development: removing the advisory locks, loosening the admin policy, or granting schema usage to `anon` each made the corresponding tests fail.

## 10. Security and GDPR (D9)

- **GDPR roles:** the customer company is the controller of its customers' data; AIBAB is the processor. Required: a data processing agreement (DPA) with every company, a list of sub-processors (Supabase, Vercel, Anthropic, email provider) and DPAs with them. **Requires legal review.**
- **Data location:** database and application in the EU (Frankfurt). For AI processing via the Anthropic API, the current retention policy and data-location options must be verified before the pilot.
- **Minimization:** no national ID numbers, no payment cards; only name, phone, email, address and the problem description. Staff profiles hold only a display name and UI locale; emails stay in `auth.users`, which AIBAB roles cannot read.
- **Retention:** configurable conversation retention (default 12 months) → automatic deletion via `jobs`.
- **Data subject rights:** export and full deletion of a customer (cascading, with an audit record that contains no personal data). Deleting an auth user cascades to the profile and memberships; deleting a sole owner is blocked until ownership is transferred or the organization is deleted.
- **Application security:** security headers (since task 1), CSP (with the widget), rate limiting, Cloudflare Turnstile for the widget, validated environment variables, secrets only in env, append-only audit log.
- **Prompt injection:** customer messages are untrusted input; system rules travel in a separate channel; the public profile has no tools that can read other customers' data; tool output is validated.

## 11. Money and time

- Amounts are stored as **integer minor units** (`*_cents integer`). Never `float`.
- Service prices use the organization's currency (one currency per organization), so `services` has no currency column. Documents that must survive a currency change (offers, v0.2) will store their own `currency`.
- Formatting takes an explicit locale and currency (`src/lib/money.ts`); there is no hard-coded market default.
- Time: `timestamptz` in UTC for instants; local wall-clock `time` for opening hours (§ 9.4); displayed in the organization's time zone.

## 12. Database roadmap

Implemented (task 2): `organizations`, `profiles`, `memberships`, `invitations`, `services`, `faq_entries`, `service_areas`, `business_hours`, `booking_settings`, `assistant_profiles`.
Planned MVP: `widget_installations`, `customers`, `contact_identities`, `leads`, `conversations`, `messages`, `appointments`, `ai_actions`, `ai_usage_events`, `audit_logs`, `onboarding_progress`.
v0.2: `offers`, `offer_items`, `tasks`, `jobs`. Global: `ai_model_prices`, `fx_rates`.

## 13. Project structure

```
src/
├─ app/                 routes (UI + route handlers)
├─ components/          ui/ (shadcn) + feature components
├─ i18n/                next-intl configuration
├─ lib/                 env, money, booking time windows, utils (no business logic)
└─ server/
   ├─ auth/             VerifiedUserId (session handling in task 3)
   └─ db/               client, withUserTx, Drizzle schema mirror
supabase/
├─ migrations/          versioned SQL (source of truth)
├─ seed.sql             local-only seed
├─ schema.snapshot.json reviewed security catalog snapshot
└─ config.toml          local Supabase configuration
messages/               UI message catalogs: bg.json, en.json
docs/                   architecture and decisions
tests/
├─ db/                  real-Postgres integration tests (npm run test:db)
├─ shared/              test cases shared by unit and database tests
└─ stubs/               module stubs for Vitest
```

Unit tests are colocated with the code they test (`*.test.ts(x)`).

## 14. Task plan

| #   | Task                                                                                                                           | Status    |
| --- | ------------------------------------------------------------------------------------------------------------------------------ | --------- |
| 1   | Project foundation: Next.js, TS, Tailwind, shadcn/ui, ESLint, Prettier, Vitest, env validation, i18n, security headers, README | done      |
| 2   | Database foundation: Supabase, roles, schemas, 10 tables, RLS, `withUserTx`, migrations, isolation/privilege/drift tests       | in review |
| 3   | Auth: sign-up (organization + owner), sign-in, sign-out, password reset, route protection, `VerifiedUserId` from `getUser()`   | planned   |
| 4   | Tenant-isolation tests for every new table (the pattern and invariants exist since task 2)                                     | ongoing   |
| 5   | App shell, dashboard, company profile, assistant profile and knowledge base                                                    | planned   |

## 15. Decisions (ADR summary)

- **ADR-001: No locale in the URL.** The B2B dashboard does not need per-language SEO. The UI language comes from the user's / organization's settings. Until task 3 the active UI locale is `bg`.
- **ADR-002: ESLint 9.** `eslint-config-next@16.4` and its plugins (react, import, jsx-a11y) do not support ESLint 10 yet. Upgrade once they do.
- **ADR-003: Money as integer minor units.** Avoids floating-point rounding errors.
- **ADR-004: No fine-tuning.** "Training" the assistant means a structured knowledge base supplied as context.
- **ADR-005: English for engineering, localized product.** Code, identifiers, comments, database names, technical documentation and commit messages are in English. User-facing text lives only in message catalogs (`/messages`) and in company-authored content; it is never hard-coded in components or translated in documentation.
- **ADR-006: Market-agnostic core.** Country, locale, time zone and currency are organization-level data (section 6). Business logic receives them as inputs and never assumes Bulgaria. MVP support is limited to what the initial market needs, without extra abstraction.
- **ADR-007: SQL migrations are the source of truth; Drizzle is a verified mirror.** drizzle-kit cannot express the security-critical parts of the schema, and two sources of truth for a security-critical schema are worse than one. A drift test and a reviewed catalog snapshot keep the mirror honest.
- **ADR-008: Dedicated database roles instead of Supabase's `authenticated`.** The runtime role has no privileges of its own (fail closed) and the Supabase API roles have none on our schemas, so isolation does not depend on Data API configuration.
- **ADR-009: SECURITY DEFINER functions owned by a role without BYPASSRLS.** `postgres` bypasses RLS on Supabase; `aibab_definer` holds only the grants and policies each function needs and cannot alter its own functions.
- **ADR-010: The server is a trusted boundary.** `withUserTx` relies on the server to supply a verified user id; the database protects tenants from each other and from application bugs, not from a compromised server or a leaked `DATABASE_URL` (§ 7.1).
