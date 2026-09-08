/**
 * Cycles console page: list, per-section edit, guardrails (LEO-277).
 *
 * Independent, tsx-runnable:  npx tsx scripts/tests/cycles-page.test.ts
 *
 * This is the first place the user ever sees their own biweekly priorities
 * outside a Feishu doc, and it is an editor over files that have no version
 * history, so the things worth locking down are the destructive ones: saving
 * the retro must leave the planner-written priorities byte-identical (content,
 * source *and* timestamp), an edit must be recorded as `user` so a later
 * planner run will not eat it, and a file whose frontmatter cannot be parsed
 * must be refused rather than rewritten.
 *
 * Driven through the real UI server with a real login session — the page's
 * value is in the endpoint and the state it returns, not in its markup.
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

/** A complete cycle: all three sections, each with a different owner. */
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
  '- **MIT** 写 LEO-277 的 Cycles 页',
  '- P1 羽毛球每周两次',
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

/** Broken YAML in the frontmatter: unparseable, so the file layer refuses writes. */
const BROKEN_FILE = ['---', "cycle: '9.21-10.4'", 'sections: {要务: [unclosed', '---', '', '## 要务', '- 手改坏了', ''].join('\n');

async function main(): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-os-cycles-page-test-'));
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

    const readState = async (): Promise<any> => (await (await fetch(`${base}/api/state`, { headers: { cookie } })).json()) as any;
    const cycleOf = (state: any, id: string): any => (state?.cycles?.items || []).find((item: any) => item.id === id);
    const saveSection = async (body: unknown, headers: Record<string, string> = authed): Promise<{ status: number; body: any }> => {
      const response = await fetch(`${base}/api/cycles/section`, { method: 'POST', headers, body: JSON.stringify(body) });
      return { status: response.status, body: (await response.json()) as any };
    };

    // --- Listing --------------------------------------------------------------
    const state = await readState();
    const ids = (state?.cycles?.items || []).map((item: any) => item.id);
    check('state lists every cycle on disk, newest first', ids.join(',') === [BROKEN_ID, NEW_ID, MID_ID, OLD_ID].join(','), ids.join(','));
    check('cycles dir is exposed for the empty state', state?.cycles?.dir === cyclesDir, String(state?.cycles?.dir));

    const newest = cycleOf(state, NEW_ID);
    check('list item carries mode', newest?.mode === 'weekly', String(newest?.mode));
    check('list item carries the cycle label', newest?.cycle === '9.7-9.13', String(newest?.cycle));
    check('list item carries the file path', newest?.path === path.join(cyclesDir, `${NEW_ID}.md`), String(newest?.path));

    const complete = cycleOf(state, OLD_ID);
    check('a complete cycle exposes all three sections', ['要务', 'retro', 'review'].every((key) => complete?.sections?.[key]));
    check('per-section source is exposed', complete?.sections?.retro?.source === 'user', String(complete?.sections?.retro?.source));
    check('per-section updated_at is exposed', complete?.sections?.review?.updatedAt === '2026-06-14T09:00:00.000Z', String(complete?.sections?.review?.updatedAt));

    const partial = cycleOf(state, MID_ID);
    check(
      'a never-written section is a missing key, not an empty string',
      Boolean(partial?.sections?.['要务']) && !('retro' in (partial?.sections || {})) && !('review' in (partial?.sections || {})),
      JSON.stringify(Object.keys(partial?.sections || {})),
    );

    // --- One section at a time ------------------------------------------------
    const before = cycleOf(state, OLD_ID);
    const savedRetro = await saveSection({ id: OLD_ID, section: 'retro', content: '补记：面试之外，羽毛球只打了一次。' });
    check('saving retro -> 200', savedRetro.status === 200 && savedRetro.body?.ok === true, JSON.stringify(savedRetro.body).slice(0, 160));
    check('save reports the file path', String(savedRetro.body?.text || '').includes(path.join(cyclesDir, `${OLD_ID}.md`)), String(savedRetro.body?.text));
    check('save reports the save time', /^\d{4}-\d{2}-\d{2}T/.test(String(savedRetro.body?.savedAt || '')), String(savedRetro.body?.savedAt));

    const after = cycleOf(savedRetro.body?.state, OLD_ID);
    check('retro content is echoed back from disk', after?.sections?.retro?.content === '补记：面试之外，羽毛球只打了一次。', String(after?.sections?.retro?.content));
    check("edits are recorded as source 'user'", after?.sections?.retro?.source === 'user', String(after?.sections?.retro?.source));
    check(
      'saving retro leaves 要务 untouched (content, source, updatedAt)',
      JSON.stringify(after?.sections?.['要务']) === JSON.stringify(before?.sections?.['要务']),
      `${JSON.stringify(before?.sections?.['要务'])} -> ${JSON.stringify(after?.sections?.['要务'])}`,
    );
    check(
      'saving retro leaves review untouched (content, source, updatedAt)',
      JSON.stringify(after?.sections?.review) === JSON.stringify(before?.sections?.review),
      `${JSON.stringify(before?.sections?.review)} -> ${JSON.stringify(after?.sections?.review)}`,
    );

    // A planner-owned section the user takes over mid-cycle: the point of the page.
    const savedPriorities = await saveSection({ id: MID_ID, section: '要务', content: '- **MIT** 写 LEO-277 的 Cycles 页\n- P0 紧急：签证材料' });
    const midAfter = cycleOf(savedPriorities.body?.state, MID_ID);
    check('要务 can be edited mid-cycle -> 200', savedPriorities.status === 200, String(savedPriorities.status));
    check('an edited 要务 flips from planner to user', midAfter?.sections?.['要务']?.source === 'user', String(midAfter?.sections?.['要务']?.source));
    check('the inserted urgent item is on disk', fs.readFileSync(path.join(cyclesDir, `${MID_ID}.md`), 'utf8').includes('P0 紧急：签证材料'));
    check(
      'writing 要务 does not invent the sections that were never written',
      !('retro' in (midAfter?.sections || {})) && !('review' in (midAfter?.sections || {})),
      JSON.stringify(Object.keys(midAfter?.sections || {})),
    );

    // Written-then-emptied must stay distinguishable from never-written.
    const emptied = await saveSection({ id: NEW_ID, section: 'retro', content: '' });
    const emptiedCycle = cycleOf(emptied.body?.state, NEW_ID);
    check(
      'a section saved empty exists with empty content',
      Boolean(emptiedCycle?.sections?.retro) && emptiedCycle?.sections?.retro?.content === '',
      JSON.stringify(emptiedCycle?.sections?.retro),
    );

    // --- Guardrails -----------------------------------------------------------
    const brokenCycle = cycleOf(await readState(), BROKEN_ID);
    check('an unparseable frontmatter is surfaced to the page', Boolean(brokenCycle?.frontmatterError), JSON.stringify(brokenCycle?.frontmatterError));
    const brokenSave = await saveSection({ id: BROKEN_ID, section: 'retro', content: '不该写进去' });
    check('saving a cycle with broken frontmatter is refused', brokenSave.status >= 400 || brokenSave.body?.ok === false, JSON.stringify(brokenSave.body).slice(0, 160));
    check('the broken file is left byte-identical', fs.readFileSync(path.join(cyclesDir, `${BROKEN_ID}.md`), 'utf8') === BROKEN_FILE);

    for (const badId of ['../../../etc/hosts', '2026-08-24_..', '2026-08-24_../evil', '', 'not-a-cycle']) {
      const escape = await saveSection({ id: badId, section: 'retro', content: 'pwned' });
      check(`out-of-range cycle id is rejected: ${badId || '(empty)'}`, escape.status >= 400 || escape.body?.ok === false, JSON.stringify(escape.body).slice(0, 120));
    }
    const missing = await saveSection({ id: '2099-01-01_1.1-1.14', section: 'retro', content: 'ghost' });
    check('a cycle id with no file is rejected instead of creating one', missing.body?.ok === false, JSON.stringify(missing.body).slice(0, 120));
    check('no file was created for the unknown cycle', !fs.existsSync(path.join(cyclesDir, '2099-01-01_1.1-1.14.md')));

    const badSection = await saveSection({ id: OLD_ID, section: 'notes', content: 'nope' });
    check('an unknown section name is rejected', badSection.body?.ok === false, JSON.stringify(badSection.body).slice(0, 120));

    const memberLogin = await fetch(`${base}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'member', password: 'member-password-1' }),
    });
    const memberHeaders = { cookie: cookieFrom(memberLogin.headers.get('set-cookie')), 'content-type': 'application/json' };
    const memberWrite = await saveSection({ id: OLD_ID, section: 'retro', content: 'member edit' }, memberHeaders);
    check('member role cannot edit a cycle -> 403', memberWrite.status === 403, String(memberWrite.status));
    check('the member edit never reached the file', !fs.readFileSync(path.join(cyclesDir, `${OLD_ID}.md`), 'utf8').includes('member edit'));

    // --- Regression: the two neighbouring editor pages are untouched -----------
    const finalState = await readState();
    // The two life-review-os files only appear when that repo is reachable on
    // the machine running this, so assert the shape, not the exact list.
    const strategyIds = (finalState?.strategy?.files || []).map((file: any) => file.id);
    // Asserts the planning files are still listed and still first, not that the
    // list never grows — the review files were added to it deliberately.
    check(
      'Review Strategy still lists its planning files, in order',
      ['biweekly_strategy', 'plan_rules', 'biweekly_mode'].every((id, index) => strategyIds[index] === id),
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

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

void main();
