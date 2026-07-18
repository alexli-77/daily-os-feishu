/**
 * LEO-210 web console tests. Independent, tsx-runnable:
 *
 *   npx tsx scripts/tests/platform-ui.test.ts
 *
 * Covers: login flow (401/200 + cookie), console page redirect, member
 * write 403 + whitelisted 200, admin-via-token 200, artifacts index read/write,
 * and RunManager cancel escalation on a mock child process.
 *
 * The whole run happens inside an isolated temp working directory so it never
 * touches the real data/runtime/users.json or artifacts index.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

function setupTempWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-os-ui-test-'));
  fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
  fs.copyFileSync(path.join(REPO_ROOT, '.env.example'), path.join(dir, '.env.example'));
  fs.copyFileSync(path.join(REPO_ROOT, 'config', 'config.example.yaml'), path.join(dir, 'config', 'config.example.yaml'));
  return dir;
}

function cookieFrom(setCookie: string | null): string {
  if (!setCookie) return '';
  return setCookie.split(';')[0];
}

async function main(): Promise<void> {
  const tmp = setupTempWorkspace();
  const originalCwd = process.cwd();
  process.chdir(tmp);

  // Import after chdir so all cwd-relative path resolution lands in the temp dir.
  const auth = await import('../../src/ui/auth.js');
  const artifacts = await import('../../src/storage/artifacts.js');
  const { runManager } = await import('../../src/service/run-manager.js');
  const { startUiServer } = await import('../../src/ui/server.js');

  // --- RunManager cancel (mock child) --------------------------------------
  {
    const signals: string[] = [];
    let cancelledCallbackRan = false;
    const stubborn = {
      pid: 4242,
      killed: false,
      kill(signal?: NodeJS.Signals | number) {
        signals.push(String(signal));
        if (signal === 'SIGKILL') this.killed = true; // ignores SIGTERM -> forces escalation
        return true;
      },
    };
    runManager.register('run_stub', stubborn, { workflow: 'daily_plan', onCancel: () => { cancelledCallbackRan = true; } });
    check('run-manager lists active run', runManager.list().some((r) => r.runId === 'run_stub'));
    const result = await runManager.cancel('run_stub', { escalationMs: 40 });
    check('run-manager escalates SIGTERM then SIGKILL', signals.join(',') === 'SIGTERM,SIGKILL', signals.join(','));
    check('run-manager cancel status killed', result.status === 'killed', result.status);
    check('run-manager onCancel writeback ran', cancelledCallbackRan);
    check('run-manager unregisters after cancel', !runManager.isActive('run_stub'));

    const exits: string[] = [];
    const graceful = {
      pid: 99,
      killed: false,
      kill(signal?: NodeJS.Signals | number) { exits.push(String(signal)); this.killed = true; return true; },
    };
    runManager.register('run_graceful', graceful, {});
    const gr = await runManager.cancel('run_graceful', { escalationMs: 200 });
    check('run-manager graceful stop uses only SIGTERM', exits.join(',') === 'SIGTERM', exits.join(','));
    check('run-manager graceful status signalled', gr.status === 'signalled', gr.status);

    const missing = await runManager.cancel('nope');
    check('run-manager cancel missing run -> not-found', missing.status === 'not-found' && missing.ok === false);
  }

  // --- Artifacts index read/write ------------------------------------------
  {
    const outDir = path.resolve('data/outputs');
    fs.mkdirSync(outDir, { recursive: true });
    const file = path.join(outDir, 'sample-report.md');
    fs.writeFileSync(file, '# hello\nartifact body');

    const record = artifacts.registerArtifact({ path: file, tags: ['report'], source: 'test' });
    check('registerArtifact returns a record', Boolean(record) && record?.type === 'markdown', record?.type);
    check('registerArtifact is previewable', record ? artifacts.isPreviewableType(record.type) : false);

    const index = artifacts.readArtifactsIndex();
    check('artifacts index contains registered file', index.some((a) => a.name === 'sample-report.md'));

    fs.writeFileSync(path.join(outDir, 'extra.log'), 'log line');
    const scan = artifacts.scanAndIndex();
    check('scanAndIndex picks up new files', scan.total >= 2, JSON.stringify(scan));

    const found = record ? artifacts.findArtifactById(record.id) : undefined;
    check('findArtifactById round-trips', Boolean(found) && found?.name === 'sample-report.md');
  }

  // --- Seed users before starting the server (so ensureAuthInitialized no-ops)
  auth.resetSessionCacheForTests();
  auth.addUser('admin', 'admin-password-1', 'admin');
  auth.addUser('member', 'member-password-1', 'member');

  const controls = await startUiServer({
    configPath: 'config/config.yaml',
    envPath: '.env',
    host: '127.0.0.1',
    port: 0,
    open: false,
  });
  const base = controls.url;

  try {
    // --- Login flow --------------------------------------------------------
    const badLogin = await fetch(`${base}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'wrong' }),
    });
    check('login with wrong password -> 401', badLogin.status === 401, String(badLogin.status));

    const adminLogin = await fetch(`${base}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin-password-1' }),
    });
    check('login with correct password -> 200', adminLogin.status === 200, String(adminLogin.status));
    const adminCookie = cookieFrom(adminLogin.headers.get('set-cookie'));
    check('login sets session cookie', adminCookie.startsWith(`${auth.SESSION_COOKIE}=`), adminCookie);

    // --- Console page auth -------------------------------------------------
    const noAuthPage = await fetch(`${base}/dashboard`, { redirect: 'manual' });
    check('dashboard without session -> redirect to /login', noAuthPage.status === 302 && noAuthPage.headers.get('location') === '/login', String(noAuthPage.status));

    const authedPage = await fetch(`${base}/dashboard`, { headers: { cookie: adminCookie } });
    const pageText = await authedPage.text();
    check('dashboard with admin session -> 200 html', authedPage.status === 200 && pageText.includes('Recent runs'), String(authedPage.status));

    const apiNoAuth = await fetch(`${base}/api/artifacts/reindex`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    check('write api without auth -> 401', apiNoAuth.status === 401, String(apiNoAuth.status));

    // --- Member role gating ------------------------------------------------
    const memberLogin = await fetch(`${base}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'member', password: 'member-password-1' }),
    });
    const memberCookie = cookieFrom(memberLogin.headers.get('set-cookie'));

    const memberWrite = await fetch(`${base}/api/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: memberCookie },
      body: JSON.stringify({ config: {} }),
    });
    check('member non-whitelisted write -> 403', memberWrite.status === 403, String(memberWrite.status));

    const memberWhitelisted = await fetch(`${base}/api/today/todo-feedback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: memberCookie },
      body: JSON.stringify({ id: 'todo-1', action: 'check' }),
    });
    check('member whitelisted write -> 200', memberWhitelisted.status === 200, String(memberWhitelisted.status));

    // --- Admin via runtime token ------------------------------------------
    const tokenWrite = await fetch(`${base}/api/artifacts/reindex`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${controls.token}` },
      body: '{}',
    });
    check('admin via runtime token write -> 200', tokenWrite.status === 200, String(tokenWrite.status));
  } finally {
    await controls.stop();
    process.chdir(originalCwd);
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
