-- LEO-281: teams / members / cycles schema + row level security.
--
-- Design rules that must not be "optimised" away:
--   1. Identity is `auth.uid()`, never the human-readable short name. cycles is
--      keyed by (team_id, owner, cycle_id). `owner` is a uuid handed out by
--      auth and is immutable for the life of the account; `members.member_id`
--      is a display label the user may change at any time. Keying on the label
--      is what would orphan rows on a rename, so the label is not in any key.
--   2. team_id is in the primary key from day one even though there is only one
--      team today. Adding it later means rewriting every policy and migrating
--      the key.
--   3. Read/write separation is enforced by the database, not by the client.
--      The realistic failure is a client bug that mis-computes ownership and
--      overwrites a teammate's row, and that same buggy code is the code that
--      would be "voluntarily" respecting the rule.
--   4. The client may only ever use the anon key. service_role bypasses RLS
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
  member_id    text not null,          -- 'leon' / 'penguin'; display label only, freely renameable
  display_name text,
  created_at   timestamptz not null default now(),
  -- member_id is unique inside a team so the UI never shows two identical
  -- labels. It is NOT an identity: nothing keys off it, and a rename is a
  -- normal, supported operation.
  -- team_id is null before the member joins a team, and NULLs are distinct in
  -- a unique index, so several unassigned members may share a member_id until
  -- they are actually placed in the same team (where this constraint fires).
  constraint members_team_member_id_key unique (team_id, member_id)
);

create table if not exists public.cycles (
  team_id    uuid not null references public.teams (id),
  owner      uuid not null default auth.uid(),
  cycle_id   text not null,            -- '2026-08-24_8.24-9.6'
  mode       text not null,            -- weekly | biweekly | quarterly (free text on purpose)
  markdown   text not null,
  updated_at timestamptz not null default now(),
  primary key (team_id, owner, cycle_id)
);

-- There is deliberately no member_id column here. It would be a copy of a value
-- the owner can change, so it would either go stale or need a cascade. Resolve
-- owner -> members.member_id at read time instead; the whole team is readable.

-- LEO-284 polls for changes by updated_at within a team.
create index if not exists cycles_team_updated_at_idx
  on public.cycles (team_id, updated_at desc);

-- ---------------------------------------------------------------------------
-- Helpers
--
-- Policies on members cannot subquery members (infinite RLS recursion), so the
-- current user's team is read through a security definer helper. It is STABLE,
-- so inside an UPDATE it observes the row as it was at the start of the
-- statement. That is what makes "you cannot move yourself to another team"
-- enforceable in a WITH CHECK clause.
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

revoke all on function public.current_team_id() from public;
grant execute on function public.current_team_id() to authenticated;

-- ---------------------------------------------------------------------------
-- Signup trigger: every auth.users row gets a members row.
-- member_id / display_name come from raw_user_meta_data, set at sign-up.
--
-- The user controls this metadata, and that is now harmless: member_id is a
-- label, not an identity, so the worst a chosen value can do is collide with a
-- teammate's label at team-assignment time and raise a unique violation. It
-- grants nothing and can be changed afterwards by either party.
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

-- Only your own row. member_id and display_name are freely editable; team_id
-- is not.
--
--   * team_id stays pinned to its current value. It is the only thing standing
--     between a user and another team's data: current_team_id() drives every
--     select policy, so letting a user set team_id would let anyone read any
--     team's cycles by guessing a uuid. Joining a team must stay a privileged
--     operation (see the LEO-282 note in supabase/README.md).
--   * member_id is deliberately NOT pinned. It is a display label; nothing keys
--     off it. cycles are keyed by `owner` (a uuid), so a rename cannot orphan
--     anything. `unique (team_id, member_id)` still prevents renaming yourself
--     onto a label a teammate is currently using — that fails with 23505, which
--     is a rejected write, not corruption.
drop policy if exists members_update_self on public.members;
create policy members_update_self on public.members
  for update to authenticated
  using (user_id = auth.uid())
  with check (
    user_id = auth.uid()
    and team_id is not distinct from public.current_team_id()
  );

-- No delete policy on purpose: deleting a members row would leave that member's
-- cycles with no label to render while the auth user is still alive. Removing a
-- member is a console operation. auth.users deletion still cascades to members.

-- cycles -------------------------------------------------------------------

drop policy if exists cycles_select_team on public.cycles;
create policy cycles_select_team on public.cycles
  for select to authenticated
  using (team_id = public.current_team_id());

-- Writes are pinned on `owner` and `team_id`. Both conditions are load-bearing,
-- and each covers a different thing:
--
--   * owner = auth.uid() is what makes primary-key squatting impossible now.
--     Under the old text key (team_id, member_id, cycle_id), `owner` was not
--     part of the key, so a client could insert a row it legitimately owned at
--     a coordinate a teammate was about to use, and that teammate's own write
--     would then fail on a unique violation. With `owner` in the key, every key
--     a user is allowed to write already contains their own uid, so the key
--     spaces of two users are disjoint by construction. There is no coordinate
--     A can occupy that B needs. The old third condition (member_id) existed
--     purely to close that hole and is no longer needed — nor possible, since
--     member_id is now mutable and cannot be part of a key.
--
--   * team_id = current_team_id() is still needed, and is NOT implied by the
--     owner check. Without it a user could insert rows they own into a team
--     they do not belong to. They could not read those rows back (the select
--     policy is scoped to their own team), but that team's members could —
--     an injection channel into someone else's read surface. On UPDATE the same
--     condition stops a user dragging their own row out of the team.
--
-- Changing `owner` on an existing row is blocked by the WITH CHECK below, so a
-- user cannot hand a row to a teammate (or take one) by rewriting the column.
drop policy if exists cycles_insert_own on public.cycles;
create policy cycles_insert_own on public.cycles
  for insert to authenticated
  with check (
    owner = auth.uid()
    and team_id = public.current_team_id()
  );

drop policy if exists cycles_update_own on public.cycles;
create policy cycles_update_own on public.cycles
  for update to authenticated
  using (owner = auth.uid())
  with check (
    owner = auth.uid()
    and team_id = public.current_team_id()
  );

drop policy if exists cycles_delete_own on public.cycles;
create policy cycles_delete_own on public.cycles
  for delete to authenticated
  using (owner = auth.uid());

-- ---------------------------------------------------------------------------
-- Team lifecycle RPCs (LEO-283)
--
-- Why these are functions and not policies. Both operations are impossible to
-- express as ordinary client writes under the policies above, and that is the
-- point, not an oversight:
--
--   * Creating a team needs two writes — insert into `teams`, then set the
--     creator's `members.team_id` — and the second one is exactly what RLS
--     pins. Adding an insert policy to `teams` would not help: the creator
--     would end up with a team they cannot join. The two writes have to happen
--     together, inside one transaction, as a privileged role.
--   * Joining needs to change `members.team_id`, which every read policy is
--     computed from (`current_team_id()`). A policy permissive enough to allow
--     a legitimate join is permissive enough to let anyone who guesses a team
--     uuid read that team's cycles. The invite code is what distinguishes the
--     two cases, and a policy cannot check it without also letting the client
--     write the column directly.
--
-- Security rules every function below follows, and why each one matters:
--
--   1. `security definer` + `set search_path = public, pg_temp`. A definer
--      function without a pinned search_path runs attacker-controlled code:
--      the caller sets search_path, plants `members` in a schema of their own,
--      and the function updates that instead. pg_temp is listed last so a
--      temporary table can never shadow a real one.
--   2. The subject is always `auth.uid()`. None of these take a "who" argument,
--      so there is no shape of call that acts on behalf of somebody else, and
--      no argument to get wrong.
--   3. `revoke all ... from public` then `grant execute ... to authenticated`.
--      Postgres grants EXECUTE to PUBLIC by default, which would expose these
--      to the bare `anon` role. They would fail on the auth.uid() check, but
--      an unauthenticated caller should not reach the body at all.
--   4. Every rejection raises. A join that silently did nothing would leave the
--      client showing "joined" while reading an empty team.
--   5. `join_team` only acts while the caller's `team_id is null`, so it cannot
--      be used to hop between teams — a member who wants to move must leave
--      first, which is a visible act with its own audit trail.
--   6. The caller's `members` row is locked (`for update`) before the null
--      check, so two concurrent calls cannot both observe "no team yet".
-- ---------------------------------------------------------------------------

-- Invite codes must not be guessable: the code is the only thing between a
-- stranger and a team's cycles, and there is no rate limiting in front of it.
-- gen_random_uuid() draws from pg_strong_random (a CSPRNG) in PG13+, so this is
-- 128 bits of entropy with no ordering, no timestamp and no sequence — unlike
-- a serial, a slug or anything derived from the team name, all of which let
-- someone who holds one code predict the next.
create or replace function public.new_invite_code()
returns text
language sql
volatile
set search_path = public, pg_temp
as $$
  select replace(gen_random_uuid()::text, '-', '');
$$;

revoke all on function public.new_invite_code() from public;

create or replace function public.create_team(team_name text)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  caller     uuid := auth.uid();
  clean_name text := nullif(btrim(team_name), '');
  existing   uuid;
  new_team   uuid;
  attempt    int;
begin
  if caller is null then
    raise exception 'create_team: not authenticated' using errcode = '28000';
  end if;
  if clean_name is null then
    raise exception 'create_team: team name is required' using errcode = '22023';
  end if;
  if char_length(clean_name) > 64 then
    raise exception 'create_team: team name is longer than 64 characters' using errcode = '22023';
  end if;

  -- Lock the caller's own row first: without it two tabs could both pass the
  -- "not in a team" check and the second insert would strand an empty team.
  select team_id into existing
    from public.members
   where user_id = caller
     for update;

  if not found then
    raise exception 'create_team: no members row for this account' using errcode = 'P0002';
  end if;
  if existing is not null then
    raise exception 'create_team: caller already belongs to a team' using errcode = 'P0001';
  end if;

  -- Retry only on invite-code collision (23505 on teams.invite_code). At 128
  -- bits this never happens; the loop is here so that if it somehow did, the
  -- user sees a team rather than an error.
  for attempt in 1..5 loop
    begin
      insert into public.teams (name, invite_code, created_by)
      values (clean_name, public.new_invite_code(), caller)
      returning id into new_team;
      exit;
    exception when unique_violation then
      if attempt = 5 then
        raise exception 'create_team: could not allocate a unique invite code' using errcode = 'P0001';
      end if;
    end;
  end loop;

  -- Same transaction as the insert. This is the half a client cannot do.
  update public.members set team_id = new_team where user_id = caller;

  return new_team;
end;
$$;

revoke all on function public.create_team(text) from public;
grant execute on function public.create_team(text) to authenticated;

create or replace function public.join_team(code text)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  caller     uuid := auth.uid();
  clean_code text := nullif(btrim(code), '');
  existing   uuid;
  target     uuid;
begin
  if caller is null then
    raise exception 'join_team: not authenticated' using errcode = '28000';
  end if;
  if clean_code is null then
    raise exception 'join_team: invite code is required' using errcode = '22023';
  end if;

  select team_id into existing
    from public.members
   where user_id = caller
     for update;

  if not found then
    raise exception 'join_team: no members row for this account' using errcode = 'P0002';
  end if;
  -- The team-hopping guard. Without it, a member of team A who obtains team B's
  -- code could move across, and (worse) move back, using the RPC to do exactly
  -- what the RLS pin on members.team_id exists to prevent.
  if existing is not null then
    raise exception 'join_team: caller already belongs to a team; leave it first' using errcode = 'P0001';
  end if;

  select id into target from public.teams where invite_code = clean_code;
  -- A wrong code is an error, never a no-op. The message deliberately does not
  -- say whether the code exists but is unusable versus does not exist at all.
  if target is null then
    raise exception 'join_team: invalid invite code' using errcode = '22023';
  end if;

  begin
    update public.members set team_id = target where user_id = caller;
  exception when unique_violation then
    -- unique (team_id, member_id): somebody in that team already shows this
    -- label. Rejected, not silently renamed.
    raise exception 'join_team: your display label is already used in that team; rename yourself first'
      using errcode = '23505';
  end;

  return target;
end;
$$;

revoke all on function public.join_team(text) from public;
grant execute on function public.join_team(text) to authenticated;

-- Leaving is the inverse of joining and grants nothing: it can only clear the
-- caller's own team_id, and afterwards current_team_id() is null, so every read
-- policy matches nothing. It exists because the same RLS pin that blocks
-- joining blocks leaving, and a UI that can join but not leave traps the user.
--
-- Cycles already pushed to the old team are intentionally left in place: they
-- belong to that team's shared history, and the caller can still delete their
-- own rows (cycles_delete_own) before leaving if they want them gone.
create or replace function public.leave_team()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  caller uuid := auth.uid();
begin
  if caller is null then
    raise exception 'leave_team: not authenticated' using errcode = '28000';
  end if;
  update public.members set team_id = null where user_id = caller;
  if not found then
    raise exception 'leave_team: no members row for this account' using errcode = 'P0002';
  end if;
end;
$$;

revoke all on function public.leave_team() from public;
grant execute on function public.leave_team() to authenticated;

-- Rotating the invite code is the only way to undo a leaked one, and `teams`
-- has no update policy, so it is a function too. Restricted to a current member
-- of that team, and it takes no team argument, so it can only ever affect the
-- caller's own team.
create or replace function public.rotate_invite_code()
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  caller   uuid := auth.uid();
  my_team  uuid;
  new_code text;
  attempt  int;
begin
  if caller is null then
    raise exception 'rotate_invite_code: not authenticated' using errcode = '28000';
  end if;

  select team_id into my_team from public.members where user_id = caller;
  if my_team is null then
    raise exception 'rotate_invite_code: caller does not belong to a team' using errcode = 'P0001';
  end if;

  for attempt in 1..5 loop
    begin
      new_code := public.new_invite_code();
      update public.teams set invite_code = new_code where id = my_team;
      return new_code;
    exception when unique_violation then
      if attempt = 5 then
        raise exception 'rotate_invite_code: could not allocate a unique invite code' using errcode = 'P0001';
      end if;
    end;
  end loop;
  return new_code;
end;
$$;

revoke all on function public.rotate_invite_code() from public;
grant execute on function public.rotate_invite_code() to authenticated;

-- ---------------------------------------------------------------------------
-- Retired helper.
--
-- current_member_id() only ever existed to pin the text short name in the
-- cycles write policies and in members_update_self. Both pins are gone, so the
-- function has no callers. Dropped last, after the policies above have been
-- recreated, so that re-running this file over an earlier draft of the schema
-- does not trip a dependency error.
-- ---------------------------------------------------------------------------

drop function if exists public.current_member_id();
