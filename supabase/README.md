# Supabase remote (LEO-281)

Local markdown stays the source of truth. This Supabase project is only a
transport channel so teammates can read each other's cycle files. Nothing in
Daily OS should require the remote to be reachable in order to work.

## The one rule that must never be broken

> **The client may only ever hold the `anon` key. Never ship, embed, commit, or
> paste the `service_role` key into anything that runs on a laptop.**

`service_role` has `BYPASSRLS`. Every policy in this directory becomes a no-op
the moment a client holds that key: any user could read every team's data and
overwrite anybody's rows. The whole point of enforcing read-only access in the
database rather than in client code is that client code is exactly what tends to
get ownership wrong. Handing the client `service_role` throws that away.

`service_role` belongs in two places only: the Supabase dashboard (which already
runs as a privileged role) and a server you control. Neither exists in this
project today.

## Files

| File | What it is |
| --- | --- |
| `migrations/20260907000000_init.sql` | Tables, helper functions, triggers, and every RLS policy. Idempotent — safe to re-run. |
| `../scripts/verify-supabase-schema.mjs` | Asserts the policies actually hold, against a real project. |

## Applying the migration

Using the dashboard (what you want for a two-person setup):

1. Open the Supabase project → **SQL Editor** → **New query**.
2. Paste the entire contents of `migrations/20260907000000_init.sql`.
3. **Run**. It should finish with no errors.
4. Re-running it later is safe; the script drops and recreates its own policies
   and triggers rather than failing on conflicts.

Using the Supabase CLI instead, if you already have it linked:

```bash
supabase db push
```

The migration is intentionally plain SQL with no CLI-only syntax, so both paths
produce the same schema.

## Creating the first team and its members

Team creation and team assignment are **console operations**. There is
deliberately no client-facing path for them: a policy that let a user set their
own `members.team_id` would let anyone join any team by guessing a UUID, which
would defeat the cross-team read protection. See the open question at the bottom.

1. Each person signs up normally (email + password). Pass the identity in the
   signup metadata so the trigger can pick it up:

   ```json
   { "member_id": "leon", "display_name": "Leon" }
   ```

   With `supabase-js` that is the `options.data` field of `signUp`. If the
   metadata is missing, the trigger falls back to the email local part.

2. Confirm the `members` rows exist (the `on_auth_user_created` trigger creates
   them automatically):

   ```sql
   select user_id, member_id, display_name, team_id from public.members;
   ```

3. Create the team, in the SQL Editor:

   ```sql
   insert into public.teams (name, invite_code, created_by)
   values ('daily-os', 'pick-a-long-random-string',
           (select user_id from public.members where member_id = 'leon'))
   returning id;
   ```

4. Put both people in it:

   ```sql
   update public.members
      set team_id = (select id from public.teams where invite_code = 'pick-a-long-random-string')
    where member_id in ('leon', 'penguin');
   ```

   `members` has `unique (team_id, member_id)`, so two people cannot end up
   sharing a `member_id` inside one team. If this statement fails with a unique
   violation, fix the duplicate `member_id` before continuing.

Adding a third person later, or renaming a `member_id`, is the same kind of
console operation. Renaming is disruptive: `cycles.member_id` is a text copy, so
existing rows would be orphaned. Update both tables together if you ever need to.

## What the policies guarantee

| Table | Read | Write |
| --- | --- | --- |
| `teams` | Only your own team's row. | Nobody. Console only. |
| `members` | Your own row, plus everyone in your team. | Your own row, and only `display_name`. `team_id` and `member_id` are pinned. No deletes. |
| `cycles` | Every row belonging to your team. | Only rows where `owner = auth.uid()` **and** `team_id` is your team **and** `member_id` is your own member id. |

The triple condition on `cycles` writes is the important one. Checking `owner`
alone would still let a client with a broken ownership calculation create rows
under a teammate's `(team_id, member_id, cycle_id)` key — squatting the primary
key that teammate is about to use.

Unauthenticated requests match no policy at all: every policy is scoped to the
`authenticated` role, so a bare anon key with no session reads and writes
nothing.

## Running the verification script

The script uses nothing but the anon key and two ordinary user sessions, so it
exercises the same surface a client has. It has no npm dependencies.

```bash
export SUPABASE_URL="https://<project-ref>.supabase.co"
export SUPABASE_ANON_KEY="<anon key>"
export SUPABASE_TEST_A_EMAIL="leon@example.com"
export SUPABASE_TEST_A_PASSWORD="..."
export SUPABASE_TEST_B_EMAIL="penguin@example.com"
export SUPABASE_TEST_B_PASSWORD="..."

# Optional but recommended: a team that user A is NOT a member of.
# Without it the cross-team read check is skipped, not passed.
export SUPABASE_TEST_OTHER_TEAM_ID="<uuid of a second team>"

npm run verify:supabase
```

It checks that:

- the signup trigger produced `members` rows with the metadata identity;
- A and B are in the same team and can read each other;
- A can write and delete their own cycle;
- `updated_at` is refreshed by the trigger and cannot be backdated by the client;
- A cannot update B's cycle, insert a cycle under B's `member_id`, or forge `owner`;
- A cannot move themselves into another team or edit B's `members` row;
- A reads nothing from a foreign team (when `SUPABASE_TEST_OTHER_TEAM_ID` is set);
- a bare anon key with no session reads nothing.

**When the required variables are absent the script exits 0 and prints `SKIPPED`
with the exact list of missing variables.** A skip is not a pass — nothing about
the remote has been checked. Do not read a green exit code as verification
unless the output says `passed` with zero skips.

The script writes one throwaway cycle row under user A's own identity and
deletes it afterwards. Point it at a scratch project if that bothers you.

## Open question for LEO-282 (auth)

Team joining is console-only today. When self-service signup arrives, the right
shape is probably a `security definer` RPC — `join_team(invite_code)` — that
sets `members.team_id` once, for the caller, only while it is still null. That
keeps the `team_id` pin in RLS intact while giving `teams.invite_code` (which is
currently unused) a purpose. It is deliberately not built yet.
