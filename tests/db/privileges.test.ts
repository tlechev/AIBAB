import { describe, expect, it } from "vitest";

import { adminSql, appSql, expectPgError } from "./helpers";

const supabaseApiRoles = ["anon", "authenticated", "service_role"] as const;
const appSchemas = ["app", "app_private"] as const;

describe("role attributes", () => {
  it("aibab roles have exactly the intended attributes", async () => {
    const rows = await adminSql<
      {
        rolname: string;
        login: boolean;
        inherit: boolean;
        bypassrls: boolean;
        super: boolean;
        createrole: boolean;
        createdb: boolean;
      }[]
    >`
      select rolname, rolcanlogin as login, rolinherit as inherit, rolbypassrls as bypassrls,
             rolsuper as super, rolcreaterole as createrole, rolcreatedb as createdb
      from pg_roles where rolname in ('aibab_app', 'aibab_user', 'aibab_definer') order by rolname`;
    const base = {
      inherit: false,
      bypassrls: false,
      super: false,
      createrole: false,
      createdb: false,
    };
    expect(rows).toEqual([
      { rolname: "aibab_app", login: true, ...base },
      { rolname: "aibab_definer", login: false, ...base },
      { rolname: "aibab_user", login: false, ...base },
    ]);
  });

  it("aibab_app is a member of aibab_user only (SET, no INHERIT); aibab_user/definer belong to nothing", async () => {
    const rows = await adminSql<{ role: string; member: string; inherit: boolean; set: boolean }[]>`
      select r.rolname as role, m.rolname as member, a.inherit_option as inherit, a.set_option as set
      from pg_auth_members a
      join pg_roles r on r.oid = a.roleid
      join pg_roles m on m.oid = a.member
      where m.rolname in ('aibab_app', 'aibab_user', 'aibab_definer')
      order by 1, 2`;
    expect(rows).toEqual([{ role: "aibab_user", member: "aibab_app", inherit: false, set: true }]);
  });
});

describe("schema privileges", () => {
  it.each(appSchemas)("Supabase API roles have no USAGE or CREATE on %s", async (schema) => {
    for (const role of supabaseApiRoles) {
      const [row] = await adminSql<{ usage: boolean; create: boolean }[]>`
        select has_schema_privilege(${role}, ${schema}, 'USAGE') as usage,
               has_schema_privilege(${role}, ${schema}, 'CREATE') as create`;
      expect(row, `${role} on ${schema}`).toEqual({ usage: false, create: false });
    }
  });

  it.each(appSchemas)("PUBLIC has no privileges on %s", async (schema) => {
    const [row] = await adminSql<{ acl: string | null }[]>`
      select nspacl::text as acl from pg_namespace where nspname = ${schema}`;
    // PUBLIC entries in an ACL start with "=" (no grantee name).
    expect(row?.acl ?? "").not.toMatch(/(^|[{,])=/);
  });

  it("aibab_app has no direct privileges on the app schemas", async () => {
    for (const schema of appSchemas) {
      const [row] = await adminSql<{ usage: boolean; create: boolean }[]>`
        select has_schema_privilege('aibab_app', ${schema}, 'USAGE') as usage,
               has_schema_privilege('aibab_app', ${schema}, 'CREATE') as create`;
      expect(row, schema).toEqual({ usage: false, create: false });
    }
  });

  it("aibab_user and aibab_definer can use but never CREATE in any schema", async () => {
    const rows = await adminSql<{ role: string; schema: string; create: boolean }[]>`
      select r.role, n.nspname as schema, has_schema_privilege(r.role, n.oid, 'CREATE') as create
      from (values ('aibab_user'), ('aibab_definer'), ('aibab_app')) as r(role)
      cross join pg_namespace n
      where has_schema_privilege(r.role, n.oid, 'CREATE')`;
    expect(rows).toEqual([]);
  });

  it("aibab roles cannot CREATE schemas in the database", async () => {
    for (const role of ["aibab_app", "aibab_user", "aibab_definer"]) {
      const [row] = await adminSql<{ create: boolean }[]>`
        select has_database_privilege(${role}, current_database(), 'CREATE') as create`;
      expect(row?.create, role).toBe(false);
    }
  });
});

describe("function privileges", () => {
  it("no app/app_private function is executable by PUBLIC or Supabase API roles", async () => {
    const rows = await adminSql<{ fn: string; acl: string | null; api_exec: boolean }[]>`
      select p.oid::regprocedure::text as fn, p.proacl::text as acl,
             has_function_privilege('anon', p.oid, 'EXECUTE')
               or has_function_privilege('authenticated', p.oid, 'EXECUTE')
               or has_function_privilege('service_role', p.oid, 'EXECUTE')
               or has_function_privilege('aibab_app', p.oid, 'EXECUTE') as api_exec
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname in ('app', 'app_private')`;
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.api_exec, row.fn).toBe(false);
      // A NULL ACL means default privileges, which include EXECUTE for PUBLIC.
      expect(row.acl, `${row.fn} must have an explicit ACL`).not.toBeNull();
      expect(row.acl ?? "", row.fn).not.toMatch(/(^|[{,])=X/);
    }
  });

  it("aibab_user can execute current_user_id() but not trigger functions", async () => {
    const [row] = await adminSql<{ uid: boolean; updated_at: boolean; immut: boolean }[]>`
      select has_function_privilege('aibab_user', 'app_private.current_user_id()', 'EXECUTE') as uid,
             has_function_privilege('aibab_user', 'app_private.set_updated_at()', 'EXECUTE') as updated_at,
             has_function_privilege('aibab_user', 'app_private.prevent_organization_id_change()', 'EXECUTE') as immut`;
    expect(row).toEqual({ uid: true, updated_at: false, immut: false });
  });
});

describe("auth and system objects", () => {
  it("aibab roles cannot read auth.users, auth schema objects or vault secrets", async () => {
    for (const role of ["aibab_app", "aibab_user", "aibab_definer"]) {
      const [row] = await adminSql<{ auth_usage: boolean; users: boolean; vault: boolean }[]>`
        select has_schema_privilege(${role}, 'auth', 'USAGE') as auth_usage,
               has_table_privilege(${role}, 'auth.users', 'SELECT') as users,
               has_table_privilege(${role}, 'vault.secrets', 'SELECT') as vault`;
      expect(row, role).toEqual({ auth_usage: false, users: false, vault: false });
    }
  });

  it("aibab_user cannot read password hashes or other roles' secrets", async () => {
    const client = appSql();
    try {
      await expectPgError(
        client.begin(async (tx) => {
          await tx`set local role aibab_user`;
          return tx`select rolpassword from pg_authid limit 1`;
        }),
        "42501",
      );
    } finally {
      await client.end();
    }
  });

  it("aibab roles hold no predefined data-access roles", async () => {
    const rows = await adminSql<{ member: string; role: string }[]>`
      select m.rolname as member, r.rolname as role
      from pg_auth_members a
      join pg_roles r on r.oid = a.roleid
      join pg_roles m on m.oid = a.member
      where m.rolname like 'aibab\_%' and r.rolname like 'pg\_%'`;
    expect(rows).toEqual([]);
  });
});

describe("SET ROLE from the real aibab_app login", () => {
  it("can switch to aibab_user", async () => {
    const client = appSql();
    try {
      const rows = await client.begin(async (tx) => {
        await tx`set local role aibab_user`;
        return tx`select current_user::text as role, session_user::text as login`;
      });
      expect(rows[0]).toEqual({ role: "aibab_user", login: "aibab_app" });
    } finally {
      await client.end();
    }
  });

  it.each([
    "postgres",
    "service_role",
    "authenticated",
    "anon",
    "aibab_definer",
    "supabase_admin",
    "supabase_auth_admin",
  ])("cannot switch to %s", async (role) => {
    const client = appSql();
    try {
      await expectPgError(
        client.begin(async (tx) => {
          await tx.unsafe(`set local role ${role}`);
        }),
        "42501",
      );
    } finally {
      await client.end();
    }
  });

  it("aibab_user cannot switch further to any other role", async () => {
    const client = appSql();
    try {
      await expectPgError(
        client.begin(async (tx) => {
          await tx`set local role aibab_user`;
          await tx`set local role aibab_definer`;
        }),
        "42501",
      );
    } finally {
      await client.end();
    }
  });
});
