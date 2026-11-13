-- =============================================================================
-- Base security helpers and generic triggers
-- =============================================================================

-- The current end user for this transaction, set by withUserTx() via
--   select set_config('app.current_user_id', <uuid>, true)
-- Returns NULL when unset or empty. A malformed value raises 22P02 and aborts
-- the transaction (fail closed).
-- TRUST BOUNDARY: PostgreSQL does not authenticate this value. Whoever holds
-- DATABASE_URL can set any user id; the application only sets ids obtained from
-- a verified Supabase session.
create function app_private.current_user_id()
returns uuid
language sql
stable
set search_path = ''
as $$
  select nullif(current_setting('app.current_user_id', true), '')::uuid
$$;

revoke all on function app_private.current_user_id() from public;
grant execute on function app_private.current_user_id() to aibab_user, aibab_definer;

-- Keeps updated_at current on every UPDATE.
create function app_private.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end
$$;

revoke all on function app_private.set_updated_at() from public;

-- Server-controlled timestamps on INSERT: clients cannot backdate rows
-- (several constraints, e.g. invitation expiry, are relative to created_at).
create function app_private.set_created_timestamps()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.created_at := now();
  new.updated_at := new.created_at;
  return new;
end
$$;

revoke all on function app_private.set_created_timestamps() from public;

-- Tenant rows can never move between organizations.
create function app_private.prevent_organization_id_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.organization_id is distinct from old.organization_id then
    raise exception 'organization_id is immutable'
      using errcode = '42501';
  end if;
  return new;
end
$$;

revoke all on function app_private.prevent_organization_id_change() from public;
