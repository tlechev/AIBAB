-- =============================================================================
-- Organization settings: booking_settings, assistant_profiles
-- One row per organization, created by app.create_organization().
-- Members read; owners and admins update. No direct INSERT/DELETE.
-- =============================================================================

create type app.slot_mode as enum ('time_window', 'exact_time');
create type app.assistant_tone as enum ('formal', 'friendly');

-- Validates booking time windows: a JSON array (max 12) of objects with exactly
-- the string keys "start" and "end" in HH:MM (local time). start is 00:00-23:59,
-- end is 00:01-24:00, start < end, sorted ascending and non-overlapping
-- (touching is allowed). Mirrors src/lib/booking/time-windows.ts.
create function app_private.is_valid_time_windows(p_windows jsonb)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_item     jsonb;
  v_start    time;
  v_end      time;
  v_prev_end time;
begin
  if p_windows is null or jsonb_typeof(p_windows) <> 'array' or jsonb_array_length(p_windows) > 12 then
    return false;
  end if;

  for v_item in select e.value from jsonb_array_elements(p_windows) with ordinality as e(value, ord) order by e.ord loop
    if jsonb_typeof(v_item) <> 'object'
       or (select count(*) from jsonb_object_keys(v_item)) <> 2
       or jsonb_typeof(v_item -> 'start') is distinct from 'string'
       or jsonb_typeof(v_item -> 'end') is distinct from 'string' then
      return false;
    end if;
    if (v_item ->> 'start') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
       or (v_item ->> 'end') !~ '^(([01][0-9]|2[0-3]):[0-5][0-9]|24:00)$' then
      return false;
    end if;

    v_start := (v_item ->> 'start')::time;
    v_end := (v_item ->> 'end')::time;
    if v_start >= v_end or (v_prev_end is not null and v_start < v_prev_end) then
      return false;
    end if;
    v_prev_end := v_end;
  end loop;

  return true;
end
$$;

revoke all on function app_private.is_valid_time_windows(jsonb) from public;
-- CHECK constraints execute the function with the privileges of the writing role.
grant execute on function app_private.is_valid_time_windows(jsonb) to aibab_user, aibab_definer;

create table app.booking_settings (
  organization_id           uuid primary key references app.organizations (id) on delete cascade,
  slot_mode                 app.slot_mode not null default 'time_window',
  time_windows              jsonb not null default '[]'::jsonb,
  capacity_per_slot         integer not null default 1,
  min_notice_hours          integer not null default 2,
  max_days_ahead            integer not null default 30,
  auto_confirm_appointments boolean not null default false,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  constraint booking_settings_time_windows_check check (app_private.is_valid_time_windows(time_windows)),
  constraint booking_settings_capacity_check check (capacity_per_slot between 1 and 100),
  constraint booking_settings_min_notice_check check (min_notice_hours between 0 and 720),
  constraint booking_settings_max_days_ahead_check check (max_days_ahead between 1 and 365)
);

comment on column app.booking_settings.auto_confirm_appointments is
  'D3: the assistant creates appointment requests; staff confirm unless this is enabled.';

create table app.assistant_profiles (
  organization_id                uuid primary key references app.organizations (id) on delete cascade,
  assistant_name                 text not null,
  greeting                       text,
  tone                           app.assistant_tone not null default 'friendly',
  custom_instructions            text,
  handoff_keywords               text[] not null default '{}',
  handoff_outside_business_hours boolean not null default true,
  is_enabled                     boolean not null default false,
  created_at                     timestamptz not null default now(),
  updated_at                     timestamptz not null default now(),
  constraint assistant_profiles_name_check
    check (char_length(assistant_name) between 1 and 60
           and assistant_name = btrim(assistant_name)
           and assistant_name !~ '[[:cntrl:]]'),
  constraint assistant_profiles_greeting_check check (greeting is null or char_length(greeting) <= 500),
  constraint assistant_profiles_custom_instructions_check
    check (custom_instructions is null or char_length(custom_instructions) <= 4000),
  constraint assistant_profiles_handoff_keywords_check
    check (cardinality(handoff_keywords) <= 50
           and array_position(handoff_keywords, null) is null
           and char_length(array_to_string(handoff_keywords, '')) <= 3000)
);

comment on table app.assistant_profiles is
  'Company-configured assistant persona (D6). Model choice and token limits are platform-controlled, not stored here.';

do $$
declare
  t text;
begin
  foreach t in array array['booking_settings', 'assistant_profiles'] loop
    execute format('create trigger %1$s_set_created_timestamps before insert on app.%1$I
                      for each row execute function app_private.set_created_timestamps()', t);
    execute format('create trigger %1$s_set_updated_at before update on app.%1$I
                      for each row execute function app_private.set_updated_at()', t);

    execute format('grant select, update on app.%I to aibab_user', t);
    execute format('grant insert on app.%I to aibab_definer', t);
    execute format('alter table app.%I enable row level security', t);

    execute format('create policy %1$s_select on app.%1$I for select to aibab_user
                      using (organization_id in (select app_private.my_organization_ids()))', t);
    execute format('create policy %1$s_update on app.%1$I for update to aibab_user
                      using (organization_id in (select app_private.my_organization_ids(''{owner,admin}'')))
                      with check (organization_id in (select app_private.my_organization_ids(''{owner,admin}'')))', t);
    execute format('create policy %1$s_definer_insert on app.%1$I for insert to aibab_definer
                      with check (true)', t);
  end loop;
end
$$;

-- organization_id is the primary key here; updating it is not granted, but the
-- trigger keeps the rule uniform with the other tenant tables.
create trigger booking_settings_prevent_organization_id_change before update on app.booking_settings
  for each row execute function app_private.prevent_organization_id_change();
create trigger assistant_profiles_prevent_organization_id_change before update on app.assistant_profiles
  for each row execute function app_private.prevent_organization_id_change();

-- -----------------------------------------------------------------------------
-- create_organization(): final signature, also creates the settings rows.
-- The previous version is owned by aibab_definer, so it is dropped as that role.
-- -----------------------------------------------------------------------------
set role aibab_definer;
drop function app.create_organization(text, text, app.industry, text, text, text, text);
reset role;

create function app.create_organization(
  p_name           text,
  p_slug           text,
  p_industry       app.industry,
  p_country_code   text,
  p_default_locale text,
  p_timezone       text,
  p_currency       text,
  p_assistant_name text
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

  -- Validation: CHECK constraints on each table + the timezone trigger.
  insert into app.organizations (id, name, slug, industry, country_code, default_locale, timezone, currency)
  values (v_org, btrim(p_name), lower(btrim(p_slug)), p_industry, upper(btrim(p_country_code)),
          btrim(p_default_locale), btrim(p_timezone), upper(btrim(p_currency)));

  -- Fails with 23503 if the user has no profile (i.e. does not exist in auth.users).
  insert into app.memberships (organization_id, user_id, role) values (v_org, v_user, 'owner');

  insert into app.booking_settings (organization_id) values (v_org);
  insert into app.assistant_profiles (organization_id, assistant_name) values (v_org, btrim(p_assistant_name));

  return v_org;
end
$$;

revoke all on function app.create_organization(text, text, app.industry, text, text, text, text, text) from public;
grant execute on function app.create_organization(text, text, app.industry, text, text, text, text, text) to aibab_user;

grant create on schema app to aibab_definer;
alter function app.create_organization(text, text, app.industry, text, text, text, text, text) owner to aibab_definer;
revoke create on schema app from aibab_definer;
