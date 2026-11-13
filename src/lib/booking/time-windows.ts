import { z } from "zod";

/**
 * Booking time windows in the organization's local time (D3, section 6 of
 * ARCHITECTURE.md). A window never crosses midnight; "24:00" is a valid end.
 * Mirrors `app_private.is_valid_time_windows` in the database; both are tested
 * against the same cases (tests/shared/time-windows-cases.ts).
 */
const startPattern = /^([01]\d|2[0-3]):[0-5]\d$/;
const endPattern = /^(([01]\d|2[0-3]):[0-5]\d|24:00)$/;

export const MAX_TIME_WINDOWS = 12;

/** Minutes since local midnight; "24:00" → 1440. */
export function toMinutes(hhmm: string): number {
  const [hours = 0, minutes = 0] = hhmm.split(":").map(Number);
  return hours * 60 + minutes;
}

export const timeWindowSchema = z.strictObject({
  start: z.string().regex(startPattern),
  end: z.string().regex(endPattern),
});

export type TimeWindow = z.infer<typeof timeWindowSchema>;

export const timeWindowsSchema = z
  .array(timeWindowSchema)
  .max(MAX_TIME_WINDOWS)
  .superRefine((windows, ctx) => {
    windows.forEach((window, index) => {
      if (toMinutes(window.start) >= toMinutes(window.end)) {
        ctx.addIssue({ code: "custom", path: [index], message: "start must be before end" });
      }
      const previous = windows[index - 1];
      if (previous && toMinutes(window.start) < toMinutes(previous.end)) {
        ctx.addIssue({
          code: "custom",
          path: [index],
          message: "windows must be sorted and must not overlap",
        });
      }
    });
  });
