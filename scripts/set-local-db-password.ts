/**
 * LOCAL DEVELOPMENT ONLY — sets the password of the `aibab_app` role in the
 * local Supabase database (Docker), using the password in DATABASE_URL.
 *
 * Why a script and not seed.sql: seed files can be pushed to hosted projects
 * (`supabase db push --include-seed`). This script is not part of migrations or
 * seeds, so no Supabase CLI command can apply it to a hosted database.
 *
 * Safety properties:
 *   - Runs only against the local Supabase container: loopback host, the port
 *     Docker publishes for `supabase_db_<project_id>`, and proof that the admin
 *     connection's backend process lives inside that container.
 *   - The password is read from DATABASE_URL (environment or .env.local), never
 *     from command-line arguments (no shell history).
 *   - Only a SCRAM-SHA-256 verifier computed locally is sent to the server, so
 *     the password never appears in server logs. Nothing secret is printed.
 *   - If DATABASE_URL still contains the placeholder from .env.example, a random
 *     password is generated and written to .env.local (gitignored).
 *
 * Usage: npm run db:local-password (also run by db:start and db:reset).
 */
import { execFileSync } from "node:child_process";
import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import postgres from "postgres";

export const PLACEHOLDER = "CHANGE_ME_LOCAL_ONLY";
const ENV_FILE = ".env.local";
const APP_ROLE = "aibab_app";

/** PostgreSQL SCRAM-SHA-256 verifier (RFC 5802 / RFC 7677), as stored in pg_authid. */
export function scramSha256Verifier(
  password: string,
  salt: Buffer = randomBytes(16),
  iterations = 4096,
): string {
  const salted = pbkdf2Sync(password, salt, iterations, 32, "sha256");
  const clientKey = createHmac("sha256", salted).update("Client Key").digest();
  const storedKey = createHash("sha256").update(clientKey).digest();
  const serverKey = createHmac("sha256", salted).update("Server Key").digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString("base64")}$${storedKey.toString("base64")}:${serverKey.toString("base64")}`;
}

const verifierPattern = /^SCRAM-SHA-256\$\d+:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/;

/** Printable ASCII only (avoids SASLprep differences), 16–128 characters. */
export function validateLocalPassword(password: string): void {
  if (password === PLACEHOLDER)
    throw new Error("DATABASE_URL still contains the placeholder password");
  if (!/^[\x21-\x7e]{16,128}$/.test(password)) {
    throw new Error("The local aibab_app password must be 16-128 printable ASCII characters");
  }
}

export function isLoopbackHost(host: string): boolean {
  return ["127.0.0.1", "localhost", "::1", "[::1]"].includes(host.toLowerCase());
}

/** Validates that both URLs point to the same loopback endpoint published by Docker. */
export function assertLocalTarget(options: {
  adminUrl: URL;
  appUrl: URL;
  publishedPorts: readonly string[];
}): void {
  const { adminUrl, appUrl, publishedPorts } = options;
  for (const [name, url] of [
    ["TEST_DATABASE_ADMIN_URL", adminUrl],
    ["DATABASE_URL", appUrl],
  ] as const) {
    if (!isLoopbackHost(url.hostname)) {
      throw new Error(`${name} must point to a loopback host (local Supabase only)`);
    }
  }
  if (adminUrl.port !== appUrl.port) {
    throw new Error("DATABASE_URL and TEST_DATABASE_ADMIN_URL must use the same port");
  }
  if (!publishedPorts.includes(adminUrl.port)) {
    throw new Error(
      `Port ${adminUrl.port} is not the port Docker publishes for the local Supabase database`,
    );
  }
  if (decodeURIComponent(appUrl.username) !== APP_ROLE) {
    throw new Error(`DATABASE_URL must connect as ${APP_ROLE}`);
  }
}

function loadEnv(): void {
  if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);
}

function requiredUrl(name: string): URL {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set (see .env.example)`);
  return new URL(value);
}

function localDbContainer(): string {
  const config = readFileSync("supabase/config.toml", "utf8");
  const projectId = /^project_id\s*=\s*"([^"]+)"/m.exec(config)?.[1];
  if (!projectId) throw new Error("project_id not found in supabase/config.toml");
  return `supabase_db_${projectId}`;
}

function publishedPorts(container: string): string[] {
  const output = execFileSync("docker", ["port", container, "5432/tcp"], { encoding: "utf8" });
  return output
    .split(/\r?\n/)
    .map((line) => /:(\d+)\s*$/.exec(line.trim())?.[1])
    .filter((port): port is string => Boolean(port));
}

/** Proves the admin connection terminates inside the local container. */
function assertBackendInContainer(container: string, pid: number): void {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error("Invalid backend pid");
  const count = execFileSync(
    "docker",
    [
      "exec",
      container,
      "psql",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "-tAc",
      `select count(*) from pg_stat_activity where pid = ${pid}`,
    ],
    { encoding: "utf8" },
  ).trim();
  if (count !== "1") {
    throw new Error("The admin connection does not belong to the local Supabase container");
  }
}

/** Replaces the placeholder in .env.local with a random password; returns it. */
function generatePasswordIntoEnvFile(): string {
  if (!existsSync(ENV_FILE)) throw new Error(`${ENV_FILE} not found (copy .env.example first)`);
  const content = readFileSync(ENV_FILE, "utf8");
  const needle = `${APP_ROLE}:${PLACEHOLDER}@`;
  if (!content.includes(needle)) {
    throw new Error(`The placeholder password is not in ${ENV_FILE}; set DATABASE_URL there`);
  }
  const password = randomBytes(24).toString("base64url");
  writeFileSync(ENV_FILE, content.replace(needle, `${APP_ROLE}:${password}@`));
  return password;
}

export async function main(): Promise<void> {
  loadEnv();
  const adminUrl = requiredUrl("TEST_DATABASE_ADMIN_URL");
  let appUrl = requiredUrl("DATABASE_URL");

  const container = localDbContainer();
  assertLocalTarget({ adminUrl, appUrl, publishedPorts: publishedPorts(container) });

  let password = decodeURIComponent(appUrl.password);
  if (password === PLACEHOLDER) {
    password = generatePasswordIntoEnvFile();
    appUrl = new URL(appUrl);
    appUrl.password = encodeURIComponent(password);
    console.log(`Generated a random local password for ${APP_ROLE} and saved it in ${ENV_FILE}.`);
  }
  validateLocalPassword(password);

  const verifier = scramSha256Verifier(password);
  if (!verifierPattern.test(verifier)) throw new Error("Unexpected verifier format");

  const admin = postgres(adminUrl.toString(), { max: 1, onnotice: () => {} });
  try {
    const [row] = await admin<{ pid: number }[]>`select pg_backend_pid() as pid`;
    assertBackendInContainer(container, row!.pid);
    // Utility statements cannot take bind parameters; the verifier contains only
    // [A-Za-z0-9+/=$:-] (checked above) and is not the password itself.
    await admin.unsafe(`alter role ${APP_ROLE} with password '${verifier}'`);
  } finally {
    await admin.end();
  }

  const app = postgres(appUrl.toString(), { max: 1, onnotice: () => {} });
  try {
    const [row] = await app<{ role: string }[]>`select current_user::text as role`;
    if (row?.role !== APP_ROLE) throw new Error("Verification login returned an unexpected role");
  } finally {
    await app.end();
  }
  console.log(`Local password for ${APP_ROLE} is set and verified (value not printed).`);
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main().catch((error: unknown) => {
    console.error(`db:local-password failed: ${(error as Error).message}`);
    process.exit(1);
  });
}
