-- =============================================================================
-- Organizations, profiles, memberships
--
-- Privilege model (see docs/ARCHITECTURE.md):
--   * aibab_user    end-user requests; minimal table/column grants + RLS.
--   * aibab_definer owns SECURITY DEFINER functions; only the grants and
--                   policies those functions need. No BYPASSRLS.
-- SECURITY DEFINER functions never take a user id parameter: the user is
-- always app_private.current_user_id().
-- =============================================================================

create type app.industry as enum ('hvac', 'plumbing_electrical', 'renovation', 'other');
create type app.member_role as enum ('owner', 'admin', 'staff');

-- -----------------------------------------------------------------------------
-- Tables
-- -----------------------------------------------------------------------------

create table app.organizations (
  id                  uuid primary key default gen_random_uuid(),
  name                text not null,
  slug                text not null,
  industry            app.industry not null,
  country_code        text not null,
  default_locale      text not null,
  timezone            text not null,
  currency            text not null,
  registration_number text,
  phone               text,
  email               text,
  website             text,
  address_line        text,
  city                text,
  postal_code         text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint organizations_slug_key unique (slug),
  constraint organizations_name_check
    check (char_length(name) between 1 and 200 and name = btrim(name) and name !~ '[[:cntrl:]]'),
  constraint organizations_slug_check
    check (slug ~ '^[a-z0-9][a-z0-9-]{1,58}[a-z0-9]$' and slug !~ '--'),
  constraint organizations_slug_reserved_check
    check (slug not in ('admin', 'api', 'app', 'assets', 'auth', 'dashboard', 'help', 'login',
                        'logout', 'register', 'settings', 'signup', 'static', 'support', 'widget', 'www')),
  constraint organizations_country_code_check check (country_code ~ '^[A-Z]{2}$'),
  -- Supported UI/assistant locales and currencies; extending them is a one-line migration.
  constraint organizations_default_locale_check check (default_locale in ('bg', 'en')),
  constraint organizations_currency_check check (currency in ('EUR')),
  constraint organizations_registration_number_check
    check (registration_number is null or char_length(registration_number) between 1 and 50),
  constraint organizations_phone_check check (phone is null or phone ~ '^\+[1-9][0-9]{6,14}$'),
  constraint organizations_email_check
    check (email is null or (char_length(email) <= 254 and email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$')),
  constraint organizations_website_check
    check (website is null or (char_length(website) <= 2048 and website ~ '^https?://')),
  constraint organizations_address_line_check check (address_line is null or char_length(address_line) <= 300),
  constraint organizations_city_check check (city is null or char_length(city) <= 120),
  constraint organizations_postal_code_check check (postal_code is null or char_length(postal_code) <= 20)
);

comment on table app.organizations is 'Tenants. Market-specific settings are data (ADR-006).';

create table app.profiles (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  full_name  text,
  locale     text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint profiles_full_name_check
    check (full_name is null or (char_length(full_name) between 1 and 200 and full_name !~ '[[:cntrl:]]')),
  constraint profiles_locale_check check (locale is null or locale in ('bg', 'en'))
);

comment on table app.profiles is
  'Minimal user profile: display name and UI locale only. No contact data (emails stay in auth.users).';

create table app.memberships (
  organization_id uuid not null references app.organizations (id) on delete cascade,
  user_id         uuid not null references app.profiles (user_id) on delete cascade,
  role            app.member_role not null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint memberships_pkey primary key (organization_id, user_id)
);

create index memberships_user_id_idx on app.memberships (user_id);

-- -----------------------------------------------------------------------------
-- Generic triggers
-- -----------------------------------------------------------------------------

create trigger organizations_set_updated_at before update on app.organizations
  for each row execute function app_private.set_updated_at();
create trigger profiles_set_updated_at before update on app.profiles
  for each row execute function app_private.set_updated_at();
create trigger memberships_set_updated_at before update on app.memberships
  for each row execute function app_private.set_updated_at();
create trigger memberships_prevent_organization_id_change before update on app.memberships
  for each row execute function app_private.prevent_organization_id_change();

-- Time zones must be valid IANA names (cannot be a CHECK: pg_timezone_names is not immutable).
create function app_private.validate_organization_timezone()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if not exists (select 1 from pg_catalog.pg_timezone_names where name = new.timezone) then
    raise exception 'invalid time zone: %', new.timezone using errcode = '22023';
  end if;
  return new;
end
$$;

revoke all on function app_private.validate_organization_timezone() from public;

create trigger organizations_validate_timezone before insert or update of timezone on app.organizations
  for each row execute function app_private.validate_organization_timezone();

-- -----------------------------------------------------------------------------
-- SECURITY DEFINER helpers for RLS (owned by aibab_definer)
-- -----------------------------------------------------------------------------

-- Organizations of the current user, optionally filtered by role.
-- Used as `organization_id in (select app_private.my_organization_ids(...))`,
-- evaluated once per query instead of once per row.
create function app_private.my_organization_ids(p_roles app.member_role[] default null)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select m.organization_id
  from app.memberships m
  where m.user_id = app_private.current_user_id()
    and (p_roles is null or m.role = any (p_roles))
$$;

-- Whether the current user shares at least one organization with p_user.
-- Answers only about the caller's own relationships; cannot enumerate users.
create function app_private.shares_organization_with(p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from app.memberships mine
    join app.memberships theirs on theirs.organization_id = mine.organization_id
    where mine.user_id = app_private.current_user_id()
      and theirs.user_id = p_user
  )
$$;

-- Creates the profile for a new auth user. raw_user_meta_data is user-controlled:
-- strip control characters, trim and cap the length.
create function app_private.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into app.profiles (user_id, full_name)
  values (
    new.id,
    left(nullif(btrim(regexp_replace(coalesce(new.raw_user_meta_data ->> 'full_name', ''),
                                     '[[:cntrl:]]', '', 'g')), ''), 200)
  );
  return new;
end
$$;

-- An organization must always keep at least one owner. Owner changes are
-- serialized per organization with a transaction-scoped advisory lock, so two
-- concurrent demotions/removals cannot both succeed.
create function app_private.protect_last_owner()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.role <> 'owner' or (tg_op = 'UPDATE' and new.role = 'owner') then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('aibab.organization_owners:' || old.organization_id::text, 0));

  -- The organization itself is being deleted (cascade): nothing to protect.
  if not exists (select 1 from app.organizations o where o.id = old.organization_id) then
    return old;
  end if;

  if not exists (
    select 1 from app.memberships m
    where m.organization_id = old.organization_id
      and m.role = 'owner'
      and m.user_id <> old.user_id
  ) then
    raise exception 'an organization must keep at least one owner'
      using errcode = 'P0001', hint = 'Promote another member to owner first.';
  end if;

  return case when tg_op = 'DELETE' then old else new end;
end
$$;

-- Creates an organization with the current user as its owner.
-- Validation: table CHECK constraints + timezone trigger (database level).
-- Limit: at most 5 owned organizations per user, serialized per user.
create function app.create_organization(
  p_name           text,
  p_slug           text,
  p_industry       app.industry,
  p_country_code   text,
  p_default_locale text,
  p_timezone       text,
  p_currency       text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := app_private.current_user_id();
  v_org  uuid := gen_random_uuid();
begin
  if v_user is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('aibab.user_organizations:' || v_user::text, 0));

  if (select count(*) from app.memberships m where m.user_id = v_user and m.role = 'owner') >= 5 then
    raise exception 'organization limit reached' using errcode = 'P0001';
  end if;

  insert into app.organizations (id, name, slug, industry, country_code, default_locale, timezone, currency)
  values (v_org, btrim(p_name), lower(btrim(p_slug)), p_industry, upper(btrim(p_country_code)),
          btrim(p_default_locale), btrim(p_timezone), upper(btrim(p_currency)));

  -- Fails with 23503 if the user has no profile (i.e. does not exist in auth.users).
  insert into app.memberships (organization_id, user_id, role) values (v_org, v_user, 'owner');

  return v_org;
end
$$;

-- -----------------------------------------------------------------------------
-- Function privileges and ownership
-- (ACLs are set before the ownership transfer; CREATE is granted only for the
--  duration of ALTER ... OWNER, which PostgreSQL requires.)
-- -----------------------------------------------------------------------------

revoke all on function app_private.my_organization_ids(app.member_role[]) from public;
revoke all on function app_private.shares_organization_with(uuid) from public;
revoke all on function app_private.handle_new_user() from public;
revoke all on function app_private.protect_last_owner() from public;
revoke all on function app.create_organization(text, text, app.industry, text, text, text, text) from public;

grant execute on function app_private.my_organization_ids(app.member_role[]) to aibab_user;
grant execute on function app_private.shares_organization_with(uuid) to aibab_user;
grant execute on function app.create_organization(text, text, app.industry, text, text, text, text) to aibab_user;

-- Triggers are created while postgres still owns the functions: CREATE TRIGGER
-- requires EXECUTE on the function at creation time only.
create trigger on_auth_user_created after insert on auth.users
  for each row execute function app_private.handle_new_user();

create trigger memberships_protect_last_owner before update of role or delete on app.memberships
  for each row execute function app_private.protect_last_owner();

grant create on schema app, app_private to aibab_definer;
alter function app_private.my_organization_ids(app.member_role[]) owner to aibab_definer;
alter function app_private.shares_organization_with(uuid) owner to aibab_definer;
alter function app_private.handle_new_user() owner to aibab_definer;
alter function app_private.protect_last_owner() owner to aibab_definer;
alter function app.create_organization(text, text, app.industry, text, text, text, text) owner to aibab_definer;
revoke create on schema app, app_private from aibab_definer;

-- -----------------------------------------------------------------------------
-- Table privileges
-- -----------------------------------------------------------------------------

-- aibab_user: country_code and currency are fixed after creation.
grant select on app.organizations to aibab_user;
grant update (name, slug, industry, default_locale, timezone, registration_number,
              phone, email, website, address_line, city, postal_code)
  on app.organizations to aibab_user;

grant select on app.profiles to aibab_user;
grant update (full_name, locale) on app.profiles to aibab_user;

-- No INSERT: memberships are created only by SECURITY DEFINER functions.
grant select, delete on app.memberships to aibab_user;
grant update (role) on app.memberships to aibab_user;

-- aibab_definer: exactly what its functions need.
grant select, insert on app.organizations to aibab_definer;
grant insert on app.profiles to aibab_definer;
grant select, insert on app.memberships to aibab_definer;

-- -----------------------------------------------------------------------------
-- Row level security
-- -----------------------------------------------------------------------------

alter table app.organizations enable row level security;
alter table app.profiles enable row level security;
alter table app.memberships enable row level security;

-- organizations
create policy organizations_select on app.organizations for select to aibab_user
  using (id in (select app_private.my_organization_ids()));
create policy organizations_update on app.organizations for update to aibab_user
  using (id in (select app_private.my_organization_ids('{owner,admin}')))
  with check (id in (select app_private.my_organization_ids('{owner,admin}')));
create policy organizations_definer_select on app.organizations for select to aibab_definer
  using (true);
create policy organizations_definer_insert on app.organizations for insert to aibab_definer
  with check (true);

-- profiles: own profile, or colleagues who share an organization
create policy profiles_select on app.profiles for select to aibab_user
  using (user_id = app_private.current_user_id() or app_private.shares_organization_with(user_id));
create policy profiles_update on app.profiles for update to aibab_user
  using (user_id = app_private.current_user_id())
  with check (user_id = app_private.current_user_id());
create policy profiles_definer_insert on app.profiles for insert to aibab_definer
  with check (true);

-- memberships: admins manage non-owners; only owners touch owner rows or grant ownership
create policy memberships_select on app.memberships for select to aibab_user
  using (organization_id in (select app_private.my_organization_ids()));
create policy memberships_update on app.memberships for update to aibab_user
  using (
    organization_id in (select app_private.my_organization_ids('{owner}'))
    or (organization_id in (select app_private.my_organization_ids('{admin}')) and role <> 'owner')
  )
  with check (
    organization_id in (select app_private.my_organization_ids('{owner}'))
    or (organization_id in (select app_private.my_organization_ids('{admin}')) and role <> 'owner')
  );
create policy memberships_delete on app.memberships for delete to aibab_user
  using (
    organization_id in (select app_private.my_organization_ids('{owner}'))
    or (organization_id in (select app_private.my_organization_ids('{admin}')) and role <> 'owner')
    or user_id = app_private.current_user_id()
  );
create policy memberships_definer_select on app.memberships for select to aibab_definer
  using (true);
create policy memberships_definer_insert on app.memberships for insert to aibab_definer
  with check (true);
