import { createHash, randomBytes } from "node:crypto";

import { eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { createInvitation, type InvitableRole } from "@/server/db/invitations";
import { invitationColumns, invitations } from "@/server/db/schema";

import { createTenantFixture } from "./fixtures";
import { adminSql, appSql, asUser, expectPgError } from "./helpers";

type Fixture = Awaited<ReturnType<typeof createTenantFixture>>;
type User = Fixture["ownerA"];

const sha256Hex = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const randomHash = () => createHash("sha256").update(randomBytes(32)).digest("hex");
const email = (label: string) => `${label}-${randomBytes(4).toString("hex")}@example.com`;

describe("invitations", () => {
  let f: Fixture;
  let inviteA: string;

  const invite = (
    user: User,
    overrides: {
      organizationId?: string;
      email?: string;
      role?: string;
      expiresInDays?: number;
    } = {},
  ) =>
    asUser(user, (tx) =>
      createInvitation(tx, {
        organizationId: overrides.organizationId ?? f.orgA,
        email: overrides.email ?? email("person"),
        role: (overrides.role ?? "staff") as InvitableRole,
        expiresInDays: overrides.expiresInDays,
      }),
    );

  const storedHash = async (id: string) => {
    const [row] = await adminSql<{ token_hash: string }[]>`
      select token_hash from app.invitations where id = ${id}`;
    return row?.token_hash;
  };

  beforeAll(async () => {
    f = await createTenantFixture();
    inviteA = (await invite(f.ownerA, { email: email("new-staff") })).invitationId;
  });

  describe("visibility", () => {
    it("owners and admins see their organization's invitations (permitted columns)", async () => {
      const rows = await asUser(f.adminD, (tx) => tx.select(invitationColumns).from(invitations));
      expect(rows.map((r) => r.id)).toContain(inviteA);
    });

    it("staff, other tenants and users without membership see none", async () => {
      for (const user of [f.staffS, f.ownerB, f.userC]) {
        expect(await asUser(user, (tx) => tx.select(invitationColumns).from(invitations))).toEqual(
          [],
        );
      }
    });
  });

  describe("creation through app.create_invitation()", () => {
    it("returns a fresh 256-bit-format token once; only its SHA-256 is stored", async () => {
      const created = await invite(f.ownerA);
      expect(created.token).toMatch(/^[0-9a-f]{64}$/);
      expect(await storedHash(created.invitationId)).toBe(sha256Hex(created.token));
      const [plain] = await adminSql<{ n: number }[]>`
        select count(*)::int as n from app.invitations
        where token_hash = ${created.token} or email = ${created.token}`;
      expect(plain?.n).toBe(0);
    });

    it("issues a different token on every call", async () => {
      const tokens = new Set<string>();
      for (let i = 0; i < 5; i++) tokens.add((await invite(f.ownerA)).token);
      expect(tokens.size).toBe(5);
    });

    it("admin can invite staff and admins; invited_by is always the caller", async () => {
      const created = await invite(f.adminD, { role: "admin" });
      const [row] = await asUser(f.adminD, (tx) =>
        tx
          .select(invitationColumns)
          .from(invitations)
          .where(eq(invitations.id, created.invitationId)),
      );
      expect(row).toMatchObject({ role: "admin", invitedBy: f.adminD, organizationId: f.orgA });
    });

    it("normalizes the email address", async () => {
      const created = await invite(f.ownerA, { email: "  Person.Upper@Example.COM " });
      const [row] = await asUser(f.ownerA, (tx) =>
        tx
          .select({ email: invitations.email })
          .from(invitations)
          .where(eq(invitations.id, created.invitationId)),
      );
      expect(row?.email).toBe("person.upper@example.com");
    });

    it.each([
      ["another organization's owner", "ownerB"],
      ["staff", "staffS"],
      ["a user without membership", "userC"],
    ] as const)("rejects %s (42501)", async (_label, who) => {
      await expectPgError(invite(f[who]), "42501");
    });

    it("rejects inviting into another organization (42501)", async () => {
      await expectPgError(invite(f.ownerA, { organizationId: f.orgB }), "42501");
    });

    it("rejects a call without a user context (42501)", async () => {
      const client = appSql();
      try {
        await expectPgError(
          client.begin(async (tx) => {
            await tx`set local role aibab_user`;
            return tx`select * from app.create_invitation(${f.orgA}::uuid, 'x@example.com', 'staff')`;
          }),
          "42501",
        );
      } finally {
        await client.end();
      }
    });

    it.each([
      ["owner role", { role: "owner" }, "23514"],
      ["malformed email", { email: "not-an-email" }, "23514"],
      ["expiry of 0 days", { expiresInDays: 0 }, "22023"],
      ["expiry beyond 30 days", { expiresInDays: 31 }, "22023"],
    ] as const)("rejects %s", async (_label, overrides, code) => {
      await expectPgError(invite(f.ownerA, overrides), code);
    });

    it("allows only one pending invitation per email, and a new one after revocation", async () => {
      const address = email("dup");
      const first = await invite(f.ownerA, { email: address });
      await expectPgError(invite(f.ownerA, { email: address }), "23505");
      await asUser(f.ownerA, (tx) =>
        tx
          .update(invitations)
          .set({ revokedAt: new Date() })
          .where(eq(invitations.id, first.invitationId)),
      );
      const second = await invite(f.ownerA, { email: address });
      expect(second.token).not.toBe(first.token);
    });

    it("composite FK: the inviter must belong to the same organization, even bypassing RLS", async () => {
      await expectPgError(
        adminSql`
          insert into app.invitations (organization_id, email, role, token_hash, invited_by, expires_at)
          values (${f.orgA}, ${email("x")}, 'staff', ${randomHash()}, ${f.ownerB}, now() + interval '1 day')`,
        "23503",
      );
    });

    it("defense in depth: timestamps are server-set even for direct inserts (RLS bypassed)", async () => {
      const [row] = await adminSql<{ created_at: Date }[]>`
        insert into app.invitations
          (organization_id, email, role, token_hash, invited_by, expires_at, created_at, updated_at)
        values (${f.orgA}, ${email("ts")}, 'staff', ${randomHash()}, ${f.ownerA},
                now() + interval '7 days', '2020-01-01', '2020-01-01')
        returning created_at`;
      expect(Math.abs(row!.created_at.getTime() - Date.now())).toBeLessThan(60_000);
    });

    it("is executable only by aibab_user", async () => {
      const signature = "app.create_invitation(uuid,text,app.member_role,integer)";
      const [row] = await adminSql<Record<string, boolean>[]>`
        select has_function_privilege('anon', ${signature}, 'EXECUTE') as anon,
               has_function_privilege('authenticated', ${signature}, 'EXECUTE') as authenticated,
               has_function_privilege('service_role', ${signature}, 'EXECUTE') as service_role,
               has_function_privilege('aibab_app', ${signature}, 'EXECUTE') as aibab_app,
               has_function_privilege('aibab_user', ${signature}, 'EXECUTE') as aibab_user`;
      expect(row).toEqual({
        anon: false,
        authenticated: false,
        service_role: false,
        aibab_app: false,
        aibab_user: true,
      });
    });
  });

  /** F7: aibab_user can neither read nor supply token_hash. */
  describe("token_hash is never readable or writable by aibab_user", () => {
    it("effective privileges in the database", async () => {
      const [row] = await adminSql<Record<string, boolean>[]>`
        select
          has_table_privilege('aibab_user', 'app.invitations', 'SELECT') as table_select,
          has_table_privilege('aibab_user', 'app.invitations', 'INSERT') as table_insert,
          has_table_privilege('aibab_user', 'app.invitations', 'UPDATE') as table_update,
          has_table_privilege('aibab_user', 'app.invitations', 'DELETE') as table_delete,
          has_column_privilege('aibab_user', 'app.invitations', 'token_hash', 'SELECT') as hash_select,
          has_column_privilege('aibab_user', 'app.invitations', 'token_hash', 'INSERT') as hash_insert,
          has_column_privilege('aibab_user', 'app.invitations', 'token_hash', 'UPDATE') as hash_update,
          has_column_privilege('aibab_user', 'app.invitations', 'email', 'SELECT') as email_select,
          has_column_privilege('aibab_user', 'app.invitations', 'revoked_at', 'UPDATE') as revoke_update`;
      expect(row).toEqual({
        table_select: false,
        table_insert: false,
        table_update: false,
        table_delete: true,
        hash_select: false,
        hash_insert: false,
        hash_update: false,
        email_select: true,
        revoke_update: true,
      });
    });

    it("cannot SELECT token_hash, including for revoked invitations", async () => {
      const created = await invite(f.ownerA);
      await asUser(f.ownerA, (tx) =>
        tx
          .update(invitations)
          .set({ revokedAt: new Date() })
          .where(eq(invitations.id, created.invitationId)),
      );
      await expectPgError(
        asUser(f.ownerA, (tx) =>
          tx.execute(
            sql`select token_hash from app.invitations where id = ${created.invitationId}`,
          ),
        ),
        "42501",
      );
      // An ORM `select()` without columns also requests token_hash.
      await expectPgError(
        asUser(f.ownerA, (tx) => tx.select().from(invitations)),
        "42501",
      );
      await expectPgError(
        asUser(f.ownerA, (tx) => tx.execute(sql`select * from app.invitations`)),
        "42501",
      );
      // Nor indirectly through a predicate on the column.
      await expectPgError(
        asUser(f.ownerA, (tx) =>
          tx.execute(sql`select id from app.invitations where token_hash like 'a%'`),
        ),
        "42501",
      );
    });

    it("cannot INSERT an invitation, with or without a caller-supplied token_hash", async () => {
      await expectPgError(
        asUser(f.ownerA, (tx) =>
          tx.execute(sql`
            insert into app.invitations (organization_id, email, role, token_hash, invited_by, expires_at)
            values (${f.orgA}, ${email("direct")}, 'staff', ${randomHash()}, ${f.ownerA}, now() + interval '7 days')`),
        ),
        "42501",
      );
      await expectPgError(
        asUser(f.ownerA, (tx) =>
          tx.execute(sql`
            insert into app.invitations (organization_id, email, role, invited_by, expires_at)
            values (${f.orgA}, ${email("direct")}, 'staff', ${f.ownerA}, now() + interval '7 days')`),
        ),
        "42501",
      );
    });

    it("cannot UPDATE token_hash", async () => {
      await expectPgError(
        asUser(f.ownerA, (tx) =>
          tx.execute(
            sql`update app.invitations set token_hash = ${randomHash()} where id = ${inviteA}`,
          ),
        ),
        "42501",
      );
      expect(await storedHash(inviteA)).toMatch(/^[0-9a-f]{64}$/);
    });

    it("an owner cannot delete a revoked invitation and re-create it with the old token hash", async () => {
      const address = email("reuse");
      const original = await invite(f.ownerA, { email: address });
      const oldHash = await storedHash(original.invitationId);
      await asUser(f.ownerA, (tx) =>
        tx
          .update(invitations)
          .set({ revokedAt: new Date() })
          .where(eq(invitations.id, original.invitationId)),
      );

      // Step 1 of the attack is no longer possible: the hash cannot be read.
      await expectPgError(
        asUser(f.ownerA, (tx) =>
          tx.execute(
            sql`select token_hash from app.invitations where id = ${original.invitationId}`,
          ),
        ),
        "42501",
      );

      // Even with a leaked hash (simulated via the admin connection), re-issuing fails.
      const deleted = await asUser(f.ownerA, (tx) =>
        tx
          .delete(invitations)
          .where(eq(invitations.id, original.invitationId))
          .returning({ id: invitations.id }),
      );
      expect(deleted).toEqual([{ id: original.invitationId }]);
      await expectPgError(
        asUser(f.ownerA, (tx) =>
          tx.execute(sql`
            insert into app.invitations (organization_id, email, role, token_hash, invited_by, expires_at)
            values (${f.orgA}, ${address}, 'staff', ${oldHash!}, ${f.ownerA}, now() + interval '7 days')`),
        ),
        "42501",
      );

      // The only creation path issues a new token; the old link stays invalid.
      const reissued = await invite(f.ownerA, { email: address });
      expect(await storedHash(reissued.invitationId)).not.toBe(oldHash);
      const [row] = await adminSql<{ n: number }[]>`
        select count(*)::int as n from app.invitations where token_hash = ${oldHash!}`;
      expect(row?.n).toBe(0);
    });

    it("other organizations and unauthorized roles stay blocked from token data", async () => {
      for (const user of [f.ownerB, f.staffS, f.userC]) {
        await expectPgError(
          asUser(user, (tx) => tx.execute(sql`select token_hash from app.invitations`)),
          "42501",
        );
      }
    });
  });

  describe("changes", () => {
    it("only revoked_at is mutable", async () => {
      for (const change of [{ role: "admin" as const }, { organizationId: f.orgB }]) {
        await expectPgError(
          asUser(f.ownerA, (tx) =>
            tx.update(invitations).set(change).where(eq(invitations.id, inviteA)),
          ),
          "42501",
        );
      }
    });

    it("another tenant cannot revoke or delete", async () => {
      const revoked = await asUser(f.ownerB, (tx) =>
        tx
          .update(invitations)
          .set({ revokedAt: new Date() })
          .where(eq(invitations.id, inviteA))
          .returning({ id: invitations.id }),
      );
      expect(revoked).toEqual([]);
      const deleted = await asUser(f.ownerB, (tx) =>
        tx.delete(invitations).where(eq(invitations.id, inviteA)).returning({ id: invitations.id }),
      );
      expect(deleted).toEqual([]);
    });

    it("an invitation cannot be both accepted and revoked", async () => {
      await expectPgError(
        adminSql`update app.invitations set accepted_at = now(), revoked_at = now() where id = ${inviteA}`,
        "23514",
      );
    });
  });

  /** F2: revocation is one-way. All operations below run as aibab_app → aibab_user. */
  describe("revocation is one-way", () => {
    const newInvitation = async () => (await invite(f.ownerA)).invitationId;
    const revoke = (user: User, id: string, at: Date | null = new Date()) =>
      asUser(user, (tx) =>
        tx
          .update(invitations)
          .set({ revokedAt: at })
          .where(eq(invitations.id, id))
          .returning({ id: invitations.id, revokedAt: invitations.revokedAt }),
      );
    const stateOf = async (id: string) => {
      const [row] = await asUser(f.ownerA, (tx) =>
        tx
          .select({ revokedAt: invitations.revokedAt, acceptedAt: invitations.acceptedAt })
          .from(invitations)
          .where(eq(invitations.id, id)),
      );
      return row!;
    };

    it("an owner or admin can revoke an active invitation; the time is set by the server", async () => {
      const id = await newInvitation();
      const [row] = await revoke(f.adminD, id, new Date("2020-01-01T00:00:00Z"));
      expect(row?.id).toBe(id);
      expect(Math.abs(row!.revokedAt!.getTime() - Date.now())).toBeLessThan(60_000);
    });

    it("a revoked invitation cannot be reactivated (revoked_at cannot be cleared)", async () => {
      const id = await newInvitation();
      await revoke(f.ownerA, id);
      const before = await stateOf(id);
      expect(await revoke(f.ownerA, id, null)).toEqual([]);
      expect(await stateOf(id)).toEqual(before);
    });

    it("revoked_at cannot be changed once set", async () => {
      const id = await newInvitation();
      await revoke(f.ownerA, id);
      const before = await stateOf(id);
      expect(await revoke(f.adminD, id, new Date(Date.now() + 86_400_000))).toEqual([]);
      expect(await stateOf(id)).toEqual(before);
    });

    it("an update that keeps an active invitation active is rejected", async () => {
      const id = await newInvitation();
      await expectPgError(revoke(f.ownerA, id, null), "42501");
      expect((await stateOf(id)).revokedAt).toBeNull();
    });

    it("an accepted invitation cannot be revoked", async () => {
      const id = await newInvitation();
      // Setup only: acceptance will be a SECURITY DEFINER function in a later task.
      await adminSql`update app.invitations set accepted_at = now() where id = ${id}`;
      expect(await revoke(f.ownerA, id)).toEqual([]);
      expect((await stateOf(id)).revokedAt).toBeNull();
    });

    it("staff and other tenants cannot revoke", async () => {
      const id = await newInvitation();
      expect(await revoke(f.staffS, id)).toEqual([]);
      expect(await revoke(f.ownerB, id)).toEqual([]);
      expect((await stateOf(id)).revokedAt).toBeNull();
    });

    it("no other column became writable", async () => {
      const id = await newInvitation();
      for (const change of [
        { email: "other@example.com" },
        { expiresAt: new Date(Date.now() + 20 * 86_400_000) },
        { acceptedAt: new Date() },
        { invitedBy: f.adminD },
        { tokenHash: randomHash() },
      ]) {
        await expectPgError(
          asUser(f.ownerA, (tx) =>
            tx.update(invitations).set(change).where(eq(invitations.id, id)),
          ),
          "42501",
        );
      }
    });

    it("owners and admins can still delete revoked invitations", async () => {
      const id = await newInvitation();
      await revoke(f.ownerA, id);
      const deleted = await asUser(f.adminD, (tx) =>
        tx.delete(invitations).where(eq(invitations.id, id)).returning({ id: invitations.id }),
      );
      expect(deleted).toEqual([{ id }]);
    });

    it("defense in depth: the trigger blocks reactivation even when RLS is bypassed", async () => {
      const id = await newInvitation();
      await revoke(f.ownerA, id);
      await expectPgError(
        adminSql`update app.invitations set revoked_at = null where id = ${id}`,
        "42501",
      );
    });
  });
});
