import { eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { memberships, organizations, profiles } from "@/server/db/schema";

import { addMember, createTenantFixture } from "./fixtures";
import { adminSql, asUser, createTestUser, expectPgError } from "./helpers";

type Fixture = Awaited<ReturnType<typeof createTenantFixture>>;

describe("tenant isolation: organizations, memberships, profiles", () => {
  let f: Fixture;
  beforeAll(async () => {
    f = await createTenantFixture();
  });

  describe("read isolation", () => {
    it("each user sees only organizations they belong to", async () => {
      const ids = async (user: Fixture["ownerA"]) =>
        (await asUser(user, (tx) => tx.select({ id: organizations.id }).from(organizations)))
          .map((r) => r.id)
          .sort();
      expect(await ids(f.ownerA)).toEqual([f.orgA, f.orgX].sort());
      expect(await ids(f.ownerB)).toEqual([f.orgB]);
      expect(await ids(f.staffS)).toEqual([f.orgA]);
      expect(await ids(f.userC)).toEqual([]);
    });

    it("memberships are visible only within the user's organizations", async () => {
      const rows = await asUser(f.ownerB, (tx) => tx.select().from(memberships));
      expect(rows.map((r) => r.organizationId)).toEqual([f.orgB]);
      expect(await asUser(f.userC, (tx) => tx.select().from(memberships))).toEqual([]);
    });

    it("filtering by another organization's id returns nothing (organization_id in the query is not trusted)", async () => {
      const rows = await asUser(f.ownerA, (tx) =>
        tx.select().from(organizations).where(eq(organizations.id, f.orgB)),
      );
      expect(rows).toEqual([]);
    });
  });

  describe("write isolation", () => {
    it("cannot update another organization (0 rows, data unchanged)", async () => {
      const updated = await asUser(f.ownerA, (tx) =>
        tx
          .update(organizations)
          .set({ name: "Hacked" })
          .where(eq(organizations.id, f.orgB))
          .returning({ id: organizations.id }),
      );
      expect(updated).toEqual([]);
      const [b] = await asUser(f.ownerB, (tx) => tx.select().from(organizations));
      expect(b?.name).toBe("Company B");
    });

    it("cannot change country or currency after creation (column privileges)", async () => {
      await expectPgError(
        asUser(f.ownerA, (tx) =>
          tx.update(organizations).set({ currency: "USD" }).where(eq(organizations.id, f.orgA)),
        ),
        "42501",
      );
      await expectPgError(
        asUser(f.ownerA, (tx) =>
          tx.update(organizations).set({ countryCode: "RO" }).where(eq(organizations.id, f.orgA)),
        ),
        "42501",
      );
    });

    it("cannot move a membership to another organization", async () => {
      await expectPgError(
        asUser(f.ownerA, (tx) =>
          tx
            .update(memberships)
            .set({ organizationId: f.orgB })
            .where(eq(memberships.userId, f.staffS)),
        ),
        "42501",
      );
    });

    it("cannot delete memberships of another organization", async () => {
      const deleted = await asUser(f.ownerA, (tx) =>
        tx
          .delete(memberships)
          .where(eq(memberships.organizationId, f.orgB))
          .returning({ userId: memberships.userId }),
      );
      expect(deleted).toEqual([]);
    });

    it("a user without membership cannot write anything", async () => {
      const updated = await asUser(f.userC, (tx) =>
        tx.update(organizations).set({ name: "X" }).returning({ id: organizations.id }),
      );
      expect(updated).toEqual([]);
      await expectPgError(
        asUser(f.userC, (tx) =>
          tx.execute(
            sql`insert into app.memberships (organization_id, user_id, role) values (${f.orgA}, ${f.userC}, 'owner')`,
          ),
        ),
        "42501",
      );
    });
  });

  describe("roles", () => {
    it("staff cannot update organization settings", async () => {
      const updated = await asUser(f.staffS, (tx) =>
        tx
          .update(organizations)
          .set({ name: "Staff Edit" })
          .where(eq(organizations.id, f.orgA))
          .returning({ id: organizations.id }),
      );
      expect(updated).toEqual([]);
    });

    it("staff cannot promote themselves", async () => {
      const updated = await asUser(f.staffS, (tx) =>
        tx
          .update(memberships)
          .set({ role: "admin" })
          .where(eq(memberships.userId, f.staffS))
          .returning({ userId: memberships.userId }),
      );
      expect(updated).toEqual([]);
    });

    it("admin can manage non-owner members", async () => {
      const staff = await createTestUser();
      await addMember(f.orgA, staff, "staff");
      const promoted = await asUser(f.adminD, (tx) =>
        tx
          .update(memberships)
          .set({ role: "admin" })
          .where(
            sql`${memberships.userId} = ${staff} and ${memberships.organizationId} = ${f.orgA}`,
          )
          .returning({ role: memberships.role }),
      );
      expect(promoted).toEqual([{ role: "admin" }]);
    });

    it("admin cannot grant ownership", async () => {
      await expectPgError(
        asUser(f.adminD, (tx) =>
          tx
            .update(memberships)
            .set({ role: "owner" })
            .where(
              sql`${memberships.userId} = ${f.staffS} and ${memberships.organizationId} = ${f.orgA}`,
            ),
        ),
        "42501",
      );
    });

    it("admin cannot change or remove an owner", async () => {
      const demoted = await asUser(f.adminD, (tx) =>
        tx
          .update(memberships)
          .set({ role: "staff" })
          .where(
            sql`${memberships.userId} = ${f.ownerA} and ${memberships.organizationId} = ${f.orgA}`,
          )
          .returning({ role: memberships.role }),
      );
      expect(demoted).toEqual([]);
      const removed = await asUser(f.adminD, (tx) =>
        tx
          .delete(memberships)
          .where(
            sql`${memberships.userId} = ${f.ownerA} and ${memberships.organizationId} = ${f.orgA}`,
          )
          .returning({ userId: memberships.userId }),
      );
      expect(removed).toEqual([]);
    });

    it("owner can transfer ownership and then leave", async () => {
      const owner = await createTestUser();
      const successor = await createTestUser();
      const { createOrganizationAs } = await import("./fixtures");
      const org = await createOrganizationAs(owner);
      await addMember(org, successor, "admin");

      await asUser(owner, (tx) =>
        tx
          .update(memberships)
          .set({ role: "owner" })
          .where(
            sql`${memberships.userId} = ${successor} and ${memberships.organizationId} = ${org}`,
          ),
      );
      const left = await asUser(owner, (tx) =>
        tx
          .delete(memberships)
          .where(sql`${memberships.userId} = ${owner} and ${memberships.organizationId} = ${org}`)
          .returning({ userId: memberships.userId }),
      );
      expect(left).toHaveLength(1);
    });
  });

  describe("profiles: visible only to the user and their colleagues", () => {
    const visibleProfiles = async (user: Fixture["ownerA"]) =>
      (await asUser(user, (tx) => tx.select({ id: profiles.userId }).from(profiles)))
        .map((r) => r.id)
        .sort();

    it("owner A sees self and colleagues from both of A's organizations, nobody else", async () => {
      const visible = await visibleProfiles(f.ownerA);
      expect(visible).toEqual(expect.arrayContaining([f.ownerA, f.adminD, f.staffS, f.ownerX]));
      expect(visible).not.toContain(f.ownerB);
      expect(visible).not.toContain(f.userC);
    });

    it("a user without memberships sees only their own profile", async () => {
      expect(await visibleProfiles(f.userC)).toEqual([f.userC]);
    });

    it("staff in org A cannot see org X members (A's other organization)", async () => {
      expect(await visibleProfiles(f.staffS)).not.toContain(f.ownerX);
    });

    it("visibility ends when the shared membership ends", async () => {
      const colleague = await createTestUser();
      await addMember(f.orgB, colleague, "staff");
      expect(await visibleProfiles(f.ownerB)).toContain(colleague);
      await asUser(f.ownerB, (tx) =>
        tx.delete(memberships).where(sql`${memberships.userId} = ${colleague}`),
      );
      expect(await visibleProfiles(f.ownerB)).not.toContain(colleague);
    });

    it("users can update only their own profile", async () => {
      const own = await asUser(f.staffS, (tx) =>
        tx.update(profiles).set({ fullName: "Staff Renamed" }).returning({ id: profiles.userId }),
      );
      expect(own).toEqual([{ id: f.staffS }]);
      const others = await asUser(f.ownerA, (tx) =>
        tx
          .update(profiles)
          .set({ fullName: "Renamed by owner" })
          .where(eq(profiles.userId, f.staffS))
          .returning({ id: profiles.userId }),
      );
      expect(others).toEqual([]);
    });

    it("the new-user trigger sanitizes the user-controlled display name", async () => {
      const user = await createTestUser("  Ivan\u0007 Petrov\u0000  ".replace("\u0000", ""));
      const [row] = await adminSql<{ full_name: string }[]>`
        select full_name from app.profiles where user_id = ${user}`;
      expect(row?.full_name).toBe("Ivan Petrov");
    });
  });
});
