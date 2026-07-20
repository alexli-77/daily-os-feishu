/**
 * LEO-211 adversarial / hardening tests.
 *
 * Independent, tsx-runnable:
 *   ESBUILD_BINARY_PATH=... DAILY_OS_SKIP_AGENT_TESTS=1 npx tsx scripts/tests/adversarial.test.ts
 *
 * Probes the MVP surface for the failure modes a hostile or degraded input can
 * trigger:
 *   - auth: unauthenticated pages, forged/expired sessions, member gating,
 *     httpOnly cookie, login brute-force throttle, token+session precedence
 *   - budget breaker: saturated ledger, price overrides, corrupt ledger rows
 *   - scorer: empty pool, tie-break stability, long CJK titles, OKR degrade,
 *     dedupe false-positive guard
 *   - RunManager: cancel-missing, double-cancel, onCancel throwing
 *   - OKR loader: missing frontmatter, misaligned table, broken parent chain
 *   - daily-plan JSON degradation: non-JSON / half-JSON fall back, never throw
 *
 * Runs inside an isolated temp working directory so it never touches real
 * data/runtime state.
 */
import assert from 'node:assert/strict';
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

function cookieFrom(setCookie: string | null): string {
  if (!setCookie) return '';
  return setCookie.split(';')[0];
}

function setupTempWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-os-adv-'));
  fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
  fs.copyFileSync(path.join(REPO_ROOT, '.env.example'), path.join(dir, '.env.example'));
  fs.copyFileSync(path.join(REPO_ROOT, 'config', 'config.example.yaml'), path.join(dir, 'config', 'config.example.yaml'));
  return dir;
}

async function main(): Promise<void> {
  const tmp = setupTempWorkspace();
  const originalCwd = process.cwd();
  process.chdir(tmp);

  // Imports after chdir so all cwd-relative resolution lands in the temp dir.
  const auth = await import('../../src/ui/auth.js');
  const server = await import('../../src/ui/server.js');
  const scorer = await import('../../src/todo/scorer.js');
  const scorerConfig = await import('../../src/todo/scorer-config.js');
  const okr = await import('../../src/okr/loader.js');
  const meter = await import('../../src/agent/token-meter.js');
  const summary = await import('../../src/workflows/summary.js');
  const { runManager } = await import('../../src/service/run-manager.js');

  try {
    await runAuthTests(auth, server);
    runBudgetTests(meter);
    runScorerTests(scorer, scorerConfig);
    await runRunManagerTests(runManager);
    runOkrTests(okr);
    runJsonDegradationTests(summary);
  } finally {
    process.chdir(originalCwd);
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

// --- auth -------------------------------------------------------------------

async function runAuthTests(
  auth: typeof import('../../src/ui/auth.js'),
  server: typeof import('../../src/ui/server.js'),
): Promise<void> {
  auth.resetSessionCacheForTests();
  server.resetLoginThrottleForTests();
  auth.addUser('admin', 'admin-password-1', 'admin');
  auth.addUser('member', 'member-password-1', 'member');

  const controls = await server.startUiServer({
    configPath: 'config/config.yaml',
    envPath: '.env',
    host: '127.0.0.1',
    port: 0,
    open: false,
  });
  const base = controls.url;
  const PAGES = ['/dashboard', '/today', '/schedules', '/runs', '/artifacts'];

  try {
    // 1) No cookie -> every console page 302 to /login.
    let allRedirect = true;
    for (const page of PAGES) {
      const res = await fetch(`${base}${page}`, { redirect: 'manual' });
      if (res.status !== 302 || res.headers.get('location') !== '/login') {
        allRedirect = false;
        check(`no-cookie ${page} -> 302 /login`, false, `${res.status} ${res.headers.get('location')}`);
      }
    }
    check('all 5 console pages redirect to /login without a session', allRedirect);

    // 2) Forged session cookie -> pages redirect, api 401.
    const forged = `${auth.SESSION_COOKIE}=deadbeefdeadbeefdeadbeef`;
    const forgedPage = await fetch(`${base}/dashboard`, { headers: { cookie: forged }, redirect: 'manual' });
    check('forged session cookie -> page 302', forgedPage.status === 302, String(forgedPage.status));
    const forgedApi = await fetch(`${base}/api/logs`, { headers: { cookie: forged } });
    check('forged session cookie -> api 401', forgedApi.status === 401, String(forgedApi.status));

    // 3) Expired session cookie -> rejected. Seed an already-expired record.
    const sessionsFile = path.resolve('data/runtime/sessions.json');
    fs.mkdirSync(path.dirname(sessionsFile), { recursive: true });
    fs.writeFileSync(
      sessionsFile,
      JSON.stringify({
        sessions: [
          {
            token: 'expired-token-xyz',
            username: 'admin',
            role: 'admin',
            created_at: '2020-01-01T00:00:00.000Z',
            expires_at: '2020-01-08T00:00:00.000Z',
          },
        ],
      }),
    );
    auth.resetSessionCacheForTests();
    const expiredApi = await fetch(`${base}/api/logs`, { headers: { cookie: `${auth.SESSION_COOKIE}=expired-token-xyz` } });
    check('expired session cookie -> api 401', expiredApi.status === 401, String(expiredApi.status));

    // --- Real logins for the role + cookie checks --------------------------
    const adminLogin = await fetch(`${base}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin-password-1' }),
    });
    const adminSetCookie = adminLogin.headers.get('set-cookie') || '';
    const adminCookie = cookieFrom(adminSetCookie);
    check('admin login -> 200', adminLogin.status === 200, String(adminLogin.status));

    // 4) Session cookie must be HttpOnly + SameSite (not JS-readable, CSRF-hardened).
    check('session cookie is HttpOnly', /HttpOnly/i.test(adminSetCookie), adminSetCookie);
    check('session cookie is SameSite=Strict', /SameSite=Strict/i.test(adminSetCookie), adminSetCookie);

    const memberLogin = await fetch(`${base}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'member', password: 'member-password-1' }),
    });
    const memberCookie = cookieFrom(memberLogin.headers.get('set-cookie'));

    // 5) member POST /api/runs/cancel -> 403 (not whitelisted).
    const memberCancel = await fetch(`${base}/api/runs/cancel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: memberCookie },
      body: JSON.stringify({ runId: 'whatever' }),
    });
    check('member POST /api/runs/cancel -> 403', memberCancel.status === 403, String(memberCancel.status));

    // 6) member POST /api/today/todo-feedback -> 200 (whitelisted).
    const memberFeedback = await fetch(`${base}/api/today/todo-feedback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: memberCookie },
      body: JSON.stringify({ id: 'todo-1', action: 'check' }),
    });
    check('member POST /api/today/todo-feedback -> 200', memberFeedback.status === 200, String(memberFeedback.status));

    // 7) Runtime token + member cookie together -> admin wins (token precedence).
    const tokenAndCookie = await fetch(`${base}/api/config`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: memberCookie,
        authorization: `Bearer ${controls.token}`,
      },
      body: JSON.stringify({ config: {} }),
    });
    // /api/config is admin-only; with the token present the request is NOT 403.
    check('runtime token overrides member cookie (not 403)', tokenAndCookie.status !== 403, String(tokenAndCookie.status));

    // 8) Login brute-force: repeated failures must incur an escalating delay.
    // Unit-level guarantee (deterministic):
    check('loginFailureDelayMs is 0 within free attempts', server.loginFailureDelayMs(3) === 0, String(server.loginFailureDelayMs(3)));
    check('loginFailureDelayMs escalates after threshold', server.loginFailureDelayMs(6) > server.loginFailureDelayMs(4), `${server.loginFailureDelayMs(4)} < ${server.loginFailureDelayMs(6)}`);
    check('loginFailureDelayMs is capped', server.loginFailureDelayMs(1000) <= 3000, String(server.loginFailureDelayMs(1000)));
    // Integration: a burst of wrong-password attempts for one user gets slower.
    server.resetLoginThrottleForTests();
    async function timeBadLogin(): Promise<number> {
      const t0 = Date.now();
      await fetch(`${base}/api/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'definitely-wrong' }),
      });
      return Date.now() - t0;
    }
    const first = await timeBadLogin();
    let last = 0;
    for (let i = 0; i < 5; i += 1) last = await timeBadLogin();
    check('brute-force: later failed login is throttled slower than the first', last > first + 100, `first=${first}ms last=${last}ms`);
  } finally {
    await controls.stop();
  }
}

// --- budget breaker ---------------------------------------------------------

function runBudgetTests(meter: typeof import('../../src/agent/token-meter.js')): void {
  // Saturated ledger trips per_task / daily / monthly independently.
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adv-ledger-'));
    const ledgerPath = path.join(dir, 'usage.jsonl');
    const alertPath = path.join(dir, 'alerts.jsonl');
    meter.recordUsage('run-sat', 'anthropic', 'claude-sonnet-5', 10, 10, 5.0, { ledgerPath });
    assert.throws(
      () => meter.checkBudget({ per_task_usd: 2, daily_usd: 100, monthly_usd: 1000 }, { runId: 'run-sat', ledgerPath, alertPath }),
      (e: unknown) => e instanceof meter.BudgetExceededError && e.scope === 'per_task',
    );
    check('budget: saturated ledger trips per_task', fs.existsSync(alertPath));
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // price_overrides change the resolved price.
  {
    const base = meter.resolveModelPrice('claude-sonnet-5');
    const overridden = meter.resolveModelPrice('claude-sonnet-5', { 'claude-sonnet-5': { input: 99, output: 199 } });
    check('budget: price_overrides override the built-in price', overridden?.input === 99 && overridden?.output === 199, JSON.stringify(overridden));
    check('budget: without override the built-in price stands', base?.input === 3, JSON.stringify(base));
    const cost = meter.estimateCostUsd('brand-new-model', 1_000_000, 0, { 'brand-new-model': { input: 7, output: 0 } });
    check('budget: estimateCost uses override for unknown model', cost === 7, String(cost));
  }

  // Corrupt ledger rows are tolerated (skipped), valid rows still counted.
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adv-ledger-corrupt-'));
    const ledgerPath = path.join(dir, 'usage.jsonl');
    fs.writeFileSync(
      ledgerPath,
      [
        'this is not json at all',
        JSON.stringify({ ts: new Date().toISOString(), day: new Date().toISOString().slice(0, 10), month: new Date().toISOString().slice(0, 7), runId: 'r', provider: 'anthropic', model: 'claude-sonnet-5', inputTokens: 1, outputTokens: 1, estCostUsd: 1.5 }),
        '{ half json',
        '',
      ].join('\n'),
    );
    const rows = meter.readLedger(ledgerPath);
    check('budget: corrupt ledger rows are skipped, valid row kept', rows.length === 1 && rows[0]?.estCostUsd === 1.5, JSON.stringify(rows));
    // checkBudget still functions over the corrupt ledger without throwing on parse.
    let threw = false;
    try {
      meter.checkBudget({ per_task_usd: 100, daily_usd: 100, monthly_usd: 100 }, { runId: 'r', ledgerPath });
    } catch {
      threw = true;
    }
    check('budget: checkBudget tolerates corrupt ledger (no crash under limit)', !threw);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// --- scorer -----------------------------------------------------------------

function runScorerTests(
  scorer: typeof import('../../src/todo/scorer.js'),
  scorerConfig: typeof import('../../src/todo/scorer-config.js'),
): void {
  const W = scorerConfig.DEFAULT_SCORER_WEIGHTS;
  const NOW = new Date('2026-07-17T00:00:00');

  // Empty candidate pool -> empty ranking, no crash.
  check('scorer: empty pool -> []', scorer.scoreAndRank([], { weights: W, now: NOW }).length === 0);
  const emptyBuild = scorer.buildScoredTodos({} as never, { generated_at: NOW.toISOString(), date: '2026-07-17', sources: {} }, '2026-07-17', { now: NOW });
  check('scorer: buildScoredTodos on empty evidence -> top []', emptyBuild.top.length === 0 && emptyBuild.total_candidates === 0);

  // All-overdue same-score -> deterministic tie-break + sequential ranks.
  const tied = ['甲任务', '乙任务', '丙任务'].map((t, i) => ({ id: `t${i}`, title: t, source: 'linear' as const, dueDate: '2026-07-01', priority: 'Urgent (1)' }));
  const rankedA = scorer.scoreAndRank([...tied], { weights: W, now: NOW });
  const rankedB = scorer.scoreAndRank([...tied].reverse(), { weights: W, now: NOW });
  const sameScores = new Set(rankedA.map((r) => r.score)).size === 1;
  check('scorer: all-overdue candidates share one score', sameScores, rankedA.map((r) => r.score).join(','));
  check('scorer: tie-break is deterministic regardless of input order', JSON.stringify(rankedA.map((r) => r.id)) === JSON.stringify(rankedB.map((r) => r.id)), `${rankedA.map((r) => r.id)} vs ${rankedB.map((r) => r.id)}`);
  check('scorer: tied ranks are sequential 1..n', JSON.stringify(rankedA.map((r) => r.rank)) === JSON.stringify([1, 2, 3]));

  // Very long CJK title -> scores without throwing.
  const longTitle = '完成'.repeat(400) + '客户合同交付';
  let longOk = true;
  try {
    const s = scorer.scoreCandidate({ id: 'long', title: longTitle, source: 'todo_inbox' }, W, NOW);
    longOk = typeof s.score === 'number' && Number.isFinite(s.score);
  } catch {
    longOk = false;
  }
  check('scorer: very long CJK title scores without throwing', longOk);

  // OKR files missing -> okr weight degrades to nothing (no okrKrId), no crash.
  // (cwd here has no memory-vault/default/10_OKR, so loadOkrIndex returns []).
  const degraded = scorer.normalizeCandidates({
    config: {} as never,
    evidence: { generated_at: NOW.toISOString(), date: '2026-07-17', sources: { vault_scan: { state: 'available', data: { candidates: [{ path: 'p.md', title: '推进 O1-KR1 相关工作' }] } } } },
    date: '2026-07-17',
    now: NOW,
  });
  check('scorer: OKR files missing -> candidate has no okrKrId (weight degrades)', degraded.length === 1 && degraded[0]?.okrKrId === undefined, JSON.stringify(degraded[0]));
  check('scorer: OKR missing -> okr breakdown component absent', scorer.scoreCandidate(degraded[0]!, W, NOW).breakdown.okr === undefined);

  // Dedupe must NOT merge two distinct tasks that only share a short common phrase.
  const distinct = scorer.normalizeCandidates({
    config: {} as never,
    evidence: {
      generated_at: NOW.toISOString(),
      date: '2026-07-17',
      sources: { todo_inbox: { state: 'available', data: { open: [{ id: 'd1', text: '完成2026年度OKR方向review收尾' }, { id: 'd2', text: '启动2026年度预算规划第一版' }] } } },
    },
    date: '2026-07-17',
    now: NOW,
  });
  check('scorer: dedupe does not false-merge distinct tasks sharing "2026年度"', distinct.length === 2, `kept ${distinct.length}`);
}

// --- RunManager -------------------------------------------------------------

async function runRunManagerTests(rm: typeof import('../../src/service/run-manager.js')['runManager']): Promise<void> {

  // Cancel a run that does not exist.
  const missing = await rm.cancel('does-not-exist');
  check('run-manager: cancel missing -> not-found', missing.status === 'not-found' && missing.ok === false);

  // Double cancel: second cancel finds nothing.
  const handle = { pid: 0, killed: false, kill: () => true };
  rm.register('dbl', handle, { workflow: 'daily_plan' });
  const c1 = await rm.cancel('dbl');
  const c2 = await rm.cancel('dbl');
  check('run-manager: first cancel ok', c1.ok === true);
  check('run-manager: double cancel -> not-found', c2.status === 'not-found' && c2.ok === false);

  // onCancel throwing must not crash the manager; cancel still resolves ok.
  let resolvedOk = false;
  rm.register('boom', { pid: 0, killed: false }, {
    onCancel: () => {
      throw new Error('writeback exploded');
    },
  });
  const boom = await rm.cancel('boom');
  resolvedOk = boom.ok === true;
  check('run-manager: onCancel throw is swallowed, cancel resolves ok', resolvedOk, boom.status);
  check('run-manager: run is unregistered after a throwing onCancel', rm.isActive('boom') === false);
}

// --- OKR loader -------------------------------------------------------------

function runOkrTests(okr: typeof import('../../src/okr/loader.js')): void {
  // Missing frontmatter: body-only file still yields objectives, no crash.
  const noFrontmatter = [
    '## Objective O1: Ship the alpha',
    'Parent: A1',
    '',
    '| KR ID | Description | Target | Current | Progress | Updated |',
    '| --- | --- | --- | --- | --- | --- |',
    '| O1-KR1 | Onboard pilot users | 20 | 5 | 25% | 2026-07-16 |',
  ].join('\n');
  const m1 = okr.parseOkrContents({ quarterly: noFrontmatter });
  check('okr: missing frontmatter still parses the objective', m1.quarterly.length === 1 && m1.quarterly[0]?.keyResults.length === 1, JSON.stringify(m1.warnings));
  let summaryOk = true;
  try {
    okr.buildOkrSummary(m1);
  } catch {
    summaryOk = false;
  }
  check('okr: buildOkrSummary does not throw on frontmatter-less model', summaryOk);

  // Misaligned table (too few columns) -> row skipped, no crash.
  const misaligned = [
    '## Objective O2: Broken table',
    '',
    '| KR ID | Description |',
    '| --- | --- |',
    '| O2-KR1 | only two columns |',
    '| O2-KR2 | Proper row | 10 | 2 | 20% | 2026-07-16 |',
  ].join('\n');
  const m2 = okr.parseOkrContents({ quarterly: misaligned });
  const krIds = m2.quarterly[0]?.keyResults.map((k) => k.id) ?? [];
  check('okr: misaligned (short) table row is skipped, valid 6-col row kept', krIds.length === 1 && krIds[0] === 'O2-KR2', JSON.stringify(krIds));

  // Broken parent chain: parent points at a non-existent A9.
  const quarterly = [
    '## Objective O1: Ship',
    'Parent: A9',
    '',
    '| KR ID | Description | Target | Current | Progress | Updated |',
    '| --- | --- | --- | --- | --- | --- |',
    '| O1-KR1 | do a thing | 1 | 0 | 0% | 2026-07-16 |',
  ].join('\n');
  const annual = ['## Objective A1: Real annual', 'Parent: N1', '', '| KR ID | Description | Target | Current | Progress | Updated |', '| --- | --- | --- | --- | --- | --- |', '| A1-KR1 | x | 1 | 0 | 0% | 2026-07-16 |'].join('\n');
  const m3 = okr.parseOkrContents({ annual, quarterly });
  const chain = okr.resolveChain(m3, 'O1-KR1');
  check('okr: broken parent chain resolves KR + records a warning, no crash', chain.kr?.id === 'O1-KR1' && chain.annual === null && chain.warnings.some((w) => /parent/i.test(w)), JSON.stringify(chain.warnings));
}

// --- daily-plan JSON degradation -------------------------------------------

function runJsonDegradationTests(summary: typeof import('../../src/workflows/summary.js')): void {
  const nonJson = '老板，今天先看这几件事：\n1. 做 A\n2. 做 B';
  const halfJson = '```json\n{"todos":[{"rank":1,"text":"A","candidateId":"c1"';

  check('json: non-JSON parses to null', summary.parseDailyPlanTodoPlan(nonJson) === null);
  check('json: half-JSON parses to null', summary.parseDailyPlanTodoPlan(halfJson) === null);

  // formatWorkflowSummaryForFeishu must fall back (legacy long-form) and never throw.
  let s1 = '';
  let s2 = '';
  let threw = false;
  try {
    s1 = summary.formatWorkflowSummaryForFeishu('daily_plan', '2026-07-17', nonJson);
    s2 = summary.formatWorkflowSummaryForFeishu('daily_plan', '2026-07-17', halfJson);
  } catch {
    threw = true;
  }
  check('json: summary falls back without throwing on non-JSON / half-JSON', !threw && s1.length > 0 && s2.length > 0, `s1=${s1.length} s2=${s2.length}`);
  // Fallback keeps the legacy content signal rather than emitting the todo card layout.
  check('json: non-JSON fallback surfaces the legacy body, not a JSON todo card', !s1.includes('完成一条就点它下面'), s1.slice(0, 60));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
