import "server-only";

import { sql } from "drizzle-orm";

import type { UserTx } from "./user-tx";

export type InvitableRole = "admin" | "staff";

export type CreatedInvitation = {
  invitationId: string;
  /**
   * Plaintext invitation token. Returned exactly once; only its SHA-256 is stored.
   * Deliver it to the invitee (e.g. in a link) and never log or persist it.
   */
  token: string;
};

/**
 * Creates an invitation through `app.create_invitation()`, the only creation path.
 * The token is generated inside the database; the caller can neither choose nor
 * read its hash. Authorization (owner/admin of the organization) is enforced in
 * the database for the user of the surrounding `withUserTx` transaction.
 */
export async function createInvitation(
  tx: UserTx,
  input: { organizationId: string; email: string; role: InvitableRole; expiresInDays?: number },
): Promise<CreatedInvitation> {
  const rows = await tx.execute<{ invitation_id: string; token: string }>(sql`
    select invitation_id, token
    from app.create_invitation(
      ${input.organizationId}::uuid, ${input.email}, ${input.role}::app.member_role,
      ${input.expiresInDays ?? 7}::integer)`);
  const row = rows[0];
  if (!row) throw new Error("create_invitation returned no row");
  return { invitationId: row.invitation_id, token: row.token };
}
