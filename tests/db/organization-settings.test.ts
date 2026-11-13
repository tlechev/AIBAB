import { eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import type { TimeWindow } from "@/lib/booking/time-windows";
import { assistantProfiles, bookingSettings, organizations } from "@/server/db/schema";
import type { UserTx } from "@/server/db/user-tx";

import { invalidTimeWindows, validTimeWindows } from "../shared/time-windows-cases";
import { createTenantFixture } from "./fixtures";
import { asUser, expectPgError } from "./helpers";

type Fixture = Awaited<ReturnType<typeof createTenantFixture>>;

describe("organization settings", () => {
  let f: Fixture;
  beforeAll(async () => {
    f = await createTenantFixture();
  });

  type SettingsCase = {
    name: string;
    readOrgIds: (tx: UserTx) => Promise<string[]>;
    /** Updates the row of `organizationId` (or every visible row when omitted). */
    update: (tx: UserTx, organizationId?: string) => Promise<{ id: string }[]>;
  };

  const settingsCases: SettingsCase[] = [
    {
      name: "booking_settings",
      readOrgIds: async (tx) =>
        (await tx.select().from(bookingSettings)).map((r) => r.organizationId),
      update: (tx, organizationId) =>
        tx
          .update(bookingSettings)
          .set({ capacityPerSlot: 3 })
          .where(organizationId ? eq(bookingSettings.organizationId, organizationId) : undefined)
          .returning({ id: bookingSettings.organizationId }),
    },
    {
      name: "assistant_profiles",
      readOrgIds: async (tx) =>
        (await tx.select().from(assistantProfiles)).map((r) => r.organizationId),
      update: (tx, organizationId) =>
        tx
          .update(assistantProfiles)
          .set({ greeting: "Здравейте!" })
          .where(organizationId ? eq(assistantProfiles.organizationId, organizationId) : undefined)
          .returning({ id: assistantProfiles.organizationId }),
    },
  ];

  describe.each(settingsCases)("$name", ({ name, readOrgIds, update }) => {
    it("members read only their organization's row", async () => {
      expect(await asUser(f.staffS, readOrgIds)).toEqual([f.orgA]);
      expect(await asUser(f.userC, readOrgIds)).toEqual([]);
    });

    it("staff cannot update; admins can", async () => {
      expect(await asUser(f.staffS, (tx) => update(tx))).toEqual([]);
      expect(await asUser(f.adminD, (tx) => update(tx, f.orgA))).toEqual([{ id: f.orgA }]);
    });

    it("another tenant cannot update organization A's row", async () => {
      expect(await asUser(f.ownerB, (tx) => update(tx, f.orgA))).toEqual([]);
    });

    it("rows cannot be inserted or deleted directly", async () => {
      await expectPgError(
        asUser(f.ownerA, (tx) =>
          tx.execute(
            sql`insert into ${sql.raw(`app.${name}`)} (organization_id) values (${f.orgA})`,
          ),
        ),
        "42501",
      );
      await expectPgError(
        asUser(f.ownerA, (tx) =>
          tx.execute(sql`delete from ${sql.raw(`app.${name}`)} where organization_id = ${f.orgA}`),
        ),
        "42501",
      );
    });
  });

  describe("time_windows: database CHECK matches the app's Zod schema", () => {
    const setWindows = (value: unknown) =>
      asUser(f.ownerA, (tx) =>
        tx
          .update(bookingSettings)
          .set({ timeWindows: value as TimeWindow[] })
          .where(eq(bookingSettings.organizationId, f.orgA))
          .returning({ windows: bookingSettings.timeWindows }),
      );

    it.each(validTimeWindows)("accepts %s", async (_label, value) => {
      const [row] = await setWindows(value);
      expect(row?.windows).toEqual(value);
    });

    it.each(invalidTimeWindows)("rejects %s", async (_label, value) => {
      await expectPgError(setWindows(value), "23514");
    });
  });

  describe("other validation", () => {
    it("rejects an invalid organization time zone on update (22023)", async () => {
      await expectPgError(
        asUser(f.ownerA, (tx) =>
          tx
            .update(organizations)
            .set({ timezone: "Europe/Atlantis" })
            .where(eq(organizations.id, f.orgA)),
        ),
        "22023",
      );
      const [row] = await asUser(f.ownerA, (tx) =>
        tx
          .update(organizations)
          .set({ timezone: "Europe/Bucharest" })
          .where(eq(organizations.id, f.orgA))
          .returning({ timezone: organizations.timezone }),
      );
      expect(row?.timezone).toBe("Europe/Bucharest");
    });

    it.each([
      ["more than 50 handoff keywords", sql`array_fill('k'::text, array[51])`],
      ["a null handoff keyword", sql`array['human', null]::text[]`],
    ])("rejects %s", async (_label, keywords) => {
      await expectPgError(
        asUser(f.ownerA, (tx) =>
          tx.execute(sql`update app.assistant_profiles set handoff_keywords = ${keywords}
                         where organization_id = ${f.orgA}`),
        ),
        "23514",
      );
    });

    it("rejects custom instructions over 4000 characters", async () => {
      await expectPgError(
        asUser(f.ownerA, (tx) =>
          tx
            .update(assistantProfiles)
            .set({ customInstructions: "x".repeat(4001) })
            .where(eq(assistantProfiles.organizationId, f.orgA)),
        ),
        "23514",
      );
    });

    it.each([
      ["capacity 0", { capacityPerSlot: 0 }],
      ["negative notice", { minNoticeHours: -1 }],
      ["booking horizon over a year", { maxDaysAhead: 366 }],
    ])("rejects booking settings with %s", async (_label, change) => {
      await expectPgError(
        asUser(f.ownerA, (tx) =>
          tx.update(bookingSettings).set(change).where(eq(bookingSettings.organizationId, f.orgA)),
        ),
        "23514",
      );
    });
  });
});
