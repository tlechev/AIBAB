# AIBAB — Architecture

> Last updated: 2026-11-13. This is a living document: every architectural change is reflected here, with a short rationale under [Decisions](#14-decisions-adr-summary).

AIBAB (AI Business Assistant) is a multi-tenant SaaS that gives small service businesses an AI assistant for handling customer inquiries, answering questions, capturing leads and creating appointment requests. The initial market is Bulgaria; the architecture is market-agnostic.

## 1. Product decisions (approved by the product owner)

| #   | Decision                                                                                                                                                                                                                                           |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Pilot industries: **HVAC (air conditioning and heating), plumbing and electrical, renovation services**. Goal: 3–5 pilot companies.                                                                                                                |
| D2  | MVP channel: **web widget**. The architecture is **channel-independent** — Viber, Messenger and Voice AI are added as adapters without changes to the business logic.                                                                              |
| D3  | The AI assistant creates an **appointment request** (`requested`); a staff member confirms it. Auto-confirmation is a future per-organization setting (`auto_confirm_appointments`, default `false`).                                              |
| D4  | Primary model candidate: **Claude Sonnet 5.5** (`claude-sonnet-5-5`). It is compared against **Claude Opus 5.5** (`claude-opus-5-5`) using realistic test scenarios and cost measurement. The model is switchable through configuration.           |
| D5  | Currency for the initial market: **EUR everywhere** — services, offers, subscription plans, reports.                                                                                                                                               |
| D6  | Each company **configures its own assistant** through an admin interface.                                                                                                                                                                          |
| D7  | **Real AI cost measurement** per organization and per conversation.                                                                                                                                                                                |
| D8  | Prepared for **self-service onboarding**: sign up → configure → install on the company website.                                                                                                                                                    |
| D9  | Security, GDPR and tenant isolation are the top priority.                                                                                                                                                                                          |
| D10 | **English** is the language of code, technical documentation and commits. **Bulgarian** is the primary UI language for the initial market; English is the second supported UI language. Business logic does not depend on any language or country. |

> **What "training" the assistant means:** we do not fine-tune the model. A company "trains" its assistant by filling in a structured knowledge base (services, prices, service areas, FAQ, rules), which is supplied as context in every conversation. This is cheaper and more predictable, changes take effect immediately, and one company's data never enters a model used by another.

## 2. Technology stack

| Layer           | Technology                                                               | Notes                                                    |
| --------------- | ------------------------------------------------------------------------ | -------------------------------------------------------- |
| Framework       | Next.js 16 (App Router, Cache Components), React 19, TypeScript (strict) | Server Actions + Route Handlers; no separate backend     |
| UI              | Tailwind CSS 4, shadcn/ui (`base-nova` preset, Base UI), lucide-react    | Light theme by default                                   |
| i18n            | next-intl (without i18n routing)                                         | Bulgarian is the default UI locale; English is supported |
| Validation      | Zod 4                                                                    | Shared schemas for forms, API, env and AI tools          |
| Database        | PostgreSQL (Supabase, EU/Frankfurt region)                               | Task 2                                                   |
| ORM             | Drizzle                                                                  | Task 2                                                   |
| Auth            | Supabase Auth (`@supabase/ssr`)                                          | Task 3                                                   |
| AI              | Anthropic TypeScript SDK behind an `LlmProvider` interface               | Stage 5                                                  |
| Background jobs | `jobs` table + Vercel Cron                                               | v0.2                                                     |
| Testing         | Vitest + Testing Library; Playwright for E2E (from task 3)               |                                                          |
| Hosting         | Vercel (`fra1` region) + Supabase EU                                     |                                                          |

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
- `InboundMessage` = `{ orgId, channel, externalThreadId, senderExternalId, text, receivedAt }`.
- The `contact_identities (org_id, channel, external_id) → customer_id` table links one customer across channels (e.g. the same phone number on Viber and on a voice call).
- `AssistantEngine` receives `capabilities` as a hint (e.g. short replies without lists for voice), but **the logic and the tools are identical** across channels.
- Voice AI is an adapter that wraps the same engine with speech-to-text (STT) and text-to-speech (TTS).

## 5. AI assistant

### 5.1 Assistant profile (D6)

Each organization has one `assistant_profile` (versioning may be added later):

- assistant name, greeting, tone (`formal` / `friendly`), additional instructions;
- handoff rules (keywords, topics, outside business hours);
- **knowledge base:** services (with price ranges in the organization's currency), business hours, service areas, FAQ;
- booking settings: time windows, capacity (number of crews), minimum notice.

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

- Every LLM call records an `ai_usage_events` row: `org_id`, `conversation_id`, `message_id`, `model`, `input_tokens`, `cache_read_tokens`, `cache_write_tokens`, `output_tokens`, `cost_usd_micros`, `cost_eur_micros`, `latency_ms`.
- Model prices live in `ai_model_prices` (versioned with `valid_from`); the USD→EUR rate lives in `fx_rates`. Historical costs therefore do not change when prices change.
- Aggregates: cost per conversation and per organization/month; a monthly cap per plan → once reached, the assistant hands off to a human instead of replying.
- **Eval harness** (stages 5/6): a set of realistic and synthetic scenarios in Bulgarian and in Latin-script Bulgarian → run on Sonnet 5.5 and Opus 5.5 → compare quality and cost per conversation.

## 6. Regional settings (D10)

The business logic is language- and country-agnostic. Market-specific values are **data**, not code:

| Setting           | Where it lives                                       | Initial value (Bulgaria)  |
| ----------------- | ---------------------------------------------------- | ------------------------- |
| Country           | `organizations.country_code` (ISO 3166-1 alpha-2)    | `BG`                      |
| Default locale    | `organizations.default_locale` (BCP 47)              | `bg`                      |
| Time zone         | `organizations.timezone` (IANA)                      | `Europe/Sofia`            |
| Currency          | `organizations.currency` (ISO 4217)                  | `EUR`                     |
| UI language       | `profiles.locale` (falls back to the org default)    | `bg`                      |
| Customer language | `customers.preferred_locale`, `conversations.locale` | detected per conversation |

MVP scope — deliberately small:

- One currency per organization; no currency conversion for customers.
- Phone numbers are stored in E.164 format; parsing uses the organization's country as the default region.
- Company identifiers are a generic `registration_number` (EIK in Bulgaria), not a Bulgaria-specific column.
- `src/i18n/config.ts` holds UI-only fallbacks (`bg`, `Europe/Sofia`); business logic never reads them.
- Supporting a new market = adding a currency to `SUPPORTED_CURRENCIES`, a message catalog and industry templates. No schema change.

## 7. Multi-tenant isolation (D9)

1. **Application layer:** `requireTenant()` → `{ orgId, userId, role }`, derived from the session and the membership. `org_id` **never** comes from the client.
2. **Data-access layer:** all queries go through `withTenantTx(ctx, fn)`, which sets the tenant context for the transaction.
3. **Database:** RLS on every tenant table; composite foreign keys `(org_id, id)` prevent cross-tenant references.
4. **Public widget:** identified by a public key (`widget_installations.public_key`) plus an allow-list of domains (Origin check). The key grants access only to the organization's public assistant profile.
5. **Tests:** automated tenant-isolation tests for every new table (mandatory in CI).

## 8. Self-service onboarding (D8) — groundwork

Flow: sign up → create organization (industry, country) → a template pre-fills services/FAQ → edit the assistant profile → test in the Playground → generate the widget snippet (`<script>` with the public key) → add allowed domains → activate.
The `onboarding_progress` table tracks the steps. Billing (Stripe or a local provider) comes after the pilot.

## 9. Security and GDPR (D9)

- **GDPR roles:** the customer company is the controller of its customers' data; AIBAB is the processor. Required: a data processing agreement (DPA) with every company, a list of sub-processors (Supabase, Vercel, Anthropic, email provider) and DPAs with them. **Requires legal review.**
- **Data location:** database and application in the EU (Frankfurt). For AI processing via the Anthropic API, the current retention policy and data-location options must be verified before the pilot.
- **Minimization:** no national ID numbers, no payment cards; only name, phone, email, address and the problem description.
- **Retention:** configurable conversation retention (default 12 months) → automatic deletion via `jobs`.
- **Data subject rights:** export and full deletion of a customer (cascading, with an audit record that contains no personal data).
- **Application security:** security headers (since task 1), CSP (with the widget), rate limiting, Cloudflare Turnstile for the widget, validated environment variables, secrets only in env, append-only audit log.
- **Prompt injection:** customer messages are untrusted input; system rules travel in a separate channel; the public profile has no tools that can read other customers' data; tool output is validated.

## 10. Money and time

- Amounts are stored as **integer minor units** (`amount_cents integer`) plus `currency char(3)`, defaulting to the organization's currency. Never `float`.
- Formatting takes an explicit locale and currency (`src/lib/money.ts`); there is no hard-coded market default.
- Time: `timestamptz` in UTC; displayed in the organization's time zone.

## 11. Database schema (MVP — details in task 2)

Tenant tables — all with `id uuid`, `org_id`, `created_at`, `updated_at`, RLS:
`organizations`, `profiles`, `memberships`, `invitations`, `assistant_profiles`, `services`, `faq_entries`, `business_hours`, `service_areas`, `booking_settings`, `widget_installations`, `customers`, `contact_identities`, `leads`, `conversations`, `messages`, `appointments`, `ai_actions`, `ai_usage_events`, `audit_logs`, `onboarding_progress`.
v0.2: `offers`, `offer_items`, `tasks`, `jobs`. Global: `ai_model_prices`, `fx_rates`.

## 12. Project structure

```
src/
├─ app/                 routes (UI + route handlers)
├─ components/          ui/ (shadcn) + feature components
├─ i18n/                next-intl configuration
├─ lib/                 env, money/formatting, utils (no business logic)
└─ server/              (from task 2) auth, db, services, ai, channels, audit, security
messages/               UI message catalogs: bg.json, en.json
docs/                   architecture and decisions
tests/                  test support files; integration and e2e suites from task 2
```

Unit tests are colocated with the code they test (`*.test.ts(x)`).

## 13. Task plan

| #   | Task                                                                                                                           | Status    |
| --- | ------------------------------------------------------------------------------------------------------------------------------ | --------- |
| 1   | Project foundation: Next.js, TS, Tailwind, shadcn/ui, ESLint, Prettier, Vitest, env validation, i18n, security headers, README | in review |
| 2   | Database: local Supabase, Drizzle, `organizations`/`profiles`/`memberships`, RLS, `withTenantTx`                               | planned   |
| 3   | Auth: sign-up (organization + owner), sign-in, sign-out, password reset, route protection                                      | planned   |
| 4   | Tenant-isolation tests                                                                                                         | planned   |
| 5   | App shell, dashboard, company profile, assistant profile and knowledge base                                                    | planned   |

## 14. Decisions (ADR summary)

- **ADR-001: No locale in the URL.** The B2B dashboard does not need per-language SEO. The UI language comes from the user's / organization's settings. Until task 3 the active UI locale is `bg`.
- **ADR-002: ESLint 9.** `eslint-config-next@16.4` and its plugins (react, import, jsx-a11y) do not support ESLint 10 yet. Upgrade once they do.
- **ADR-003: Money as integer minor units.** Avoids floating-point rounding errors.
- **ADR-004: No fine-tuning.** "Training" the assistant means a structured knowledge base supplied as context.
- **ADR-005: English for engineering, localized product.** Code, identifiers, comments, database names, technical documentation and commit messages are in English. User-facing text lives only in message catalogs (`/messages`) and in company-authored content; it is never hard-coded in components or translated in documentation.
- **ADR-006: Market-agnostic core.** Country, locale, time zone and currency are organization-level data (section 6). Business logic receives them as inputs and never assumes Bulgaria. MVP support is limited to what the initial market needs, without extra abstraction.
