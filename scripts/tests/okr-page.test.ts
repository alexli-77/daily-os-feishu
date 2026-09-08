/**
 * Standalone /okr platform page: two columns (5-year north star + annual).
 *
 * Independent, tsx-runnable:  npx tsx scripts/tests/okr-page.test.ts
 *
 * The page is read-only, so what is worth locking down is not "does a heading
 * exist" but the ways it can silently go blank: a missing file, a file whose
 * body has no parseable objective, an objective with no key results. Each of
 * those has to become a message, and none of them may take the request down —
 * the OKR files are hand-edited markdown, so malformed input is the normal case,
 * not the exceptional one.
 *
 * The other half is what the split moved: /today must no longer carry the OKR
 * block, and the Config console must keep its OKR editor (plus the Review
 * Strategy and Decision Policy sections that live next to it) working exactly
 * as before.
 *
 * Driven through the real UI server with a real login session, inside a temp
 * workspace: no real config or vault is touched.
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

const NORTH_STAR = [
  '---',
  'title: North Star OKR',
  'level: north-star',
  'cycle: 2026-2031',
  'status: active',
  'updated: 2026-07-16',
  '---',
  '',
  '# North Star OKR (5-year)',
  '',
  '## Objective N1: 只工作不上班',
  '',
  'Parent: none',
  '',
  '| KR ID | Description | Target | Current | Progress | Updated |',
  '| --- | --- | --- | --- | --- | --- |',
  '| N1-KR1 | 被动收入覆盖生活成本 | 100% | 30% | 30% | 2026-07-16 |',
  '| N1-KR2 | 建立可复制的产品线 | 3 条 | 1 条 | 33% | 2026-07-16 |',
  '',
  '## Objective N2: 博士毕业并留在学术圈边上',
  '',
  'Parent: none',
  '',
  '| KR ID | Description | Target | Current | Progress | Updated |',
  '| --- | --- | --- | --- | --- | --- |',
  '| N2-KR1 | 一作论文 | 4 篇 | 0 篇 | 0% | 2026-07-16 |',
  // Shaped like the real long-horizon files, where Target/Updated are blank and
  // Current is the em-dash placeholder.
  '| N2-KR2 | 方向还没定 |  | — | 0% |  |',
  '',
].join('\n');

const ANNUAL = [
  '---',
  'title: Annual OKR',
  'level: annual',
  'cycle: 2026',
  'status: active',
  'updated: 2026-08-01',
  '---',
  '',
  '## Objective A1: 把 Daily OS 做到有人付费',
  '',
  'Parent: N1',
  '',
  '| KR ID | Description | Target | Current | Progress | Updated |',
  '| --- | --- | --- | --- | --- | --- |',
  '| A1-KR1 | 付费用户数 | 10 | 2 | 20% | 2026-08-01 |',
  '',
].join('\n');

const CURRENT = [
  '---',
  'title: Current OKR',
  'level: current',
  'cycle: 2026Q3',
  '---',
  '',
  '## Objective O1: 本季把 console 拆干净',
  '',
  'Parent: A1',
  '',
  '| KR ID | Description | Target | Current | Progress | Updated |',
  '| --- | --- | --- | --- | --- | --- |',
  '| O1-KR1 | 页面拆分完成 | 3 页 | 1 页 | 33% | 2026-08-01 |',
  '',
].join('\n');

/**
 * Everything a hand-edited file can get wrong at once: unterminated frontmatter,
 * an Objective heading with no colon, a KR table with missing columns, and an
 * objective heading that carries a script tag. Nothing here must throw, and the
 * script tag must not survive as markup.
 */
const MALFORMED = [
  '---',
  'title: broken',
  'cycle: 2026',
  '',
  '## Objective without an id or colon',
  '',
  '| KR ID | Description |',
  '| --- | --- |',
  '| X-KR1 | 两列的残表 |',
  '',
  '## Objective A9: <script>alert("xss")</script>',
  '',
  '| KR ID | Description | Target | Current | Progress | Updated |',
  '| --- | --- | --- | --- | --- | --- |',
  '| A9-KR1 | 注入测试 | <img src=x onerror=alert(1)> | — | 不是数字 |  |',
  '',
].join('\n');

async function main(): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-os-okr-page-test-'));
  const vault = path.join(tmp, 'vault');
  const okrDir = path.join(vault, '10_OKR');
  const northStarPath = path.join(okrDir, 'north-star-okr.md');
  const annualPath = path.join(okrDir, 'annual-okr.md');
  fs.mkdirSync(okrDir, { recursive: true });
  fs.writeFileSync(northStarPath, NORTH_STAR, 'utf8');
  fs.writeFileSync(annualPath, ANNUAL, 'utf8');
  fs.writeFileSync(path.join(okrDir, 'current-okr.md'), CURRENT, 'utf8');
  writeConfig(tmp, vault);
  fs.writeFileSync(path.join(tmp, '.env'), '');

  const originalCwd = process.cwd();
  process.chdir(tmp);

  const auth = await import('../../src/ui/auth.js');
  const { startUiServer } = await import('../../src/ui/server.js');

  auth.resetSessionCacheForTests();
  auth.addUser('admin', 'admin-password-1', 'admin');

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

    const getPage = async (pathname: string): Promise<{ status: number; html: string }> => {
      const response = await fetch(`${base}${pathname}`, { headers: { cookie } });
      return { status: response.status, html: await response.text() };
    };
    const postJson = async (pathname: string, body: unknown): Promise<{ status: number; body: any }> => {
      const response = await fetch(`${base}${pathname}`, { method: 'POST', headers: authed, body: JSON.stringify(body) });
      return { status: response.status, body: (await response.json()) as any };
    };
    const readState = async (): Promise<any> => (await (await fetch(`${base}/api/state`, { headers: { cookie } })).json()) as any;

    // --- Reachability + nav ---------------------------------------------------
    const anon = await fetch(`${base}/okr`, { redirect: 'manual' });
    check(
      '/okr without a session redirects to /login',
      anon.status === 302 && anon.headers.get('location') === '/login',
      `${anon.status} ${anon.headers.get('location')}`,
    );

    const okrPage = await getPage('/okr');
    check('/okr with a session -> 200', okrPage.status === 200, String(okrPage.status));
    check('/okr is in the nav', okrPage.html.includes('href="/okr"'));
    check('/okr marks itself as the active nav item', okrPage.html.includes('class="nav-link active" href="/okr"'));

    // --- Both columns render, structured, not raw markdown --------------------
    check('five-year column has a heading', okrPage.html.includes('5 年 North Star'));
    check('annual column has a heading', okrPage.html.includes('年度 Annual'));
    check('five-year objective title is rendered', okrPage.html.includes('只工作不上班'), okrPage.html.slice(0, 200));
    check('five-year second objective is rendered', okrPage.html.includes('博士毕业并留在学术圈边上'));
    check('annual objective title is rendered', okrPage.html.includes('把 Daily OS 做到有人付费'));
    check('key results from both files are rendered', okrPage.html.includes('N1-KR1') && okrPage.html.includes('A1-KR1'));
    check('KR description is rendered', okrPage.html.includes('被动收入覆盖生活成本'));
    check('KR target / current are rendered', okrPage.html.includes('目标 100%') && okrPage.html.includes('当前 30%'));
    check('KR progress becomes a bar width', okrPage.html.includes('style="width:30%"'), 'no 30% bar');
    check("annual objective's parent link is shown", okrPage.html.includes('↦ N1'));
    // Every objective in the real north-star and annual files says `Parent: none`,
    // so rendering it verbatim would tag all of them with a link to nothing.
    check('a "none" parent is not rendered as a link', !okrPage.html.includes('↦ none'), 'placeholder parent leaked');
    check('column summary counts objectives and KRs', okrPage.html.includes('2 个 Objective · 4 个 KR'));
    check('a KR with no target/current gets no meta row', !okrPage.html.includes('目标 — · 当前 —'), 'empty meta row rendered');
    check('the empty-meta KR still renders', okrPage.html.includes('N2-KR2') && okrPage.html.includes('方向还没定'));
    check('frontmatter cycle is surfaced', okrPage.html.includes('周期 2026-2031'));
    check(
      'the markdown source is not dumped on the page',
      !okrPage.html.includes('| KR ID | Description') && !okrPage.html.includes('| --- |'),
      'raw table markup leaked',
    );
    check('the quarterly file is not part of this page', !okrPage.html.includes('O1-KR1'));
    check('the two columns share one grid container', okrPage.html.includes('class="two-col"'));

    // --- Missing file ---------------------------------------------------------
    fs.rmSync(annualPath);
    const missingAnnual = await getPage('/okr');
    check('a missing annual file still returns 200', missingAnnual.status === 200, String(missingAnnual.status));
    check('a missing annual file gets an explicit empty state', missingAnnual.html.includes('还没有 <code>annual-okr.md</code>'));
    check('a missing annual file points at the editor', missingAnnual.html.includes('href="/console#okr"'));
    check('the surviving column still renders', missingAnnual.html.includes('只工作不上班'));

    // --- Both files missing ---------------------------------------------------
    fs.rmSync(okrDir, { recursive: true, force: true });
    const noDir = await getPage('/okr');
    check('a missing 10_OKR dir still returns 200', noDir.status === 200, String(noDir.status));
    check(
      'both columns fall back to an empty state',
      noDir.html.includes('还没有 <code>north-star-okr.md</code>') && noDir.html.includes('还没有 <code>annual-okr.md</code>'),
    );
    check('the empty page is not blank', noDir.html.includes('5 年 North Star') && noDir.html.includes('年度 Annual'));

    // --- Unparseable content --------------------------------------------------
    fs.mkdirSync(okrDir, { recursive: true });
    fs.writeFileSync(northStarPath, NORTH_STAR, 'utf8');
    fs.writeFileSync(annualPath, MALFORMED, 'utf8');
    const malformed = await getPage('/okr');
    check('a malformed file does not throw', malformed.status === 200, String(malformed.status));
    check('a heading with no parseable id is not rendered as an objective', !malformed.html.includes('without an id or colon'));
    check('a KR row with too few columns is dropped, not half-rendered', !malformed.html.includes('X-KR1'));
    check('the parseable objective in a malformed file still renders', malformed.html.includes('A9-KR1'));
    check('a non-numeric progress renders as — with an empty bar', malformed.html.includes('style="width:0%"'));
    check('an injected script tag is escaped, not rendered', !malformed.html.includes('<script>alert("xss")</script>'));
    check('an injected img tag is escaped, not rendered', !malformed.html.includes('<img src=x onerror'));
    check('the healthy column is unaffected by its neighbour', malformed.html.includes('N1-KR1'));

    // An objective heading that parses but carries no KR table.
    fs.writeFileSync(annualPath, ['## Objective A1: 只有标题没有 KR', '', 'Parent: N1', ''].join('\n'), 'utf8');
    const noKrs = await getPage('/okr');
    check('an objective without key results says so', noKrs.html.includes('这个 Objective 下还没有 KR'), String(noKrs.status));

    // A file that exists but has nothing an objective parser can use.
    fs.writeFileSync(annualPath, '随手记的一段话，没有任何 OKR 结构。\n', 'utf8');
    const noObjectives = await getPage('/okr');
    check('a file with no objectives explains what is missing', noObjectives.html.includes('没有解析出 Objective'), String(noObjectives.status));

    // --- /today no longer carries OKR ----------------------------------------
    fs.writeFileSync(annualPath, ANNUAL, 'utf8');
    const today = await getPage('/today');
    check('/today still renders', today.status === 200 && today.html.includes("Today's plan"), String(today.status));
    check('/today keeps the todo column', today.html.includes('My todos'));
    check('/today no longer has the OKR chain column', !today.html.includes('OKR chain'));
    check('/today no longer has the north-star bar', !today.html.includes('north-bar') && !today.html.includes('North Star'));
    check('/today renders no key results', !today.html.includes('N1-KR1') && !today.html.includes('O1-KR1'));
    check('/today links to the new OKR page', today.html.includes('href="/okr"'));

    // --- Config console: the OKR editor still works ---------------------------
    const state = await readState();
    const levels = (state?.okr?.files || []).map((file: any) => file.level);
    check('state still exposes the three OKR editor files', levels.join(',') === 'north-star,annual,current', levels.join(','));
    check('editor state carries the file markdown', String(state?.okr?.files?.[0]?.markdown || '').includes('Objective N1'));
    check('editor state carries the OKR dir', state?.okr?.dir === okrDir, String(state?.okr?.dir));

    const edited = `${ANNUAL}\n## Objective A2: 通过 console 新增的目标\n\nParent: N1\n`;
    const savedOkr = await postJson('/api/okr', { level: 'annual', markdown: edited });
    check('saving from the OKR editor -> 200', savedOkr.status === 200 && savedOkr.body?.ok === true, JSON.stringify(savedOkr.body).slice(0, 160));
    check('the OKR editor writes the file on disk', fs.readFileSync(annualPath, 'utf8').includes('通过 console 新增的目标'));
    check(
      'the saved markdown comes back in the editor state',
      String((savedOkr.body?.state?.okr?.files || []).find((f: any) => f.level === 'annual')?.markdown || '').includes('Objective A2'),
    );

    const afterSave = await getPage('/okr');
    check('the standalone page reflects an editor save', afterSave.html.includes('通过 console 新增的目标'));

    const formatted = await postJson('/api/okr/format', { level: 'annual', markdown: '目标：随手写的一行\n' });
    check('the OKR format button still returns normalized markdown', formatted.status === 200 && typeof formatted.body?.formatted === 'string', JSON.stringify(formatted.body).slice(0, 160));
    check('normalized markdown carries the loader-format heading', String(formatted.body?.formatted || '').includes('## Objective'), String(formatted.body?.formatted || '').slice(0, 120));

    // --- Config console: Review Strategy unchanged ----------------------------
    const strategyFiles = (state?.strategy?.files || []).map((file: any) => file.id);
    check('state still exposes the biweekly strategy file', strategyFiles.includes('biweekly_strategy'), strategyFiles.join(','));
    check('state still exposes the built-in default strategy', String(state?.strategy?.defaultStrategy || '').length > 0);

    const savedStrategy = await postJson('/api/strategy', { id: 'biweekly_strategy', markdown: '计划条目规则：MIT 最多 3 条。' });
    check('saving a strategy file -> 200', savedStrategy.status === 200 && savedStrategy.body?.ok === true, JSON.stringify(savedStrategy.body).slice(0, 160));
    const strategyAfter = (savedStrategy.body?.state?.strategy?.files || []).find((file: any) => file.id === 'biweekly_strategy');
    check('the saved strategy markdown round-trips', String(strategyAfter?.markdown || '').includes('MIT 最多 3 条'), String(strategyAfter?.markdown || ''));

    const unknownStrategy = await postJson('/api/strategy', { id: 'nope', markdown: 'x' });
    check('an unknown strategy id is still refused', unknownStrategy.body?.ok === false || unknownStrategy.status >= 400, JSON.stringify(unknownStrategy.body).slice(0, 160));

    // --- Config console: Decision Policy unchanged ----------------------------
    check('state still exposes the decision policy path', String(state?.decisionPolicy?.notesPath || '').length > 0, String(state?.decisionPolicy?.notesPath));
    const savedPolicy = await postJson('/api/decision-policy', { policyMd: '# 决策规则\n- 先问动机再问方案。' });
    check('saving the decision policy -> 200', savedPolicy.status === 200 && savedPolicy.body?.ok === true, JSON.stringify(savedPolicy.body).slice(0, 160));
    check(
      'the saved decision policy round-trips',
      String(savedPolicy.body?.state?.decisionPolicy?.policyMd || '').includes('先问动机再问方案'),
      String(savedPolicy.body?.state?.decisionPolicy?.policyMd || ''),
    );
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
