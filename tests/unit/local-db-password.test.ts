import { readdirSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  assertLocalTarget,
  isLoopbackHost,
  PLACEHOLDER,
  scramSha256Verifier,
  validateLocalPassword,
} from "../../scripts/set-local-db-password";

describe("no credentials in files that the Supabase CLI can push", () => {
  const files = [
    "supabase/seed.sql",
    ...readdirSync("supabase/migrations").map((f) => `supabase/migrations/${f}`),
  ];

  it.each(files)("%s sets no role password", (file) => {
    const sql = readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("--"))
      .join("\n");
    expect(sql).not.toMatch(/\bpassword\s*'/i);
    expect(sql).not.toMatch(/alter\s+(role|user)[^;]*\bpassword\b/i);
    expect(sql).not.toMatch(/create\s+(role|user)[^;]*\bpassword\b/i);
  });

  it(".env.example contains only the placeholder for the aibab_app password", () => {
    const example = readFileSync(".env.example", "utf8");
    expect(example).toContain(`aibab_app:${PLACEHOLDER}@`);
    expect(example).not.toContain("aibab_app_local_dev");
  });
});

describe("scramSha256Verifier", () => {
  it("produces a PostgreSQL SCRAM-SHA-256 verifier that does not contain the password", () => {
    const password = "a-very-local-password-123";
    const verifier = scramSha256Verifier(password);
    expect(verifier).toMatch(
      /^SCRAM-SHA-256\$4096:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/,
    );
    expect(verifier).not.toContain(password);
  });

  it("is deterministic for a fixed salt and salted per call by default", () => {
    const salt = Buffer.alloc(16, 7);
    expect(scramSha256Verifier("p".repeat(20), salt)).toBe(
      scramSha256Verifier("p".repeat(20), salt),
    );
    expect(scramSha256Verifier("p".repeat(20))).not.toBe(scramSha256Verifier("p".repeat(20)));
  });
});

describe("validateLocalPassword", () => {
  it.each([
    ["the placeholder", PLACEHOLDER],
    ["a short password", "short"],
    ["a password with spaces", "has spaces in it 12345"],
    ["non-ASCII characters", "паролапаролапарола"],
  ])("rejects %s", (_label, password) => {
    expect(() => validateLocalPassword(password)).toThrow();
  });

  it("accepts a generated-style password", () => {
    expect(() => validateLocalPassword("Zm9vYmFyYmF6cXV4LWxvY2Fs")).not.toThrow();
  });
});

describe("assertLocalTarget", () => {
  const admin = new URL("postgresql://postgres:postgres@127.0.0.1:54322/postgres");
  const app = new URL("postgresql://aibab_app:x@127.0.0.1:54322/postgres");

  it("accepts the local Docker endpoint", () => {
    expect(() =>
      assertLocalTarget({ adminUrl: admin, appUrl: app, publishedPorts: ["54322"] }),
    ).not.toThrow();
  });

  it.each([
    [
      "a hosted admin URL",
      new URL("postgresql://postgres:x@db.abcdefgh.supabase.co:5432/postgres"),
      app,
      ["54322"],
    ],
    [
      "a hosted app URL",
      admin,
      new URL("postgresql://aibab_app:x@aws-0-eu-central-1.pooler.supabase.com:6543/postgres"),
      ["54322"],
    ],
    [
      "a loopback port that Docker does not publish (e.g. an SSH tunnel)",
      new URL("postgresql://postgres:x@127.0.0.1:6543/postgres"),
      new URL("postgresql://aibab_app:x@127.0.0.1:6543/postgres"),
      ["54322"],
    ],
    [
      "mismatched ports",
      admin,
      new URL("postgresql://aibab_app:x@127.0.0.1:5432/postgres"),
      ["54322", "5432"],
    ],
    [
      "a different app role",
      admin,
      new URL("postgresql://postgres:x@127.0.0.1:54322/postgres"),
      ["54322"],
    ],
  ])("rejects %s", (_label, adminUrl, appUrl, ports) => {
    expect(() => assertLocalTarget({ adminUrl, appUrl, publishedPorts: ports })).toThrow();
  });

  it("recognizes loopback hosts only", () => {
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("LOCALHOST")).toBe(true);
    expect(isLoopbackHost("[::1]")).toBe(true);
    expect(isLoopbackHost("127.0.0.1.example.com")).toBe(false);
    expect(isLoopbackHost("10.0.0.5")).toBe(false);
  });
});
