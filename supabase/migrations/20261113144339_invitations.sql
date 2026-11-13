-- =============================================================================
-- Invitations
--
-- Only a SHA-256 hash of the invitation token is stored; the token itself is
-- sent to the invitee and never persisted. Tokens are generated only inside the
-- database by app.create_invitation(); end users can neither read nor supply
-- token_hash, so a revoked token can never be re-issued. Accepting an
-- invitation (creating the membership) will be a SECURITY DEFINER function in a
-- later task.
-- =============================================================================

create table app.invitations (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references app.organizations (id) on delete cascade,
  email           text not null,
  role            app.member_role not null,
  token_hash      text not null,
  invited_by      uuid not null,
  expires_at      timestamptz not null,
  accepted_at     timestamptz,
  revoked_at      timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint invitations_organization_id_id_key unique (organization_id, id),
  constraint invitations_token_hash_key unique (token_hash),
  -- Ownership is never granted by invitation; owners promote members explicitly.
  constraint invitations_role_check check (role in ('admin', 'staff')),
  constraint invitations_email_check
    check (char_length(email) <= 254
           and email = lower(btrim(email))
           and email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  constraint invitations_token_hash_check check (token_hash ~ '^[0-9a-f]{64}$'),
  constraint invitations_expiry_check
    check (expires_at > created_at and expires_at <= created_at + interval '30 days'),
  constraint invitations_state_check check (accepted_at is null or revoked_at is null),
  -- The inviter must be a member of the same organization (composite FK; FK
  -- checks are independent of RLS). Pending invitations go away with the inviter.
  constraint invitations_invited_by_fkey foreign key (organization_id, invited_by)
    references app.memberships (organization_id, user_id) on delete cascade
);

-- At most one pending invitation per email and organization.
create unique index invitations_pending_email_key on app.invitations (organization_id, email)
  where accepted_at is null and revoked_at is null;

create index invitations_invited_by_idx on app.invitations (organization_id, invited_by);

create trigger invitations_set_created_timestamps before insert on app.invitations
  for each row execute function app_private.set_created_timestamps();
create trigger invitations_set_updated_at before update on app.invitations
  for each row execute function app_private.set_updated_at();
create trigger invitations_prevent_organization_id_change before update on app.invitations
  for each row execute function app_private.prevent_organization_id_change();

-- Revocation is one-way and server-timed. Defense in depth: holds even for
-- roles that bypass RLS. (The RLS policy below already limits aibab_user to
-- "active → revoked".)
create function app_private.enforce_invitation_revocation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.revoked_at is not null and new.revoked_at is distinct from old.revoked_at then
    raise exception 'invitation revocation is irreversible' using errcode = '42501';
  end if;
  if old.revoked_at is null and new.revoked_at is not null then
    new.revoked_at := now();
  end if;
  return new;
end
$$;

revoke all on function app_private.enforce_invitation_revocation() from public;

create trigger invitations_enforce_revocation before update of revoked_at on app.invitations
  for each row execute function app_private.enforce_invitation_revocation();

-- -----------------------------------------------------------------------------
-- create_invitation(): the only way to create an invitation.
-- Generates the token from the server's strong RNG (two v4 UUIDs = 244 random
-- bits), stores only its SHA-256 and returns the plaintext token exactly once.
-- The caller must be an owner/admin of the organization; invited_by is always
-- the caller. Remaining validation: table CHECK constraints and indexes.
-- -----------------------------------------------------------------------------
create function app.create_invitation(
  p_organization_id uuid,
  p_email           text,
  p_role            app.member_role,
  p_expires_in_days integer default 7
)
returns table (invitation_id uuid, token text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user  uuid := app_private.current_user_id();
  v_id    uuid := gen_random_uuid();
  v_token text;
begin
  if v_user is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  if p_organization_id is null
     or p_organization_id not in (select app_private.my_organization_ids('{owner,admin}')) then
    raise exception 'not allowed to invite members to this organization' using errcode = '42501';
  end if;
  if p_expires_in_days is null or p_expires_in_days not between 1 and 30 then
    raise exception 'invitation expiry must be between 1 and 30 days' using errcode = '22023';
  end if;

  v_token := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');

  insert into app.invitations (id, organization_id, email, role, token_hash, invited_by, expires_at)
  values (v_id, p_organization_id, lower(btrim(p_email)), p_role,
          encode(sha256(convert_to(v_token, 'UTF8')), 'hex'), v_user,
          now() + make_interval(days => p_expires_in_days));

  return query select v_id, v_token;
end
$$;

revoke all on function app.create_invitation(uuid, text, app.member_role, integer) from public;
grant execute on function app.create_invitation(uuid, text, app.member_role, integer) to aibab_user;

grant create on schema app to aibab_definer;
alter function app.create_invitation(uuid, text, app.member_role, integer) owner to aibab_definer;
revoke create on schema app from aibab_definer;

-- -----------------------------------------------------------------------------
-- Privileges (F7): aibab_user never reads or supplies token_hash.
--   * No table-level SELECT: column-level SELECT on every column except token_hash.
--   * No INSERT: invitations are created only by app.create_invitation().
--   * UPDATE only on revoked_at; DELETE (owners/admins, enforced by RLS).
-- The explicit REVOKE guarantees no table-level privilege survives.
-- -----------------------------------------------------------------------------
revoke all on app.invitations from aibab_user;
grant select (id, organization_id, email, role, invited_by, expires_at,
              accepted_at, revoked_at, created_at, updated_at)
  on app.invitations to aibab_user;
grant update (revoked_at) on app.invitations to aibab_user;
grant delete on app.invitations to aibab_user;

grant insert on app.invitations to aibab_definer;

alter table app.invitations enable row level security;

create policy invitations_select on app.invitations for select to aibab_user
  using (organization_id in (select app_private.my_organization_ids('{owner,admin}')));
-- create_invitation() performs the authorization; this policy only lets its owner insert.
create policy invitations_definer_insert on app.invitations for insert to aibab_definer
  with check (accepted_at is null and revoked_at is null);
-- The only permitted change is revoking an active invitation:
-- USING selects only active rows; WITH CHECK requires the result to be revoked.
create policy invitations_update on app.invitations for update to aibab_user
  using (
    organization_id in (select app_private.my_organization_ids('{owner,admin}'))
    and accepted_at is null
    and revoked_at is null
  )
  with check (
    organization_id in (select app_private.my_organization_ids('{owner,admin}'))
    and revoked_at is not null
  );
create policy invitations_delete on app.invitations for delete to aibab_user
  using (organization_id in (select app_private.my_organization_ids('{owner,admin}')));
