/**
 * The standalone /cycles platform page (LEO-286). Independent, tsx-runnable:
 *
 *   npx tsx scripts/tests/cycles-standalone-page.test.ts
 *
 * Cycles used to be a section of the config console. It is not configuration, so
 * it moved out to its own top-level page with a left panel and card-shaped
 * sections. Two halves are worth locking down, and they need different tools:
 *
 *   - the routing and the endpoints, driven through the real UI server with a
 *     real login session: /cycles exists and is in the nav, /console no longer
 *     carries a cycles section, and the save endpoint still refuses everything
 *     it refused before (broken frontmatter, foreign owner, member role);
 *   - the rendering, driven by evaluating the *shipped* client script against a
 *     DOM stub. Card layout, ordering, draft survival and the zoom dialog are
 *     behaviour; matching the source with a regex would prove nothing about a
 *     save button that stays clickable or a draft that quietly disappears.
 *
 * Teammate read-only rendering has its own coverage in team-sync.test.ts, which
 * drives the same script; what is asserted here is what the move added.
 *
 * Runs entirely inside a temp workspace: no real config or vault is touched.
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

function cookieFrom(setCookie: string | null): string {
  return setCookie ? setCookie.split(';')[0] : '';
}

function writeConfig(root: string, vault: string): void {
  const parsed = yaml.load(fs.readFileSync(path.join(REPO_ROOT, 'config', 'config.example.yaml'), 'utf8')) as Record<string, any>;
  parsed.memory.repository_path = vault;
  fs.mkdirSync(path.join(root, 'config'), { recursive: true });
  fs.writeFileSync(path.join(root, 'config', 'config.yaml'), yaml.dump(parsed), 'utf8');
}

const OLD_ID = '2026-06-01_6.1-6.14';
const MID_ID = '2026-08-24_8.24-9.6';
const NEW_ID = '2026-09-07_9.7-9.13';
const BROKEN_ID = '2026-09-21_9.21-10.4';

/** All three sections, each with a different owner. */
const OLD_FILE = [
  '---',
  "cycle: '6.1-6.14'",
  'mode: biweekly',
  'updated_at: 2026-06-14T09:00:00.000Z',
  'sections:',
  "  要务: {source: planner, updated_at: '2026-06-01T08:00:00.000Z'}",
  "  retro: {source: user, updated_at: '2026-06-13T21:00:00.000Z'}",
  "  review: {source: ai, updated_at: '2026-06-14T09:00:00.000Z'}",
  '---',
  '',
  '## 要务',
  '- **MIT** 把 LEO-276 文件层落地',
  '',
  '## retro',
  '前半程被面试打断。',
  '',
  '## review',
  'AI：节奏偏慢，下个周期收敛范围。',
  '',
].join('\n');

/** Priorities only — `retro` and `review` keys must stay absent, not empty. */
const MID_FILE = [
  '---',
  "cycle: '8.24-9.6'",
  'mode: biweekly',
  'sections:',
  "  要务: {source: planner, updated_at: '2026-08-24T08:00:00.000Z'}",
  '---',
  '',
  '## 要务',
  '- **MIT** 写 Cycles 页',
  '',
].join('\n');

const NEW_FILE = [
  '---',
  "cycle: '9.7-9.13'",
  'mode: weekly',
  'sections:',
  "  要务: {source: planner, updated_at: '2026-09-07T08:00:00.000Z'}",
  '---',
  '',
  '## 要务',
  '- **MIT** 单周试跑',
  '',
].join('\n');

const BROKEN_FILE = ['---', "cycle: '9.21-10.4'", 'sections: {要务: [unclosed', '---', '', '## 要务', '- 手改坏了', ''].join('\n');

async function main(): Promise<void> {
  await testServerRoutes();
  await testPageRendering();

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

// --- 1. routing + endpoints ---------------------------------------------------

async function testServerRoutes(): Promise<void> {
  console.log('\n--- routes and endpoints ---');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-os-cycles-standalone-'));
  const vault = path.join(tmp, 'vault');
  const cyclesDir = path.join(vault, '20_CYCLES');
  fs.mkdirSync(cyclesDir, { recursive: true });
  fs.writeFileSync(path.join(cyclesDir, `${OLD_ID}.md`), OLD_FILE, 'utf8');
  fs.writeFileSync(path.join(cyclesDir, `${MID_ID}.md`), MID_FILE, 'utf8');
  fs.writeFileSync(path.join(cyclesDir, `${NEW_ID}.md`), NEW_FILE, 'utf8');
  fs.writeFileSync(path.join(cyclesDir, `${BROKEN_ID}.md`), BROKEN_FILE, 'utf8');
  writeConfig(tmp, vault);
  fs.writeFileSync(path.join(tmp, '.env'), '');

  const originalCwd = process.cwd();
  process.chdir(tmp);

  const auth = await import('../../src/ui/auth.js');
  const { startUiServer } = await import('../../src/ui/server.js');

  auth.resetSessionCacheForTests();
  auth.addUser('admin', 'admin-password-1', 'admin');
  auth.addUser('member', 'member-password-1', 'member');

  const controls = await startUiServer({ configPath: 'config/config.yaml', envPath: '.env', host: '127.0.0.1', port: 0, open: false });
  const base = controls.url;

  try {
    const login = await fetch(`${base}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin-password-1' }),
    });
    const cookie = cookieFrom(login.headers.get('set-cookie'));
    const authed = { cookie, 'content-type': 'application/json' };

    const page = async (route: string, headers: Record<string, string> = { cookie }): Promise<{ status: number; html: string }> => {
      const response = await fetch(`${base}${route}`, { headers, redirect: 'manual' });
      return { status: response.status, html: response.status === 200 ? await response.text() : '' };
    };
    const readCycles = async (headers: Record<string, string> = { cookie }): Promise<{ status: number; body: any }> => {
      const response = await fetch(`${base}/api/cycles/state`, { headers });
      return { status: response.status, body: (await response.json()) as any };
    };
    const saveSection = async (body: unknown, headers: Record<string, string> = authed): Promise<{ status: number; body: any }> => {
      const response = await fetch(`${base}/api/cycles/section`, { method: 'POST', headers, body: JSON.stringify(body) });
      return { status: response.status, body: (await response.json()) as any };
    };
    const cycleOf = (items: any[], id: string): any => (items || []).find((item: any) => item.id === id);

    // --- the page exists and is in the nav -----------------------------------
    const cyclesPage = await page('/cycles');
    check('/cycles is served to a signed-in user', cyclesPage.status === 200, String(cyclesPage.status));
    check('/cycles renders the left panel and the three cards',
      cyclesPage.html.includes('id="cycle-list"') &&
      cyclesPage.html.includes('id="cycle-members"') &&
      ['priorities', 'retro', 'review'].every((key) => cyclesPage.html.includes(`id="cycle-card-${key}"`)),
    );
    check('/cycles ships a zoom dialog', cyclesPage.html.includes('id="cycle-modal"') && cyclesPage.html.includes('aria-modal="true"'));
    check('/cycles marks itself active in the nav', cyclesPage.html.includes('class="nav-link active" href="/cycles"'));

    const dashboard = await page('/dashboard');
    check('every platform page links to /cycles', dashboard.html.includes('href="/cycles"') && dashboard.html.includes('>Cycles<'));
    check('Cycles sits between Today and Chat in the nav',
      dashboard.html.indexOf('href="/today"') < dashboard.html.indexOf('href="/cycles"') &&
      dashboard.html.indexOf('href="/cycles"') < dashboard.html.indexOf('href="/chat"'),
    );

    const anonymous = await fetch(`${base}/cycles`, { redirect: 'manual' });
    check('/cycles redirects an anonymous visitor to the login page',
      anonymous.status === 302 && anonymous.headers.get('location') === '/login',
      `${anonymous.status} ${anonymous.headers.get('location')}`,
    );

    // --- the console no longer carries it ------------------------------------
    const console_ = await page('/console');
    check('/console has no cycles section left', !console_.html.includes('id="section-cycles"'), 'section-cycles still rendered');
    check('/console has no Cycles sidebar button left', !console_.html.includes('data-section="cycles"'), 'nav button still rendered');
    check('/console has no cycle editors left', !console_.html.includes('id="cycle-md-retro"'), 'cycle textarea still rendered');
    check('/console keeps its configuration sections',
      console_.html.includes('data-section="decision"') && console_.html.includes('data-section="strategy"') && console_.html.includes('data-section="okr"'),
    );

    // --- the page's read model -----------------------------------------------
    const state = await readCycles();
    const items = state.body?.cycles?.items || [];
    check('/api/cycles/state answers 200', state.status === 200 && state.body?.ok === true, JSON.stringify(state.body).slice(0, 120));
    check('cycles come back newest first', items.map((item: any) => item.id).join(',') === [BROKEN_ID, NEW_ID, MID_ID, OLD_ID].join(','), items.map((item: any) => item.id).join(','));
    check('the cycles dir travels with the list', state.body?.cycles?.dir === cyclesDir, String(state.body?.cycles?.dir));
    check('the team view travels with the list', typeof state.body?.team?.status === 'string', JSON.stringify(state.body?.team).slice(0, 120));
    check('a complete cycle exposes all three sections', ['要务', 'retro', 'review'].every((key) => cycleOf(items, OLD_ID)?.sections?.[key]));
    check(
      'a never-written section is a missing key, not an empty string',
      Boolean(cycleOf(items, MID_ID)?.sections?.['要务']) && !('retro' in (cycleOf(items, MID_ID)?.sections || {})),
      JSON.stringify(Object.keys(cycleOf(items, MID_ID)?.sections || {})),
    );
    check('a broken frontmatter is surfaced so the page can disable saving', Boolean(cycleOf(items, BROKEN_ID)?.frontmatterError));

    // --- three independent saves ---------------------------------------------
    const before = cycleOf(items, OLD_ID);
    const savedRetro = await saveSection({ id: OLD_ID, section: 'retro', content: '补记：羽毛球只打了一次。' });
    check('saving retro -> 200', savedRetro.status === 200 && savedRetro.body?.ok === true, JSON.stringify(savedRetro.body).slice(0, 160));
    const afterRetro = cycleOf((await readCycles()).body?.cycles?.items, OLD_ID);
    check("a retro edit is recorded as source 'user'", afterRetro?.sections?.retro?.source === 'user', String(afterRetro?.sections?.retro?.source));
    check(
      'saving retro leaves 要务 untouched (content, source, updatedAt)',
      JSON.stringify(afterRetro?.sections?.['要务']) === JSON.stringify(before?.sections?.['要务']),
      `${JSON.stringify(before?.sections?.['要务'])} -> ${JSON.stringify(afterRetro?.sections?.['要务'])}`,
    );
    check(
      'saving retro leaves review untouched (content, source, updatedAt)',
      JSON.stringify(afterRetro?.sections?.review) === JSON.stringify(before?.sections?.review),
      JSON.stringify(afterRetro?.sections?.review),
    );

    const savedReview = await saveSection({ id: OLD_ID, section: 'review', content: '这一段我自己改了。' });
    const afterReview = cycleOf((await readCycles()).body?.cycles?.items, OLD_ID);
    check('saving review -> 200', savedReview.status === 200, String(savedReview.status));
    check('an AI-written review flips to user when edited by hand', afterReview?.sections?.review?.source === 'user', String(afterReview?.sections?.review?.source));
    check(
      'saving review leaves the retro just saved untouched',
      JSON.stringify(afterReview?.sections?.retro) === JSON.stringify(afterRetro?.sections?.retro),
      JSON.stringify(afterReview?.sections?.retro),
    );

    const savedPriorities = await saveSection({ id: MID_ID, section: '要务', content: '- **MIT** 写 Cycles 页\n- P0 紧急：签证材料' });
    const midAfter = cycleOf((await readCycles()).body?.cycles?.items, MID_ID);
    check('要务 can be taken over mid-cycle -> 200', savedPriorities.status === 200, String(savedPriorities.status));
    check('an edited 要务 flips from planner to user', midAfter?.sections?.['要务']?.source === 'user', String(midAfter?.sections?.['要务']?.source));
    check(
      'writing 要务 does not invent the sections that were never written',
      !('retro' in (midAfter?.sections || {})) && !('review' in (midAfter?.sections || {})),
      JSON.stringify(Object.keys(midAfter?.sections || {})),
    );

    // --- guardrails, unchanged by the move ------------------------------------
    const brokenSave = await saveSection({ id: BROKEN_ID, section: 'retro', content: '不该写进去' });
    check('saving a cycle with broken frontmatter is refused', brokenSave.status >= 400 || brokenSave.body?.ok === false, JSON.stringify(brokenSave.body).slice(0, 160));
    check('the broken file is left byte-identical', fs.readFileSync(path.join(cyclesDir, `${BROKEN_ID}.md`), 'utf8') === BROKEN_FILE);

    // Hiding the save button is a convenience; this is the rule. A hand-made
    // request that names any owner has to be refused on the server.
    const foreign = await saveSection({ id: OLD_ID, section: 'retro', content: '写成队友的', owner: '11111111-2222-3333-4444-555555555555' });
    check('a write that names a foreign owner is refused', foreign.body?.ok === false, JSON.stringify(foreign.body).slice(0, 160));
    check('the refused foreign write never reached the file', !fs.readFileSync(path.join(cyclesDir, `${OLD_ID}.md`), 'utf8').includes('写成队友的'));

    const memberLogin = await fetch(`${base}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'member', password: 'member-password-1' }),
    });
    const memberCookie = cookieFrom(memberLogin.headers.get('set-cookie'));
    const memberPage = await page('/cycles', { cookie: memberCookie });
    check('a member may read /cycles', memberPage.status === 200, String(memberPage.status));
    check('a member is not offered the team sync button', !memberPage.html.includes('id="cycles-team-sync"'));
    check('a member may read /api/cycles/state', (await readCycles({ cookie: memberCookie })).status === 200);
    const memberWrite = await saveSection({ id: OLD_ID, section: 'retro', content: 'member edit' }, { cookie: memberCookie, 'content-type': 'application/json' });
    check('a member cannot save a cycle -> 403', memberWrite.status === 403, String(memberWrite.status));
    check('the member edit never reached the file', !fs.readFileSync(path.join(cyclesDir, `${OLD_ID}.md`), 'utf8').includes('member edit'));

    // --- regression: the neighbouring console editors are untouched ------------
    const finalState = (await (await fetch(`${base}/api/state`, { headers: { cookie } })).json()) as any;
    const strategyIds = (finalState?.strategy?.files || []).map((file: any) => file.id);
    check(
      'Review Strategy still lists its files',
      strategyIds[0] === 'biweekly_strategy' && strategyIds.every((id: string) => ['biweekly_strategy', 'plan_rules', 'biweekly_mode'].includes(id)),
      strategyIds.join(','),
    );
    check('Review Strategy still exposes the built-in default', String(finalState?.strategy?.defaultStrategy || '').includes('计划条目规则'));
    const strategySave = await fetch(`${base}/api/strategy`, {
      method: 'POST',
      headers: authed,
      body: JSON.stringify({ id: 'biweekly_strategy', markdown: '计划条目规则（下双周要务）：\n- 自定义\n' }),
    });
    check('Review Strategy still saves', strategySave.status === 200 && fs.readFileSync(path.join(tmp, 'prompts', 'biweekly_strategy.md'), 'utf8').includes('自定义'));
    const strategyEscape = await fetch(`${base}/api/strategy`, {
      method: 'POST',
      headers: authed,
      body: JSON.stringify({ id: '../../../etc/hosts', markdown: 'pwned' }),
    });
    check('Review Strategy allowlist still rejects unknown ids', ((await strategyEscape.json()) as any)?.ok === false);

    const notesPath = String(finalState?.decisionPolicy?.notesPath || '');
    check('Decision Policy still resolves its notes file', notesPath.startsWith(vault), notesPath);
    const policySave = await fetch(`${base}/api/decision-policy`, {
      method: 'POST',
      headers: authed,
      body: JSON.stringify({ policyMd: '# 决策规则\n- 先看长期影响\n' }),
    });
    check('Decision Policy still saves', policySave.status === 200 && fs.readFileSync(notesPath, 'utf8').includes('先看长期影响'));
  } finally {
    await controls.stop();
    process.chdir(originalCwd);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// --- 2. the shipped client script ---------------------------------------------

const MATE_ID = '99999999-8888-7777-6666-555555555555';

function cycleFixture(id: string, startDate: string, label: string, sections: Record<string, unknown>, extra: Record<string, unknown> = {}): any {
  return {
    id,
    startDate,
    cycle: label,
    mode: 'biweekly',
    updatedAt: `${startDate}T08:00:00.000Z`,
    path: `/tmp/vault/20_CYCLES/${id}.md`,
    frontmatterError: '',
    sections,
    ...extra,
  };
}

async function testPageRendering(): Promise<void> {
  console.log('\n--- shipped /cycles script ---');
  const page = await loadCyclesPage();

  const older = cycleFixture(OLD_ID, '2026-06-01', '6.1-6.14', {
    要务: { content: '- 老周期要务', source: 'planner', updatedAt: '2026-06-01T08:00:00.000Z' },
    retro: { content: '老周期 retro', source: 'user', updatedAt: '2026-06-13T21:00:00.000Z' },
    review: { content: '老周期 review', source: 'ai', updatedAt: '2026-06-14T09:00:00.000Z' },
  });
  const middle = cycleFixture(MID_ID, '2026-08-24', '8.24-9.6', {
    要务: { content: '- 本期要务', source: 'planner', updatedAt: '2026-08-24T08:00:00.000Z' },
  });
  const newest = cycleFixture(NEW_ID, '2026-09-07', '9.7-9.13', {
    要务: { content: '- 最新要务', source: 'planner', updatedAt: '2026-09-07T08:00:00.000Z' },
  });
  const broken = cycleFixture(BROKEN_ID, '2026-09-21', '9.21-10.4', {}, { frontmatterError: 'bad indentation' });

  // Deliberately unsorted: ordering is the page's job, not the fixture's.
  const mine = { dir: '/tmp/vault/20_CYCLES', items: [middle, newest, older] };
  page.setState({ cycles: mine, team: null });
  page.render();

  // --- left panel -----------------------------------------------------------
  const listed = page.listedCycleIds();
  check('the left panel lists my cycles newest first', listed.join(',') === [NEW_ID, MID_ID, OLD_ID].join(','), listed.join(','));
  check('the newest cycle is selected by default', page.el('cycle-list').innerHTML.includes(`data-cycle-id="${NEW_ID}" aria-current="true"`), page.el('cycle-list').innerHTML.slice(0, 200));
  check('the empty state is out of the way when there are cycles', page.el('cycles-empty').hidden === true);
  check('the vault directory is shown', page.el('cycles-dir').textContent.includes('/tmp/vault/20_CYCLES'), page.el('cycles-dir').textContent);
  check('with no team, the member panel says there is nothing to see', page.el('cycle-members').innerHTML.includes('还没有队友'), page.el('cycle-members').innerHTML);

  // --- three cards ----------------------------------------------------------
  check('the cards are shown', page.el('cycle-cards').hidden === false);
  check('the selected cycle fills the 要务 card', page.el('cycle-md-priorities').value === '- 最新要务', page.el('cycle-md-priorities').value);
  check('a never-written section is called out as never written', page.el('cycle-meta-retro').textContent.includes('还没写过'), page.el('cycle-meta-retro').textContent);
  check('a written section reports its source', page.el('cycle-meta-priorities').textContent.includes('planner'), page.el('cycle-meta-priorities').textContent);
  check('every card offers its own save control', ['priorities', 'retro', 'review'].every((key) => page.el('cycle-actions-' + key).hidden === false && page.el('cycle-save-' + key).disabled === false));
  check('the heading names the selected cycle', page.el('cycle-heading').textContent.includes('9.7-9.13'), page.el('cycle-heading').textContent);
  check('the file path of the selected cycle is shown', page.el('cycle-file-path').textContent.includes(`${NEW_ID}.md`), page.el('cycle-file-path').textContent);

  // --- drafts survive switching cycles --------------------------------------
  page.el('cycle-md-retro').value = '最新周期的草稿';
  page.fire('cycle-md-retro', 'input');
  page.clickCycle(OLD_ID);
  check('clicking another cycle switches the cards', page.el('cycle-md-priorities').value === '- 老周期要务', page.el('cycle-md-priorities').value);
  check('the other cycle brings its own retro', page.el('cycle-md-retro').value === '老周期 retro', page.el('cycle-md-retro').value);
  page.el('cycle-md-review').value = '老周期的草稿';
  page.fire('cycle-md-review', 'input');
  page.clickCycle(NEW_ID);
  check('switching back restores the unsaved draft', page.el('cycle-md-retro').value === '最新周期的草稿', page.el('cycle-md-retro').value);
  page.clickCycle(OLD_ID);
  check('the second cycle keeps its own draft too', page.el('cycle-md-review').value === '老周期的草稿', page.el('cycle-md-review').value);
  check('a draft never leaks into another cycle', page.el('cycle-md-retro').value === '老周期 retro', page.el('cycle-md-retro').value);
  page.clickCycle(NEW_ID);

  // --- zoom -----------------------------------------------------------------
  page.el('cycle-zoom-retro').focused = false;
  page.clickZoom('retro');
  check('the zoom dialog opens', page.el('cycle-modal').hidden === false);
  check('the dialog shows the section it was opened from', page.el('cycle-modal-title').textContent === 'retro', page.el('cycle-modal-title').textContent);
  check('the dialog shows the card content', page.el('cycle-modal-text').value === '最新周期的草稿', page.el('cycle-modal-text').value);
  check('the dialog carries the same meta line', page.el('cycle-modal-meta').textContent === page.el('cycle-meta-retro').textContent);
  check('focus moves into the dialog', page.activeElement()?.id === 'cycle-modal-text', String(page.activeElement()?.id));
  check('my own dialog can save', page.el('cycle-modal-actions').hidden === false && page.el('cycle-modal-save').disabled === false);

  page.el('cycle-modal-text').value = '在放大视图里继续写';
  page.fire('cycle-modal-text', 'input');
  check('typing in the dialog writes through to the card', page.el('cycle-md-retro').value === '在放大视图里继续写', page.el('cycle-md-retro').value);

  page.pressKey('Escape');
  check('Escape closes the dialog', page.el('cycle-modal').hidden === true);
  check('focus returns to the control that opened it', page.activeElement()?.id === 'cycle-zoom-retro', String(page.activeElement()?.id));
  check('the text typed in the dialog is still in the card', page.el('cycle-md-retro').value === '在放大视图里继续写', page.el('cycle-md-retro').value);
  page.clickCycle(OLD_ID);
  page.clickCycle(NEW_ID);
  check('the dialog edit was drafted like any other typing', page.el('cycle-md-retro').value === '在放大视图里继续写', page.el('cycle-md-retro').value);

  // --- broken frontmatter ---------------------------------------------------
  page.setState({ cycles: { dir: '/tmp/vault/20_CYCLES', items: [broken, newest] }, team: null });
  page.render();
  check('a re-render keeps the cycle I was reading', page.el('cycle-heading').textContent.includes('9.7-9.13'), page.el('cycle-heading').textContent);
  page.clickCycle(BROKEN_ID);
  check('the broken cycle can still be opened', page.el('cycle-heading').textContent.includes('9.21-10.4'), page.el('cycle-heading').textContent);
  check('a broken frontmatter is warned about', page.el('cycle-frontmatter-error').hidden === false && page.el('cycle-frontmatter-error').textContent.includes('bad indentation'), page.el('cycle-frontmatter-error').textContent);
  check('a broken frontmatter disables every save button', ['priorities', 'retro', 'review'].every((key) => page.el('cycle-save-' + key).disabled === true));
  check('a broken frontmatter disables every editor', ['priorities', 'retro', 'review'].every((key) => page.el('cycle-md-' + key).disabled === true));
  check('the left panel flags the broken file', page.el('cycle-list').innerHTML.includes('frontmatter 解析失败'));
  page.clickZoom('retro');
  check('the dialog over a broken cycle cannot save either', page.el('cycle-modal-save').disabled === true);
  page.pressKey('Escape');

  // --- teammates ------------------------------------------------------------
  const mateOlder = cycleFixture(OLD_ID, '2026-06-01', '6.1-6.14', { 要务: { content: '- 队友的老要务', source: 'planner', updatedAt: '2026-06-01T08:00:00.000Z' } });
  const mateNewer = cycleFixture(MID_ID, '2026-08-24', '8.24-9.6', { 要务: { content: '- 队友的最新要务', source: 'planner', updatedAt: '2026-08-24T08:00:00.000Z' } });
  const team = {
    status: 'ready',
    reason: '',
    cacheDir: '/tmp/data/team-cache',
    self: { userId: 'self', memberId: 'leon', displayName: 'Leon' },
    syncedAt: '2026-09-02T10:00:00.000Z',
    lastCheckedAt: '2026-09-02T10:00:00.000Z',
    lastError: '',
    // Deliberately unsorted, and older first.
    members: [{ userId: MATE_ID, memberId: 'penguin', displayName: '企鹅', label: '企鹅', cycles: [mateOlder, mateNewer] }],
  };
  page.setState({ cycles: mine, team });
  page.render();
  check('the member panel lists the teammate', page.el('cycle-members').innerHTML.includes('企鹅') && page.el('cycle-members').innerHTML.includes(MATE_ID));
  check('the member entry previews their latest cycle', page.el('cycle-members').innerHTML.includes('最新 8.24-9.6'), page.el('cycle-members').innerHTML);

  page.clickMember(MATE_ID);
  check("a teammate view shows that teammate's latest cycle", page.el('cycle-md-priorities').value === '- 队友的最新要务', page.el('cycle-md-priorities').value);
  check('a teammate view has no save control at all', ['priorities', 'retro', 'review'].every((key) => page.el('cycle-actions-' + key).hidden === true && page.el('cycle-save-' + key).disabled === true));
  check('a teammate view is read-only text', ['priorities', 'retro', 'review'].every((key) => page.el('cycle-md-' + key).readOnly === true));
  check('a teammate view says whose it is', page.el('cycle-readonly').hidden === false && page.el('cycle-readonly').textContent.includes('只读'), page.el('cycle-readonly').textContent);
  check('the left panel still lists my own cycles', page.listedCycleIds().join(',') === [NEW_ID, MID_ID, OLD_ID].join(','), page.listedCycleIds().join(','));
  check('none of my cycles looks selected while a teammate is shown', !page.el('cycle-list').innerHTML.includes('aria-current'), page.el('cycle-list').innerHTML.slice(0, 160));

  page.clickZoom('priorities');
  check('a teammate card still zooms', page.el('cycle-modal').hidden === false && page.el('cycle-modal-text').value === '- 队友的最新要务');
  check('the zoomed teammate card is read-only', page.el('cycle-modal-text').readOnly === true);
  check('the zoomed teammate card offers no save', page.el('cycle-modal-actions').hidden === true);
  check('focus lands on the only control there is', page.activeElement()?.id === 'cycle-modal-close', String(page.activeElement()?.id));
  page.pressKey('Escape');
  check('Escape closes a read-only dialog too', page.el('cycle-modal').hidden === true);

  // Typing in a read-only view must not create a draft under a colliding id.
  page.el('cycle-md-priorities').value = '试图改队友的';
  page.fire('cycle-md-priorities', 'input');
  page.clickCycle(NEW_ID);
  check('clicking one of my cycles leaves the teammate view', page.el('cycle-md-priorities').value === '- 最新要务', page.el('cycle-md-priorities').value);
  check('typing over a teammate never became a draft of mine', page.el('cycle-md-retro').value === '在放大视图里继续写', page.el('cycle-md-retro').value);
  check('my save controls are back', page.el('cycle-actions-retro').hidden === false && page.el('cycle-readonly').hidden === true);

  // A teammate with nothing cached is an empty state, not a blank form.
  page.setState({ cycles: mine, team: { ...team, members: [{ ...team.members[0], cycles: [] }] } });
  page.render();
  page.clickMember(MATE_ID);
  check('an empty teammate hides the cards', page.el('cycle-cards').hidden === true && page.el('cycle-detail-empty').hidden === false);
  check('the empty state names the teammate', page.el('cycle-detail-empty').textContent.includes('企鹅'), page.el('cycle-detail-empty').textContent);

  // No cycles of my own at all.
  page.setState({ cycles: { dir: '/tmp/vault/20_CYCLES', items: [] }, team: null });
  page.render();
  check('with no cycles the empty state appears', page.el('cycles-empty').hidden === false);
  check('with no cycles the cards are hidden', page.el('cycle-cards').hidden === true);
}

/**
 * The shipped /cycles script, evaluated against a DOM stub. Delegated handlers
 * are fired through the listeners the script itself registered, so the wiring is
 * under test and not just the render functions.
 */
async function loadCyclesPage() {
  const { CYCLES_JS } = await import('../../src/ui/pages.js');

  interface StubElement {
    id: string;
    value: string;
    textContent: string;
    innerHTML: string;
    hidden: boolean;
    disabled: boolean;
    readOnly: boolean;
    focused: boolean;
    dataset: Record<string, string>;
    listeners: Record<string, Array<(event: unknown) => void>>;
    addEventListener(type: string, handler: (event: unknown) => void): void;
    querySelectorAll(): unknown[];
    closest(): unknown;
    focus(): void;
    dispatchEvent(): void;
  }

  const elements = new Map<string, StubElement>();
  const makeElement = (id: string): StubElement => {
    const element: StubElement = {
      id,
      value: '',
      textContent: '',
      innerHTML: '',
      hidden: false,
      disabled: false,
      readOnly: false,
      focused: false,
      dataset: {},
      listeners: {},
      addEventListener(type, handler) {
        (element.listeners[type] ||= []).push(handler);
      },
      querySelectorAll: () => [],
      closest: () => null,
      focus() {
        element.focused = true;
        documentStub.activeElement = element;
      },
      dispatchEvent() {},
    };
    return element;
  };
  const get = (id: string): StubElement => {
    if (!elements.has(id)) elements.set(id, makeElement(id));
    return elements.get(id)!;
  };

  const documentListeners: Record<string, Array<(event: unknown) => void>> = {};
  const documentStub = {
    getElementById: (id: string) => get(id),
    querySelectorAll: () => [] as unknown[],
    addEventListener(type: string, handler: (event: unknown) => void) {
      (documentListeners[type] ||= []).push(handler);
    },
    activeElement: null as StubElement | null,
    title: '',
  };
  const windowStub = {
    location: { search: '', pathname: '/cycles', hash: '' },
    history: { replaceState() {} },
    addEventListener() {},
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    setTimeout: () => 0,
    clearTimeout() {},
    setInterval: () => 0,
    clearInterval() {},
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
    `${CYCLES_JS}
     return {
       renderCyclesPage,
       setState: (next) => { cyclesData = next; },
     };`,
  );
  const api = factory(
    documentStub,
    windowStub,
    windowStub.location,
    windowStub.history,
    storageStub,
    storageStub,
    // The script kicks off a load on evaluation. Never resolving it keeps the
    // fixtures the test sets below from being raced by a stub response.
    () => new Promise(() => {}),
    { clipboard: {} },
    windowStub.setTimeout,
    windowStub.clearTimeout,
    windowStub.setInterval,
    windowStub.clearInterval,
  ) as { renderCyclesPage: () => void; setState: (next: unknown) => void };

  /** A click whose target resolves `closest(selector)` the way the real one would. */
  const clickOn = (containerId: string, selector: string, dataset: Record<string, string>): void => {
    const target = { closest: (query: string) => (query === selector ? { dataset } : null) };
    for (const handler of get(containerId).listeners.click || []) handler({ target });
  };

  return {
    el: get,
    setState: api.setState,
    render: api.renderCyclesPage,
    activeElement: () => documentStub.activeElement,
    listedCycleIds: (): string[] =>
      [...get('cycle-list').innerHTML.matchAll(/data-cycle-id="([^"]+)"/g)].map((match) => match[1]),
    clickCycle: (id: string) => clickOn('cycle-list', '[data-cycle-id]', { cycleId: id }),
    clickMember: (ownerId: string) => clickOn('cycle-members', '[data-owner-id]', { ownerId }),
    clickZoom: (key: string) => clickOn('cycle-cards', '[data-cycle-zoom]', { cycleZoom: key }),
    pressKey: (key: string) => {
      for (const handler of documentListeners.keydown || []) handler({ key, preventDefault() {} });
    },
    fire: (id: string, type: string) => {
      for (const handler of get(id).listeners[type] || []) handler({ target: get(id) });
    },
  };
}

void main();
