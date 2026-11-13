import { pgSchema } from "drizzle-orm/pg-core";

/**
 * Drizzle mirror of the `app` schema, used for typed queries only.
 * The SQL migrations in `supabase/migrations/` are the source of truth;
 * `tests/db/schema-drift.test.ts` verifies that this mirror matches them.
 */
export const app = pgSchema("app");
