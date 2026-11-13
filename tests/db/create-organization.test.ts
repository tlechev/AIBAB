import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { assistantProfiles, bookingSettings, memberships, organizations } from "@/server/db/schema";

import { createOrganizationAs, organizationInput, uniqueSlug } from "./fixtures";
import { adminSql, appSql, asUser, asVerified, createTestUser, expectPgError } from "./helpers";

describe("app.create_organization()", () => {
  it("creates the organization and makes the caller its owner", async () => {
    const user = await createTestUser();
    const slug = uniqueSlug("klima");
    const orgId = await createOrganizationAs(user, {
      name: "  Klima Pro  ",
      slug: ` ${slug.toUpperCase()} `,
    });

    const result = await asUser(user, async (tx) => ({
      orgs: await tx.select().from(organizations),
      members: await tx.select().from(memberships),
    }));
    expect(result.orgs).toHaveLength(1);
    expect(result.orgs[0]).toMatchObject({
      id: orgId,
      name: "Klima Pro",
      slug,
      countryCode: "BG",
      defaultLocale: "bg",
      timezone: "Europe/Sofia",
      currency: "EUR",
    });
    expect(result.members).toEqual([
      expect.objectContaining({ organizationId: orgId, userId: user, role: "owner" }),
    ]);
  });

  it("creates default booking settings and the assistant profile", async () => {
    const user = await createTestUser();
    const orgId = await createOrganizationAs(user, { assistantName: "  Мария  " });
    const settings = await asUser(user, async (tx) => ({
      booking: await tx.select().from(bookingSettings),
      assistant: await tx.select().from(assistantProfiles),
    }));
    expect(settings.booking).toEqual([
      expect.objectContaining({
        organizationId: orgId,
        slotMode: "time_window",
        timeWindows: [],
        capacityPerSlot: 1,
        autoConfirmAppointments: false,
      }),
    ]);
    expect(settings.assistant).toEqual([
      expect.objectContaining({ organizationId: orgId, assistantName: "Мария", isEnabled: false }),
    ]);
  });

  it("uses the transaction user, not a parameter: without a user context it is rejected", async () => {
    const client = appSql();
    try {
      await expectPgError(
        client.begin(async (tx) => {
          await tx`set local role aibab_user`;
          const i = organizationInput();
          return tx`select app.create_organization(${i.name}, ${i.slug}, 'hvac', 'BG', 'bg', 'Europe/Sofia', 'EUR', 'Ana')`;
        }),
        "42501",
      );
    } finally {
      await client.end();
    }
  });

  it("rejects a user id that does not exist in auth.users (no profile)", async () => {
    await expectPgError(
      createOrganizationAs(asVerified("00000000-0000-4000-8000-000000000001")),
      "23503",
    );
  });

  describe("database-level input validation", () => {
    let user: Awaited<ReturnType<typeof createTestUser>>;
    beforeAll(async () => {
      user = await createTestUser();
    });

    const cases: Array<[string, Parameters<typeof organizationInput>[0], string]> = [
      ["empty name", { name: "   " }, "23514"],
      ["name over 200 chars", { name: "x".repeat(201) }, "23514"],
      [
        "name with control characters",
        { name: "Bad\u0000Name".replace("\u0000", "\u0007") },
        "23514",
      ],
      ["slug too short", { slug: "ab" }, "23514"],
      ["slug with spaces", { slug: "bad slug" }, "23514"],
      ["slug with leading hyphen", { slug: "-bad" }, "23514"],
      ["slug with double hyphen", { slug: "bad--slug" }, "23514"],
      ["reserved slug", { slug: "admin" }, "23514"],
      ["country code with 3 letters", { countryCode: "BGR" }, "23514"],
      ["unsupported locale", { defaultLocale: "de" }, "23514"],
      ["unknown time zone", { timezone: "Mars/Olympus_Mons" }, "22023"],
      ["unsupported currency", { currency: "USD" }, "23514"],
      ["malformed currency", { currency: "EURO" }, "23514"],
      ["unknown industry", { industry: "bakery" }, "22P02"],
      ["empty assistant name", { assistantName: "  " }, "23514"],
      ["assistant name over 60 chars", { assistantName: "a".repeat(61) }, "23514"],
      ["assistant name with control characters", { assistantName: "Ana\u0007" }, "23514"],
    ];

    it.each(cases)("rejects %s", async (_label, overrides, code) => {
      await expectPgError(createOrganizationAs(user, overrides), code);
    });

    it("rejects a duplicate slug", async () => {
      const slug = uniqueSlug();
      await createOrganizationAs(user, { slug });
      const other = await createTestUser();
      await expectPgError(createOrganizationAs(other, { slug }), "23505");
    });

    it("is atomic: a failure in the last step leaves nothing behind", async () => {
      const fresh = await createTestUser();
      const slug = uniqueSlug("atomic");
      // The assistant profile is inserted last; the organization and membership must roll back too.
      await expectPgError(createOrganizationAs(fresh, { slug, assistantName: "" }), "23514");
      const [row] = await adminSql<{ orgs: number; members: number }[]>`
        select (select count(*)::int from app.organizations where slug = ${slug}) as orgs,
               (select count(*)::int from app.memberships where user_id = ${fresh}) as members`;
      expect(row).toEqual({ orgs: 0, members: 0 });
    });
  });

  describe("limit of 5 owned organizations", () => {
    it("rejects the 6th organization", async () => {
      const user = await createTestUser();
      for (let i = 0; i < 5; i++) await createOrganizationAs(user);
      await expectPgError(createOrganizationAs(user), "P0001");
    });

    it("holds under concurrent requests (exactly one of two parallel calls succeeds at 4 owned)", async () => {
      for (let round = 0; round < 3; round++) {
        const user = await createTestUser();
        for (let i = 0; i < 4; i++) await createOrganizationAs(user);
        const results = await Promise.allSettled([
          createOrganizationAs(user),
          createOrganizationAs(user),
          createOrganizationAs(user),
        ]);
        expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
        const [row] = await adminSql<{ n: number }[]>`
          select count(*)::int as n from app.memberships where user_id = ${user} and role = 'owner'`;
        expect(row?.n).toBe(5);
      }
    });
  });

  it("is not callable by Supabase API roles", async () => {
    const signature = "app.create_organization(text,text,app.industry,text,text,text,text,text)";
    const [row] = await adminSql<{ anon: boolean; auth: boolean; app: boolean; user: boolean }[]>`
      select
        has_function_privilege('anon', ${signature}, 'EXECUTE') as anon,
        has_function_privilege('authenticated', ${signature}, 'EXECUTE') as auth,
        has_function_privilege('aibab_app', ${signature}, 'EXECUTE') as app,
        has_function_privilege('aibab_user', ${signature}, 'EXECUTE') as user`;
    expect(row).toEqual({ anon: false, auth: false, app: false, user: true });
  });

  it("aibab_user cannot insert organizations or memberships directly", async () => {
    const user = await createTestUser();
    await expectPgError(
      asUser(user, (tx) =>
        tx.execute(sql`insert into app.organizations (name, slug, industry, country_code, default_locale, timezone, currency)
                       values ('X', ${uniqueSlug()}, 'hvac', 'BG', 'bg', 'Europe/Sofia', 'EUR')`),
      ),
      "42501",
    );
  });
});
