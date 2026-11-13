import { describe, expect, it } from "vitest";

import { parseEnv, publicEnvSchema, serverEnvSchema } from "./env";

describe("parseEnv", () => {
  it("accepts a valid app URL and strips trailing slashes", () => {
    const env = parseEnv(publicEnvSchema, { NEXT_PUBLIC_APP_URL: "https://app.example.com//" });
    expect(env.NEXT_PUBLIC_APP_URL).toBe("https://app.example.com");
  });

  it("fails fast with a readable message when a variable is missing", () => {
    expect(() => parseEnv(publicEnvSchema, {})).toThrow(/NEXT_PUBLIC_APP_URL/);
  });

  it("rejects non-http protocols", () => {
    expect(() => parseEnv(publicEnvSchema, { NEXT_PUBLIC_APP_URL: "javascript:alert(1)" })).toThrow(
      /Invalid environment variables[\s\S]*must be a valid http\(s\) URL/,
    );
  });

  const validServer = {
    NEXT_PUBLIC_APP_URL: "http://localhost:3000",
    DATABASE_URL: "postgresql://aibab_app:pw@127.0.0.1:54322/postgres",
  };

  it("defaults NODE_ENV to development on the server schema", () => {
    const env = parseEnv(serverEnvSchema, validServer);
    expect(env.NODE_ENV).toBe("development");
  });

  it("rejects an unknown NODE_ENV", () => {
    expect(() => parseEnv(serverEnvSchema, { ...validServer, NODE_ENV: "staging" })).toThrow(
      /NODE_ENV/,
    );
  });

  it("requires DATABASE_URL on the server", () => {
    expect(() =>
      parseEnv(serverEnvSchema, { NEXT_PUBLIC_APP_URL: "http://localhost:3000" }),
    ).toThrow(/DATABASE_URL/);
  });

  it("rejects a non-postgres DATABASE_URL without echoing the value", () => {
    const secret = "https://user:super-secret-password@db.example.com/postgres";
    let message = "";
    try {
      parseEnv(serverEnvSchema, { ...validServer, DATABASE_URL: secret });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/DATABASE_URL/);
    expect(message).not.toContain("super-secret-password");
  });
});
