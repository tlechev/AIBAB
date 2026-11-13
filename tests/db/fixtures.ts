import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";

import type { VerifiedUserId } from "@/server/auth/verified-user-id";

import { adminSql, asUser, createTestUser } from "./helpers";

export type OrganizationInput = {
  name: string;
  slug: string;
  industry: string;
  countryCode: string;
  defaultLocale: string;
  timezone: string;
  currency: string;
  assistantName: string;
};

export function uniqueSlug(prefix = "org"): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

export function organizationInput(overrides: Partial<OrganizationInput> = {}): OrganizationInput {
  return {
    name: "Test Company",
    slug: uniqueSlug(),
    industry: "hvac",
    countryCode: "BG",
    defaultLocale: "bg",
    timezone: "Europe/Sofia",
    currency: "EUR",
    assistantName: "Ana",
    ...overrides,
  };
}

/** Calls app.create_organization() as `userId`, exactly like the app will. */
export async function createOrganizationAs(
  userId: VerifiedUserId,
  overrides: Partial<OrganizationInput> = {},
): Promise<string> {
  const input = organizationInput(overrides);
  return asUser(userId, async (tx) => {
    const rows = await tx.execute<{ id: string }>(sql`
      select app.create_organization(
        ${input.name}, ${input.slug}, ${input.industry}::app.industry, ${input.countryCode},
        ${input.defaultLocale}, ${input.timezone}, ${input.currency}, ${input.assistantName}) as id`);
    return rows[0]!.id;
  });
}

/**
 * Adds a membership directly (test setup only). In the app, memberships are
 * created by SECURITY DEFINER functions (invitation acceptance, task 3/5).
 */
export async function addMember(
  organizationId: string,
  userId: string,
  role: "owner" | "admin" | "staff",
): Promise<void> {
  await adminSql`
    insert into app.memberships (organization_id, user_id, role)
    values (${organizationId}, ${userId}, ${role}::app.member_role)`;
}

/**
 * Two tenants plus edge-case users:
 *   owner A (org A), admin D and staff S in org A,
 *   owner B (org B), user C without any membership,
 *   owner X (org X) where A is also an admin (A belongs to two organizations).
 */
export async function createTenantFixture() {
  const [ownerA, adminD, staffS, ownerB, userC, ownerX] = await Promise.all([
    createTestUser("Owner A"),
    createTestUser("Admin D"),
    createTestUser("Staff S"),
    createTestUser("Owner B"),
    createTestUser("User C"),
    createTestUser("Owner X"),
  ]);
  const orgA = await createOrganizationAs(ownerA, { name: "Company A" });
  const orgB = await createOrganizationAs(ownerB, { name: "Company B" });
  const orgX = await createOrganizationAs(ownerX, { name: "Company X" });
  await addMember(orgA, adminD, "admin");
  await addMember(orgA, staffS, "staff");
  await addMember(orgX, ownerA, "admin");
  return { ownerA, adminD, staffS, ownerB, userC, ownerX, orgA, orgB, orgX };
}
