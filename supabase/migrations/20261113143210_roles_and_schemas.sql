-- =============================================================================
-- Roles and schemas
--
-- aibab_app      LOGIN, NOINHERIT. The runtime connection role (DATABASE_URL).
--                Holds no privileges of its own; it can only SET ROLE aibab_user.
--                Its password is provisioned out-of-band
--                (scripts/set-local-db-password.ts locally).
-- aibab_user     NOLOGIN. Every end-user request runs as this role inside
--                withUserTx(), with app.current_user_id set for the transaction.
-- aibab_definer  NOLOGIN, no BYPASSRLS. Owns SECURITY DEFINER functions and holds
--                only the grants/policies those functions need.
--
-- Supabase API roles (anon, authenticated, service_role) receive nothing here.
-- Roles are cluster-wide, so creation is idempotent.
-- =============================================================================

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'aibab_user') then
    create role aibab_user nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'aibab_app') then
    create role aibab_app login noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'aibab_definer') then
    create role aibab_definer nologin noinherit;
  end if;
end
$$;

-- Enforce the attributes even if a role already existed with different ones.
-- postgres holds CREATEROLE, CREATEDB, REPLICATION and BYPASSRLS, so it can
-- clear those. It cannot change SUPERUSER (or alter a superuser role at all);
-- the assertion below fails the migration in that case instead.
alter role aibab_app     with login   noinherit nocreatedb nocreaterole noreplication nobypassrls;
alter role aibab_user    with nologin noinherit nocreatedb nocreaterole noreplication nobypassrls;
alter role aibab_definer with nologin noinherit nocreatedb nocreaterole noreplication nobypassrls;

-- Remove every role membership that involves the aibab roles, except the
-- administrative grants to postgres (the migration owner). The intended
-- memberships are re-created explicitly below.
do $$
declare
  r record;
begin
  for r in
    select ro.rolname as role_name, me.rolname as member_name, gr.rolname as grantor_name
    from pg_auth_members a
    join pg_roles ro on ro.oid = a.roleid
    join pg_roles me on me.oid = a.member
    join pg_roles gr on gr.oid = a.grantor
    where (ro.rolname in ('aibab_app', 'aibab_user', 'aibab_definer')
           or me.rolname in ('aibab_app', 'aibab_user', 'aibab_definer'))
      and me.rolname <> 'postgres'
  loop
    execute format('revoke %I from %I granted by %I', r.role_name, r.member_name, r.grantor_name);
  end loop;
end
$$;

-- aibab_app may switch to aibab_user, but never inherits its privileges.
grant aibab_user to aibab_app with inherit false, set true;

-- postgres (migration owner) must be able to SET ROLE aibab_definer to transfer
-- function ownership. It does not inherit the role's privileges.
grant aibab_definer to postgres with inherit false, set true;

-- Fail the migration if anything could not be enforced.
do $$
begin
  if exists (
    select 1 from pg_roles
    where rolname in ('aibab_app', 'aibab_user', 'aibab_definer')
      and (rolsuper or rolinherit or rolcreatedb or rolcreaterole or rolreplication or rolbypassrls
           or rolcanlogin <> (rolname = 'aibab_app'))
  ) then
    raise exception 'aibab roles do not have the expected attributes';
  end if;

  if exists (
    select 1
    from pg_auth_members a
    join pg_roles ro on ro.oid = a.roleid
    join pg_roles me on me.oid = a.member
    where (ro.rolname in ('aibab_app', 'aibab_user', 'aibab_definer')
           or me.rolname in ('aibab_app', 'aibab_user', 'aibab_definer'))
      and me.rolname <> 'postgres'
      and not (ro.rolname = 'aibab_user' and me.rolname = 'aibab_app'
               and not a.admin_option and not a.inherit_option and a.set_option)
  ) then
    raise exception 'aibab roles have unexpected memberships';
  end if;
end
$$;

create schema app;
create schema app_private;

comment on schema app is 'AIBAB application data. Not exposed through the Supabase Data API.';
comment on schema app_private is 'AIBAB security helpers. Not exposed through the Supabase Data API.';

revoke all on schema app, app_private from public;
grant usage on schema app, app_private to aibab_user, aibab_definer;

-- PostgreSQL grants EXECUTE on new functions to PUBLIC by default; disable that.
alter default privileges for role postgres in schema app, app_private
  revoke execute on functions from public;
