/** UI languages with a complete message catalog in `/messages`. */
export const locales = ["bg", "en"] as const;
export type Locale = (typeof locales)[number];

/**
 * Platform fallbacks for the UI only, chosen for the initial (Bulgarian) market.
 * Business logic must not read these: per-user / per-organization regional
 * settings take precedence once they exist (ADR-006).
 */
export const defaultLocale: Locale = "bg";
export const defaultTimeZone = "Europe/Sofia";

export function isLocale(value: string): value is Locale {
  return (locales as readonly string[]).includes(value);
}
