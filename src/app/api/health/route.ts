import { connection } from "next/server";

/**
 * Liveness probe for uptime monitoring. `connection()` opts out of
 * prerendering so every call is served by a live function, not a build artifact.
 * Database readiness is added in task 2.
 */
export async function GET(): Promise<Response> {
  await connection();
  return Response.json({ status: "ok" }, { headers: { "Cache-Control": "no-store" } });
}
