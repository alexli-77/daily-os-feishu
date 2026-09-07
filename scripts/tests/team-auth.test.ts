/**
 * Supabase auth + team membership (LEO-282 / LEO-283).
 *
 * Independent, tsx-runnable:  npx tsx scripts/tests/team-auth.test.ts
 *
 * Driven end to end: the real UI server, the real config file, the real session
 * file on disk, against a stub Supabase that mirrors what the SQL in
 * supabase/migrations/20260907000000_init.sql actually enforces (invite code
 * checked, no team hopping, RPCs rejecting rather than silently succeeding).
 * Nothing here matches source text — every assertion is a behaviour.
 *
 * The property this suite exists to protect is the one that is easiest to lose:
 * **the remote may never be able to break the local app.** Unconfigured, signed
 * out, expired, or unreachable, the Cycles page and the other console editors
 * must behave exactly as they do today.
 *
 * Runs entirely inside a temp workspace: no real config, vault or session is
 * touched.
 */
import fs from 'node:fs';
import http from 'node:http';
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

function cookieFrom(setCookie: string | null): string {
  return setCookie ? setCookie.split(';')[0] : '';
}

// --- Stub Supabase ---------------------------------------------------------
// Small on purpose: it only has to reproduce the *decisions* the database makes,
// because those decisions are what the client has to surface correctly.

interface StubUser {
  id: string;
  email: string;
  password: string;
  memberId: string;
  displayName: string;
  teamId: string | null;
}

interface StubTeam {
  id: string;
  name: string;
  inviteCode: string;
  createdBy: string;
}

class StubSupabase {
  readonly users = new Map<string, StubUser>();
  readonly teams = new Map<string, StubTeam>();
  /** access token -> user id. A token missing from here answers 401, like an expired JWT. */
  readonly tokens = new Map<string, string>();
  readonly refreshTokens = new Map<string, string>();
  /** Forced failure for the next refresh calls: 0 = healthy. */
  refreshFailStatus = 0;
  refreshCount = 0;
  private counter = 0;
  private server?: http.Server;
  url = '';

  async start(): Promise<void> {
    this.server = http.createServer((request, response) => {
      void this.handle(request, response);
    });
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    const address = this.server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    this.url = `http://127.0.0.1:${port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }

  private id(prefix: string): string {
    this.counter += 1;
    return `${prefix}-${this.counter}`;
  }

  private issue(user: StubUser): Record<string, unknown> {
    const accessToken = this.id('access');
    const refreshToken = this.id('refresh');
    this.tokens.set(accessToken, user.id);
    this.refreshTokens.set(refreshToken, user.id);
    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_in: 3600,
      token_type: 'bearer',
      user: { id: user.id, email: user.email },
    };
  }

  private userFor(request: http.IncomingMessage): StubUser | null {
    const header = String(request.headers.authorization || '');
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    const userId = this.tokens.get(token);
    return userId ? this.users.get(userId) || null : null;
  }

  private async handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const url = new URL(request.url || '/', this.url);
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    const send = (status: number, payload: unknown): void => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(payload));
    };
    const fail = (status: number, message: string): void => send(status, { message, code: 'STUB' });

    if (url.pathname === '/auth/v1/signup') {
      const email = String(body.email || '');
      if ([...this.users.values()].some((user) => user.email === email)) return fail(400, 'User already registered');
      const meta = (body.data || {}) as Record<string, unknown>;
      const user: StubUser = {
        id: this.id('user'),
        email,
        password: String(body.password || ''),
        // Mirrors the on_auth_user_created trigger.
        memberId: String(meta.member_id || email.split('@')[0]),
        displayName: String(meta.display_name || ''),
        teamId: null,
      };
      this.users.set(user.id, user);
      return send(200, this.issue(user));
    }

    if (url.pathname === '/auth/v1/token') {
      const grant = url.searchParams.get('grant_type');
      if (grant === 'password') {
        const user = [...this.users.values()].find((candidate) => candidate.email === String(body.email || ''));
        if (!user || user.password !== String(body.password || '')) return fail(400, 'Invalid login credentials');
        return send(200, this.issue(user));
      }
      if (grant === 'refresh_token') {
        this.refreshCount += 1;
        if (this.refreshFailStatus) return fail(this.refreshFailStatus, 'refresh rejected by stub');
        const userId = this.refreshTokens.get(String(body.refresh_token || ''));
        const user = userId ? this.users.get(userId) : null;
        if (!user) return fail(400, 'Invalid Refresh Token');
        this.refreshTokens.delete(String(body.refresh_token || ''));
        return send(200, this.issue(user));
      }
      return fail(400, 'unsupported grant');
    }

    if (url.pathname === '/auth/v1/logout') return send(204, {});

    const caller = this.userFor(request);
    if (!caller) return fail(401, 'JWT expired');

    if (url.pathname === '/rest/v1/members') {
      const byUser = (url.searchParams.get('user_id') || '').replace('eq.', '');
      const byTeam = (url.searchParams.get('team_id') || '').replace('eq.', '');
      const rows = [...this.users.values()]
        .filter((user) => (byUser ? user.id === byUser : true))
        .filter((user) => (byTeam ? user.teamId === byTeam : true))
        // The members_select_team policy: yourself, plus your team.
        .filter((user) => user.id === caller.id || (caller.teamId !== null && user.teamId === caller.teamId))
        .map((user) => ({ user_id: user.id, team_id: user.teamId, member_id: user.memberId, display_name: user.displayName }));
      return send(200, rows);
    }

    if (url.pathname === '/rest/v1/teams') {
      const byId = (url.searchParams.get('id') || '').replace('eq.', '');
      const rows = [...this.teams.values()]
        .filter((team) => (byId ? team.id === byId : true))
        .filter((team) => team.id === caller.teamId) // teams_select_own
        .map((team) => ({ id: team.id, name: team.name, invite_code: team.inviteCode }));
      return send(200, rows);
    }

    // The RPCs. Same rejections as the SQL, same order.
    if (url.pathname === '/rest/v1/rpc/create_team') {
      const name = String(body.team_name || '').trim();
      if (!name) return fail(400, 'create_team: team name is required');
      if (caller.teamId) return fail(400, 'create_team: caller already belongs to a team');
      const team: StubTeam = {
        id: this.id('team'),
        name,
        inviteCode: `${this.id('code')}-${Math.random().toString(16).slice(2)}`,
        createdBy: caller.id,
      };
      this.teams.set(team.id, team);
      caller.teamId = team.id; // same transaction as the insert
      return send(200, team.id);
    }

    if (url.pathname === '/rest/v1/rpc/join_team') {
      const code = String(body.code || '').trim();
      if (!code) return fail(400, 'join_team: invite code is required');
      if (caller.teamId) return fail(400, 'join_team: caller already belongs to a team; leave it first');
      const team = [...this.teams.values()].find((candidate) => candidate.inviteCode === code);
      if (!team) return fail(400, 'join_team: invalid invite code');
      const clash = [...this.users.values()].some((user) => user.teamId === team.id && user.memberId === caller.memberId);
      if (clash) return fail(400, 'join_team: your display label is already used in that team; rename yourself first');
      caller.teamId = team.id;
      return send(200, team.id);
    }

    if (url.pathname === '/rest/v1/rpc/leave_team') {
      caller.teamId = null;
      response.writeHead(204);
      response.end();
      return;
    }

    if (url.pathname === '/rest/v1/rpc/rotate_invite_code') {
      if (!caller.teamId) return fail(400, 'rotate_invite_code: caller does not belong to a team');
      const team = this.teams.get(caller.teamId)!;
      team.inviteCode = `${this.id('code')}-${Math.random().toString(16).slice(2)}`;
      return send(200, team.inviteCode);
    }

    return fail(404, `stub: no route for ${url.pathname}`);
  }
}

// --- The shipped console script, against a DOM stub ------------------------
// Same technique as console-model-picker.test.ts: the panel's whole job is to
// show the right one of four states, and only running the real script proves it
// does. Asserting on the HTML string would pass for a panel that never switches.

interface StubElement {
  id: string;
  value: string;
  hidden: boolean;
  innerHTML: string;
  textContent: string;
  dataset: Record<string, string>;
  readonly: boolean;
  focus(): void;
  select(): void;
  addEventListener(): void;
  dispatchEvent(): void;
}

function loadTeamPanel(shippedJs: string): { renderTeam: (team: unknown) => void; el: (id: string) => StubElement } {
  const elements = new Map<string, StubElement>();
  const makeElement = (id: string): StubElement => ({
    id,
    value: '',
    hidden: false,
    innerHTML: '',
    textContent: '',
    dataset: {},
    readonly: false,
    focus() {},
    select() {},
    addEventListener() {},
    dispatchEvent() {},
  });
  const documentStub = {
    getElementById: (id: string) => {
      if (!elements.has(id)) elements.set(id, makeElement(id));
      return elements.get(id)!;
    },
    querySelectorAll: () => [] as unknown[],
    addEventListener() {},
    title: '',
  };
  const windowStub = {
    location: { search: '', pathname: '/console', hash: '' },
    history: { replaceState() {} },
    addEventListener() {},
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    setTimeout: () => 0,
    clearTimeout() {},
    setInterval: () => 0,
    clearInterval() {},
    confirm: () => true,
  };
  const storageStub = { getItem: () => null, setItem() {}, removeItem() {} };
  const factory = new Function(
    'document',
    'window',
    'location',
    'history',
    'sessionStorage',
    'localStorage',
    'fetch',
    'navigator',
    'setTimeout',
    'clearTimeout',
    'setInterval',
    'clearInterval',
    `${shippedJs}
     return { renderTeam };`,
  );
  const api = factory(
    documentStub,
    windowStub,
    windowStub.location,
    windowStub.history,
    storageStub,
    storageStub,
    () => Promise.resolve({ json: () => Promise.resolve({}) }),
    { clipboard: {} },
    windowStub.setTimeout,
    windowStub.clearTimeout,
    windowStub.setInterval,
    windowStub.clearInterval,
  ) as { renderTeam: (team: unknown) => void };
  return { renderTeam: api.renderTeam, el: (id: string) => documentStub.getElementById(id) };
}

// --- Fixtures --------------------------------------------------------------

const CYCLE_ID = '2026-08-24_8.24-9.6';
const CYCLE_FILE = [
  '---',
  "cycle: '8.24-9.6'",
  'mode: biweekly',
  'sections:',
  "  要务: {source: planner, updated_at: '2026-08-24T08:00:00.000Z'}",
  '---',
  '',
  '## 要务',
  '- **MIT** 写 LEO-282 的 Team 区',
  '',
].join('\n');

const PASSWORD_A = 'leon-password-1';
const PASSWORD_B = 'penguin-password-1';
/** A JWT whose payload says role=service_role. Signature is irrelevant: the guard reads the claim. */
const SERVICE_ROLE_KEY = [
  Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'),
  Buffer.from(JSON.stringify({ role: 'service_role', iss: 'supabase' })).toString('base64url'),
  'not-a-real-signature',
].join('.');
const ANON_KEY = [
  Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'),
  Buffer.from(JSON.stringify({ role: 'anon', iss: 'supabase' })).toString('base64url'),
  'not-a-real-signature',
].join('.');

function writeConfig(root: string, vault: string): void {
  const parsed = yaml.load(fs.readFileSync(path.join(REPO_ROOT, 'config', 'config.example.yaml'), 'utf8')) as Record<string, any>;
  parsed.memory.repository_path = vault;
  fs.mkdirSync(path.join(root, 'config'), { recursive: true });
  fs.writeFileSync(path.join(root, 'config', 'config.yaml'), yaml.dump(parsed), 'utf8');
}

async function main(): Promise<void> {
  const stub = new StubSupabase();
  await stub.start();

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-os-team-auth-test-'));
  const vault = path.join(tmp, 'vault');
  const cyclesDir = path.join(vault, '20_CYCLES');
  fs.mkdirSync(cyclesDir, { recursive: true });
  fs.writeFileSync(path.join(cyclesDir, `${CYCLE_ID}.md`), CYCLE_FILE, 'utf8');
  writeConfig(tmp, vault);
  fs.writeFileSync(path.join(tmp, '.env'), '');

  const originalCwd = process.cwd();
  process.chdir(tmp);

  const auth = await import('../../src/ui/auth.js');
  const { startUiServer, JS: SHIPPED_JS } = await import('../../src/ui/server.js');
  const { loadConfig } = await import('../../src/config/load-config.js');
  const session = await import('../../src/team/session.js');
  const { AppConfigSchema } = await import('../../src/config/schema.js');

  auth.resetSessionCacheForTests();
  auth.addUser('admin', 'admin-password-1', 'admin');
  auth.addUser('member', 'member-password-1', 'member');

  const sessionFile = session.teamSessionPath();
  const currentConfig = (): any => loadConfig('config/config.yaml');

  let controls = await startUiServer({ configPath: 'config/config.yaml', envPath: '.env', host: '127.0.0.1', port: 0, open: false });
  let base = controls.url;
  let cookie = '';
  let authed: Record<string, string> = {};

  const login = async (username: string, password: string): Promise<Record<string, string>> => {
    const response = await fetch(`${base}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    return { cookie: cookieFrom(response.headers.get('set-cookie')), 'content-type': 'application/json' };
  };

  const readState = async (): Promise<any> => (await (await fetch(`${base}/api/state`, { headers: { cookie } })).json()) as any;
  const teamPost = async (
    action: string,
    body: unknown = {},
    headers: Record<string, string> = authed,
  ): Promise<{ status: number; body: any }> => {
    const response = await fetch(`${base}/api/team/${action}`, { method: 'POST', headers, body: JSON.stringify(body) });
    return { status: response.status, body: (await response.json()) as any };
  };
  const saveConfigWith = async (mutate: (config: any) => void): Promise<{ status: number; body: any }> => {
    const state = await readState();
    const next = structuredClone(state.config);
    mutate(next);
    const response = await fetch(`${base}/api/config`, { method: 'POST', headers: authed, body: JSON.stringify({ config: next }) });
    return { status: response.status, body: (await response.json()) as any };
  };

  try {
    authed = await login('admin', 'admin-password-1');
    cookie = authed.cookie;

    // --- 1. Supabase not configured ----------------------------------------
    const unconfigured = currentConfig();
    check('an empty team config is "not configured"', session.isSupabaseConfigured(unconfigured) === false);
    let threw = false;
    let readSession: unknown = 'unset';
    try {
      readSession = session.readTeamSession(unconfigured);
    } catch {
      threw = true;
    }
    check('readTeamSession returns null and does not throw when unconfigured', !threw && readSession === null, String(readSession));
    check('listTeamMembers is empty when unconfigured', (await session.listTeamMembers(unconfigured)).length === 0);
    const unconfiguredFetch = await session
      .supabaseFetch(unconfigured, '/rest/v1/members')
      .then(() => '')
      .catch((error: Error) => error.message);
    check('supabaseFetch refuses when unconfigured', /未配置/.test(String(unconfiguredFetch)), String(unconfiguredFetch));

    // Local functionality is the whole point: it must be untouched here.
    const offlineState = await readState();
    check(
      'Cycles state is intact while Supabase is unconfigured',
      (offlineState?.cycles?.items || []).some((item: any) => item.id === CYCLE_ID),
      JSON.stringify((offlineState?.cycles?.items || []).map((item: any) => item.id)),
    );
    check('state.team reports not configured, not signed in', offlineState?.team?.configured === false && offlineState?.team?.signedIn === false);
    const signInWhileUnconfigured = await teamPost('signin', { email: 'leon@example.com', password: PASSWORD_A });
    check(
      'signing in while unconfigured fails as data, not as a 500',
      signInWhileUnconfigured.status === 200 && signInWhileUnconfigured.body?.ok === false,
      JSON.stringify(signInWhileUnconfigured.body).slice(0, 160),
    );

    // --- 2. A service_role key is refused at the point it is pasted --------
    const rejected = await saveConfigWith((next) => {
      next.team.supabase_url = stub.url;
      next.team.supabase_anon_key = SERVICE_ROLE_KEY;
    });
    check('saving a service_role key is rejected', rejected.body?.ok === false && /service_role/.test(String(rejected.body?.error)), JSON.stringify(rejected.body).slice(0, 160));
    check('the rejected key never reached config.yaml', !fs.readFileSync(path.join(tmp, 'config', 'config.yaml'), 'utf8').includes(SERVICE_ROLE_KEY));
    check(
      'a service_role key would not count as configured either',
      session.isSupabaseConfigured(AppConfigSchema.parse({ ...currentConfig(), team: { supabase_url: stub.url, supabase_anon_key: SERVICE_ROLE_KEY } })) === false,
    );

    // --- 3. Configure, then register and sign in ---------------------------
    const saved = await saveConfigWith((next) => {
      next.team.supabase_url = stub.url;
      next.team.supabase_anon_key = ANON_KEY;
    });
    check('the anon key saves', saved.body?.ok === true && saved.body?.state?.team?.configured === true, JSON.stringify(saved.body?.error || '').slice(0, 160));

    const signup = await teamPost('signup', { email: 'leon@example.com', password: PASSWORD_A, displayName: 'Leon' });
    check('signup succeeds', signup.body?.ok === true, JSON.stringify(signup.body?.error || ''));
    check('signup leaves the user signed in but teamless', signup.body?.state?.team?.signedIn === true && !signup.body?.state?.team?.teamId, JSON.stringify(signup.body?.state?.team));

    const live = session.readTeamSession(currentConfig());
    check('readTeamSession exposes the contract fields', Boolean(live?.userId && live?.email === 'leon@example.com' && live?.accessToken && live?.memberId), JSON.stringify(live && { ...live, accessToken: '<redacted>' }));
    check('teamId is null before joining a team', live?.teamId === null, String(live?.teamId));
    check('the session file is owner-only (0600)', (fs.statSync(sessionFile).mode & 0o777) === 0o600, (fs.statSync(sessionFile).mode & 0o777).toString(8));

    // A password must never reach the log, and neither must a token.
    const logs = await (await fetch(`${base}/api/logs`, { headers: { cookie } })).json();
    const logText = JSON.stringify(logs);
    check('the password is not in the UI log', !logText.includes(PASSWORD_A));
    check('the access token is not in the UI log', !logText.includes(String(live?.accessToken)));

    // --- 4. Create a team --------------------------------------------------
    const created = await teamPost('create', { name: 'daily-os' });
    check('creating a team succeeds', created.body?.ok === true, JSON.stringify(created.body?.error || ''));
    const createdTeam = created.body?.state?.team;
    check('the creator is inside the team it just created', Boolean(createdTeam?.teamId), JSON.stringify(createdTeam));
    check('the team name and invite code come back', createdTeam?.teamName === 'daily-os' && Boolean(createdTeam?.inviteCode), JSON.stringify(createdTeam));
    const inviteCode = String(createdTeam?.inviteCode || '');
    const createdTeamId = String(createdTeam?.teamId || '');
    check('listTeamMembers returns the roster, including yourself', (await session.listTeamMembers(currentConfig())).some((member) => member.memberId === 'Leon'), JSON.stringify(await session.listTeamMembers(currentConfig())));

    const createdTwice = await teamPost('create', { name: 'second-team' });
    check('a second team cannot be created while already in one', createdTwice.body?.ok === false, JSON.stringify(createdTwice.body).slice(0, 160));

    // --- 5. Restart: the session survives ----------------------------------
    await controls.stop();
    controls = await startUiServer({ configPath: 'config/config.yaml', envPath: '.env', host: '127.0.0.1', port: 0, open: false });
    base = controls.url;
    authed = await login('admin', 'admin-password-1');
    cookie = authed.cookie;
    const afterRestart = await readState();
    check(
      'the session survives a restart (no re-login)',
      afterRestart?.team?.signedIn === true && afterRestart?.team?.teamId === createdTeamId,
      JSON.stringify(afterRestart?.team),
    );

    // --- 6. The second person joins ----------------------------------------
    await teamPost('signout');
    check('signing out clears the local session file', !fs.existsSync(sessionFile));
    check('readTeamSession is null after signing out', session.readTeamSession(currentConfig()) === null);

    const signupB = await teamPost('signup', { email: 'penguin@example.com', password: PASSWORD_B, displayName: 'Penguin' });
    check('the second account registers', signupB.body?.ok === true, JSON.stringify(signupB.body?.error || ''));
    check('the second account does not inherit the first one\'s team', !signupB.body?.state?.team?.teamId, JSON.stringify(signupB.body?.state?.team));

    const wrongCode = await teamPost('join', { code: 'definitely-not-the-code' });
    check('a wrong invite code is an explicit error', wrongCode.body?.ok === false && /invalid invite code/.test(String(wrongCode.body?.error)), JSON.stringify(wrongCode.body?.error));
    check('a wrong invite code does not join anything', !wrongCode.body?.state?.team?.teamId, JSON.stringify(wrongCode.body?.state?.team));
    const emptyCode = await teamPost('join', { code: '   ' });
    check('an empty invite code is refused', emptyCode.body?.ok === false, JSON.stringify(emptyCode.body?.error));

    const joined = await teamPost('join', { code: inviteCode });
    check('the right invite code joins', joined.body?.ok === true, JSON.stringify(joined.body?.error || ''));
    check('the joiner now sees the team', joined.body?.state?.team?.teamName === 'daily-os', JSON.stringify(joined.body?.state?.team));
    check('both members are visible to the joiner', (joined.body?.state?.team?.members || []).length === 2, JSON.stringify(joined.body?.state?.team?.members));

    // Already in a team: rejected locally, and rejected by the RPC itself.
    const joinAgain = await teamPost('join', { code: inviteCode });
    check('a member already in a team cannot join again', joinAgain.body?.ok === false && /已经在一个团队/.test(String(joinAgain.body?.error)), JSON.stringify(joinAgain.body?.error));
    const rpcDirect = await session.supabaseFetch(currentConfig(), '/rest/v1/rpc/join_team', {
      method: 'POST',
      body: JSON.stringify({ code: inviteCode }),
    });
    const rpcDirectText = await rpcDirect.text();
    check(
      'the RPC itself refuses a second join (no team hopping)',
      rpcDirect.status === 400 && /already belongs to a team/.test(rpcDirectText),
      `${rpcDirect.status} ${rpcDirectText}`.slice(0, 160),
    );

    // --- 7. Token refresh --------------------------------------------------
    const expireSession = (): void => {
      const stored = JSON.parse(fs.readFileSync(sessionFile, 'utf8')) as Record<string, unknown>;
      stored.expiresAt = Date.now() - 60_000;
      fs.writeFileSync(sessionFile, JSON.stringify(stored), 'utf8');
    };
    const storedToken = (): string => String((JSON.parse(fs.readFileSync(sessionFile, 'utf8')) as Record<string, unknown>).accessToken || '');

    const tokenBefore = storedToken();
    const refreshesBefore = stub.refreshCount;
    expireSession();
    const membersAfterRefresh = await session.listTeamMembers(currentConfig());
    check('an expired access token is refreshed transparently', stub.refreshCount === refreshesBefore + 1 && membersAfterRefresh.length === 2, `${stub.refreshCount - refreshesBefore} refreshes, ${membersAfterRefresh.length} members`);
    check('the refreshed token replaces the stored one', storedToken() !== tokenBefore && Boolean(storedToken()));

    // A stale token the server rejects with 401 is refreshed reactively too.
    const goodToken = storedToken();
    stub.tokens.delete(goodToken);
    const reactive = await session.supabaseFetch(currentConfig(), '/rest/v1/members?select=user_id', { method: 'GET' });
    check('a 401 triggers one refresh and a retry', reactive.status === 200, String(reactive.status));

    // Transient failure: the session must survive it.
    stub.refreshFailStatus = 503;
    expireSession();
    const transient = await session
      .supabaseFetch(currentConfig(), '/rest/v1/members?select=user_id', { method: 'GET' })
      .then(() => '')
      .catch((error: Error) => error.message);
    check('a 5xx on refresh reports an error', /Supabase/.test(String(transient)), String(transient));
    check('a 5xx on refresh does NOT sign the user out', fs.existsSync(sessionFile) && session.readTeamSession(currentConfig()) !== null);
    const duringOutage = await readState();
    check(
      'the Cycles page still works while Supabase is failing',
      (duringOutage?.cycles?.items || []).some((item: any) => item.id === CYCLE_ID),
      JSON.stringify((duringOutage?.cycles?.items || []).map((item: any) => item.id)),
    );

    // Rejected refresh token: the session is over, and that is all that happens.
    stub.refreshFailStatus = 400;
    const dead = await session
      .supabaseFetch(currentConfig(), '/rest/v1/members?select=user_id', { method: 'GET' })
      .then(() => '')
      .catch((error: Error) => error.message);
    check('a rejected refresh token asks for a re-login', /重新登录/.test(String(dead)), String(dead));
    check('a rejected refresh token clears the local session', !fs.existsSync(sessionFile) && session.readTeamSession(currentConfig()) === null);
    const afterExpiry = await readState();
    check('after the session dies the console still answers', afterExpiry?.ok === true && afterExpiry?.team?.signedIn === false, JSON.stringify(afterExpiry?.team));
    check(
      'after the session dies the Cycles page is unchanged',
      (afterExpiry?.cycles?.items || []).some((item: any) => item.id === CYCLE_ID),
      JSON.stringify((afterExpiry?.cycles?.items || []).map((item: any) => item.id)),
    );
    check('listTeamMembers degrades to empty when signed out', (await session.listTeamMembers(currentConfig())).length === 0);
    stub.refreshFailStatus = 0;

    // --- 8. Leaving and rotating -------------------------------------------
    const backIn = await teamPost('signin', { email: 'penguin@example.com', password: PASSWORD_B });
    check('signing back in restores the team without re-joining', backIn.body?.ok === true && backIn.body?.state?.team?.teamName === 'daily-os', JSON.stringify(backIn.body?.state?.team));

    const rotated = await teamPost('rotate-code');
    const newCode = String(rotated.body?.state?.team?.inviteCode || '');
    check('rotating replaces the invite code', rotated.body?.ok === true && Boolean(newCode) && newCode !== inviteCode, JSON.stringify(rotated.body?.error || newCode));
    check('the new invite code is not in the response text', !String(rotated.body?.text || '').includes(newCode), String(rotated.body?.text));

    const left = await teamPost('leave');
    check('leaving a team succeeds', left.body?.ok === true, JSON.stringify(left.body?.error || ''));
    check('after leaving there is no team', !left.body?.state?.team?.teamId, JSON.stringify(left.body?.state?.team));
    check('after leaving the roster is empty', (await session.listTeamMembers(currentConfig())).length === 0);
    const leaveTwice = await teamPost('leave');
    check('leaving twice is refused rather than pretending', leaveTwice.body?.ok === false, JSON.stringify(leaveTwice.body?.error));

    const rejoined = await teamPost('join', { code: newCode });
    check('the rotated code works for a fresh join', rejoined.body?.ok === true, JSON.stringify(rejoined.body?.error || ''));
    const staleCode = await (async (): Promise<{ status: number; body: any }> => {
      await teamPost('leave');
      return teamPost('join', { code: inviteCode });
    })();
    check('the rotated-away code no longer works', staleCode.body?.ok === false && /invalid invite code/.test(String(staleCode.body?.error)), JSON.stringify(staleCode.body?.error));

    // --- 9. The member role cannot touch any of this -----------------------
    const memberHeaders = await login('member', 'member-password-1');
    for (const action of ['create', 'join', 'signin', 'signup', 'leave', 'rotate-code', 'signout', 'refresh']) {
      const attempt = await teamPost(action, { name: 'x', code: 'x', email: 'a@b.c', password: 'password-1' }, memberHeaders);
      check(`member role is refused: /api/team/${action} -> 403`, attempt.status === 403, String(attempt.status));
    }
    const unauth = await fetch(`${base}/api/team/create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'x' }),
    });
    check('an unauthenticated caller is refused', unauth.status === 401, String(unauth.status));

    // --- 10. The panel shows one of four states ----------------------------
    const panel = loadTeamPanel(SHIPPED_JS);
    const blocks = (): string =>
      ['team-auth-block', 'team-join-block', 'team-info-block']
        .filter((id) => !panel.el(id).hidden)
        .join(',');

    panel.renderTeam({ configured: false, signedIn: false });
    check('unconfigured: no team form at all, just guidance', blocks() === '', blocks());
    check('unconfigured: the status says local功能 is unaffected', /本地功能/.test(panel.el('team-status').textContent), panel.el('team-status').textContent);

    panel.renderTeam({ configured: true, signedIn: false });
    check('configured but signed out: only the login form', blocks() === 'team-auth-block', blocks());

    panel.renderTeam({ configured: true, signedIn: true, teamId: '', email: 'leon@example.com', memberId: 'Leon', displayName: 'Leon' });
    check('signed in without a team: only create/join', blocks() === 'team-join-block', blocks());
    check('signed in without a team: the identity is shown', /leon@example.com/.test(panel.el('team-identity').textContent), panel.el('team-identity').textContent);

    panel.renderTeam({
      configured: true,
      signedIn: true,
      userId: 'user-1',
      teamId: 'team-1',
      teamName: 'daily-os',
      inviteCode: 'abc123def456ghi789jkl012',
      memberId: 'Leon',
      displayName: 'Leon',
      members: [
        { userId: 'user-1', memberId: 'Leon', displayName: 'Leon' },
        { userId: 'user-2', memberId: 'Penguin', displayName: 'Penguin' },
      ],
    });
    check('joined: only the team panel', blocks() === 'team-info-block', blocks());
    check('joined: the team name is rendered', panel.el('team-name').textContent === 'daily-os', panel.el('team-name').textContent);
    check('joined: the invite code is copyable from a field', panel.el('team-invite-code').value === 'abc123def456ghi789jkl012', panel.el('team-invite-code').value);
    check('joined: both members are listed', /Leon/.test(panel.el('team-members').innerHTML) && /Penguin/.test(panel.el('team-members').innerHTML), panel.el('team-members').innerHTML);
    check('joined: you are marked in the roster', /（你）/.test(panel.el('team-members').innerHTML), panel.el('team-members').innerHTML);

    // A teammate's display name is server data; it must not become markup.
    panel.renderTeam({
      configured: true,
      signedIn: true,
      userId: 'user-1',
      teamId: 'team-1',
      teamName: 'daily-os',
      members: [{ userId: 'user-9', memberId: 'x', displayName: '<img src=x onerror=alert(1)>' }],
    });
    check(
      'a hostile display name is escaped, not rendered',
      !panel.el('team-members').innerHTML.includes('<img'),
      panel.el('team-members').innerHTML,
    );

    // --- 11. Regression: the three untouched pages -------------------------
    const finalState = await readState();
    const strategyIds = (finalState?.strategy?.files || []).map((file: any) => file.id);
    check('Review Strategy still lists its files', strategyIds[0] === 'biweekly_strategy', strategyIds.join(','));
    const strategySave = await fetch(`${base}/api/strategy`, {
      method: 'POST',
      headers: authed,
      body: JSON.stringify({ id: 'biweekly_strategy', markdown: '计划条目规则（下双周要务）：\n- 自定义\n' }),
    });
    check('Review Strategy still saves', strategySave.status === 200 && fs.readFileSync(path.join(tmp, 'prompts', 'biweekly_strategy.md'), 'utf8').includes('自定义'));

    const notesPath = String(finalState?.decisionPolicy?.notesPath || '');
    check('Decision Policy still resolves its notes file', notesPath.startsWith(vault), notesPath);
    const policySave = await fetch(`${base}/api/decision-policy`, {
      method: 'POST',
      headers: authed,
      body: JSON.stringify({ policyMd: '# 决策规则\n- 先看长期影响\n' }),
    });
    check('Decision Policy still saves', policySave.status === 200 && fs.readFileSync(notesPath, 'utf8').includes('先看长期影响'));

    const cycleSave = await fetch(`${base}/api/cycles/section`, {
      method: 'POST',
      headers: authed,
      body: JSON.stringify({ id: CYCLE_ID, section: 'retro', content: '这个周期被 Supabase 接线占满了。' }),
    });
    const cycleBody = (await cycleSave.json()) as any;
    check('Cycles still saves one section', cycleSave.status === 200 && cycleBody?.ok === true, JSON.stringify(cycleBody).slice(0, 160));
    check('the cycle edit reached the file', fs.readFileSync(path.join(cyclesDir, `${CYCLE_ID}.md`), 'utf8').includes('Supabase 接线占满'));
    check(
      'saving a cycle section did not disturb the priorities',
      fs.readFileSync(path.join(cyclesDir, `${CYCLE_ID}.md`), 'utf8').includes('- **MIT** 写 LEO-282 的 Team 区'),
    );
  } finally {
    await controls.stop();
    await stub.stop();
    process.chdir(originalCwd);
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

void main();
