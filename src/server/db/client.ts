import "server-only";

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { serverEnv } from "@/lib/env.server";

import * as schema from "./schema";

export type Database = ReturnType<typeof createDatabase>;

/**
 * Creates a Drizzle client for a connection string. The application connects as
 * `aibab_app`, which has no privileges of its own: every query must run inside
 * `withUserTx()` (fail closed).
 *
 * `prepare: false` keeps the client compatible with the Supabase transaction
 * pooler (Supavisor), which does not support prepared statements.
 */
export function createDatabase(connectionString: string, options: { max?: number } = {}) {
  const client = postgres(connectionString, { prepare: false, max: options.max ?? 10 });
  return drizzle(client, { schema });
}

let database: Database | undefined;

/** Lazily created singleton for the application runtime. */
export function getDatabase(): Database {
  database ??= createDatabase(serverEnv().DATABASE_URL);
  return database;
}
