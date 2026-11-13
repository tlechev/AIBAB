import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { createDatabase } from "@/server/db/client";
import { withUserTx } from "@/server/db/user-tx";

import { appDb, appSql, asVerified, createTestUser, expectPgError } from "./helpers";

async function currentContext(tx: { execute: typeof appDb.execute }) {
  const rows = await tx.execute<{ role: string; uid: string | null }>(
    sql`select current_user::text as role, app_private.current_user_id()::text as uid`,
  );
  return rows[0];
}

describe("withUserTx: transaction user context", () => {
  it("runs as aibab_user with the given user id", async () => {
    const userId = await createTestUser();
    const ctx = await withUserTx(appDb, userId, (tx) => currentContext(tx));
    expect(ctx).toEqual({ role: "aibab_user", uid: userId });
  });

  it("fails closed: aibab_app without withUserTx cannot use the app schemas", async () => {
    await expectPgError(appDb.execute(sql`select app_private.current_user_id()`), "42501");
  });

  it("returns NULL user when the setting is missing", async () => {
    const sqlClient = appSql();
    try {
      const rows = await sqlClient.begin(async (tx) => {
        await tx`set local role aibab_user`;
        return tx`select app_private.current_user_id() as uid`;
      });
      expect(rows[0]?.uid).toBeNull();
    } finally {
      await sqlClient.end();
    }
  });

  it("treats an empty user id as missing", async () => {
    const sqlClient = appSql();
    try {
      const rows = await sqlClient.begin(async (tx) => {
        await tx`select set_config('app.current_user_id', '', true)`;
        await tx`set local role aibab_user`;
        return tx`select app_private.current_user_id() as uid`;
      });
      expect(rows[0]?.uid).toBeNull();
    } finally {
      await sqlClient.end();
    }
  });

  it("aborts on a malformed user id set directly in the database (22P02)", async () => {
    const sqlClient = appSql();
    try {
      await expectPgError(
        sqlClient.begin(async (tx) => {
          await tx`select set_config('app.current_user_id', 'not-a-uuid', true)`;
          await tx`set local role aibab_user`;
          return tx`select app_private.current_user_id()`;
        }),
        "22P02",
      );
    } finally {
      await sqlClient.end();
    }
  });

  it("rejects a non-UUID user id before touching the database", async () => {
    await expect(
      withUserTx(appDb, asVerified("abc'); drop schema app; --"), async () => 1),
    ).rejects.toThrow(TypeError);
  });

  it("does not leak role or user id to the next transaction after COMMIT", async () => {
    const db = createDatabase(process.env.DATABASE_URL!, { max: 1 });
    try {
      const userId = await createTestUser();
      await withUserTx(db, userId, async () => undefined);
      const rows = await db.execute<{ role: string; setting: string | null }>(
        sql`select current_user::text as role, nullif(current_setting('app.current_user_id', true), '') as setting`,
      );
      expect(rows[0]).toEqual({ role: "aibab_app", setting: null });
    } finally {
      await db.$client.end();
    }
  });

  it("does not leak role or user id to the next transaction after ROLLBACK", async () => {
    const db = createDatabase(process.env.DATABASE_URL!, { max: 1 });
    try {
      const userId = await createTestUser();
      await expect(
        withUserTx(db, userId, async () => {
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
      const rows = await db.execute<{ role: string; setting: string | null }>(
        sql`select current_user::text as role, nullif(current_setting('app.current_user_id', true), '') as setting`,
      );
      expect(rows[0]).toEqual({ role: "aibab_app", setting: null });
    } finally {
      await db.$client.end();
    }
  });

  it("sees an unknown (non-existent) user id as a user without data", async () => {
    const ghost = asVerified("00000000-0000-4000-8000-000000000000");
    const ctx = await withUserTx(appDb, ghost, (tx) => currentContext(tx));
    expect(ctx).toEqual({ role: "aibab_user", uid: ghost });
  });
});
