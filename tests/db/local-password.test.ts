import { execFile } from "node:child_process";
import { promisify } from "node:util";

import postgres from "postgres";
import { describe, expect, it } from "vitest";

import { pgCode } from "./helpers";

const run = promisify(execFile);

/** F1: the local aibab_app password comes only from scripts/set-local-db-password.ts. */
describe("local aibab_app password", () => {
  const appUrl = () => new URL(process.env.DATABASE_URL!);

  async function canLogin(url: URL): Promise<true | string | undefined> {
    const client = postgres(url.toString(), { max: 1, onnotice: () => {}, connect_timeout: 5 });
    try {
      await client`select 1`;
      return true;
    } catch (error) {
      return pgCode(error);
    } finally {
      await client.end({ timeout: 1 });
    }
  }

  it("the configured local password works", async () => {
    expect(await canLogin(appUrl())).toBe(true);
  });

  it("the previously published development password no longer works (28P01)", async () => {
    const url = appUrl();
    url.password = "aibab_app_local_dev";
    expect(await canLogin(url)).toBe("28P01");
  });

  it("the placeholder is not a valid password", async () => {
    const url = appUrl();
    url.password = "CHANGE_ME_LOCAL_ONLY";
    expect(await canLogin(url)).toBe("28P01");
  });

  it.each([
    [
      "a non-loopback host",
      {
        TEST_DATABASE_ADMIN_URL:
          "postgresql://postgres:postgres@db.example.supabase.co:54322/postgres",
      },
      /loopback/,
    ],
    [
      // 54321 is published by the API gateway container, not by the database container.
      "a loopback port that is not the database container's",
      {
        TEST_DATABASE_ADMIN_URL: "postgresql://postgres:postgres@127.0.0.1:54321/postgres",
        DATABASE_URL: "postgresql://aibab_app:x-x-x-x-x-x-x-x-x@127.0.0.1:54321/postgres",
      },
      /not the port Docker publishes/,
    ],
  ])(
    "the script refuses %s and leaves the password unchanged",
    async (_label, overrides, message) => {
      let failure: { code?: number; stderr?: string } | undefined;
      try {
        await run(process.execPath, ["scripts/set-local-db-password.ts"], {
          env: { ...process.env, ...overrides },
        });
      } catch (error) {
        failure = error as { code?: number; stderr?: string };
      }
      expect(failure?.code).toBe(1);
      expect(failure?.stderr).toMatch(message);
      expect(await canLogin(appUrl())).toBe(true);
    },
  );
});
