import { z } from "zod";

/**
 * Environment variables, safe to expose to the browser (NEXT_PUBLIC_*).
 * Next.js inlines NEXT_PUBLIC_* at build time, so they must be read via
 * static `process.env.NAME` access (see `readPublicEnv`).
 */
export const publicEnvSchema = z.object({
  NEXT_PUBLIC_APP_URL: z
    .url({ protocol: /^https?$/, error: "must be a valid http(s) URL" })
    .transform((value) => value.replace(/\/+$/, "")),
});

/** Server-only variables. Extended in later tasks (Supabase, Anthropic, ...). */
export const serverEnvSchema = publicEnvSchema.extend({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
});

export type PublicEnv = z.output<typeof publicEnvSchema>;
export type ServerEnv = z.output<typeof serverEnvSchema>;

type RawEnv = Record<string, string | undefined>;

/** Validates raw env values and fails fast with a readable message. */
export function parseEnv<TSchema extends z.ZodType>(
  schema: TSchema,
  raw: RawEnv,
): z.output<TSchema> {
  const result = schema.safeParse(raw);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid environment variables:\n${details}`);
  }
  return result.data;
}

export function readPublicEnv(): PublicEnv {
  return parseEnv(publicEnvSchema, {
    NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
  });
}
