import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { signTestJwt, supabaseAnonKey, supabaseUrl } from "./helpers";

/**
 * The `app` schemas must not be reachable through the Supabase Data API
 * (PostgREST) or GraphQL, regardless of configuration. These tests call the
 * real local API gateway.
 */
describe("Supabase Data API exposure", () => {
  it("config.toml exposes only public and graphql_public", () => {
    const config = readFileSync("supabase/config.toml", "utf8");
    const match = /^\s*schemas\s*=\s*\[([^\]]*)\]/m.exec(config);
    const schemas = (match?.[1] ?? "")
      .split(",")
      .map((s) => s.trim().replace(/"/g, ""))
      .filter(Boolean);
    expect(schemas.sort()).toEqual(["graphql_public", "public"]);
  });

  const callers = [
    { name: "anon", headers: () => ({ apikey: supabaseAnonKey() }) },
    {
      name: "authenticated",
      headers: () => ({
        apikey: supabaseAnonKey(),
        Authorization: `Bearer ${signTestJwt({ role: "authenticated", aud: "authenticated", sub: crypto.randomUUID() })}`,
      }),
    },
  ];

  it.each(callers)("REST rejects the app schema profile for $name", async ({ headers }) => {
    for (const schema of ["app", "app_private"]) {
      const response = await fetch(`${supabaseUrl()}/rest/v1/`, {
        headers: { ...headers(), "Accept-Profile": schema },
      });
      const body = (await response.json()) as { code?: string };
      expect(response.ok, schema).toBe(false);
      expect(body.code, schema).toBe("PGRST106");
    }
  });

  it.each(callers)("GraphQL does not reflect app tables for $name", async ({ headers }) => {
    const response = await fetch(`${supabaseUrl()}/graphql/v1`, {
      method: "POST",
      headers: { ...headers(), "Content-Type": "application/json" },
      body: JSON.stringify({
        query: "{ organizationsCollection { edges { node { id name } } } }",
      }),
    });
    const body = (await response.json()) as { data?: unknown; errors?: { message: string }[] };
    expect(body.errors?.length ?? 0).toBeGreaterThan(0);
    expect(JSON.stringify(body.data ?? null)).not.toContain("edges");
  });

  it.each(callers)("REST RPC cannot reach app functions for $name", async ({ headers }) => {
    const response = await fetch(`${supabaseUrl()}/rest/v1/rpc/current_user_id`, {
      method: "POST",
      headers: {
        ...headers(),
        "Content-Profile": "app_private",
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    expect(response.ok).toBe(false);
  });
});
