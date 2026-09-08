/**
 * Read mode on /cycles, and the AI review entry point.
 *
 * Independent, tsx-runnable:  npx tsx scripts/tests/cycle-read-mode.test.ts
 *
 * The three sections are markdown in a fixed shape, so the page renders them
 * itself rather than pulling in a markdown parser. That choice has one hard
 * safety property, and it is what most of this file asserts: **no input line
 * may be dropped**. A section that does not match its expected shape falls back
 * to plain paragraphs. Losing a line of someone's retro to a parser is a worse
 * outcome than showing it unstyled.
 *
 * The rendering half drives the shipped CYCLES_JS against a DOM stub. The
 * endpoint half drives the real UI server with a real session.
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

const PRIORITIES = [
  '### 工作 · 技术专家',
  '- 发起至少 5 家目标公司内推或定向申请 **MIT**',
  '- 确认英文简历 v1 可修改版本存在',
  '',
  '### 金钱 · 家庭理财规划师',
  '- 校准家庭财富三个数 (LEO-102)',
].join('\n');

const RETRO = [
  '😄状态',
  '情绪：正常',
  '精力：偏低',
  '外部压力：',
  '计划外吃掉时间的事：搬家占掉两天',
  '👍🏻做的好',
  'MIT 按时完成，投递启动了',
  '💪🏻待改进',
  '口播连续两周 0 条',
].join('\n');

const REVIEW = 'MIT 完成率 100%，节奏稳定。\n\n口播仍为 0，是执行力问题。';

async function main(): Promise<void> {
  await testRendering();
  await testReviewEndpoint();
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

// --- 1. read-mode rendering ----------------------------------------------------

async function testRendering(): Promise<void> {
  console.log('\n--- read mode ---');
  const render = await loadRenderer();

  // --- 要务 -------------------------------------------------------------------
  const tasks = render('priorities', PRIORITIES);
  check('an OKR heading becomes a group title', tasks.includes('工作 · 技术专家') && tasks.includes('cy-group-title'), tasks.slice(0, 120));
  check('both groups are rendered', tasks.includes('金钱 · 家庭理财规划师'));
  check('bullets become list items, without their dash', tasks.includes('<li class="cy-task ') && !tasks.includes('>- '), tasks.slice(0, 200));
  check('MIT becomes a badge', tasks.includes('<span class="cy-badge">MIT</span>'));
  check('the MIT marker is not also left in the text', !/MIT<\/span><span>[^<]*MIT/.test(tasks) && !tasks.includes('**MIT**'), tasks);
  check('a Linear id becomes a link', tasks.includes('href="https://linear.app/') && tasks.includes('>LEO-102</a>'), tasks.slice(-260));
  check('no markdown syntax leaks into the rendered view', !tasks.includes('###') && !tasks.includes('**'));
  check('every task line survives', ['发起至少 5 家', '确认英文简历 v1', '校准家庭财富三个数'].every((piece) => tasks.includes(piece)));

  // --- retro ------------------------------------------------------------------
  const retro = render('retro', RETRO);
  check('the three retro sections are titled', ['状态', '做的好', '待改进'].every((title) => retro.includes(title)), retro.slice(0, 200));
  check('状态 lines become field rows', retro.includes('<dl class="cy-fields">') && retro.includes('<dt>情绪</dt>'), retro.slice(0, 300));
  check('a field value is shown next to its name', retro.includes('<dd>正常</dd>'));
  check('an unanswered field is marked rather than dropped', retro.includes('（未填）'), retro.slice(0, 400));
  check('a long field value is kept as a value, not a heading', retro.includes('搬家占掉两天'));
  check('the free-text sections become paragraphs', retro.includes('<p>MIT 按时完成，投递启动了</p>') && retro.includes('<p>口播连续两周 0 条</p>'), retro.slice(-260));
  check('the emoji headings are not repeated in the body', (retro.match(/待改进/g) || []).length === 1, retro);

  // --- the fallback, which is the whole safety story ---------------------------
  const freeform = render('retro', '这是一段没有任何标题的旧复盘。\n第二行也要在。');
  check('a retro with no recognised headings still renders', freeform.includes('这是一段没有任何标题的旧复盘。'), freeform);
  check('and keeps every line of it', freeform.includes('第二行也要在。'), freeform);

  // The real vault files use 👍🏻 / 💪🏻. A skin-tone modifier is Emoji_Modifier,
  // not Extended_Pictographic, so a class covering only the latter recognised
  // 😄状态 and swallowed the other two sections into it — with every line still
  // on screen, which is exactly why the fallback cannot be the only check.
  const toned = render('retro', '😄状态\n情绪：正常\n👍🏻做的好\n甲\n💪🏻待改进\n乙');
  check('skin-tone modified headings are recognised', (toned.match(/cy-group-title/g) || []).length === 3, toned);
  check('and their bodies land in the right section', /待改进<\/h4><p>乙<\/p>/.test(toned.replace(/💪🏻 /, '')), toned);
  const plain = render('retro', '状态\n情绪：正常\n做得好\n甲\n待改进\n乙');
  check('bare headings and the 做得好 spelling also work', (plain.match(/cy-group-title/g) || []).length === 3, plain);

  const oddTasks = render('priorities', '随手写的一行，没有标题也没有项目符号');
  check('要务 with no heading and no bullet still renders', oddTasks.includes('随手写的一行'), oddTasks);

  check('an empty section renders as nothing at all', render('priorities', '') === '' && render('retro', '   \n  ') === '');

  // --- escaping ---------------------------------------------------------------
  const nasty = render('review', '<script>alert(1)</script> 和 <img src=x onerror=alert(2)>');
  check('markup in the content is escaped, not executed', !nasty.includes('<script>') && !nasty.includes('<img'), nasty);
  check('and the text is still readable', nasty.includes('&lt;script&gt;'), nasty);

  const review = render('review', REVIEW);
  check('review paragraphs are split on blank lines', (review.match(/<p>/g) || []).length === 2, review);

  // --- mode switching ---------------------------------------------------------
  const page = await loadCyclesPage();
  const cycle = {
    id: '2026-08-24_8.24-9.6', startDate: '2026-08-24', cycle: '8.24-9.6', mode: 'biweekly',
    runId: '', updatedAt: '2026-09-01T00:00:00.000Z', path: '/tmp/v/20_CYCLES/x.md', frontmatterError: '',
    sections: {
      要务: { content: PRIORITIES, source: 'planner', updatedAt: '2026-08-24T08:00:00.000Z' },
      retro: { content: RETRO, source: 'user', updatedAt: '2026-09-06T21:00:00.000Z' },
    },
  };
  page.setState({ cycles: { dir: '/tmp/v/20_CYCLES', items: [cycle] }, team: null });
  page.render();

  check('a section with content opens in read mode', page.el('cycle-read-priorities').hidden === false && page.el('cycle-md-priorities').hidden === true);
  check('the toggle offers the other mode', page.el('cycle-mode-priorities').textContent === '编辑', page.el('cycle-mode-priorities').textContent);
  check('an empty section opens in the editor instead', page.el('cycle-md-review').hidden === false && page.el('cycle-read-review').hidden === true);
  check('and its toggle is disabled, since there is nothing to read', page.el('cycle-mode-review').disabled === true);

  page.clickMode('priorities');
  check('toggling shows the textarea', page.el('cycle-md-priorities').hidden === false && page.el('cycle-read-priorities').hidden === true);
  check('the textarea holds the original markdown', page.el('cycle-md-priorities').value === PRIORITIES, page.el('cycle-md-priorities').value.slice(0, 60));
  check('the toggle now offers reading', page.el('cycle-mode-priorities').textContent === '阅读');

  // Read mode must show what would be saved, not what is on disk.
  page.el('cycle-md-priorities').value = '### 改过的标题\n- 改过的条目';
  page.fire('cycle-md-priorities', 'input');
  page.clickMode('priorities');
  check('read mode renders the unsaved edit, not the stored text', page.el('cycle-read-priorities').innerHTML.includes('改过的标题'), page.el('cycle-read-priorities').innerHTML.slice(0, 160));
  check('and the old text is gone from the view', !page.el('cycle-read-priorities').innerHTML.includes('工作 · 技术专家'));

  // An empty section forcing edit mode must not follow you to the next cycle:
  // that would make one blank review turn every later cycle into raw markdown.
  const second = { ...cycle, id: '2026-08-10_8.10-8.23', startDate: '2026-08-10', cycle: '8.10-8.23',
    sections: { review: { content: REVIEW, source: 'ai', updatedAt: '2026-09-07T00:00:00.000Z' } } };
  page.setState({ cycles: { dir: '/tmp/v/20_CYCLES', items: [cycle, second] }, team: null });
  page.render();
  check('the cycle with no review still opens that card in the editor', page.el('cycle-md-review').hidden === false);

  // An empty retro is pre-filled with the scaffold, which is text but not
  // content. Opening it for reading would show an empty form to read.
  const blankRetro = { ...cycle, id: '2026-09-07_9.7-9.20', startDate: '2026-09-07', cycle: '9.7-9.20',
    sections: { 要务: { content: PRIORITIES, source: 'planner', updatedAt: '2026-09-07T08:00:00.000Z' } } };
  page.setState({ cycles: { dir: '/tmp/v/20_CYCLES', items: [blankRetro] }, team: null });
  page.render();
  check('the retro scaffold opens in the editor, not for reading', page.el('cycle-md-retro').hidden === false, page.el('cycle-mode-retro').textContent);
  check('and it is flagged as a template', page.el('cycle-template-retro').hidden === false);
  check('while 要务 on the same cycle still opens for reading', page.el('cycle-read-priorities').hidden === false);

  page.setState({ cycles: { dir: '/tmp/v/20_CYCLES', items: [cycle, second] }, team: null });
  page.render();
  page.clickCycle('2026-08-10_8.10-8.23');
  check('a section left in edit mode only because it was empty does not stay there', page.el('cycle-read-review').hidden === false, page.el('cycle-mode-review').textContent);
  // An explicit choice, on the other hand, is remembered across cycles.
  page.clickMode('review');
  page.clickCycle('2026-08-24_8.24-9.6');
  page.clickCycle('2026-08-10_8.10-8.23');
  check('an explicitly chosen mode survives switching cycles', page.el('cycle-md-review').hidden === false);
  page.clickMode('review');

  page.setState({ cycles: { dir: '/tmp/v/20_CYCLES', items: [cycle] }, team: null });
  page.render();

  // --- per-item status (green / yellow / red) ---------------------------------
  // A cycle id of its own: drafts are keyed by id, and the assertions above left
  // an edited 要务 under the other one.
  const statusCycle = { ...cycle, id: '2026-04-06_4.6-4.19', startDate: '2026-04-06', cycle: '4.6-4.19',
    sections: { 要务: { content: PRIORITIES, source: 'planner', updatedAt: '2026-04-06T00:00:00.000Z' } } };
  page.setState({ cycles: { dir: '/tmp/v/20_CYCLES', items: [statusCycle] }, team: null });
  page.render();
  const dots = () => [...String(page.el('cycle-read-priorities').innerHTML).matchAll(/data-cycle-task="(\d+)" data-cycle-status="([a-z]*)"/g)].map((m) => [m[1], m[2]]);
  check('every task row offers three status controls', dots().length === 3 * 3, String(dots().length));
  check('an unmarked row offers all three states', dots().slice(0, 3).map((d) => d[1]).join(',') === 'done,partial,missed', dots().slice(0, 3).join('|'));

  const firstLine = Number(dots()[0][0]);
  page.clickTask(firstLine, 'done');
  check('marking done rewrites that line in the markdown', page.el('cycle-md-priorities').value.split('\n')[firstLine].endsWith('✅'), page.el('cycle-md-priorities').value.split('\n')[firstLine]);
  check('and only that line', page.el('cycle-md-priorities').value.split('\n').filter((l: string) => /[✅🚧❌]/u.test(l)).length === 1);
  check('the rendered row is coloured', page.el('cycle-read-priorities').innerHTML.includes('cy-task cy-task-done'));
  check('the marker is not also left in the sentence', !page.el('cycle-read-priorities').innerHTML.includes('✅'), page.el('cycle-read-priorities').innerHTML.slice(0, 300));
  check('the active dot now clears instead of re-setting', dots()[0][1] === '', dots()[0].join('|'));
  check('the change is unsaved, so the save row comes back in read mode', page.el('cycle-actions-priorities').hidden === false);
  check('and it says so', page.el('cycle-status-priorities').textContent.includes('还没保存'), page.el('cycle-status-priorities').textContent);

  page.clickTask(firstLine, 'partial');
  check('switching to partial replaces the marker rather than appending', page.el('cycle-md-priorities').value.split('\n')[firstLine].endsWith('🚧'));
  check('only one marker survives the switch', (page.el('cycle-md-priorities').value.split('\n')[firstLine].match(/[✅🚧❌]/gu) || []).length === 1, page.el('cycle-md-priorities').value.split('\n')[firstLine]);

  page.clickTask(firstLine, 'missed');
  check('red is written as ❌', page.el('cycle-md-priorities').value.split('\n')[firstLine].endsWith('❌'));
  page.clickTask(firstLine, '');
  check('clearing removes the marker entirely', !/[✅🚧❌]/u.test(page.el('cycle-md-priorities').value.split('\n')[firstLine]), page.el('cycle-md-priorities').value.split('\n')[firstLine]);

  // MIT and Linear ids must survive being marked, since the marker is appended
  // to the same line they live on.
  const mitLine = page.el('cycle-md-priorities').value.split('\n').findIndex((l: string) => l.includes('**MIT**'));
  page.clickTask(mitLine, 'done');
  const marked = page.el('cycle-md-priorities').value.split('\n')[mitLine];
  check('MIT emphasis survives a status change', marked.includes('**MIT**'), marked);
  check('the row still shows its MIT badge', page.el('cycle-read-priorities').innerHTML.includes('cy-badge'), marked);
  const leoLine = page.el('cycle-md-priorities').value.split('\n').findIndex((l: string) => l.includes('LEO-102'));
  page.clickTask(leoLine, 'missed');
  check('a Linear id survives a status change', page.el('cycle-md-priorities').value.split('\n')[leoLine].includes('LEO-102'));
  check('and is still a link', page.el('cycle-read-priorities').innerHTML.includes('>LEO-102</a>'));

  // A marker already in the file is read back, not duplicated.
  const preMarked = { ...cycle, id: '2026-05-01_5.1-5.14', startDate: '2026-05-01', cycle: '5.1-5.14',
    sections: { 要务: { content: '### 组\n- 已经做完的事 ✅\n- 做了一半 🚧\n- 完全没动 ❌', source: 'planner', updatedAt: '2026-05-01T00:00:00.000Z' } } };
  page.setState({ cycles: { dir: '/tmp/v/20_CYCLES', items: [preMarked] }, team: null });
  page.render();
  const html = page.el('cycle-read-priorities').innerHTML;
  check('markers already in the file are read back', ['cy-task-done', 'cy-task-partial', 'cy-task-missed'].every((c) => html.includes(c)), html.slice(0, 200));
  check('and are not shown twice', !html.includes('✅') && !html.includes('🚧') && !html.includes('❌'), html.slice(0, 200));
}

// --- 2. the review endpoint ----------------------------------------------------

async function testReviewEndpoint(): Promise<void> {
  console.log('\n--- /api/cycles/review ---');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-os-review-endpoint-'));
  const vault = path.join(tmp, 'vault');
  const cycles = path.join(vault, '20_CYCLES');
  fs.mkdirSync(cycles, { recursive: true });
  const file = (id: string, body: string) => fs.writeFileSync(path.join(cycles, `${id}.md`), body, 'utf8');
  file('2026-08-24_8.24-9.6', ["---", "cycle: '8.24-9.6'", 'mode: biweekly', 'sections:', "  要务: {source: planner, updated_at: '2026-08-24T08:00:00.000Z'}", "  retro: {source: user, updated_at: '2026-09-06T21:00:00.000Z'}", '---', '', '## 要务', PRIORITIES, '', '## retro', RETRO, ''].join('\n'));
  file('2026-06-01_6.1-6.14', ["---", "cycle: '6.1-6.14'", 'mode: biweekly', 'sections: {}', '---', ''].join('\n'));

  const parsed = yaml.load(fs.readFileSync(path.join(REPO_ROOT, 'config', 'config.example.yaml'), 'utf8')) as Record<string, any>;
  parsed.memory.repository_path = vault;
  // No life-review-os CLI is reachable from this temp workdir on purpose: the
  // point is to prove the guards fire before the provider is ever invoked, and
  // that a missing CLI is reported rather than hung on.
  parsed.skills = { ...(parsed.skills || {}), enabled: true, registry: [{ id: 'weekly-review', provider: 'claude', path: path.join(tmp, 'SKILL.md'), workdir: tmp, effects: [], require_confirmation_for: [] }] };
  fs.mkdirSync(path.join(tmp, 'config'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'config', 'config.yaml'), yaml.dump(parsed), 'utf8');
  fs.writeFileSync(path.join(tmp, '.env'), '');
  fs.writeFileSync(path.join(tmp, 'SKILL.md'), '# skill\n', 'utf8');

  const originalCwd = process.cwd();
  process.chdir(tmp);
  const auth = await import('../../src/ui/auth.js');
  const { startUiServer } = await import('../../src/ui/server.js');
  auth.resetSessionCacheForTests();
  auth.addUser('admin', 'admin-password-1', 'admin');
  const controls = await startUiServer({ configPath: 'config/config.yaml', envPath: '.env', host: '127.0.0.1', port: 0, open: false });
  const base = controls.url;

  try {
    const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'admin-password-1' }) });
    const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
    const post = async (body: unknown): Promise<{ status: number; body: any }> => {
      const response = await fetch(`${base}/api/cycles/review`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) });
      return { status: response.status, body: (await response.json()) as any };
    };

    const anon = await fetch(`${base}/api/cycles/review`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', redirect: 'manual' });
    check('the endpoint needs a session', anon.status === 302 || anon.status === 401, String(anon.status));

    const bad = await post({ id: 'not-a-cycle-id' });
    check('an invalid cycle id is refused', bad.body.ok === false && /Invalid cycle id/.test(String(bad.body.error)), JSON.stringify(bad.body));

    const missing = await post({ id: '2026-01-01_1.1-1.14' });
    check('an unknown cycle is refused', missing.body.ok === false && /Cycle not found/.test(String(missing.body.error)), JSON.stringify(missing.body));

    const empty = await post({ id: '2026-06-01_6.1-6.14' });
    check('a cycle with nothing in it is refused before any model call', empty.body.ok === false && /没有可以复盘的内容/.test(String(empty.body.error)), JSON.stringify(empty.body));

    const foreign = await post({ id: '2026-08-24_8.24-9.6', owner: '11111111-1111-1111-1111-111111111111' });
    check("generating for a teammate's cycle is refused", foreign.body.ok === false, JSON.stringify(foreign.body));

    const noCli = await post({ id: '2026-08-24_8.24-9.6' });
    check('a missing life-review-os CLI is reported, not hung on', noCli.body.ok === false && /life-review-os/i.test(String(noCli.body.error)), JSON.stringify(noCli.body).slice(0, 200));

    // The file must be untouched no matter which way the request went.
    const after = fs.readFileSync(path.join(cycles, '2026-08-24_8.24-9.6.md'), 'utf8');
    check('generating never writes to the cycle file', !after.includes('## review'), after.slice(0, 120));
  } finally {
    await controls.stop();
    process.chdir(originalCwd);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// --- harness -------------------------------------------------------------------

/** Just the section renderer, pulled out of the shipped script. */
async function loadRenderer(): Promise<(key: string, text: string) => string> {
  const { CYCLES_JS } = await import('../../src/ui/pages.js');
  const factory = new Function(
    'document', 'window', 'location', 'history', 'sessionStorage', 'localStorage', 'fetch', 'navigator',
    'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
    `${CYCLES_JS}\n return { cycleRenderSection };`,
  );
  const stub = { getElementById: () => null, querySelectorAll: () => [], addEventListener() {}, activeElement: null, title: '' };
  const win = { __LINEAR_WS__: 'leon', location: { search: '', pathname: '/cycles', hash: '' }, history: { replaceState() {} }, addEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }) };
  const api = factory(stub, win, win.location, win.history, { getItem: () => null, setItem() {}, removeItem() {} }, { getItem: () => null, setItem() {}, removeItem() {} }, () => new Promise(() => {}), { clipboard: {} }, () => 0, () => {}, () => 0, () => {}) as any;
  return api.cycleRenderSection;
}

/** The whole page against a DOM stub, same shape as cycles-standalone-page.test.ts. */
async function loadCyclesPage() {
  const { CYCLES_JS } = await import('../../src/ui/pages.js');
  const elements = new Map<string, any>();
  const make = (id: string): any => ({
    id, value: '', textContent: '', innerHTML: '', hidden: false, disabled: false, readOnly: false,
    dataset: {}, style: {}, listeners: {} as Record<string, Array<(event: unknown) => void>>,
    addEventListener(type: string, handler: (event: unknown) => void) { (this.listeners[type] ||= []).push(handler); },
    querySelectorAll: () => [], closest: () => null,
    focus() { documentStub.activeElement = this; }, dispatchEvent() {},
  });
  const get = (id: string): any => {
    if (!elements.has(id)) elements.set(id, make(id));
    return elements.get(id);
  };
  const documentListeners: Record<string, Array<(event: unknown) => void>> = {};
  const documentStub = {
    getElementById: get,
    querySelectorAll: () => [] as unknown[],
    addEventListener(type: string, handler: (event: unknown) => void) { (documentListeners[type] ||= []).push(handler); },
    activeElement: null as any,
    title: '',
  };
  const win = { __LINEAR_WS__: 'leon', location: { search: '', pathname: '/cycles', hash: '' }, history: { replaceState() {} }, addEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }) };
  const storage = { getItem: () => null, setItem() {}, removeItem() {} };
  const factory = new Function(
    'document', 'window', 'location', 'history', 'sessionStorage', 'localStorage', 'fetch', 'navigator',
    'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
    `${CYCLES_JS}\n return { renderCyclesPage, setState: (next) => { cyclesData = next; } };`,
  );
  const api = factory(documentStub, win, win.location, win.history, storage, storage, () => new Promise(() => {}), { clipboard: {} }, () => 0, () => {}, () => 0, () => {}) as any;
  const clickOn = (containerId: string, selector: string, dataset: Record<string, string>): void => {
    const target = { closest: (query: string) => (query === selector ? { dataset } : null) };
    for (const handler of get(containerId).listeners.click || []) handler({ target });
  };
  return {
    el: get,
    setState: api.setState,
    render: api.renderCyclesPage,
    clickMode: (key: string) => clickOn('cycle-cards', '[data-cycle-mode]', { cycleMode: key }),
    clickCycle: (id: string) => clickOn('cycle-list', '[data-cycle-id]', { cycleId: id }),
    clickTask: (line: number, status: string) => clickOn('cycle-cards', '[data-cycle-task]', { cycleTask: String(line), cycleStatus: status }),
    pressKey: (key: string) => { for (const handler of documentListeners.keydown || []) handler({ key, preventDefault() {} }); },
    fire: (id: string, type: string) => { for (const handler of get(id).listeners[type] || []) handler({ target: get(id) }); },
  };
}

void main();
