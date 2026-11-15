# ADR-011: Cryptographically bound transaction identity

| Field      | Value                                                                                                |
| ---------- | ---------------------------------------------------------------------------------------------------- |
| Status     | **Accepted** (approved in principle by the product owner on 2026-11-15) — **not yet implemented**    |
| Date       | 2026-11-15 (revised the same day after a replay review, § 3.1, and a final security review)          |
| Amends     | ADR-010 (the server is a trusted boundary)                                                           |
| Applies to | `withUserTx`, `app_private.current_user_id()`, every RLS policy and SECURITY DEFINER function        |
| Evidence   | PostgreSQL 17.11 (local Supabase CLI 3.1 stack), drizzle-orm 0.45.4, postgres.js 4.1.1, pgcrypto 1.3 |

## 1. Context and threat model

`withUserTx(db, userId, fn)` currently sets the transaction-local setting `app.current_user_id` and runs `SET LOCAL ROLE aibab_user`. RLS policies and SECURITY DEFINER functions trust `app_private.current_user_id()`, which simply returns that setting.

**Threat considered:** an attacker who can execute **arbitrary SQL through the runtime connection** — typically SQL injection in application code, including stored injection that runs inside another user's request — while that request is being served. This ADR does not address a compromised application server or a database superuser (§ 9).

**Confirmed problem** (reproduced locally, all probes rolled back):

| Probe                                                                   | Result                                                                                      |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `select set_config('app.current_user_id', '<B>', true)` as `aibab_user` | `current_user_id()` returns _B_                                                             |
| `SET LOCAL app.current_user_id = '<B>'` as `aibab_user`                 | returns _B_ — `SET` is a utility command, so revoking a function privilege could never help |
| `RESET ROLE` as `aibab_user`                                            | `current_user` becomes `aibab_app`; `SET ROLE aibab_user` works again                       |
| Owner/ACL of `pg_catalog.set_config`                                    | `supabase_admin`, default PUBLIC execute — not revocable by the project roles               |

PostgreSQL accepts "a setting for any two-part parameter name" (custom options), `SET LOCAL` lasts "only till the end of the current transaction", and `RESET ROLE` "can be executed by any user". Consequently **anything `aibab_app` can execute, an attacker with arbitrary SQL can execute**, and any identity mechanism that `aibab_app` can trigger with chosen inputs is forgeable.

## 2. Why simpler designs are insufficient

- **Plain GUC (current design):** writable by anyone in the session; the attacker becomes any user in any organization.
- **Restricted SECURITY DEFINER setter** (`establish_user(user_id)` callable by `aibab_app` or `aibab_user`): the attacker resets to `aibab_app` and calls it with an arbitrary id. Being "not directly writable" protects nothing when the caller chooses the input. Even a setter that writes to definer-owned storage only moves the problem unless it **verifies a credential the attacker cannot produce**.
- **`GRANT SET ON PARAMETER` / revoking `set_config`:** custom placeholder settings cannot be restricted, `set_config` is not ours, and `SET` is not a function.
- **Role per user or per tenant via `SET ROLE`:** `aibab_app` must be a member of every such role, so `RESET ROLE` + `SET ROLE` reaches all of them. Separate logins per user or tenant prevent switching but break connection pooling and do not scale.
- **Verifying the Supabase access token inside PostgreSQL:** Supabase recommends asymmetric signing keys (ES256/RS256) and marks HS256 "Not recommended for production"; pgcrypto has no signature verification ("No support for signing"); `pgjwt` is deprecated on Postgres 17 in Supabase. The HS256 path would also place the project's JWT secret in the database (able to mint Auth tokens) and allow replay of a stolen token for its lifetime without logout checks.
- **Asymmetric signature from the server (e.g. Ed25519) verified in the database:** preferable in principle (the database would hold only a public key), but requires `pgsodium`, which Supabase marks as pending deprecation. Revisit when a supported primitive exists.

## 3. Decision

The transaction identity becomes a **self-authenticating context**: an HMAC-SHA256 over the user id and **values bound to the transaction start on the current backend**, computed by the application server with a key that the database session cannot read, and **verified by `app_private.current_user_id()` every time it is evaluated**. Anyone may still write the setting; only a value carrying a valid MAC for the current backend and transaction start is accepted.

### 3.1 Transaction binding

#### Finding: the transaction start time is not unique per transaction

PostgreSQL documents `now()` as the "start of current transaction", constant within it. It does **not** document that two transactions receive different start times, and they do not:

| Experiment (PostgreSQL 17.11)                                                                                           | Result                                                                                                                                                                                       |
| ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **R1** — three transactions in **one simple-query message** (`psql -c "begin; …; commit; begin; …; commit; …"`), 3 runs | **Identical** `(pid, xact_start_us)` for all three transactions in every run (9/9). The start time is taken per client message. Virtual transaction ids differ (`1/2096 → 1/2097 → 1/2098`). |
| **R1b** — the same three transactions as separate messages                                                              | distinct start times (≈ 1.4–2.3 ms apart)                                                                                                                                                    |
| **R2** — postgres.js, extended protocol, 5 × 200 pipelined transactions and 2 000 sequential ones on one connection     | 0 duplicate `(pid, xact_start_us)` in 3 000 transactions                                                                                                                                     |
| **R6** — conversion `(extract(epoch from now()) * 1000000)::bigint`                                                     | `extract` returns `numeric`; the product is integral and the cast is exact — no rounding or truncation                                                                                       |

The cause is documented: `statement_timestamp()` is "the time of receipt of the latest command message from the client", and it equals `transaction_timestamp()` "during the first command of a transaction". Every transaction that begins while one simple-query message is being processed therefore starts at that message's receipt time.

So `pid + xact_start_us` identifies a **transaction start time on a backend**, which may be shared by several transactions started within one client message. It is **not** a unique transaction identifier. The time source is the system clock, so clock steps or a coarse clock could also repeat a value across messages; this was **not** testable locally.

#### Why the binding is still sufficient for the `withUserTx` protocol

A context can only be replayed into a transaction that starts at the **same microsecond on the same backend** as the transaction it was minted for. `withUserTx` must ensure — and with the current driver does ensure (I1–I2 below) — that this transaction was started by **trusted code in its own message**, and that the context is minted **after** that start by a separate query:

1. The attacker's SQL can only run in messages sent after the context exists (inside `fn`). A transaction they start there (`COMMIT; BEGIN; …` in one injected message) has the start time of **that** message, which differs from the minted one — the old context is rejected.
2. The attacker cannot cause the server to mint a context for a transaction that started in an attacker-controlled message: minting happens only inside `withUserTx`, for the transaction it has just started.
3. A context exfiltrated from another user's transaction (stored injection) can only be replayed in a later transaction on the same backend, which starts in a later message — rejected, barring the clock caveats below.

This is a **protocol invariant, not a database guarantee**, and the tests in § 8 must enforce it.

#### Implementation properties the argument depends on

Verified against drizzle-orm 0.45.4 and postgres.js 4.1.1 (final review, direct connection; § 12):

| #   | Property                                                                         | Status and evidence                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| I1  | `BEGIN` is its own message and completes before any other query                  | **Verified.** `db.transaction()` → postgres.js `begin()` leases a connection and **awaits** `control(lease, 'begin')`, a fixed-text simple query, before calling `fn` (`postgres/src/index.js`). The message log shows `begin` alone; inside the transaction `now() < statement_timestamp()` holds for the first query.                                                                                                                                  |
| I2  | The context is minted only after the transaction has started, in a later message | **Verified for the current helper shape** (sequential `await`s after I1). Task 2.2 must keep the mint query first and must not accept caller input before it.                                                                                                                                                                                                                                                                                            |
| I3  | The helper never signs a transaction it did not start                            | **Enforced at compile time only:** `withUserTx` takes a `Database`; passing a `UserTx` is a type error (missing `$client`). Nothing checks this at run time; a nested call would run in a savepoint of the caller's transaction.                                                                                                                                                                                                                         |
| I4  | Caller SQL cannot end the transaction and keep a valid identity                  | **Holds for identity, not for atomicity.** A caller `COMMIT`/`ROLLBACK` discards the context and the `LOCAL` role; later statements run as `aibab_app` (no privileges) or in a transaction started by a later message, where the minted context fails the start-time check. The transaction's **atomicity is broken silently**: postgres.js only checks the final command tag, and `COMMIT` outside a transaction returns `COMMIT` with WARNING `25P01`. |
| I5  | The helper detects termination, rollback or loss of transaction state            | **Not verified — gap.** Caller `COMMIT`, `ROLLBACK` and `COMMIT; BEGIN` all let `withUserTx` resolve successfully. Errors swallowed by `fn` **are** detected (postgres.js rethrows them and rolls back). Required correction: § 6, step 6.                                                                                                                                                                                                               |
| I6  | Context and role are transaction-local                                           | **Verified** for what the helper sets (`set_config(…, true)`, `SET LOCAL ROLE`); existing tests cover COMMIT and ROLLBACK. **Session-level state set by caller SQL is not reverted** (§ 7).                                                                                                                                                                                                                                                              |
| I7  | The whole lifecycle stays on one physical backend                                | **Verified on a direct connection:** the lease is exclusive; 8 concurrent transactions × 8 statements (including concurrent statements inside `fn`) each saw one `pg_backend_pid()` and one start time. **Not verified through Supavisor** (§ 7).                                                                                                                                                                                                        |

Multi-statement messages: drizzle passes every query to postgres.js `unsafe()`, which uses the **simple** protocol when the query has no parameters, so a parameterless `` sql`…` `` may contain several statements, including `COMMIT; BEGIN`. Queries with parameters use the extended protocol and are limited to one statement (`42601`). The ESLint rules (§ 7.1 of ARCHITECTURE.md) keep query text static in `src/`, so this matters only for arbitrary SQL execution, which is the threat model.

#### Clock behaviour (residual risk, not eliminated)

- **Backward step:** a context minted for start time _S_ on backend _P_ becomes valid again only in a later transaction on _P_ that starts at exactly _S_, which requires the clock to step back across _S_ and a message to be received at that exact microsecond. Unlikely, not impossible; not testable locally.
- **Coarse resolution:** if the clock advanced in ticks coarser than message spacing, consecutive messages on one backend could share a start time, which would make the same-message limitation reachable across messages. PostgreSQL on Linux reads the clock with microsecond resolution; R1b and R2 observed no repeats across messages. The hosted platform's clock is a deployment assumption (§ 7).

Both are accepted risks (§ 9). The virtual transaction id would remove them (§ 11).

#### Alternatives evaluated

| Candidate                                                       | Uniqueness (evidence)                                                                                                                                                                                        | Read-only tx                        | Read replica                                                            | Stable in tx | Trustworthy for the verifier   | Pooling                           | Overhead (evidence)                                                                                                                                                                                     | Attacker can forge/replay?                                                                                                                                 | Decision                                                         |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------- | ----------------------------------------------------------------------- | ------------ | ------------------------------ | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| **`pid` + transaction start (µs)**                              | per backend and **client message** (R1, R1b, R2)                                                                                                                                                             | yes                                 | expected yes (no XID needed; not tested)                                | yes          | yes (server-computed values)   | yes (one backend per transaction) | negligible to read                                                                                                                                                                                      | not forgeable; replay only within the same message or on an exact clock repeat (§ 3.1)                                                                     | **chosen**                                                       |
| `pg_current_xact_id()`                                          | unique for the life of the installation (xid8)                                                                                                                                                               | yes, but **assigns an XID** (E1–E4) | **no** — standby transactions "will never be assigned a transaction ID" | yes          | yes                            | yes                               | **1 XID + ≈ 45 B WAL per read-only tx** (8 000 tx: 8 000 XIDs, ≈ 365 KB WAL); commits then wait for WAL flush under `synchronous_commit`; faster freeze cycles; no local throughput difference measured | not forgeable; no replay                                                                                                                                   | rejected                                                         |
| `pg_current_xact_id_if_assigned()`                              | `NULL` in every read-only transaction                                                                                                                                                                        | `NULL`                              | `NULL`                                                                  | yes          | —                              | —                                 | none                                                                                                                                                                                                    | read-only transactions would share `NULL`                                                                                                                  | not viable                                                       |
| Virtual transaction id (`pg_locks.virtualtransaction`)          | per transaction on the backend slot (`procNumber/localXID`, increments per transaction — R1, R2); behaviour when a slot is reused by a new backend not established (R7: no reuse observed in 25 connections) | yes (no XID)                        | expected yes (not tested)                                               | yes          | yes (read from the lock table) | yes                               | single session ≈ 48 µs per lookup; **8 clients: −37 % to −43 % tps, +0.5–0.7 ms per transaction with two lookups** (R8, worst case with empty statements); reading `pg_locks` touches the lock manager  | not forgeable; closes the same-message and clock cases                                                                                                     | **rejected for MVP on measured cost**; documented upgrade (§ 11) |
| `backend_start` + transaction start                             | identifies the **backend session**, not the transaction                                                                                                                                                      | yes                                 | yes                                                                     | yes          | yes                            | yes                               | one `pg_stat_activity` read                                                                                                                                                                             | **does not prevent replay between transactions on the same backend** (R1 shows same session, same start time); it only separates sessions that reuse a pid | rejected (no benefit for the reviewed scenario)                  |
| Server-generated nonce                                          | unique if the database records it                                                                                                                                                                            | needs a write                       | no (writes)                                                             | —            | needs definer-owned storage    | yes                               | a write per transaction assigns an XID — same costs as `pg_current_xact_id()`                                                                                                                           | without a database record it can be replayed; with one it adds writes                                                                                      | rejected                                                         |
| `current_query()` inspection to refuse multi-statement messages | —                                                                                                                                                                                                            | —                                   | —                                                                       | —            | text parsing of SQL            | —                                 | —                                                                                                                                                                                                       | brittle; not a security boundary                                                                                                                           | rejected                                                         |

### 3.2 Payload format (version 1)

```
context = "v1" "." key_id "." user_id "." backend_pid "." xact_start_us "." mac
payload = "v1" "." key_id "." user_id "." backend_pid "." xact_start_us
mac     = lowercase hex( HMAC-SHA256( K[key_id], UTF-8(payload) ) )      -- 64 characters
```

| Field           | Format                                                                                                      |
| --------------- | ----------------------------------------------------------------------------------------------------------- |
| `key_id`        | `^[a-z0-9-]{1,32}$`                                                                                         |
| `user_id`       | canonical lowercase UUID (from a `VerifiedUserId`)                                                          |
| `backend_pid`   | decimal integer, `pg_catalog.pg_backend_pid()` in this transaction                                          |
| `xact_start_us` | decimal integer, `(extract(epoch from pg_catalog.now()) * 1000000)::bigint` in this transaction (exact, R6) |
| `mac`           | `^[0-9a-f]{64}$`                                                                                            |

No field may contain `.`; any other shape is rejected. The context is stored in the transaction-local setting `app.user_context`. The legacy setting `app.current_user_id` is **ignored entirely** — no fallback, no dual mode. The mint query, the `set_config` call and the verifier use `pg_catalog`-qualified functions **and operators** (e.g. `OPERATOR(pg_catalog.*)`), because caller SQL can change the session's `search_path` (§ 7). Today no runtime role has `CREATE` on any schema and `pg_temp` is never searched for functions or operators, so unqualified names are not exploitable; qualification keeps this independent of future grants.

## 4. Keys, roles and access

| Object                          | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Key material                    | 32 random bytes per key. Server side: `AIBAB_CONTEXT_KEY` (base64url) and `AIBAB_CONTEXT_KEY_ID` — server-only, validated with Zod, never logged, never `NEXT_PUBLIC_`. Separate keys per environment.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Database copy                   | `app_private.identity_keys (id text primary key, key bytea not null, created_at timestamptz, retired_at timestamptz)`, RLS enabled. **Never** in migrations or seeds (enforced by a test); inserted with **bound parameters**. Owner `postgres` (the migration role, as for every table); no `INSERT`/`UPDATE`/`DELETE` for any other role, so provisioning, rotation and retirement are possible only through the administrative connection. No default ACL exists for `app_private` today, so a new table gets no implicit grants.                                                                                                                                                                                                                                                                                                  |
| Role `aibab_identity`           | `NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`, enforced and asserted like the other roles. The **only** role with `SELECT` on `identity_keys`; owns no other function.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Indirect access                 | Only `postgres` may be a member of `aibab_identity` (`SET` without `INHERIT`, required to transfer function ownership as for `aibab_definer`; `postgres` can read the table anyway). On Supabase, creating a role also gives `postgres` an `ADMIN` membership granted by `supabase_admin` (observed for every `aibab_*` role). Other `CREATEROLE` roles (`dashboard_user`, `supabase_auth_admin`, `supabase_functions_admin`, `supabase_storage_admin`) hold no `ADMIN` option on `aibab_*` roles and therefore cannot grant them (PostgreSQL 16+ rule). No member with `INHERIT`; no `pg_read_all_data`; `aibab_user`, `aibab_app`, `aibab_definer` and the Supabase API roles have no path to the table — asserted by catalog invariants on effective privileges (`pg_has_role`, `has_table_privilege`), not only on direct grants. |
| `app_private.current_user_id()` | `SECURITY DEFINER`, owner `aibab_identity`, `search_path = ''`, no dynamic SQL, never returns or logs key material. `EXECUTE` for `aibab_user` and `aibab_definer` only (explicit `REVOKE … FROM PUBLIC`, as today). **Every relation reference schema-qualified:** `search_path = ''` still searches the session's temporary schema first for relation names (verified: an unqualified name resolved to a temporary table), and runtime roles can create temporary tables.                                                                                                                                                                                                                                                                                                                                                           |
| Extension access                | `aibab_identity` needs `USAGE` on schema `extensions` (PUBLIC has none today). `EXECUTE` on `extensions.hmac(bytea, bytea, text)` and `extensions.digest(text, text)` is already granted to PUBLIC by the extension. `USAGE` also exposes the other PUBLIC-executable functions in `extensions` to `aibab_identity`, which is acceptable because the role has no login and runs only the verifier.                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Separation                      | `aibab_definer` (other SECURITY DEFINER functions) has no access to `identity_keys`, so their defects cannot read the key.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

## 5. Verification and fail-closed rules

`app_private.current_user_id()`:

1. Setting absent or empty → return `NULL`. Every policy compares against the user id, so `NULL` matches nothing: no rows are visible, writes fail their policies, and the `create_*` functions raise `42501`.
2. Otherwise parse; any deviation from § 3.2 → raise `42501 'invalid user context'`.
3. `backend_pid <> pg_backend_pid()` or `xact_start_us <>` the current transaction start → raise `42501`.
4. Unknown `key_id`, or `retired_at` not null and `<= now()` → raise `42501`.
5. Recompute the MAC and compare → mismatch raises `42501`.
6. Return `user_id::uuid`.

**Decision (formerly open):** an absent context means "no user" (`NULL`, fail closed); a present but invalid context is treated as tampering or misconfiguration and aborts the statement (`42501`). Both outcomes deny access. Error messages never include the context, the key, or which check failed.

**`42501` is raised only when the verifier is evaluated.** PostgreSQL evaluates an initplan lazily, on first use (verified: a raising initplan in a filter did not raise when the scan produced no rows). A statement whose policies are never evaluated, for example on an empty table, completes without error and returns or changes nothing. Fail-closed is preserved, because no row is disclosed or modified without a successful verification, but tests for `42501` must use tables that contain candidate rows.

**Comparison:** step 5 compares `digest(expected, 'sha256')` with `digest(supplied, 'sha256')` using ordinary equality. **This is not a constant-time comparison, and hashing does not make it one.** Hashing both sides means that timing reveals information about hashes of the attacker's guesses rather than about the expected MAC itself, which reduces the practical value of a timing side channel; this is a mitigation, not a guarantee. Accepted risk (§ 9).

**Evaluation-frequency requirement:** identity should be verified **once per statement**. This is a requirement for task 2.2, not a property of the current policies, and it is not guaranteed globally: it depends on each expression's plan. `EXPLAIN (ANALYZE)` as `aibab_user` against the current schema (final review; 425 memberships, 395 profiles; UPDATE/DELETE plans not executed, except two no-op UPDATEs in a rolled-back transaction to observe `WITH CHECK`):

| Policy (command)                                                                                                                                                         | Expression using identity                                          | Observed evaluation                                                                                                                                                                                    | Task 2.2                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `organizations_*`, `memberships_select`, `memberships_update`, `invitations_*`, and the select/insert/update/delete policies of the 6 knowledge-base and settings tables | `organization_id IN (select app_private.my_organization_ids(…))`   | `hashed SubPlan`, `loops=1` — **once per statement**, in `USING` and in `WITH CHECK` (both no-op UPDATEs: `loops=1` for 5 rows). `INSERT … WITH CHECK` is not shown by `EXPLAIN` and was not executed. | keep; add a test for INSERT                                                                     |
| `profiles_select` (SELECT, and the SELECT check inside UPDATE)                                                                                                           | `user_id = current_user_id() OR shares_organization_with(user_id)` | **per-row filter:** both functions for every scanned row (395)                                                                                                                                         | **rewrite:** `user_id = (select …current_user_id()) OR user_id IN (select …my_colleague_ids())` |
| `profiles_update` (UPDATE)                                                                                                                                               | `user_id = current_user_id()`                                      | index condition (evaluated once per scan) **and** re-evaluated in the per-row filter; plan-dependent                                                                                                   | wrap: `(select …current_user_id())`                                                             |
| `memberships_delete` (DELETE)                                                                                                                                            | `… OR user_id = current_user_id()`                                 | **per-row filter** for that branch                                                                                                                                                                     | wrap: verified to become an `InitPlan` (`loops=1`, index condition)                             |
| body of `my_organization_ids`                                                                                                                                            | `m.user_id = current_user_id()`                                    | index condition (once) with the current index; **per row (425)** when a sequential scan is chosen                                                                                                      | wrap: verified `InitPlan`, once, in both plan shapes                                            |
| body of `shares_organization_with`                                                                                                                                       | `mine.user_id = current_user_id()`                                 | runs once per call, i.e. per `profiles` row                                                                                                                                                            | replaced by `my_colleague_ids()` (set-returning, used as `IN (select …)`)                       |
| `create_organization`, `create_invitation`                                                                                                                               | `v_user := current_user_id()` in PL/pgSQL                          | once per call                                                                                                                                                                                          | keep                                                                                            |

The proposed `profiles_select` rewrite was simulated as an explicit predicate: it plans as an `InitPlan` plus a `hashed SubPlan` (each `loops=1`) and returned **exactly the same rows** as the current expression for all 195 users who share an organization (595 user–profile pairs, 0 differences). Wrapping a `STABLE` function in a scalar subquery does not change its value within a statement, and identity cannot change mid-statement to anything except another context that also verifies, so the optimization preserves security semantics. Tests must assert the plan shape for every policy (§ 8).

## 6. Transaction flow

Target flow for task 2.2. **None of it is implemented yet.** Steps 2 and 6 are **required safeguards**: `withUserTx` must not return success after caller SQL has ended its transaction.

1. The server verifies the session with `supabase.auth.getUser()` (task 3) and obtains a `VerifiedUserId`.
2. `withUserTx` starts the transaction in its own message (`BEGIN`, I1) and then, in a separate query, reads `pg_catalog.pg_backend_pid()`, the transaction start (µs) and `pg_catalog.now() < pg_catalog.statement_timestamp()`. If the last value is false, `BEGIN` was not in an earlier message, and the helper refuses to sign (fail closed). This is one extra round trip.
3. The server builds the payload, computes the MAC with `node:crypto`, and sets `app.user_context` with `pg_catalog.set_config(..., true)` using a **bound parameter**.
4. `SET LOCAL ROLE aibab_user`; the application's queries run.
5. Each statement evaluates the identity once where the plan allows it (§ 5); membership-based policies then apply.
6. **Before COMMIT**, the helper re-reads the backend pid and the transaction start in its own query and throws if they differ from the minted values, which makes postgres.js roll back. This closes gap I5: after a caller `COMMIT`/`ROLLBACK`, that query runs in an implicit or caller-started transaction with a different start time. It is detection, not prevention: work committed by a caller `COMMIT` before the check cannot be undone, and the check does not authenticate anything.
7. COMMIT or ROLLBACK discards the setting and the role. A transaction started later on the same connection by a separate message has a different start time, so the old context is rejected (subject to § 3.1 and § 9).

Invariants for implementers (I1–I7, § 3.1):

- never start the `withUserTx` transaction in a message that contains caller-supplied SQL;
- never run caller code before the context is minted;
- never mint a context for a transaction that `withUserTx` did not start (keep the `Database` parameter type and do not accept a `UserTx`);
- never accept a context from outside `withUserTx`.

## 7. Connection pooling

- Supavisor **transaction mode** is expected to run a whole transaction on one server backend, which would keep `pg_backend_pid()` and `now()` consistent for steps 2–6 and make the context's lifetime match the transaction. This is the design assumption; it is **not verified** (see below).
- The design uses no prepared statements (`prepare: false` remains), no session state and no temporary tables.
- **Session-level state set by caller SQL survives COMMIT** and persists on the connection. Verified with postgres.js on a direct connection: `SET ROLE aibab_user`, `SET app.user_context = …`, `SET app.current_user_id = …` and `SET search_path = …` issued inside `fn` were still in effect outside any transaction afterwards, inside the next `withUserTx` call (where only the helper's `LOCAL` values override them), and after it. postgres.js does not reset session state when it releases a connection. Runtime roles can also create temporary objects (`TEMP` privilege, verified).
  - **Identity:** not affected by ADR-011. Every `withUserTx` sets the context and role with `LOCAL` scope, a stale context fails verification, and the verifier qualifies every name (§ 4).
  - **Defence in depth:** a leaked session `SET ROLE aibab_user` means that a query outside `withUserTx` on that connection runs as `aibab_user` instead of failing as `aibab_app`; under ADR-011 it sees no tenant data (`NULL` identity). Under the **current** design, a leaked session `app.current_user_id` would also act as that user for such a query — one more reason for ADR-011.
  - **Hygiene:** a leaked `search_path`, timeouts or temporary objects affect later requests that use unqualified names (§ 11).
- **Not verified against a running Supavisor**: the local stack excludes the `supavisor` container. A pooled integration test is a deployment gate before the first hosted deployment (§ 8, test 18). With a transaction pooler, two behaviours differ from a direct connection and must be tested:
  - after a caller `COMMIT`, the following statements may be routed to **another backend** (they would then fail the pid check);
  - session-level state left by one request may reach **another client's** transaction on the same backend.

## 8. Required PostgreSQL security tests (task 2.2)

All through the real `aibab_app` login, against the local Supabase stack:

1. Valid context → the intended user; all existing RLS tests pass unchanged in intent.
2. Forged `user_id` with the original MAC → `42501`.
3. Wrong `backend_pid` → `42501`; wrong `xact_start_us` → `42501`.
4. **Replay into a later transaction started by a separate message on the same connection** (including `COMMIT; BEGIN` issued from inside `fn`) → rejected.
5. **Known limitation, asserted explicitly:** transactions started within one simple-query message share the start time (R1). The test documents that a context minted for a transaction started in such a message is accepted in its siblings, and that `withUserTx` never starts its transaction that way.
6. Pipelined extended-protocol transactions (as postgres.js issues them) never share a start time with the minted transaction (R2).
7. Unknown `key_id`; retired key past its grace time → `42501`.
8. Malformed contexts (field count, version, patterns, extra dots, non-hex MAC) → `42501`.
9. Legacy `app.current_user_id` set to a valid user id → ignored (`NULL`).
10. `SET LOCAL` / session-level `SET app.user_context = …` with forged values → `42501`; a session-level value left on the connection does not authorize a later transaction.
11. `RESET ROLE` / `SET ROLE` sequences, including a session-level `SET ROLE aibab_user` left on the connection → no path yields an identity without a valid context.
12. `aibab_user`, `aibab_app`, `aibab_definer`, `anon`, `authenticated`, `service_role` cannot read `identity_keys` or obtain key material. Catalog invariants on **effective** privileges:
    - `pg_has_role(…, 'aibab_identity', 'MEMBER' | 'SET')` is false for every role except `postgres`;
    - `SET ROLE aibab_identity` fails with `42501` from `aibab_app` and after `RESET ROLE`;
    - `GRANT aibab_identity TO aibab_app` fails as `aibab_app`;
    - no runtime role has `INSERT`/`UPDATE`/`DELETE` on `identity_keys`;
    - `aibab_identity` owns only `current_user_id()`;
    - no other SECURITY DEFINER function is owned by it or reads the table.
13. A session holding only `DATABASE_URL` (no key) sees no tenant data and cannot use `create_*`.
14. Key rotation: old and new keys accepted during the grace period; only the new key afterwards.
15. `EXPLAIN` for every policy shows identity verification once per statement (no per-row calls), with tables that contain candidate rows. `INSERT … WITH CHECK` (not shown by `EXPLAIN`) is covered by a test in a rolled-back transaction. `track_functions` cannot be enabled by `postgres` (no `SET` privilege), so call counts are inferred from plan shape.
16. Mutation checks: disabling the MAC, pid or start-time check makes the corresponding tests fail.
17. Static test: migrations and seeds contain no identity key material.
18. Before hosted use: the suite through a Supavisor transaction-mode connection, including a check that every statement of a `withUserTx` call sees one backend pid, and the session-state cases of tests 22–23.
19. **Caller transaction control inside `fn`** (§ 6 step 6):
    - `COMMIT`, `ROLLBACK`, `COMMIT; BEGIN` and `ROLLBACK; BEGIN; SET LOCAL ROLE aibab_user` → `withUserTx` rejects, and identity is `NULL` or the context is rejected in every statement after the caller's command;
    - `BEGIN` → WARNING `25001` only, same transaction, identity unchanged;
    - `ROLLBACK TO SAVEPOINT` of an unknown savepoint → `3B001`.
20. **Mint self-check:** the mint query reports `now() < statement_timestamp()`; a variant that starts the transaction in the same message is refused before signing.
21. **Savepoints:** a context or role change inside a rolled-back `tx.transaction()` is reverted and the outer identity is intact; a forged context set inside a savepoint is rejected.
22. **Session-level state:** session `SET ROLE aibab_user`, `SET app.user_context`, `SET search_path` and a non-`ON COMMIT DROP` temporary table left by one `withUserTx` call do not change the identity or the result of the next call on the same connection, and the verifier ignores a temporary table named `identity_keys`.
23. **Connection reuse:** after success, after a thrown error, after an error swallowed by `fn` (rethrown by postgres.js) and after a caller `COMMIT`, the next transaction on the same connection starts without a valid identity.
24. **Type-level:** passing a `UserTx` as the `db` argument of `withUserTx` is a compile error (`@ts-expect-error` fixture).

## 9. Consequences and remaining limitations

**Security outcome:** SQL injection **can still act as the current authenticated user, but must not be able to impersonate another user.** An attacker who injects SQL into user _A_'s request keeps _A_'s permissions in that transaction; they cannot obtain a valid context for another user, and a context they capture is rejected in transactions started by later messages.

**Accepted risks:**

- **Same-message transactions:** transactions started within one simple-query message share the start time (R1). Unreachable for an attacker under the `withUserTx` invariants (§ 3.1, § 6); enforced by tests.
- **Clock steps and coarse clocks:** a backward step to the exact microsecond on the same backend, or a coarse system clock, could revalidate a captured context in a later transaction (§ 3.1). Not testable locally; expected to be small on hosted Linux (microsecond clock), but **not verified**. The protocol does not eliminate this risk; the virtual transaction id would (§ 11).
- **Caller transaction control:** SQL inside `fn` can `COMMIT` or `ROLLBACK` part of the work. Identity is not affected (I4). The required pre-commit check (§ 6 step 6, not yet implemented) turns this into an error, but work already committed by the caller cannot be undone.
- **SQL injection boundary:** HMAC prevents impersonation through a forged or replayed context. It does **not** prevent SQL injection, which can still read and change everything the current user may access, issue transaction control, and leave session-level state on the connection (§ 7).
- **Non-constant-time MAC comparison** (§ 5).
- **Compromised application server** (signing key + `DATABASE_URL`) can act as any user. `DATABASE_URL` **alone** no longer grants access to tenant data.
- **Database superuser and the table owner (`postgres`)**, including the Supabase SQL editor and migrations, bypass the mechanism and can read the key.
- **Symmetric key:** whoever obtains the database copy of the key (database compromise, backups, a defect in `current_user_id()`) can forge contexts.
- **Availability:** a missing or mismatched key makes every user query fail closed (`42501`) — an outage, not a leak.

**Costs** (measured locally unless marked):

| Item                               | Value                                                                                                                            |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| HMAC verification (prototype)      | ≈ 12.8 µs per call, single session, 10 000 calls; the prototype took the key as a parameter — the key lookup is **not** included |
| Extra round trips per `withUserTx` | **estimate**: two network round trips to the database — the mint query and the pre-commit check (§ 6) — not measured             |
| Per-statement cost                 | one verification per statement once § 5 is implemented; **not yet measured** with real policies                                  |

## 10. Migration and rollback

Implementation is a separate task (2.2) before task 3:

1. **New migration** (task 2 is committed; existing migrations are not edited): role `aibab_identity` with enforced attributes; `identity_keys` with RLS and grants; extension grants; replacement of `current_user_id()` with ownership transfer; policies and helper functions rewritten to evaluate identity once per statement (§ 5).
2. **Atomic cutover, no dual mode:** the migration, the new `withUserTx`, key provisioning and the tests land in one change.
3. **Key provisioning:** locally, a script modelled on `scripts/set-local-db-password.ts` (local container only, key generated into `.env.local`, inserted with bound parameters); hosted, a one-time provisioning step defined in Stage 7.
4. **Rotation:** insert a new key → deploy the server with the new `key_id` → set `retired_at = now() + grace` on the old key → delete it later. **Emergency rotation:** insert and deploy a new key and retire the old one immediately; in-flight transactions fail and are retried.
5. **Recovery:** missing key in the server environment → restore from the secret manager; missing database row → re-provision; both show up as `42501` spikes.
6. **Rollback:** a follow-up migration restores the previous `current_user_id()` and policies and drops the role and table, together with the previous `withUserTx`. Rolling back reintroduces the impersonation risk and should be temporary.

## 11. Open questions

1. **Supavisor verification:** run the § 8 suite through a Supavisor transaction-mode connection (locally or in Stage 7).
2. **Virtual transaction id hardening:** adopt `pg_locks.virtualtransaction` as an additional binding if a realistic workload benchmark in task 2.2 shows acceptable overhead, or if the clock caveats are judged material. Prerequisites: confirm local-xid behaviour when a backend slot is reused, and measure contention with production-like connection counts.
3. **Read replicas:** verify the chosen binding on a hot standby before any replica is used for user queries (expected to work; not tested).
4. **Pooling hygiene:** session-level state left by caller SQL persists on the connection (verified, § 7). Decide:
   - whether to revoke the default `TEMP` privilege from PUBLIC on the application database (ownership and feasibility on Supabase to be checked);
   - whether `withUserTx` should also pin `search_path` with `SET LOCAL`;
   - whether connections should be reset (`DISCARD ALL` outside a transaction) or discarded after a `withUserTx` failure.

   None of these is needed for identity.

5. **Hosted key provisioning** and storage (secret manager, access, audit) — Stage 7.
6. **Asymmetric verification** once a supported signature primitive is available in the database.

Resolved during review (now decisions): absent vs. invalid context (§ 5); `backend_start` as a binding (rejected, § 3.1); constant-time comparison (accepted risk, § 5, § 9).

## 12. References

PostgreSQL 17 documentation:

- Customized options — https://www.postgresql.org/docs/17/runtime-config-custom.html
- `SET` (`SET LOCAL` lifetime) — https://www.postgresql.org/docs/17/sql-set.html
- `SET ROLE` / `RESET ROLE` — https://www.postgresql.org/docs/17/sql-set-role.html
- Writing SECURITY DEFINER functions safely — https://www.postgresql.org/docs/17/sql-createfunction.html
- `GRANT … ON PARAMETER` — https://www.postgresql.org/docs/17/sql-grant.html
- `pg_current_xact_id()`, `pg_current_xact_id_if_assigned()`, xid8 — https://www.postgresql.org/docs/17/functions-info.html
- Transactions and identifiers (XID assignment on first write, virtual transaction ids) — https://www.postgresql.org/docs/17/transaction-id.html
- Hot standby (no transaction ids on standbys) — https://www.postgresql.org/docs/17/hot-standby.html
- Preventing transaction ID wraparound — https://www.postgresql.org/docs/17/routine-vacuuming.html
- `synchronous_commit` / asynchronous commit — https://www.postgresql.org/docs/17/runtime-config-wal.html, https://www.postgresql.org/docs/17/wal-async-commit.html
- `now()` / `transaction_timestamp()` — https://www.postgresql.org/docs/17/functions-datetime.html
- `pg_stat_activity` visibility — https://www.postgresql.org/docs/17/monitoring-stats.html
- pgcrypto (`hmac`, `digest`; no signing) — https://www.postgresql.org/docs/17/pgcrypto.html

Supabase documentation:

- JWT signing keys — https://supabase.com/docs/guides/auth/signing-keys
- pgjwt (deprecated on Postgres 17) — https://supabase.com/docs/guides/database/extensions/pgjwt
- pgsodium (pending deprecation) — https://supabase.com/docs/guides/database/extensions/pgsodium
- Connecting to Postgres (transaction mode, prepared statements, session state) — https://supabase.com/docs/guides/database/connecting-to-postgres
- `auth.getUser()` — https://supabase.com/docs/reference/javascript/auth-getuser
- `auth.getClaims()` — https://supabase.com/docs/reference/javascript/auth-getclaims
- Vault — https://supabase.com/docs/guides/database/vault

Local evidence (2026-11-15; all probes read-only or rolled back; no DDL persisted): impersonation P1–P4; extensions P5; HMAC prototype; binding E1–E7; pgbench XID/WAL comparison (2 × 8 000 tx); replay review R1, R1b (psql), R2 (postgres.js, 3 000 tx), R6 (conversion), R7 (25 backends), R8 (pgbench, 8 clients, 15 s × 2 rounds per mode); `EXPLAIN` of the `profiles` and `memberships` policies as `aibab_user`; `TEMP` privilege check. Final review (same day, as `aibab_app` through drizzle-orm/postgres.js unless noted; no writes persisted):

- message log and `now() < statement_timestamp()` for `withUserTx`;
- simple vs. extended protocol multi-statement behaviour;
- pid stability across 8 concurrent transactions;
- caller `COMMIT`/`ROLLBACK`/`BEGIN`/`COMMIT; BEGIN` inside `fn`;
- `SET ROLE` to `aibab_definer`, `postgres`, `authenticated` and `service_role` (all `42501`), `RESET ROLE`, and `GRANT aibab_definer TO aibab_app` (`42501`);
- session-level state persistence across calls; savepoint rollback; swallowed errors; `TEMP` table creation;
- catalog queries on role attributes, memberships, `pg_has_role`, schema/database privileges, SECURITY DEFINER functions with effective `EXECUTE`, default ACLs and table owners (as `postgres`, read-only);
- temporary-schema resolution under `search_path = ''`;
- `EXPLAIN` of every `aibab_user` policy, plus `EXPLAIN ANALYZE` of two no-op UPDATEs in a rolled-back transaction;
- the rewrite simulation and equivalence check; lazy initplan evaluation;
- a type-check of `withUserTx(tx, …)`.
