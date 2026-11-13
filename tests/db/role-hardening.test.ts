import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

import postgres from "postgres";
import { describe, expect, it } from "vitest";

import { adminSql } from "./helpers";

/**
 * F3: the roles migration must repair roles that already exist with wrong
 * attributes or memberships (roles are cluster-wide, so they can pre-exist).
 *
 * The test deliberately breaks the real cluster-wide roles, then runs the
 * migration in a scratch database (schemas are per-database, roles are not)
 * and checks the repaired state. `finally` re-runs the migration so the roles
 * are always restored, even if an assertion fails.
 */
const migration = readFileSync("supabase/migrations/20261113143210_roles_and_schemas.sql", "utf8");

async function readRoleState() {
  const roles = await adminSql<
    {
      name: string;
      login: boolean;
      inherit: boolean;
      superuser: boolean;
      createdb: boolean;
      createrole: boolean;
      replication: boolean;
      bypassrls: boolean;
    }[]
  >`
    select rolname as name, rolcanlogin as login, rolinherit as inherit, rolsuper as superuser,
           rolcreatedb as createdb, rolcreaterole as createrole, rolreplication as replication,
           rolbypassrls as bypassrls
    from pg_roles where rolname in ('aibab_app', 'aibab_user', 'aibab_definer') order by 1`;
  const memberships = await adminSql<
    { role: string; member: string; admin: boolean; inherit: boolean; set: boolean }[]
  >`
    select ro.rolname as role, me.rolname as member,
           a.admin_option as admin, a.inherit_option as inherit, a.set_option as set
    from pg_auth_members a
    join pg_roles ro on ro.oid = a.roleid
    join pg_roles me on me.oid = a.member
    where (ro.rolname like 'aibab\_%' or me.rolname like 'aibab\_%') and me.rolname <> 'postgres'
    order by 1, 2`;
  return { roles: roles.map((r) => ({ ...r })), memberships: memberships.map((m) => ({ ...m })) };
}

const off = {
  inherit: false,
  superuser: false,
  createdb: false,
  createrole: false,
  replication: false,
  bypassrls: false,
};
const expectedState = {
  roles: [
    { name: "aibab_app", login: true, ...off },
    { name: "aibab_definer", login: false, ...off },
    { name: "aibab_user", login: false, ...off },
  ],
  memberships: [
    { role: "aibab_user", member: "aibab_app", admin: false, inherit: false, set: true },
  ],
};

describe("roles migration repairs pre-existing roles (F3)", () => {
  it("the current state is the expected one", async () => {
    expect(await readRoleState()).toEqual(expectedState);
  });

  it("restores attributes and memberships after they were tampered with", async () => {
    const database = `aibab_role_hardening_${randomBytes(4).toString("hex")}`;
    await adminSql.unsafe(`create database ${database}`);
    const scratchUrl = new URL(process.env.TEST_DATABASE_ADMIN_URL!);
    scratchUrl.pathname = `/${database}`;
    const scratch = postgres(scratchUrl.toString(), { max: 1, onnotice: () => {} });

    try {
      // Every attribute the migration must clear, plus dangerous memberships.
      await adminSql.unsafe(`
        alter role aibab_app     with inherit createdb createrole replication bypassrls;
        alter role aibab_user    with login inherit createdb createrole replication bypassrls;
        alter role aibab_definer with login inherit createdb createrole replication bypassrls;
        grant aibab_definer to aibab_app with inherit true, set true;
        grant aibab_definer to aibab_user with inherit true, set true;
        revoke aibab_user from aibab_app;
        grant aibab_user to aibab_app with admin true, inherit true, set true;
      `);
      const tampered = await readRoleState();
      expect(tampered).not.toEqual(expectedState);
      expect(tampered.roles.every((r) => r.bypassrls && r.inherit && r.createrole)).toBe(true);
      expect(tampered.memberships).toContainEqual(
        expect.objectContaining({ role: "aibab_definer", member: "aibab_app" }),
      );

      await scratch.unsafe(migration);

      expect(await readRoleState()).toEqual(expectedState);
    } finally {
      // Always leave the cluster-wide roles in the expected state.
      await scratch.unsafe(`drop schema if exists app, app_private cascade`).catch(() => {});
      await scratch.unsafe(migration).catch(() => {});
      await scratch.end();
      await adminSql.unsafe(`drop database if exists ${database} with (force)`);
    }
  });

  it("the migration is idempotent for the roles (re-running keeps the expected state)", async () => {
    const database = `aibab_role_hardening_${randomBytes(4).toString("hex")}`;
    await adminSql.unsafe(`create database ${database}`);
    const scratchUrl = new URL(process.env.TEST_DATABASE_ADMIN_URL!);
    scratchUrl.pathname = `/${database}`;
    const scratch = postgres(scratchUrl.toString(), { max: 1, onnotice: () => {} });
    try {
      await scratch.unsafe(migration);
      expect(await readRoleState()).toEqual(expectedState);
    } finally {
      await scratch.end();
      await adminSql.unsafe(`drop database if exists ${database} with (force)`);
    }
  });
});
