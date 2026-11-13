import { foreignKey, index, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

import { app } from "./app-schema";
import { memberRole, memberships, organizations } from "./organizations";

export const invitations = app.table(
  "invitations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: memberRole("role").notNull(),
    /**
     * SHA-256 (hex) of the invitation token; the token itself is never stored.
     * Not readable or writable by `aibab_user` — never select this column in app code.
     */
    tokenHash: text("token_hash").notNull().unique("invitations_token_hash_key"),
    invitedBy: uuid("invited_by").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("invitations_organization_id_id_key").on(table.organizationId, table.id),
    foreignKey({
      name: "invitations_invited_by_fkey",
      columns: [table.organizationId, table.invitedBy],
      foreignColumns: [memberships.organizationId, memberships.userId],
    }).onDelete("cascade"),
    index("invitations_invited_by_idx").on(table.organizationId, table.invitedBy),
  ],
);

/**
 * The invitation columns `aibab_user` may read (everything except `token_hash`).
 * Use with `tx.select(invitationColumns)` / `.returning(invitationColumns)`;
 * `select()` without columns would request `token_hash` and fail with 42501.
 */
export const invitationColumns = {
  id: invitations.id,
  organizationId: invitations.organizationId,
  email: invitations.email,
  role: invitations.role,
  invitedBy: invitations.invitedBy,
  expiresAt: invitations.expiresAt,
  acceptedAt: invitations.acceptedAt,
  revokedAt: invitations.revokedAt,
  createdAt: invitations.createdAt,
  updatedAt: invitations.updatedAt,
};
