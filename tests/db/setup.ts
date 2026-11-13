import { existsSync } from "node:fs";

// Load local env files (both gitignored). Later files do not override earlier ones.
for (const file of [".env.test.local", ".env.local"]) {
  if (existsSync(file)) process.loadEnvFile(file);
}

const required = [
  "DATABASE_URL",
  "TEST_DATABASE_ADMIN_URL",
  "TEST_SUPABASE_URL",
  "TEST_SUPABASE_ANON_KEY",
  "TEST_SUPABASE_JWT_SECRET",
];
const missing = required.filter((name) => !process.env[name]);
if (missing.length > 0) {
  throw new Error(
    `Missing env for database tests: ${missing.join(", ")}. See .env.example (section "Database tests").`,
  );
}
