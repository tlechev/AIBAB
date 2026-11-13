import { createHmac, randomUUID } from "node:crypto";

import postgres from "postgres";
import { afterAll } from "vitest";

import type { VerifiedUserId } from "@/server/auth/verified-user-id";
import { createDatabase, type Database } from "@/server/db/client";
import { withUserTx, type UserTx } from "@/server/db/user-tx";

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing env ${name}`);
  return value;
}

/**
 * Superuser-like connection for test setup and catalog inspection only.
 * Application code never has access to this connection.
 */
export const adminSql = postgres(env("TEST_DATABASE_ADMIN_URL"), { max: 2, onnotice: () => {} });

/** Runtime connection exactly as the app uses it: the `aibab_app` role. */
export const appDb: Database = createDatabase(env("DATABASE_URL"), { max: 4 });

/** Raw `aibab_app` connections for tests that need explicit session control. */
export function appSql(options: { max?: number } = {}) {
  return postgres(env("DATABASE_URL"), {
    max: options.max ?? 1,
    prepare: false,
    onnotice: () => {},
  });
}

afterAll(async () => {
  await adminSql.end({ timeout: 5 });
  await appDb.$client.end({ timeout: 5 });
});

/** Test-only: production code obtains VerifiedUserId from a verified session. */
export function asVerified(userId: string): VerifiedUserId {
  return userId as VerifiedUserId;
}

/** Creates a user in auth.users (the profile is created by trigger). */
export async function createTestUser(fullName = "Test User"): Promise<VerifiedUserId> {
  const id = randomUUID();
  await adminSql`
    insert into auth.users (id, aud, role, email, raw_user_meta_data, created_at, updated_at)
    values (${id}, 'authenticated', 'authenticated', ${`${id}@test.aibab.local`},
            ${adminSql.json({ full_name: fullName })}, now(), now())`;
  return asVerified(id);
}

export function asUser<T>(userId: VerifiedUserId, fn: (tx: UserTx) => Promise<T>): Promise<T> {
  return withUserTx(appDb, userId, fn);
}

/** Extracts the SQLSTATE from postgres.js or Drizzle-wrapped errors. */
export function pgCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/** Asserts that `promise` rejects with the given SQLSTATE. */
export async function expectPgError(promise: Promise<unknown>, code: string): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  if (caught === undefined) throw new Error(`Expected SQLSTATE ${code}, but the query succeeded`);
  const actual = pgCode(caught);
  if (actual !== code) {
    throw new Error(`Expected SQLSTATE ${code}, got ${actual ?? "none"}: ${String(caught)}`);
  }
}

/** Signs an HS256 JWT like Supabase Auth would, for Data API exposure tests. */
export function signTestJwt(claims: Record<string, unknown>): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "HS256", typ: "JWT" });
  const now = Math.floor(Date.now() / 1000);
  const payload = encode({ iss: "supabase-demo", iat: now, exp: now + 600, ...claims });
  const signature = createHmac("sha256", env("TEST_SUPABASE_JWT_SECRET"))
    .update(`${header}.${payload}`)
    .digest("base64url");
  return `${header}.${payload}.${signature}`;
}

export const supabaseUrl = () => env("TEST_SUPABASE_URL");
export const supabaseAnonKey = () => env("TEST_SUPABASE_ANON_KEY");
