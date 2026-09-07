# Supabase remote (LEO-281)

Local markdown stays the source of truth. This Supabase project is only a
transport channel so teammates can read each other's cycle files. Nothing in
Daily OS should require the remote to be reachable in order to work.

## Identity is a uuid, not a name

`cycles` is keyed by `(team_id, owner, cycle_id)`, where `owner` is `auth.uid()`
— the uuid auth issues once and never changes. `members.member_id` (`leon`,
`penguin`) is a **display label**. It is not identity, nothing keys off it, and
the person it belongs to can change it whenever they like.

The alternative — keying cycles on the short name — was tried first and is worse
in a way that is not obvious until you try to rename someone. The name lives in
two tables at once, so a rename either orphans every existing cycle or needs a
coordinated multi-table update. The only way to make that safe in RLS is to
forbid renaming outright, which trades a normal user action away for an
implementation detail. A uuid key removes the trade: rename freely, the rows are
still yours because they were never filed under your name to begin with.

`cycles` therefore has **no `member_id` column**. To show "penguin's week",
resolve `owner` against `members` at read time — the whole team's `members` rows
are readable, so this is a local join, not a round trip.

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

If you applied an **earlier draft** of this file to a scratch project — the one
where `cycles` had a `member_id` column and was keyed `(team_id, member_id,
cycle_id)` — re-running is not enough, and it fails *silently*: `create table if
not exists` leaves the old table untouched, the run reports success, and you end
up with the new policies bolted onto the old key. Drop the table first and
re-run. Nothing is deployed, so there is nothing to preserve:

```sql
drop table if exists public.cycles;
```

The rest of the file upgrades in place, including dropping the now-unused
`public.current_member_id()`.

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

1. Each person signs up normally (email + password). Pass a starting label in
   the signup metadata so the trigger can pick it up:

   ```json
   { "member_id": "leon", "display_name": "Leon" }
   ```

   With `supabase-js` that is the `options.data` field of `signUp`. If the
   metadata is missing, the trigger falls back to the email local part.

   The user controls this metadata, and that is fine. `member_id` is a label,
   grants nothing, and is not a key — the account's identity is the uuid auth
   assigns. The worst a chosen value can do is collide with a teammate's label
   at step 4 and raise a unique violation, which is a rejected statement rather
   than something to clean up. Either person can then just rename.

2. Confirm the `members` rows exist (the `on_auth_user_created` trigger creates
   them automatically), and note the uuids:

   ```sql
   select user_id, member_id, display_name, team_id from public.members;
   ```

3. Create the team, in the SQL Editor. Address people by `user_id`, not by
   label:

   ```sql
   insert into public.teams (name, invite_code, created_by)
   values ('daily-os', 'pick-a-long-random-string', '<leon-user-id-uuid>')
   returning id;
   ```

4. Put both people in it:

   ```sql
   update public.members
      set team_id = (select id from public.teams where invite_code = 'pick-a-long-random-string')
    where user_id in ('<leon-user-id-uuid>', '<penguin-user-id-uuid>');
   ```

   `members` has `unique (team_id, member_id)`, so two people cannot end up
   showing the same label inside one team. If this statement fails with a unique
   violation, rename one of them first — that is now a one-line update with no
   consequences elsewhere.

Adding a third person later is the same kind of console operation. **Renaming is
not**: anyone can change their own `member_id` from the client at any time, and
their cycles follow them, because those rows are filed under `owner`.

## What the policies guarantee

| Table | Read | Write |
| --- | --- | --- |
| `teams` | Only your own team's row. | Nobody. Console only. |
| `members` | Your own row, plus everyone in your team. | Your own row: `member_id` and `display_name` are yours to change. `team_id` is pinned. No deletes. |
| `cycles` | Every row belonging to your team. | Only rows where `owner = auth.uid()` **and** `team_id` is your team. |

Both conditions on `cycles` writes are load-bearing, and they cover different
things.

`owner = auth.uid()` is what makes primary-key squatting impossible. Under the
old text key `(team_id, member_id, cycle_id)`, `owner` was not part of the key,
so a client with a broken ownership calculation could insert a row it genuinely
owned at a coordinate a teammate was about to use — and that teammate's own
write would then fail on a unique violation. Now `owner` *is* in the key, and the
policy forces it to the caller's uid, so the set of keys a user can write is
exactly the set containing their own uid. Two users' key spaces cannot intersect.
The third condition that used to close this hole is gone because the hole is
gone, not because it was relaxed.

`team_id = public.current_team_id()` does not follow from the owner check and is
still required. Without it a user could insert rows they legitimately own into a
team they do not belong to. They could not read them back — `cycles_select_team`
is scoped to their own team — but that team's members could: an injection channel
into somebody else's read surface. On `UPDATE` the same condition stops a user
dragging their own row out of the team.

`WITH CHECK` also blocks rewriting `owner` on an existing row, so a user can
neither hand a row to a teammate nor take one.

`team_id` on `members` stays pinned for a separate reason: `current_team_id()`
is the input to every read policy, so letting a user set it is letting them read
any team. Unpinning `member_id` does not weaken that — the two columns were
pinned in the same clause but never for the same reason.

Unauthenticated requests match no policy at all: every policy is scoped to the
`authenticated` role, so a bare anon key with no session reads and writes
nothing.

### What renaming still cannot do

`unique (team_id, member_id)` means you cannot rename yourself onto a label a
teammate is currently using. It does **not** stop you taking a label a teammate
used to have. That is a UI-level confusion at worst — no row changes hands,
because nothing is filed under the label — but it is a reason for the client to
render from `owner` and treat `member_id` as presentation.

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

- the signup trigger produced `members` rows from the signup metadata;
- A and B are in the same team and can read each other;
- A can write and delete their own cycle, and `owner` defaults to A's uuid;
- `updated_at` is refreshed by the trigger and cannot be backdated by the client;
- **A can rename their own `member_id`, and afterwards still owns and can still
  write every cycle they had before the rename** — the check the old text key
  could not have passed;
- A cannot rename onto B's current label;
- A cannot update B's cycle, insert into B's key space, forge `owner`, or hand
  one of their own rows to B;
- A cannot move themselves into another team, nor edit B's `members` row;
- A reads nothing from a foreign team, and cannot insert or move a cycle into one
  (all three only when `SUPABASE_TEST_OTHER_TEAM_ID` is set);
- a bare anon key with no session reads nothing.

**When the required variables are absent the script exits 0 and prints `SKIPPED`
with the exact list of missing variables.** A skip is not a pass — nothing about
the remote has been checked. Do not read a green exit code as verification
unless the output says `passed` with zero skips.

The script writes one throwaway cycle row under user A's own identity and deletes
it afterwards, and it renames user A's `member_id` and puts it back. Both are
user A's own data and neither touches user B, but point the script at a scratch
project if that bothers you. If it dies between the two rename steps, A is left
with a `-renamed-<suffix>` label; set it back by hand.

## Open question for LEO-282 (auth)

Team joining is console-only today. When self-service signup arrives, the right
shape is probably a `security definer` RPC — `join_team(invite_code)` — that
sets `members.team_id` once, for the caller, only while it is still null. That
keeps the `team_id` pin in RLS intact while giving `teams.invite_code` (which is
currently unused) a purpose. It is deliberately not built yet.
