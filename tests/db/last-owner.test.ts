import { describe, expect, it } from "vitest";

import { addMember, createOrganizationAs } from "./fixtures";
import { adminSql, appSql, createTestUser, expectPgError, pgCode } from "./helpers";

type Sql = ReturnType<typeof appSql>;

/** Opens a transaction as `userId` and keeps it open until `release` resolves. */
function openUserTx(
  client: Sql,
  userId: string,
  statement: (tx: Sql) => Promise<unknown>,
  release: Promise<void>,
) {
  return client.begin(async (tx) => {
    await tx`select set_config('app.current_user_id', ${userId}, true)`;
    await tx`set local role aibab_user`;
    await statement(tx as unknown as Sql);
    await release;
  });
}

describe("an organization always keeps at least one owner", () => {
  it("the sole owner cannot demote or remove themselves", async () => {
    const owner = await createTestUser();
    const org = await createOrganizationAs(owner);
    const client = appSql();
    try {
      await expectPgError(
        openUserTx(
          client,
          owner,
          (tx) =>
            tx`update app.memberships set role = 'admin' where organization_id = ${org} and user_id = ${owner}`,
          Promise.resolve(),
        ),
        "P0001",
      );
      await expectPgError(
        openUserTx(
          client,
          owner,
          (tx) =>
            tx`delete from app.memberships where organization_id = ${org} and user_id = ${owner}`,
          Promise.resolve(),
        ),
        "P0001",
      );
    } finally {
      await client.end();
    }
  });

  it.each([
    ["demote", "update app.memberships set role = 'admin'"],
    ["remove", "delete from app.memberships"],
  ])("two owners who concurrently %s themselves cannot both succeed", async (_label, statement) => {
    const owner1 = await createTestUser();
    const owner2 = await createTestUser();
    const org = await createOrganizationAs(owner1);
    await addMember(org, owner2, "owner");

    const c1 = appSql();
    const c2 = appSql();
    try {
      let releaseFirst!: () => void;
      const firstMayCommit = new Promise<void>((resolve) => (releaseFirst = resolve));
      let firstDidWrite!: () => void;
      const firstWrote = new Promise<void>((resolve) => (firstDidWrite = resolve));

      // tx1 changes owner1 and holds its transaction open.
      const tx1 = openUserTx(
        c1,
        owner1,
        async (tx) => {
          await tx.unsafe(`${statement} where organization_id = $1 and user_id = $2`, [
            org,
            owner1,
          ]);
          firstDidWrite();
        },
        firstMayCommit,
      );
      await firstWrote;

      // tx2 changes owner2 while tx1 is still open: it must wait for tx1's lock.
      const tx2 = openUserTx(
        c2,
        owner2,
        (tx) =>
          tx.unsafe(`${statement} where organization_id = $1 and user_id = $2`, [org, owner2]),
        Promise.resolve(),
      );

      // Prove tx2 is actually blocked on the advisory lock before tx1 commits.
      let waiting = 0;
      for (let attempt = 0; attempt < 50 && waiting === 0; attempt++) {
        const [row] = await adminSql<{ waiting: number }[]>`
          select count(*)::int as waiting from pg_stat_activity
          where usename = 'aibab_app' and wait_event_type = 'Lock' and wait_event = 'advisory'`;
        waiting = row?.waiting ?? 0;
        if (waiting === 0) await new Promise((resolve) => setTimeout(resolve, 50));
      }
      releaseFirst();

      const [r1, r2] = await Promise.allSettled([tx1, tx2]);
      expect(waiting).toBe(1);
      expect(r1.status).toBe("fulfilled");
      expect(r2.status).toBe("rejected");
      expect(pgCode((r2 as PromiseRejectedResult).reason)).toBe("P0001");

      const [row] = await adminSql<{ owners: number }[]>`
        select count(*)::int as owners from app.memberships
        where organization_id = ${org} and role = 'owner'`;
      expect(row?.owners).toBe(1);
    } finally {
      await c1.end();
      await c2.end();
    }
  });

  it("deleting the whole organization is not blocked by the owner rule", async () => {
    const owner = await createTestUser();
    const org = await createOrganizationAs(owner);
    await adminSql`delete from app.organizations where id = ${org}`;
    const [row] = await adminSql<{ n: number }[]>`
      select count(*)::int as n from app.memberships where organization_id = ${org}`;
    expect(row?.n).toBe(0);
  });
});
