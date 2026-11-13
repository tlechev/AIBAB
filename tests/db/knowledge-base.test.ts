import { randomUUID } from "node:crypto";

import { sql, type SQL } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import type { UserTx } from "@/server/db/user-tx";

import { createTenantFixture } from "./fixtures";
import { adminSql, asUser, expectPgError } from "./helpers";

type Fixture = Awaited<ReturnType<typeof createTenantFixture>>;

let slot = 0;
/** Non-overlapping 5-minute business-hours slots on Mondays. */
function nextSlot(): { opens: string; closes: string } {
  const start = (slot++ % 280) * 5;
  const fmt = (m: number) =>
    `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  return { opens: fmt(start), closes: fmt(start + 5) };
}

type TableSpec = { table: string; insertRow: (organizationId: string) => SQL };

const tables: TableSpec[] = [
  {
    table: "services",
    insertRow: (org) =>
      sql`insert into app.services (organization_id, name, price_from_cents, price_to_cents)
          values (${org}, ${`Service ${randomUUID()}`}, 5000, 12000) returning id`,
  },
  {
    table: "faq_entries",
    insertRow: (org) =>
      sql`insert into app.faq_entries (organization_id, question, answer)
          values (${org}, ${`Question ${randomUUID()}?`}, 'Answer') returning id`,
  },
  {
    table: "service_areas",
    insertRow: (org) =>
      sql`insert into app.service_areas (organization_id, name)
          values (${org}, ${`Area ${randomUUID()}`}) returning id`,
  },
  {
    table: "business_hours",
    insertRow: (org) => {
      const { opens, closes } = nextSlot();
      return sql`insert into app.business_hours (organization_id, weekday, opens_at, closes_at)
                 values (${org}, 1, ${opens}, ${closes}) returning id`;
    },
  },
];

async function insert(tx: UserTx, spec: TableSpec, org: string): Promise<string> {
  const rows = await tx.execute<{ id: string }>(spec.insertRow(org));
  return rows[0]!.id;
}
const t = (name: string) => sql.raw(`app.${name}`);
const ids = (tx: UserTx, name: string) =>
  tx.execute<{ id: string }>(sql`select id from ${t(name)}`).then((r) => r.map((x) => x.id));
const touch = (tx: UserTx, name: string, id: string) =>
  tx
    .execute<{ id: string }>(
      sql`update ${t(name)} set updated_at = now() where id = ${id} returning id`,
    )
    .then((r) => r.length);
const remove = (tx: UserTx, name: string, id: string) =>
  tx
    .execute<{ id: string }>(sql`delete from ${t(name)} where id = ${id} returning id`)
    .then((r) => r.length);

describe.each(tables)("tenant isolation matrix: $table", (spec) => {
  let f: Fixture;
  let rowA: string;

  beforeAll(async () => {
    f = await createTenantFixture();
    rowA = await asUser(f.ownerA, (tx) => insert(tx, spec, f.orgA));
  });

  it("owner and admin can create rows in their organization", async () => {
    expect(rowA).toMatch(/^[0-9a-f-]{36}$/);
    const byAdmin = await asUser(f.adminD, (tx) => insert(tx, spec, f.orgA));
    expect(byAdmin).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("staff can read but cannot create, update or delete", async () => {
    expect(await asUser(f.staffS, (tx) => ids(tx, spec.table))).toContain(rowA);
    await expectPgError(
      asUser(f.staffS, (tx) => insert(tx, spec, f.orgA)),
      "42501",
    );
    expect(await asUser(f.staffS, (tx) => touch(tx, spec.table, rowA))).toBe(0);
    expect(await asUser(f.staffS, (tx) => remove(tx, spec.table, rowA))).toBe(0);
  });

  it("another tenant cannot read, create in, update or delete organization A's data", async () => {
    expect(await asUser(f.ownerB, (tx) => ids(tx, spec.table))).not.toContain(rowA);
    await expectPgError(
      asUser(f.ownerB, (tx) => insert(tx, spec, f.orgA)),
      "42501",
    );
    expect(await asUser(f.ownerB, (tx) => touch(tx, spec.table, rowA))).toBe(0);
    expect(await asUser(f.ownerB, (tx) => remove(tx, spec.table, rowA))).toBe(0);
    const [still] = await adminSql.unsafe<{ n: number }[]>(
      `select count(*)::int as n from app.${spec.table} where id = $1`,
      [rowA],
    );
    expect(still?.n).toBe(1);
  });

  it("a user without membership sees nothing and cannot write", async () => {
    expect(await asUser(f.userC, (tx) => ids(tx, spec.table))).toEqual([]);
    await expectPgError(
      asUser(f.userC, (tx) => insert(tx, spec, f.orgA)),
      "42501",
    );
  });

  it("rows cannot be moved to another organization, even one the user administers", async () => {
    // ownerA is an admin of org X, so RLS alone would allow the target; the trigger forbids it.
    await expectPgError(
      asUser(f.ownerA, (tx) =>
        tx.execute(sql`update ${t(spec.table)} set organization_id = ${f.orgX} where id = ${rowA}`),
      ),
      "42501",
    );
  });

  it("client-supplied created_at is ignored", async () => {
    const [row] = await adminSql.unsafe<{ age_seconds: number }[]>(
      `select extract(epoch from now() - created_at)::int as age_seconds from app.${spec.table} where id = $1`,
      [rowA],
    );
    expect(row?.age_seconds).toBeLessThan(300);
  });
});

describe("composite foreign keys: faq_entries → services", () => {
  let f: Fixture;
  let serviceA: string;

  beforeAll(async () => {
    f = await createTenantFixture();
    serviceA = await asUser(f.ownerA, (tx) => insert(tx, tables[0]!, f.orgA));
  });

  it("an FAQ in org X cannot reference a service of org A, even for a member of both", async () => {
    await expectPgError(
      asUser(f.ownerA, (tx) =>
        tx.execute(sql`insert into app.faq_entries (organization_id, question, answer, service_id)
                       values (${f.orgX}, 'Cross-tenant?', 'No', ${serviceA})`),
      ),
      "23503",
    );
  });

  it("the composite FK holds even when RLS is bypassed", async () => {
    await expectPgError(
      adminSql`insert into app.faq_entries (organization_id, question, answer, service_id)
               values (${f.orgB}, 'Cross-tenant?', 'No', ${serviceA})`,
      "23503",
    );
  });

  it("deleting a service clears service_id but keeps organization_id", async () => {
    const service = await asUser(f.ownerA, (tx) => insert(tx, tables[0]!, f.orgA));
    const [faq] = await asUser(f.ownerA, (tx) =>
      tx.execute<{
        id: string;
      }>(sql`insert into app.faq_entries (organization_id, question, answer, service_id)
                                      values (${f.orgA}, 'Linked?', 'Yes', ${service}) returning id`),
    );
    await asUser(f.ownerA, (tx) => tx.execute(sql`delete from app.services where id = ${service}`));
    const [row] = await adminSql<{ organization_id: string; service_id: string | null }[]>`
      select organization_id, service_id from app.faq_entries where id = ${faq!.id}`;
    expect(row).toEqual({ organization_id: f.orgA, service_id: null });
  });
});

describe("services validation", () => {
  let f: Fixture;
  beforeAll(async () => {
    f = await createTenantFixture();
  });

  const invalid: Array<[string, SQL]> = [
    ["negative price", sql`-1, null`],
    ["upper bound below lower bound", sql`5000, 1000`],
    ["upper bound without lower bound", sql`null, 1000`],
  ];
  it.each(invalid)("rejects %s", async (_label, prices) => {
    await expectPgError(
      asUser(f.ownerA, (tx) =>
        tx.execute(sql`insert into app.services (organization_id, name, price_from_cents, price_to_cents)
                       values (${f.orgA}, ${`S ${randomUUID()}`}, ${prices})`),
      ),
      "23514",
    );
  });

  it("rejects duplicate names within an organization (case-insensitive)", async () => {
    await asUser(f.ownerA, (tx) =>
      tx.execute(
        sql`insert into app.services (organization_id, name) values (${f.orgA}, 'Montage')`,
      ),
    );
    await expectPgError(
      asUser(f.ownerA, (tx) =>
        tx.execute(
          sql`insert into app.services (organization_id, name) values (${f.orgA}, 'montage')`,
        ),
      ),
      "23505",
    );
    // The same name is fine in another organization.
    await asUser(f.ownerB, (tx) =>
      tx.execute(
        sql`insert into app.services (organization_id, name) values (${f.orgB}, 'Montage')`,
      ),
    );
  });
});
