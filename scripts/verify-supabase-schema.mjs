#!/usr/bin/env node
/**
 * LEO-281 verification: run the RLS assertions against a real Supabase project.
 *
 * This talks to the project over plain HTTP (PostgREST + GoTrue) so it needs no
 * dependencies. It only ever uses the anon key plus two signed-in test users,
 * which is exactly the surface a client has.
 *
 * Required environment:
 *   SUPABASE_URL                  https://<ref>.supabase.co
 *   SUPABASE_ANON_KEY             anon / publishable key
 *   SUPABASE_TEST_A_EMAIL         member A (e.g. leon)
 *   SUPABASE_TEST_A_PASSWORD
 *   SUPABASE_TEST_B_EMAIL         member B in the SAME team (e.g. penguin)
 *   SUPABASE_TEST_B_PASSWORD
 *
 * Optional:
 *   SUPABASE_TEST_OTHER_TEAM_ID   uuid of a team A does not belong to. Without
 *                                 it the cross-team read assertion is skipped
 *                                 rather than silently passing.
 *
 * When the required variables are missing the script exits 0 and prints exactly
 * which ones were absent. It never reports success for checks it did not run.
 */

const REQUIRED = [
  'SUPABASE_URL',
  'SUPABASE_ANON_KEY',
  'SUPABASE_TEST_A_EMAIL',
  'SUPABASE_TEST_A_PASSWORD',
  'SUPABASE_TEST_B_EMAIL',
  'SUPABASE_TEST_B_PASSWORD',
];

const missing = REQUIRED.filter((name) => !process.env[name]);
if (missing.length > 0) {
  console.log('SKIPPED: Supabase verification did not run.');
  console.log(`Reason: missing environment variable(s): ${missing.join(', ')}`);
  console.log('');
  console.log('This is a skip, not a pass. Nothing about the remote schema or its');
  console.log('RLS policies has been verified. See supabase/README.md for how to');
  console.log('create the two test users and export these variables.');
  process.exit(0);
}

const BASE = process.env.SUPABASE_URL.replace(/\/+$/, '');
const ANON = process.env.SUPABASE_ANON_KEY;
const OTHER_TEAM_ID = process.env.SUPABASE_TEST_OTHER_TEAM_ID || '';

const results = [];
let failed = 0;
let skipped = 0;

function check(name, ok, detail = '') {
  results.push({ name, state: ok ? 'PASS' : 'FAIL', detail });
  if (!ok) failed += 1;
}

function skip(name, reason) {
  results.push({ name, state: 'SKIP', detail: reason });
  skipped += 1;
}

async function signIn(email, password) {
  const res = await fetch(`${BASE}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: ANON, 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    throw new Error(
      `sign-in failed for ${email}: ${res.status} ${body.error_description || body.msg || ''}`,
    );
  }
  return body.access_token;
}

async function rest(token, path, init = {}) {
  const res = await fetch(`${BASE}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: ANON,
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, ok: res.ok, body };
}

/** A write is "blocked" when RLS rejects it or when it silently matches no row. */
function writeBlocked(res) {
  if (res.status === 401 || res.status === 403) return true;
  if (res.status === 409) return true; // conflict on someone else's primary key
  if (res.ok && Array.isArray(res.body) && res.body.length === 0) return true;
  return false;
}

async function main() {
  const tokenA = await signIn(process.env.SUPABASE_TEST_A_EMAIL, process.env.SUPABASE_TEST_A_PASSWORD);
  const tokenB = await signIn(process.env.SUPABASE_TEST_B_EMAIL, process.env.SUPABASE_TEST_B_PASSWORD);

  // --- signup trigger ------------------------------------------------------
  const meB = await rest(tokenB, 'members?select=user_id,team_id,member_id');
  const rowsB = Array.isArray(meB.body) ? meB.body : [];
  const b = rowsB.find((r) => r.user_id) ?? null;
  check('signup trigger created a members row for user B', rowsB.length > 0);

  const meA = await rest(tokenA, 'members?select=user_id,team_id,member_id,display_name');
  const rowsA = Array.isArray(meA.body) ? meA.body : [];
  // Identify A by elimination: A is the row that is not B. Never by member_id,
  // which is exactly the mutable label this schema refuses to treat as identity.
  const a = rowsA.find((r) => r.user_id !== b?.user_id) ?? rowsA[0] ?? null;
  check(
    'signup trigger created a members row for user A',
    rowsA.length > 0 && Boolean(a?.member_id),
    `members visible to A: ${rowsA.length}`,
  );

  const teamA = a?.team_id ?? null;
  const teamB = b?.team_id ?? null;
  check('user A has been assigned to a team', Boolean(teamA), String(teamA));
  check('user A and user B share a team', Boolean(teamA) && teamA === teamB, `${teamA} vs ${teamB}`);

  const uidA = a?.user_id;
  const uidB = b?.user_id;
  const memberIdA = a?.member_id;
  const memberIdB = b?.member_id;

  // --- same-team read ------------------------------------------------------
  check(
    'user A sees every members row in the team',
    rowsA.some((r) => r.user_id === uidB),
    `A sees: ${rowsA.map((r) => r.member_id).join(', ')}`,
  );

  const teamsA = await rest(tokenA, 'teams?select=id');
  check(
    'user A sees exactly one team (their own)',
    Array.isArray(teamsA.body) && teamsA.body.length === 1 && teamsA.body[0].id === teamA,
  );

  // --- own write + updated_at ---------------------------------------------
  const probeCycle = `verify-${Date.now()}`;
  const probeUrl =
    `cycles?team_id=eq.${teamA}&owner=eq.${uidA}&cycle_id=eq.${encodeURIComponent(probeCycle)}`;
  const insertOwn = await rest(tokenA, 'cycles', {
    method: 'POST',
    headers: { prefer: 'return=representation' },
    body: JSON.stringify({
      team_id: teamA,
      cycle_id: probeCycle,
      mode: 'weekly',
      markdown: 'verify probe',
    }),
  });
  check('user A can write their own cycle', insertOwn.ok, `status ${insertOwn.status}`);
  const firstUpdatedAt = Array.isArray(insertOwn.body) ? insertOwn.body[0]?.updated_at : null;
  check(
    'owner defaults to the caller uuid, no member_id column is involved',
    Array.isArray(insertOwn.body) &&
      insertOwn.body[0]?.owner === uidA &&
      !('member_id' in (insertOwn.body[0] || {})),
    `owner ${Array.isArray(insertOwn.body) ? insertOwn.body[0]?.owner : 'n/a'}`,
  );

  if (insertOwn.ok) {
    await new Promise((r) => setTimeout(r, 1100));
    const touched = await rest(tokenA, probeUrl, {
      method: 'PATCH',
      headers: { prefer: 'return=representation' },
      body: JSON.stringify({ markdown: 'verify probe 2', updated_at: '2000-01-01T00:00:00Z' }),
    });
    const secondUpdatedAt = Array.isArray(touched.body) ? touched.body[0]?.updated_at : null;
    check(
      'updated_at is refreshed by the trigger and cannot be backdated',
      Boolean(firstUpdatedAt && secondUpdatedAt) &&
        new Date(secondUpdatedAt).getTime() > new Date(firstUpdatedAt).getTime(),
      `${firstUpdatedAt} -> ${secondUpdatedAt}`,
    );
  } else {
    skip('updated_at is refreshed by the trigger', 'own-write probe failed, nothing to update');
  }

  // --- renaming yourself is allowed, and does not orphan anything ----------
  // This is the point of keying cycles on `owner` instead of on the short name.
  const renamed = `${memberIdA}-renamed-${Date.now().toString(36)}`;
  const rename = await rest(tokenA, `members?user_id=eq.${uidA}`, {
    method: 'PATCH',
    headers: { prefer: 'return=representation' },
    body: JSON.stringify({ member_id: renamed }),
  });
  check(
    'user A can rename their own member_id',
    rename.ok && Array.isArray(rename.body) && rename.body[0]?.member_id === renamed,
    `status ${rename.status}`,
  );

  if (rename.ok && insertOwn.ok) {
    const afterRename = await rest(tokenA, `${probeUrl}&select=cycle_id,owner,markdown`);
    check(
      "renaming does not orphan user A's existing cycles",
      Array.isArray(afterRename.body) &&
        afterRename.body.length === 1 &&
        afterRename.body[0].owner === uidA,
      `rows found by owner after rename: ${Array.isArray(afterRename.body) ? afterRename.body.length : 'n/a'}`,
    );
    const writeAfterRename = await rest(tokenA, probeUrl, {
      method: 'PATCH',
      headers: { prefer: 'return=representation' },
      body: JSON.stringify({ markdown: 'still mine after the rename' }),
    });
    check(
      'user A can still write those cycles under the new name',
      writeAfterRename.ok && Array.isArray(writeAfterRename.body) && writeAfterRename.body.length === 1,
      `status ${writeAfterRename.status}`,
    );
  } else {
    skip("renaming does not orphan user A's existing cycles", 'rename or own-write probe failed');
    skip('user A can still write those cycles under the new name', 'rename or own-write probe failed');
  }

  // Restore the original label so the script is re-runnable.
  if (rename.ok) {
    await rest(tokenA, `members?user_id=eq.${uidA}`, {
      method: 'PATCH',
      body: JSON.stringify({ member_id: memberIdA }),
    });
  }

  // A rename may not collide with a label a teammate is currently using.
  const collide = await rest(tokenA, `members?user_id=eq.${uidA}`, {
    method: 'PATCH',
    headers: { prefer: 'return=representation' },
    body: JSON.stringify({ member_id: memberIdB }),
  });
  check(
    "user A cannot rename onto user B's label",
    writeBlocked(collide) || collide.status === 409,
    `status ${collide.status}`,
  );

  // --- cross-member write --------------------------------------------------
  const bCycles = await rest(tokenA, `cycles?select=cycle_id&owner=eq.${uidB}&limit=1`);
  const bCycleId = Array.isArray(bCycles.body) ? bCycles.body[0]?.cycle_id : null;

  if (bCycleId) {
    const hijack = await rest(
      tokenA,
      `cycles?team_id=eq.${teamA}&owner=eq.${uidB}&cycle_id=eq.${encodeURIComponent(bCycleId)}`,
      {
        method: 'PATCH',
        headers: { prefer: 'return=representation' },
        body: JSON.stringify({ markdown: 'HIJACKED BY VERIFY SCRIPT' }),
      },
    );
    check(
      "user A cannot update user B's existing cycle",
      writeBlocked(hijack),
      `status ${hijack.status}`,
    );
  } else {
    skip("user A cannot update user B's existing cycle", 'user B has no cycle row to attempt against');
  }

  // The old key-squatting attack, restated for the uuid key: A tries to plant a
  // row at a coordinate owned by B. `owner` is in the primary key, so this is
  // the only way to reach B's key space at all, and the insert policy blocks it.
  const squat = await rest(tokenA, 'cycles', {
    method: 'POST',
    headers: { prefer: 'return=representation' },
    body: JSON.stringify({
      team_id: teamA,
      owner: uidB,
      cycle_id: bCycleId || `squat-${Date.now()}`,
      mode: 'weekly',
      markdown: 'squat',
    }),
  });
  check(
    "user A cannot insert a cycle into user B's key space",
    writeBlocked(squat),
    `status ${squat.status}`,
  );

  const forged = await rest(tokenA, 'cycles', {
    method: 'POST',
    headers: { prefer: 'return=representation' },
    body: JSON.stringify({
      team_id: teamA,
      cycle_id: `forge-${Date.now()}`,
      mode: 'weekly',
      markdown: 'forge',
      owner: uidB,
    }),
  });
  check('user A cannot forge the owner column', writeBlocked(forged), `status ${forged.status}`);

  if (insertOwn.ok) {
    const giveAway = await rest(tokenA, probeUrl, {
      method: 'PATCH',
      headers: { prefer: 'return=representation' },
      body: JSON.stringify({ owner: uidB }),
    });
    check(
      'user A cannot reassign one of their own cycles to user B',
      writeBlocked(giveAway),
      `status ${giveAway.status}`,
    );
  } else {
    skip('user A cannot reassign one of their own cycles to user B', 'own-write probe failed');
  }

  // --- members row is locked down -----------------------------------------
  const switchTeam = await rest(tokenA, `members?user_id=eq.${uidA}`, {
    method: 'PATCH',
    headers: { prefer: 'return=representation' },
    body: JSON.stringify({ team_id: OTHER_TEAM_ID || '00000000-0000-0000-0000-000000000000' }),
  });
  check(
    'user A cannot move themselves into another team',
    writeBlocked(switchTeam) || switchTeam.status === 400,
    `status ${switchTeam.status}`,
  );

  const renameOther = await rest(tokenA, `members?user_id=eq.${uidB}`, {
    method: 'PATCH',
    headers: { prefer: 'return=representation' },
    body: JSON.stringify({ display_name: 'HIJACKED BY VERIFY SCRIPT', member_id: 'hijacked' }),
  });
  check(
    "user A cannot edit user B's members row",
    writeBlocked(renameOther),
    `status ${renameOther.status}`,
  );

  // --- cross-team read -----------------------------------------------------
  if (OTHER_TEAM_ID) {
    const crossCycles = await rest(tokenA, `cycles?select=cycle_id&team_id=eq.${OTHER_TEAM_ID}`);
    check(
      'user A reads nothing from a foreign team',
      Array.isArray(crossCycles.body) && crossCycles.body.length === 0,
      `status ${crossCycles.status}`,
    );
    const crossTeam = await rest(tokenA, `teams?select=id&id=eq.${OTHER_TEAM_ID}`);
    check(
      'user A cannot read a foreign teams row',
      Array.isArray(crossTeam.body) && crossTeam.body.length === 0,
    );

    // This is what the team_id condition on the write policies buys now that
    // member_id is gone: without it A could own a row inside a team A is not in
    // and that team would read it.
    const crossInsert = await rest(tokenA, 'cycles', {
      method: 'POST',
      headers: { prefer: 'return=representation' },
      body: JSON.stringify({
        team_id: OTHER_TEAM_ID,
        cycle_id: `cross-${Date.now()}`,
        mode: 'weekly',
        markdown: 'cross-team injection',
      }),
    });
    check(
      'user A cannot insert a cycle they own into a foreign team',
      writeBlocked(crossInsert),
      `status ${crossInsert.status}`,
    );

    if (insertOwn.ok) {
      const moveTeam = await rest(tokenA, probeUrl, {
        method: 'PATCH',
        headers: { prefer: 'return=representation' },
        body: JSON.stringify({ team_id: OTHER_TEAM_ID }),
      });
      check(
        'user A cannot move their own cycle into a foreign team',
        writeBlocked(moveTeam),
        `status ${moveTeam.status}`,
      );
    } else {
      skip('user A cannot move their own cycle into a foreign team', 'own-write probe failed');
    }
  } else {
    skip(
      'user A reads nothing from a foreign team',
      'SUPABASE_TEST_OTHER_TEAM_ID is not set, so there is no foreign team to read',
    );
    skip('user A cannot read a foreign teams row', 'SUPABASE_TEST_OTHER_TEAM_ID is not set');
    skip(
      'user A cannot insert a cycle they own into a foreign team',
      'SUPABASE_TEST_OTHER_TEAM_ID is not set; a made-up uuid would fail on the foreign key instead of on RLS',
    );
    skip(
      'user A cannot move their own cycle into a foreign team',
      'SUPABASE_TEST_OTHER_TEAM_ID is not set',
    );
  }

  // --- anon key with no session -------------------------------------------
  const anonRead = await fetch(`${BASE}/rest/v1/cycles?select=cycle_id`, {
    headers: { apikey: ANON, authorization: `Bearer ${ANON}` },
  });
  const anonBody = await anonRead.json().catch(() => null);
  check(
    'anon key without a session reads nothing',
    !anonRead.ok || (Array.isArray(anonBody) && anonBody.length === 0),
    `status ${anonRead.status}`,
  );

  // --- cleanup -------------------------------------------------------------
  if (insertOwn.ok) {
    await rest(tokenA, probeUrl, { method: 'DELETE' });
  }
}

main()
  .then(() => {
    for (const r of results) {
      const detail = r.detail ? ` (${r.detail})` : '';
      console.log(`${r.state.padEnd(4)} ${r.name}${detail}`);
    }
    console.log('');
    console.log(
      `${results.length - failed - skipped} passed, ${failed} failed, ${skipped} skipped.`,
    );
    if (skipped > 0) {
      console.log('Skipped checks were NOT verified.');
    }
    process.exit(failed > 0 ? 1 : 0);
  })
  .catch((err) => {
    for (const r of results) {
      console.log(`${r.state.padEnd(4)} ${r.name}`);
    }
    console.error('');
    console.error(`ERROR: verification aborted: ${err.message}`);
    process.exit(1);
  });
