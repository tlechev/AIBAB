import type postgres from "postgres";

/**
 * Reads a deterministic description of everything security-relevant in the
 * `app` and `app_private` schemas. Used by the schema snapshot and invariants.
 */
export async function readCatalog(sql: postgres.Sql) {
  const schemas = ["app", "app_private"];

  const tables = await sql<
    { table: string; rls: boolean; force_rls: boolean; owner: string; acl: string[] }[]
  >`
    select c.relname as table, c.relrowsecurity as rls, c.relforcerowsecurity as force_rls,
           pg_get_userbyid(c.relowner) as owner,
           coalesce((select array_agg(x::text order by x::text) from unnest(c.relacl) x), '{}') as acl
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'app' and c.relkind = 'r'
    order by c.relname`;

  const columns = await sql<
    {
      table: string;
      column: string;
      type: string;
      not_null: boolean;
      default: string | null;
      acl: string[];
    }[]
  >`
    select c.relname as table, a.attname as column, format_type(a.atttypid, a.atttypmod) as type,
           a.attnotnull as not_null, pg_get_expr(d.adbin, d.adrelid) as default,
           coalesce((select array_agg(x::text order by x::text) from unnest(a.attacl) x), '{}') as acl
    from pg_attribute a
    join pg_class c on c.oid = a.attrelid
    join pg_namespace n on n.oid = c.relnamespace
    left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
    where n.nspname = 'app' and c.relkind = 'r' and a.attnum > 0 and not a.attisdropped
    order by c.relname, a.attnum`;

  const constraints = await sql<
    { table: string; name: string; type: string; definition: string }[]
  >`
    select c.relname as table, con.conname as name, con.contype::text as type,
           pg_get_constraintdef(con.oid) as definition
    from pg_constraint con
    join pg_class c on c.oid = con.conrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'app'
    order by c.relname, con.conname`;

  const indexes = await sql<{ table: string; name: string; definition: string }[]>`
    select tablename as table, indexname as name, indexdef as definition
    from pg_indexes where schemaname = 'app'
    order by tablename, indexname`;

  const enums = await sql<{ name: string; values: string[] }[]>`
    select t.typname as name, array_agg(e.enumlabel order by e.enumsortorder) as values
    from pg_type t
    join pg_enum e on e.enumtypid = t.oid
    join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'app'
    group by t.typname
    order by t.typname`;

  const policies = await sql<
    {
      table: string;
      name: string;
      command: string;
      roles: string[];
      using: string | null;
      with_check: string | null;
    }[]
  >`
    select tablename as table, policyname as name, cmd as command, roles::text[] as roles,
           qual as using, with_check
    from pg_policies where schemaname = 'app'
    order by tablename, policyname`;

  const functions = await sql<
    {
      signature: string;
      owner: string;
      security_definer: boolean;
      volatility: string;
      config: string[];
      acl: string[];
    }[]
  >`
    select p.oid::regprocedure::text as signature, pg_get_userbyid(p.proowner) as owner,
           p.prosecdef as security_definer, p.provolatile::text as volatility,
           coalesce(p.proconfig, '{}') as config,
           coalesce((select array_agg(x::text order by x::text) from unnest(p.proacl) x), '{}') as acl
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = any (${schemas})
    order by 1`;

  const triggers = await sql<{ schema: string; table: string; name: string; definition: string }[]>`
    select n.nspname as schema, c.relname as table, t.tgname as name, pg_get_triggerdef(t.oid) as definition
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    join pg_proc p on p.oid = t.tgfoid
    join pg_namespace pn on pn.oid = p.pronamespace
    where not t.tgisinternal and (n.nspname = 'app' or pn.nspname in ('app', 'app_private'))
    order by 1, 2, 3`;

  const schemaAcl = await sql<{ schema: string; owner: string; acl: string[] }[]>`
    select nspname as schema, pg_get_userbyid(nspowner) as owner,
           coalesce((select array_agg(x::text order by x::text) from unnest(nspacl) x), '{}') as acl
    from pg_namespace where nspname = any (${schemas})
    order by 1`;

  const types = await sql<{ name: string; kind: string; owner: string }[]>`
    select t.typname as name, t.typtype::text as kind, pg_get_userbyid(t.typowner) as owner
    from pg_type t join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = any (${schemas}) and t.typtype in ('e', 'r', 'm', 'd', 'c') and t.typrelid = 0
    order by 1`;

  const roles = await sql<
    {
      name: string;
      login: boolean;
      inherit: boolean;
      superuser: boolean;
      createdb: boolean;
      createrole: boolean;
      replication: boolean;
      bypassrls: boolean;
      config: string[];
    }[]
  >`
    select rolname as name, rolcanlogin as login, rolinherit as inherit, rolsuper as superuser,
           rolcreatedb as createdb, rolcreaterole as createrole, rolreplication as replication,
           rolbypassrls as bypassrls, coalesce(rolconfig, '{}') as config
    from pg_roles where rolname like 'aibab\_%'
    order by 1`;

  const roleMemberships = await sql<
    {
      role: string;
      member: string;
      grantor: string;
      admin: boolean;
      inherit: boolean;
      set: boolean;
    }[]
  >`
    select ro.rolname as role, me.rolname as member, gr.rolname as grantor,
           a.admin_option as admin, a.inherit_option as inherit, a.set_option as set
    from pg_auth_members a
    join pg_roles ro on ro.oid = a.roleid
    join pg_roles me on me.oid = a.member
    join pg_roles gr on gr.oid = a.grantor
    where ro.rolname like 'aibab\_%' or me.rolname like 'aibab\_%'
    order by 1, 2, 3`;

  const plain = <T>(rows: readonly T[]) => rows.map((row) => ({ ...row }));
  return {
    roles: plain(roles),
    roleMemberships: plain(roleMemberships),
    schemas: plain(schemaAcl),
    types: plain(types),
    enums: plain(enums),
    tables: plain(tables),
    columns: plain(columns),
    constraints: plain(constraints),
    indexes: plain(indexes),
    policies: plain(policies),
    functions: plain(functions),
    triggers: plain(triggers),
  };
}

export type Catalog = Awaited<ReturnType<typeof readCatalog>>;
