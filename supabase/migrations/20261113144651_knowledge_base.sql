-- =============================================================================
-- Knowledge base: services, FAQ, service areas, business hours
--
-- Members read; owners and admins write. Every table carries organization_id,
-- exposes (organization_id, id) as a composite FK target, and forbids moving
-- rows between organizations. Prices use the organization's currency
-- (one currency per organization, ADR-006) and are integer cents (ADR-003).
-- =============================================================================

create extension if not exists btree_gist with schema extensions;

create type app.price_unit as enum ('job', 'hour', 'unit', 'square_meter', 'linear_meter');

-- Note: no custom range type. On Supabase, the constructor functions that
-- CREATE TYPE ... AS RANGE generates are owned by supabase_admin with default
-- PUBLIC EXECUTE, which postgres cannot revoke. The exclusion constraint below
-- uses the built-in tsrange on a fixed date instead ('24:00' = next midnight).

-- -----------------------------------------------------------------------------
-- services
-- -----------------------------------------------------------------------------
create table app.services (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid not null references app.organizations (id) on delete cascade,
  name                text not null,
  description         text,
  price_from_cents    integer,
  price_to_cents      integer,
  price_unit          app.price_unit not null default 'job',
  duration_minutes    integer,
  requires_inspection boolean not null default false,
  is_active           boolean not null default true,
  sort_order          integer not null default 0,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint services_organization_id_id_key unique (organization_id, id),
  constraint services_name_check
    check (char_length(name) between 1 and 200 and name = btrim(name) and name !~ '[[:cntrl:]]'),
  constraint services_description_check check (description is null or char_length(description) <= 4000),
  constraint services_price_from_check check (price_from_cents is null or price_from_cents >= 0),
  constraint services_price_range_check
    check (price_to_cents is null or (price_from_cents is not null and price_to_cents >= price_from_cents)),
  constraint services_duration_check check (duration_minutes is null or duration_minutes between 1 and 10080),
  constraint services_sort_order_check check (sort_order between 0 and 10000)
);

create unique index services_organization_id_name_key on app.services (organization_id, lower(name));

-- -----------------------------------------------------------------------------
-- faq_entries
-- -----------------------------------------------------------------------------
create table app.faq_entries (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references app.organizations (id) on delete cascade,
  question        text not null,
  answer          text not null,
  service_id      uuid,
  is_active       boolean not null default true,
  sort_order      integer not null default 0,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint faq_entries_organization_id_id_key unique (organization_id, id),
  constraint faq_entries_question_check
    check (char_length(question) between 1 and 500 and question = btrim(question)),
  constraint faq_entries_answer_check check (char_length(answer) between 1 and 4000),
  constraint faq_entries_sort_order_check check (sort_order between 0 and 10000),
  -- A FAQ entry may only reference a service of the same organization.
  -- SET NULL clears service_id only, never organization_id.
  constraint faq_entries_service_fkey foreign key (organization_id, service_id)
    references app.services (organization_id, id) on delete set null (service_id)
);

create index faq_entries_service_idx on app.faq_entries (organization_id, service_id);

-- -----------------------------------------------------------------------------
-- service_areas
-- -----------------------------------------------------------------------------
create table app.service_areas (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references app.organizations (id) on delete cascade,
  name            text not null,
  notes           text,
  is_active       boolean not null default true,
  sort_order      integer not null default 0,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint service_areas_organization_id_id_key unique (organization_id, id),
  constraint service_areas_name_check
    check (char_length(name) between 1 and 120 and name = btrim(name) and name !~ '[[:cntrl:]]'),
  constraint service_areas_notes_check check (notes is null or char_length(notes) <= 1000),
  constraint service_areas_sort_order_check check (sort_order between 0 and 10000)
);

create unique index service_areas_organization_id_name_key on app.service_areas (organization_id, lower(name));

-- -----------------------------------------------------------------------------
-- business_hours: local time in the organization's time zone.
-- An interval never crosses midnight; overnight work is two rows
-- (e.g. Mon 22:00-24:00 and Tue 00:00-02:00). Overlaps are rejected by an
-- exclusion constraint (safe under concurrent inserts); touching intervals
-- such as 09:00-12:00 and 12:00-13:00 are allowed.
-- -----------------------------------------------------------------------------
create table app.business_hours (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references app.organizations (id) on delete cascade,
  weekday         smallint not null,
  opens_at        time not null,
  closes_at       time not null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint business_hours_organization_id_id_key unique (organization_id, id),
  constraint business_hours_weekday_check check (weekday between 1 and 7),
  constraint business_hours_interval_check check (opens_at < closes_at),
  constraint business_hours_no_overlap exclude using gist (
    organization_id with =,
    weekday with =,
    tsrange(date '2000-01-01' + opens_at, date '2000-01-01' + closes_at, '[)') with &&
  )
);

-- -----------------------------------------------------------------------------
-- Triggers, privileges and RLS (same pattern for all four tables)
-- -----------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array['services', 'faq_entries', 'service_areas', 'business_hours'] loop
    execute format('create trigger %1$s_set_created_timestamps before insert on app.%1$I
                      for each row execute function app_private.set_created_timestamps()', t);
    execute format('create trigger %1$s_set_updated_at before update on app.%1$I
                      for each row execute function app_private.set_updated_at()', t);
    execute format('create trigger %1$s_prevent_organization_id_change before update on app.%1$I
                      for each row execute function app_private.prevent_organization_id_change()', t);

    execute format('grant select, insert, update, delete on app.%I to aibab_user', t);
    execute format('alter table app.%I enable row level security', t);

    execute format('create policy %1$s_select on app.%1$I for select to aibab_user
                      using (organization_id in (select app_private.my_organization_ids()))', t);
    execute format('create policy %1$s_insert on app.%1$I for insert to aibab_user
                      with check (organization_id in (select app_private.my_organization_ids(''{owner,admin}'')))', t);
    execute format('create policy %1$s_update on app.%1$I for update to aibab_user
                      using (organization_id in (select app_private.my_organization_ids(''{owner,admin}'')))
                      with check (organization_id in (select app_private.my_organization_ids(''{owner,admin}'')))', t);
    execute format('create policy %1$s_delete on app.%1$I for delete to aibab_user
                      using (organization_id in (select app_private.my_organization_ids(''{owner,admin}'')))', t);
  end loop;
end
$$;
