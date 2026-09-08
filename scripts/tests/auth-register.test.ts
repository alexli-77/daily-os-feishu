/**
 * Sign-up, the signed-out welcome page, and the topbar identity.
 *
 * Independent, tsx-runnable:  npx tsx scripts/tests/auth-register.test.ts
 *
 * Before this, `/` bounced to `/dashboard` and on to `/login`, so a visitor's
 * only screen was a password form with no way out of it. The properties worth
 * holding onto are that the root is reachable signed out, that it leaks nothing
 * personal, and that the field validation the form performs is also performed
 * by the endpoint — a client-side check decides what the form looks like and
 * nothing about what gets stored.
 *
 * Driven through the real UI server. Runs entirely inside a temp workspace: no
 * real config, vault or user database is touched.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

let passed = 0;
let failed = 0;
function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const GOOD = { username: 'leon', email: 'leon@example.com', password: 'abcd1234' };

async function main(): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-os-auth-'));
  const vault = path.join(tmp, 'vault');
  fs.mkdirSync(vault, { recursive: true });
  const parsed = yaml.load(fs.readFileSync(path.join(REPO_ROOT, 'config', 'config.example.yaml'), 'utf8')) as Record<string, any>;
  parsed.memory.repository_path = vault;
  fs.mkdirSync(path.join(tmp, 'config'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'config', 'config.yaml'), yaml.dump(parsed), 'utf8');
  fs.writeFileSync(path.join(tmp, '.env'), '');

  const originalCwd = process.cwd();
  process.chdir(tmp);

  const auth = await import('../../src/ui/auth.js');
  const { startUiServer } = await import('../../src/ui/server.js');
  const { pixelAvatarSvg, randomAvatarSeed } = await import('../../src/ui/avatar.js');
  auth.resetSessionCacheForTests();

  const controls = await startUiServer({ configPath: 'config/config.yaml', envPath: '.env', host: '127.0.0.1', port: 0, open: false });
  const base = controls.url;
  const headers = { 'content-type': 'application/json', origin: base };
  const register = async (body: unknown): Promise<{ status: number; body: any; cookie: string }> => {
    const response = await fetch(`${base}/api/register`, { method: 'POST', headers, body: JSON.stringify(body) });
    return { status: response.status, body: (await response.json()) as any, cookie: (response.headers.get('set-cookie') || '').split(';')[0] };
  };

  try {
    // --- the signed-out root ---------------------------------------------------
    const home = await fetch(`${base}/`, { redirect: 'manual' });
    const homeHtml = home.status === 200 ? await home.text() : '';
    check('/ is a page when signed out, not a redirect', home.status === 200, `${home.status} -> ${home.headers.get('location')}`);
    check('it offers sign-up from the top right', homeHtml.includes('id="auth-open"') && homeHtml.includes('注册 / 登录'));
    check('it ships the sign-up dialog', homeHtml.includes('id="auth-modal"') && homeHtml.includes('aria-modal="true"'));
    check('it says what the product is', homeHtml.includes('双周复盘'), homeHtml.slice(0, 120));
    // The whole reason the root was behind a login: it must stay free of the
    // owner's data now that it is not.
    check('it leaks no vault path', !homeHtml.includes(vault), 'vault path on the public page');
    check('it leaks no config or env', !homeHtml.includes('supabase') && !homeHtml.includes('app_secret'));

    const login = await fetch(`${base}/login`, { redirect: 'manual' });
    const loginHtml = await login.text();
    check('/login is no longer a dead end', loginHtml.includes('href="/"'), 'no way back to the welcome page');
    check('/login no longer offers the signed-out console shell', !loginHtml.includes('without signing in'));

    // --- validation, per field -------------------------------------------------
    const cases: Array<[string, Record<string, string>, string]> = [
      ['a malformed email', { ...GOOD, email: 'not-an-email' }, 'email'],
      ['an email with no dot', { ...GOOD, email: 'a@b' }, 'email'],
      ['a password under 8', { ...GOOD, password: 'abc1234' }, 'password'],
      ['a password over 20', { ...GOOD, password: 'a'.repeat(21) }, 'password'],
      ['an illegal username', { ...GOOD, username: 'le on!' }, 'username'],
      ['a missing email', { ...GOOD, email: '' }, 'email'],
      ['a missing password', { ...GOOD, password: '' }, 'password'],
    ];
    for (const [label, body, field] of cases) {
      const result = await register(body);
      check(`the endpoint refuses ${label}`, result.status === 400 && Boolean(result.body?.errors?.[field]), JSON.stringify(result.body));
      check(`  and names the field it is about (${field})`, Object.keys(result.body?.errors || {}).includes(field));
      check(`  and creates nothing`, !result.cookie);
    }

    const boundary = await register({ ...GOOD, password: 'abcd1234'.slice(0, 8) });
    check('exactly 8 characters is accepted', boundary.status === 200, JSON.stringify(boundary.body));

    // --- what a successful sign-up does ---------------------------------------
    check('sign-up returns the account', boundary.body?.ok === true && boundary.body?.username === 'leon');
    check('sign-up signs you in, with no second round trip', Boolean(boundary.cookie), 'no session cookie on the response');

    const cookie = boundary.cookie;
    const dash = await fetch(`${base}/dashboard`, { headers: { cookie }, redirect: 'manual' });
    const dashHtml = dash.status === 200 ? await dash.text() : '';
    check('the session works immediately', dash.status === 200, String(dash.status));

    // --- the topbar -------------------------------------------------------------
    check('the topbar shows an avatar', dashHtml.includes('class="avatar"') && dashHtml.includes('<svg'));
    check('the topbar shows the username', dashHtml.includes('>leon</span>'));
    check('the Setup link is gone', !dashHtml.includes('setup-link') && !dashHtml.includes('>Setup<'));
    check('the role is no longer appended to the name', !dashHtml.includes('· admin'), 'role badge still rendered');

    const rootWhenSignedIn = await fetch(`${base}/`, { headers: { cookie }, redirect: 'manual' });
    check('signed in, the root goes to the dashboard', rootWhenSignedIn.status === 302 && rootWhenSignedIn.headers.get('location') === '/dashboard');

    // --- account rules ----------------------------------------------------------
    const dup = await register({ ...GOOD, email: 'other@example.com' });
    check('a taken username is refused, on the username field', dup.status === 400 && Boolean(dup.body?.errors?.username), JSON.stringify(dup.body));

    const stored = auth.findUser('leon');
    check('the email is stored', stored?.email === GOOD.email, String(stored?.email));
    check('the password is not stored in plaintext', !JSON.stringify(stored).includes(GOOD.password));
    check('an avatar seed is assigned', Boolean(stored?.avatar_seed));
    // Per-device install: whoever registers on a machine owns that machine's
    // config, and the server only ever listens on 127.0.0.1.
    check('a new account is an admin', stored?.role === 'admin', String(stored?.role));

    const secondSeed = auth.findUser('admin')?.avatar_seed;
    check('the bootstrap admin got a seed too', Boolean(secondSeed), 'blank seed renders as a shared avatar');
    check('two accounts do not share an avatar', stored?.avatar_seed !== secondSeed);

    // An account that predates the avatar_seed column carries ''. The renderer
    // falls back to the username for those, so nothing looks broken — which is
    // precisely why this needs asserting: a name-derived avatar changes when
    // the name does, and the stored seed exists to stop that.
    const { dbSetUserAvatarSeed, dbUsersMissingAvatarSeed } = await import('../../src/storage/db.js');
    dbSetUserAvatarSeed('leon', '');
    check('an account with no seed is detected', dbUsersMissingAvatarSeed().includes('leon'));
    auth.ensureAuthInitialized();
    const backfilled = auth.findUser('leon')?.avatar_seed;
    check('startup backfills a seed for it', Boolean(backfilled), 'still empty after ensureAuthInitialized');
    check('and leaves no account without one', dbUsersMissingAvatarSeed().length === 0, dbUsersMissingAvatarSeed().join(','));
    auth.ensureAuthInitialized();
    check('a second start does not reroll it', auth.findUser('leon')?.avatar_seed === backfilled, 'the avatar would change on every restart');
  } finally {
    await controls.stop();
    process.chdir(originalCwd);
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // --- the avatar itself --------------------------------------------------------
  console.log('\n--- pixel avatar ---');
  const { pixelAvatarSvg: draw, randomAvatarSeed: seed } = await import('../../src/ui/avatar.js');
  check('the same seed always draws the same avatar', draw('abc') === draw('abc'));
  check('different seeds draw different avatars', draw('abc') !== draw('abd'));
  check('it is a square SVG on a 5x5 grid', draw('abc').includes('viewBox="0 0 5 5"') && draw('abc', 40).includes('width="40"'));
  check('it stays crisp rather than smoothed', draw('abc').includes('shape-rendering="crispEdges"'));
  check('it is mirrored, so it reads as a face', (() => {
    const xs = [...draw('abc').matchAll(/<rect x="(\d)" y="(\d)"/g)].map((m) => `${m[1]},${m[2]}`);
    return xs.every((cell) => {
      const [x, y] = cell.split(',').map(Number);
      return xs.includes(`${4 - x},${y}`);
    });
  })());

  // The first implementation drew every cell from a rehash of the seed plus its
  // coordinates. It looked fine and produced a blank square 14% of the time.
  const counts = Array.from({ length: 1500 }, () => (draw(seed()).match(/<rect x=/g) || []).length);
  check('no avatar is ever blank', counts.every((n) => n > 0), `min ${Math.min(...counts)}`);
  check('none is a solid block either', counts.every((n) => n < 25), `max ${Math.max(...counts)}`);
  check('none is so sparse it looks broken', counts.every((n) => n >= 4), `min ${Math.min(...counts)}`);
  check('seeds are unique enough to not collide', new Set(Array.from({ length: 500 }, () => seed())).size === 500);

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

void main();
