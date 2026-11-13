import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import type { VerifiedUserId } from "@/server/auth/verified-user-id";

import { createOrganizationAs } from "./fixtures";
import { adminSql, asUser, createTestUser, expectPgError, pgCode } from "./helpers";

/** Real PostgreSQL behavior of `time`, '24:00' and the exclusion constraint. */
describe("business_hours", () => {
  let owner: VerifiedUserId;
  let org: string;

  const add = (weekday: number, opens: string, closes: string, organizationId = org) =>
    asUser(owner, (tx) =>
      tx.execute<{ opens_at: string; closes_at: string }>(sql`
        insert into app.business_hours (organization_id, weekday, opens_at, closes_at)
        values (${organizationId}, ${weekday}, ${opens}, ${closes})
        returning opens_at::text, closes_at::text`),
    );

  beforeAll(async () => {
    owner = await createTestUser();
    org = await createOrganizationAs(owner);
  });

  it("PostgreSQL accepts 24:00 as a time and orders it after 23:59", async () => {
    const [row] = await adminSql<{ t: string; later: boolean }[]>`
      select '24:00'::time::text as t, '24:00'::time > '23:59'::time as later`;
    expect(row).toEqual({ t: "24:00:00", later: true });
  });

  it("stores an interval ending at 24:00", async () => {
    const [row] = await add(1, "22:00", "24:00");
    expect(row).toEqual({ opens_at: "22:00:00", closes_at: "24:00:00" });
  });

  it("rejects an interval overlapping the end of the day (exclusion 23P01)", async () => {
    await expectPgError(add(1, "23:30", "24:00"), "23P01");
  });

  it("allows touching intervals (lunch break pattern)", async () => {
    await add(2, "09:00", "12:00");
    await add(2, "13:00", "17:00");
    await add(2, "12:00", "13:00");
  });

  it.each([
    ["partial overlap", "11:00", "14:00"],
    ["contained interval", "10:00", "11:00"],
    ["containing interval", "08:00", "18:00"],
    ["identical interval", "09:00", "12:00"],
  ])("rejects %s (23P01)", async (_label, opens, closes) => {
    await expectPgError(add(2, opens, closes), "23P01");
  });

  it("the same hours are fine on another weekday and in another organization", async () => {
    await add(3, "09:00", "12:00");
    const other = await createOrganizationAs(owner);
    await add(2, "09:00", "12:00", other);
  });

  it.each([
    ["empty interval", 4, "10:00", "10:00", "23514"],
    ["interval crossing midnight", 4, "22:00", "02:00", "23514"],
    ["start at 24:00", 4, "24:00", "24:00", "23514"],
    ["weekday 0", 0, "09:00", "10:00", "23514"],
    ["weekday 8", 8, "09:00", "10:00", "23514"],
  ] as const)("rejects %s (%s)", async (_label, weekday, opens, closes, code) => {
    await expectPgError(add(weekday, opens, closes), code);
  });

  it("rejects hours beyond 24:00 at the type level (22008)", async () => {
    await expectPgError(add(4, "23:00", "24:30"), "22008");
  });

  it("models overnight work as two rows on consecutive days", async () => {
    await add(5, "22:00", "24:00");
    await add(6, "00:00", "02:00");
  });

  it("is safe under concurrency: of two parallel overlapping inserts exactly one succeeds", async () => {
    const results = await Promise.allSettled([add(7, "09:00", "12:00"), add(7, "10:00", "13:00")]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(pgCode(rejected.reason)).toBe("23P01");
  });
});
