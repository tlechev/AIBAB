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

  it("defaults NODE_ENV to development on the server schema", () => {
    const env = parseEnv(serverEnvSchema, { NEXT_PUBLIC_APP_URL: "http://localhost:3000" });
    expect(env.NODE_ENV).toBe("development");
  });

  it("rejects an unknown NODE_ENV", () => {
    expect(() =>
      parseEnv(serverEnvSchema, {
        NEXT_PUBLIC_APP_URL: "http://localhost:3000",
        NODE_ENV: "staging",
      }),
    ).toThrow(/NODE_ENV/);
  });
});
