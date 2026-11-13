import { boolean, integer, jsonb, text, timestamp, uuid } from "drizzle-orm/pg-core";

import type { TimeWindow } from "@/lib/booking/time-windows";

import { app } from "./app-schema";
import { organizations } from "./organizations";

export const slotMode = app.enum("slot_mode", ["time_window", "exact_time"]);
export const assistantTone = app.enum("assistant_tone", ["formal", "friendly"]);

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
};

export const bookingSettings = app.table("booking_settings", {
  organizationId: uuid("organization_id")
    .primaryKey()
    .references(() => organizations.id, { onDelete: "cascade" }),
  slotMode: slotMode("slot_mode").notNull().default("time_window"),
  /** Validated by `timeWindowsSchema` (app) and `app_private.is_valid_time_windows` (DB). */
  timeWindows: jsonb("time_windows").$type<TimeWindow[]>().notNull().default([]),
  capacityPerSlot: integer("capacity_per_slot").notNull().default(1),
  minNoticeHours: integer("min_notice_hours").notNull().default(2),
  maxDaysAhead: integer("max_days_ahead").notNull().default(30),
  autoConfirmAppointments: boolean("auto_confirm_appointments").notNull().default(false),
  ...timestamps,
});

export const assistantProfiles = app.table("assistant_profiles", {
  organizationId: uuid("organization_id")
    .primaryKey()
    .references(() => organizations.id, { onDelete: "cascade" }),
  assistantName: text("assistant_name").notNull(),
  greeting: text("greeting"),
  tone: assistantTone("tone").notNull().default("friendly"),
  customInstructions: text("custom_instructions"),
  handoffKeywords: text("handoff_keywords").array().notNull().default([]),
  handoffOutsideBusinessHours: boolean("handoff_outside_business_hours").notNull().default(true),
  isEnabled: boolean("is_enabled").notNull().default(false),
  ...timestamps,
});
