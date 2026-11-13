import "server-only";

import { parseEnv, serverEnvSchema, type ServerEnv } from "./env";

let cached: ServerEnv | undefined;

/** Validated server environment. Throws on first access if anything is missing. */
export function serverEnv(): ServerEnv {
  cached ??= parseEnv(serverEnvSchema, process.env);
  return cached;
}
