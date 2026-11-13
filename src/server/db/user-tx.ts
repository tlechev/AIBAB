import "server-only";

import { sql } from "drizzle-orm";

import type { VerifiedUserId } from "@/server/auth/verified-user-id";

import type { Database } from "./client";

export type UserTx = Parameters<Parameters<Database["transaction"]>[0]>[0];

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Runs `fn` in a transaction as the end user `userId`, with RLS enforced.
 *
 * 1. `app.current_user_id` is set transaction-locally (bind parameter, no SQL
 *    string building). RLS policies and SECURITY DEFINER functions read it via
 *    `app_private.current_user_id()`.
 * 2. `SET LOCAL ROLE aibab_user` switches to the only role with table grants.
 *
 * Both settings are discarded at COMMIT or ROLLBACK, so nothing leaks to the
 * next transaction on a pooled connection.
 *
 * Trust boundary: PostgreSQL does not authenticate `userId`. It must come from
 * a verified Supabase session; the `VerifiedUserId` type enforces that at
 * compile time.
 */
export async function withUserTx<T>(
  db: Database,
  userId: VerifiedUserId,
  fn: (tx: UserTx) => Promise<T>,
): Promise<T> {
  if (!uuidPattern.test(userId)) {
    throw new TypeError("withUserTx: userId must be a UUID");
  }
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.current_user_id', ${userId}, true)`);
    await tx.execute(sql`set local role aibab_user`);
    return fn(tx);
  });
}
