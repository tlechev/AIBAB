import { index, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { authUsers } from "drizzle-orm/supabase";

import { app } from "./app-schema";

export const industry = app.enum("industry", [
  "hvac",
  "plumbing_electrical",
  "renovation",
  "other",
]);

export const memberRole = app.enum("member_role", ["owner", "admin", "staff"]);

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
};

export const organizations = app.table("organizations", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique("organizations_slug_key"),
  industry: industry("industry").notNull(),
  countryCode: text("country_code").notNull(),
  defaultLocale: text("default_locale").notNull(),
  timezone: text("timezone").notNull(),
  currency: text("currency").notNull(),
  registrationNumber: text("registration_number"),
  phone: text("phone"),
  email: text("email"),
  website: text("website"),
  addressLine: text("address_line"),
  city: text("city"),
  postalCode: text("postal_code"),
  ...timestamps,
});

export const profiles = app.table("profiles", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => authUsers.id, { onDelete: "cascade" }),
  fullName: text("full_name"),
  locale: text("locale"),
  ...timestamps,
});

export const memberships = app.table(
  "memberships",
  {
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => profiles.userId, { onDelete: "cascade" }),
    role: memberRole("role").notNull(),
    ...timestamps,
  },
  (table) => [
    primaryKey({ name: "memberships_pkey", columns: [table.organizationId, table.userId] }),
    index("memberships_user_id_idx").on(table.userId),
  ],
);
