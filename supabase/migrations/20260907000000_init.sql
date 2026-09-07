-- LEO-281: teams / members / cycles schema + row level security.
--
-- Design rules that must not be "optimised" away:
--   1. cycles is keyed by (team_id, member_id, cycle_id). team_id is in the
--      primary key from day one even though there is only one team today.
--      Adding it later means rewriting every policy and migrating the key.
--   2. Read/write separation is enforced by the database, not by the client.
--      The realistic failure is a client bug that mis-computes ownership and
--      overwrites a teammate's row, and that same buggy code is the code that
--      would be "voluntarily" respecting the rule.
--   3. The client may only ever use the anon key. service_role bypasses RLS
--      and voids everything below. See supabase/README.md.
--
-- Safe to run more than once (idempotent).

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table if not exists public.teams (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  invite_code  text unique not null,
  created_by   uuid not null,
  created_at   timestamptz not null default now()
);

create table if not exists public.members (
  user_id      uuid primary key references auth.users (id) on delete cascade,
  team_id      uuid references public.teams (id),
  member_id    text not null,          -- 'leon' / 'penguin'; shown in the UI and used in local filenames
  display_name text,
  created_at   timestamptz not null default now(),
  -- member_id must be unique inside a team: cycles rows point at it by text.
  -- team_id is null before the member joins a team, and NULLs are distinct in
  -- a unique index, so several unassigned members may share a member_id until
  -- they are actually placed in the same team (where this constraint fires).
  constraint members_team_member_id_key unique (team_id, member_id)
);

create table if not exists public.cycles (
  team_id    uuid not null references public.teams (id),
  member_id  text not null,
  cycle_id   text not null,            -- '2026-08-24_8.24-9.6'
  mode       text not null,            -- weekly | biweekly | quarterly (free text on purpose)
  markdown   text not null,
  updated_at timestamptz not null default now(),
  owner      uuid not null default auth.uid(),
  primary key (team_id, member_id, cycle_id)
);

-- LEO-284 polls for changes by updated_at within a team.
create index if not exists cycles_team_updated_at_idx
  on public.cycles (team_id, updated_at desc);

-- ---------------------------------------------------------------------------
-- Helpers
--
-- Policies on members cannot subquery members (infinite RLS recursion), so the
-- current user's team and member_id are read through security definer helpers.
-- Both are STABLE, so inside an UPDATE they observe the row as it was at the
-- start of the statement. That is what makes "you cannot move yourself to
-- another team" enforceable in a WITH CHECK clause.
-- ---------------------------------------------------------------------------

create or replace function public.current_team_id()
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select team_id from public.members where user_id = auth.uid();
$$;

create or replace function public.current_member_id()
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select member_id from public.members where user_id = auth.uid();
$$;

revoke all on function public.current_team_id() from public;
revoke all on function public.current_member_id() from public;
grant execute on function public.current_team_id() to authenticated;
grant execute on function public.current_member_id() to authenticated;

-- ---------------------------------------------------------------------------
-- Signup trigger: every auth.users row gets a members row.
-- member_id / display_name come from raw_user_meta_data, set at sign-up.
-- ---------------------------------------------------------------------------

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.members (user_id, member_id, display_name)
  values (
    new.id,
    coalesce(
      nullif(trim(new.raw_user_meta_data ->> 'member_id'), ''),
      nullif(split_part(coalesce(new.email, ''), '@', 1), ''),
      'user_' || left(new.id::text, 8)
    ),
    nullif(trim(new.raw_user_meta_data ->> 'display_name'), '')
  )
  on conflict (user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- updated_at maintenance. Set in a trigger so a client cannot backdate it and
-- break LEO-284's polling change detection.
-- ---------------------------------------------------------------------------

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists cycles_touch_updated_at on public.cycles;
create trigger cycles_touch_updated_at
  before update on public.cycles
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Row level security
--
-- Every policy targets the `authenticated` role only. The `anon` role matches
-- no policy at all, so an unauthenticated anon key sees and writes nothing.
-- ---------------------------------------------------------------------------

alter table public.teams   enable row level security;
alter table public.members enable row level security;
alter table public.cycles  enable row level security;

-- teams --------------------------------------------------------------------
-- Read your own team only. Creating / renaming / deleting a team is a console
-- operation for now (see supabase/README.md); no insert, update or delete
-- policy exists, so those are denied for every client.

drop policy if exists teams_select_own on public.teams;
create policy teams_select_own on public.teams
  for select to authenticated
  using (id = public.current_team_id());

-- members ------------------------------------------------------------------

drop policy if exists members_select_team on public.members;
create policy members_select_team on public.members
  for select to authenticated
  using (
    user_id = auth.uid()                     -- always see yourself, even before joining a team
    or team_id = public.current_team_id()    -- and everyone in your team
  );

-- Normally the signup trigger creates this row (security definer, bypasses
-- RLS). This policy only allows a user to backfill their own missing row.
drop policy if exists members_insert_self on public.members;
create policy members_insert_self on public.members
  for insert to authenticated
  with check (user_id = auth.uid());

-- Only your own row, and only display_name is actually mutable:
--   * team_id is pinned to its current value, otherwise anyone could join an
--     arbitrary team by guessing a uuid and read that team's cycles.
--   * member_id is pinned because cycles rows reference it by text; renaming
--     it would orphan every cycle already written.
drop policy if exists members_update_self on public.members;
create policy members_update_self on public.members
  for update to authenticated
  using (user_id = auth.uid())
  with check (
    user_id = auth.uid()
    and team_id is not distinct from public.current_team_id()
    and member_id is not distinct from public.current_member_id()
  );

-- No delete policy on purpose: deleting a members row would orphan that
-- member's cycles while leaving the auth user alive. Removing a member is a
-- console operation. auth.users deletion still cascades.

-- cycles -------------------------------------------------------------------

drop policy if exists cycles_select_team on public.cycles;
create policy cycles_select_team on public.cycles
  for select to authenticated
  using (team_id = public.current_team_id());

-- Writes are pinned on three axes at once. `owner` alone is not enough: a
-- client that mis-computes ownership could otherwise squat a teammate's
-- (team_id, member_id, cycle_id) key with rows owned by itself.
drop policy if exists cycles_insert_own on public.cycles;
create policy cycles_insert_own on public.cycles
  for insert to authenticated
  with check (
    owner = auth.uid()
    and team_id = public.current_team_id()
    and member_id = public.current_member_id()
  );

drop policy if exists cycles_update_own on public.cycles;
create policy cycles_update_own on public.cycles
  for update to authenticated
  using (owner = auth.uid())
  with check (
    owner = auth.uid()
    and team_id = public.current_team_id()
    and member_id = public.current_member_id()
  );

drop policy if exists cycles_delete_own on public.cycles;
create policy cycles_delete_own on public.cycles
  for delete to authenticated
  using (owner = auth.uid());
