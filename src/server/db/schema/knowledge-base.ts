import {
  boolean,
  foreignKey,
  index,
  integer,
  smallint,
  text,
  time,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

import { app } from "./app-schema";
import { organizations } from "./organizations";

export const priceUnit = app.enum("price_unit", [
  "job",
  "hour",
  "unit",
  "square_meter",
  "linear_meter",
]);

const tenantColumns = {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
};

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
};

export const services = app.table(
  "services",
  {
    ...tenantColumns,
    name: text("name").notNull(),
    description: text("description"),
    /** Integer cents in the organization's currency. */
    priceFromCents: integer("price_from_cents"),
    priceToCents: integer("price_to_cents"),
    priceUnit: priceUnit("price_unit").notNull().default("job"),
    durationMinutes: integer("duration_minutes"),
    requiresInspection: boolean("requires_inspection").notNull().default(false),
    isActive: boolean("is_active").notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    ...timestamps,
  },
  (table) => [unique("services_organization_id_id_key").on(table.organizationId, table.id)],
);

export const faqEntries = app.table(
  "faq_entries",
  {
    ...tenantColumns,
    question: text("question").notNull(),
    answer: text("answer").notNull(),
    serviceId: uuid("service_id"),
    isActive: boolean("is_active").notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    ...timestamps,
  },
  (table) => [
    unique("faq_entries_organization_id_id_key").on(table.organizationId, table.id),
    // ON DELETE SET NULL (service_id) is defined in SQL; Drizzle cannot express the column list.
    foreignKey({
      name: "faq_entries_service_fkey",
      columns: [table.organizationId, table.serviceId],
      foreignColumns: [services.organizationId, services.id],
    }),
    index("faq_entries_service_idx").on(table.organizationId, table.serviceId),
  ],
);

export const serviceAreas = app.table(
  "service_areas",
  {
    ...tenantColumns,
    name: text("name").notNull(),
    notes: text("notes"),
    isActive: boolean("is_active").notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    ...timestamps,
  },
  (table) => [unique("service_areas_organization_id_id_key").on(table.organizationId, table.id)],
);

/** Local wall-clock time in the organization's time zone; '24:00:00' is a valid end. */
export const businessHours = app.table(
  "business_hours",
  {
    ...tenantColumns,
    /** ISO weekday: 1 = Monday ... 7 = Sunday. */
    weekday: smallint("weekday").notNull(),
    opensAt: time("opens_at").notNull(),
    closesAt: time("closes_at").notNull(),
    ...timestamps,
  },
  (table) => [unique("business_hours_organization_id_id_key").on(table.organizationId, table.id)],
);
