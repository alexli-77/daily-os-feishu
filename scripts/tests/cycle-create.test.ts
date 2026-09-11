/**
 * Creating the next cycle from the console: the 沿用上一期 default policy.
 *
 * Independent, tsx-runnable:  npx tsx scripts/tests/cycle-create.test.ts
 *
 * The dates are the whole feature. A cycle file's name *is* its identity, so a
 * planner that is a day out writes a file nobody is looking at, and one that
 * assumes 14 days is wrong for every weekly cycle in this vault's history —
 * `6.22-6.28` and `6.29-7.12` sit next to each other in it.
 *
 * The second property is that the file it produces parses. `writeCycle` refuses
 * to touch a cycle whose frontmatter it cannot read, so a creation that emitted
 * slightly-wrong YAML would produce a cycle that can never be edited or planned
 * into again.
 *
 * Everything runs against a temp vault; no real config or vault is touched.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

import { AppConfigSchema, type AppConfig } from '../../src/config/schema.js';
import { cycleFilePath, listCycles, readCycle, writeCycle } from '../../src/cycles/file.js';
import { planNextCycle } from '../../src/cycles/next.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

type TestFn = () => void | Promise<void>;
const tests: Array<{ name: string; fn: TestFn }> = [];
function test(name: string, fn: TestFn): void {
  tests.push({ name, fn });
}

const CREATED: string[] = [];

/** A config whose vault points at a fresh temp directory. */
function tempConfig(): AppConfig {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-os-cycle-create-'));
  CREATED.push(vault);
  const parsed = yaml.load(fs.readFileSync(path.join(REPO_ROOT, 'config', 'config.example.yaml'), 'utf8')) as Record<string, any>;
  parsed.memory.repository_path = vault;
  fs.mkdirSync(path.join(vault, '20_CYCLES'), { recursive: true });
  return AppConfigSchema.parse(parsed);
}

/** One cycle on disk, written the way a planning run writes it. */
function seed(config: AppConfig, id: string, label: string, mode: string): void {
  writeCycle(config, id, { cycle: label, mode, sections: { 要务: { content: '- 一条要务', source: 'planner' } } });
}

test('the biweekly cycle in progress is followed by the next fourteen days', () => {
  const config = tempConfig();
  seed(config, '2026-09-07_9.7-9.20', '9.7-9.20', 'biweekly');

  const plan = planNextCycle(listCycles(config)[0], { today: '2026-09-10' });
  assert.equal(plan.id, '2026-09-21_9.21-10.4');
  assert.equal(plan.label, '9.21-10.4');
  assert.equal(plan.startDate, '2026-09-21');
  assert.equal(plan.endDate, '2026-10-04');
  assert.equal(plan.days, 14);
  assert.equal(plan.mode, 'biweekly');
  assert.equal(plan.lengthFrom, 'previous-label');
});

test('a weekly cycle is followed by a weekly one, not by a hard-coded fortnight', () => {
  const config = tempConfig();
  seed(config, '2026-06-22_6.22-6.28', '6.22-6.28', 'weekly');

  const plan = planNextCycle(listCycles(config)[0], { today: '2026-06-25' });
  assert.equal(plan.id, '2026-06-29_6.29-7.5');
  assert.equal(plan.days, 7);
  assert.equal(plan.mode, 'weekly');
});

test('the newest cycle is the one followed, whatever order the directory lists', () => {
  const config = tempConfig();
  seed(config, '2026-08-24_8.24-9.6', '8.24-9.6', 'biweekly');
  seed(config, '2026-06-22_6.22-6.28', '6.22-6.28', 'weekly');
  seed(config, '2026-09-07_9.7-9.20', '9.7-9.20', 'biweekly');

  assert.equal(planNextCycle(listCycles(config)[0], { today: '2026-09-10' }).startDate, '2026-09-21');
});

test('a requested length wins, and redates the mode with it', () => {
  const config = tempConfig();
  seed(config, '2026-09-07_9.7-9.20', '9.7-9.20', 'biweekly');

  const plan = planNextCycle(listCycles(config)[0], { days: 7, today: '2026-09-10' });
  assert.equal(plan.id, '2026-09-21_9.21-9.27');
  assert.equal(plan.days, 7);
  assert.equal(plan.mode, 'weekly');
  assert.equal(plan.lengthFrom, 'request');
});

test('a label that is not a date range falls back to the mode, not to nothing', () => {
  const config = tempConfig();
  // A hand-edited file: the name still dates it, the label no longer parses.
  writeCycle(config, '2026-09-07_september', { cycle: '搬家周期', mode: 'weekly' });

  const plan = planNextCycle(listCycles(config)[0], { today: '2026-09-10' });
  assert.equal(plan.startDate, '2026-09-14');
  assert.equal(plan.days, 7);
  assert.equal(plan.lengthFrom, 'previous-mode');
});

test('an empty vault starts today rather than dating from a blank string', () => {
  const config = tempConfig();

  const plan = planNextCycle(listCycles(config)[0] || null, { today: '2026-09-10' });
  assert.equal(plan.id, '2026-09-10_9.10-9.23');
  assert.equal(plan.days, 14);
  assert.equal(plan.lengthFrom, 'default');
  assert.equal(plan.previousId, '');
});

test('a cycle that wraps the new year is followed into the next one', () => {
  const config = tempConfig();
  seed(config, '2026-12-21_12.21-1.3', '12.21-1.3', 'biweekly');

  const plan = planNextCycle(listCycles(config)[0], { today: '2026-12-30' });
  assert.equal(plan.id, '2027-01-04_1.4-1.17');
  assert.equal(plan.days, 14);
});

test('the created file parses, and is writable afterwards', () => {
  const config = tempConfig();
  seed(config, '2026-09-07_9.7-9.20', '9.7-9.20', 'biweekly');

  const plan = planNextCycle(listCycles(config)[0], { today: '2026-09-10' });
  writeCycle(config, plan.id, { cycle: plan.label, mode: plan.mode });

  const created = readCycle(config, plan.id);
  assert.ok(created);
  assert.equal(created.frontmatterError, undefined);
  assert.equal(created.cycle, '9.21-10.4');
  assert.equal(created.mode, 'biweekly');
  // Empty on purpose: 要务 belongs to the planning run, and a placeholder would
  // be indistinguishable from a plan nobody made.
  assert.deepEqual(created.sections, {});
  // The planner writes into it next, which is only possible if the frontmatter
  // this created round-trips.
  writeCycle(config, plan.id, { sections: { 要务: { content: '- 规划写的', source: 'planner' } } });
  assert.equal(readCycle(config, plan.id)?.sections['要务']?.source, 'planner');
});

test('creating twice targets the same file, which is what the endpoint refuses', () => {
  const config = tempConfig();
  seed(config, '2026-09-07_9.7-9.20', '9.7-9.20', 'biweekly');

  const first = planNextCycle(listCycles(config)[0], { today: '2026-09-10' });
  writeCycle(config, first.id, { cycle: first.label, mode: first.mode });
  writeCycle(config, first.id, { sections: { 要务: { content: '- 已经规划好的一条', source: 'planner' } } });

  // The new cycle is now the newest, so a second creation plans the one after
  // it — a plain "next" would quietly follow it instead of colliding. The
  // collision the endpoint guards is the file that is already there, which the
  // planner may have filled in already.
  const again = planNextCycle(listCycles(config).find((doc) => doc.id === '2026-09-07_9.7-9.20') || null, { today: '2026-09-10' });
  assert.equal(again.id, first.id);
  assert.equal(fs.existsSync(cycleFilePath(config, again.id)), true);
  assert.equal(readCycle(config, again.id)?.sections['要务']?.content, '- 已经规划好的一条');
});

/**
 * The endpoint itself, over HTTP.
 *
 * Same harness as `cycle-read-mode.test.ts`: a temp vault, a temp config, a real
 * server on port 0. No life-review-os CLI is reachable from the temp workdir on
 * purpose — the planning run must report itself as unavailable rather than being
 * started, so nothing in this test can reach a model or a real vault.
 */
async function testCreateEndpoint(): Promise<void> {
  console.log('\n--- /api/cycles/create ---');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-os-create-endpoint-'));
  CREATED.push(tmp);
  const vault = path.join(tmp, 'vault');
  const cycles = path.join(vault, '20_CYCLES');
  fs.mkdirSync(cycles, { recursive: true });
  const file = (id: string, label: string): void =>
    fs.writeFileSync(
      path.join(cycles, `${id}.md`),
      ['---', `cycle: '${label}'`, 'mode: biweekly', 'sections: {}', '---', ''].join('\n'),
      'utf8',
    );
  file('2026-09-07_9.7-9.20', '9.7-9.20');

  const parsed = yaml.load(fs.readFileSync(path.join(REPO_ROOT, 'config', 'config.example.yaml'), 'utf8')) as Record<string, any>;
  parsed.memory.repository_path = vault;
  parsed.skills = {
    ...(parsed.skills || {}),
    enabled: true,
    registry: [{ id: 'weekly-review', provider: 'claude', path: path.join(tmp, 'SKILL.md'), workdir: tmp, effects: [], require_confirmation_for: [] }],
  };
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

  try {
    const login = await fetch(`${controls.url}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin-password-1' }),
    });
    const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
    const post = async (body: unknown): Promise<any> => {
      const response = await fetch(`${controls.url}/api/cycles/create`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      return (await response.json()) as any;
    };

    const anon = await fetch(`${controls.url}/api/cycles/create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
      redirect: 'manual',
    });
    assert.ok(anon.status === 302 || anon.status === 401, `the endpoint needs a session, got ${anon.status}`);

    const created = await post({});
    assert.equal(created.ok, true, JSON.stringify(created));
    assert.equal(created.cycle, '9.21-10.4');
    assert.equal(created.startDate, '2026-09-21');
    assert.equal(created.days, 14);
    assert.equal(created.lengthFrom, 'previous-label');
    assert.equal(fs.existsSync(path.join(cycles, '2026-09-21_9.21-10.4.md')), true);
    // No CLI in the temp workdir, so the run is reported as impossible instead
    // of being started — a promise of 要务 that never arrive is worse than none.
    assert.equal(created.planning.status, 'unavailable');
    assert.ok(String(created.planning.reason).includes('要务'), created.planning.reason);
    // Frontmatter only: nothing invented under 要务 while the planner is absent.
    const markdown = fs.readFileSync(path.join(cycles, '2026-09-21_9.21-10.4.md'), 'utf8');
    assert.equal(markdown.includes('## '), false, markdown);

    const nonsense = await post({ days: '两周' });
    assert.equal(nonsense.ok, false);
    assert.ok(/周期长度/.test(String(nonsense.error)), nonsense.error);
    const tooLong = await post({ days: 400 });
    assert.equal(tooLong.ok, false, JSON.stringify(tooLong));

    const foreign = await post({ owner: '11111111-1111-1111-1111-111111111111' });
    assert.equal(foreign.ok, false, "creating into a teammate's name is refused");

    // Two requests at once — a double-click — chain instead of colliding: the
    // second reads the list after the first has written, and follows the cycle
    // that now exists. Worth pinning down, because the alternative most people
    // would assume (the second one lands on the same file) is the destructive
    // one, and it does not happen.
    for (const name of fs.readdirSync(cycles)) fs.rmSync(path.join(cycles, name));
    file('2026-09-07_9.7-9.20', '9.7-9.20');
    const both = await Promise.all([post({}), post({})]);
    assert.deepEqual(
      both.map((result) => result.cycle).sort(),
      ['10.5-10.18', '9.21-10.4'],
      JSON.stringify(both),
    );

    // The refusal itself. It guards a name in 20_CYCLES that exists and cannot
    // be read — a readable one would have been listed and followed, not landed
    // on — so the scenario has to be built rather than provoked. A directory is
    // the cheapest unreadable thing; a half-written file or a permissions
    // problem reaches the same branch.
    for (const name of fs.readdirSync(cycles)) fs.rmSync(path.join(cycles, name), { recursive: true });
    file('2026-09-07_9.7-9.20', '9.7-9.20');
    fs.mkdirSync(path.join(cycles, '2026-09-21_9.21-10.4.md'));
    const collision = await post({});
    assert.equal(collision.ok, false, JSON.stringify(collision));
    assert.ok(/已经存在/.test(String(collision.error)), collision.error);
    assert.equal(fs.statSync(path.join(cycles, '2026-09-21_9.21-10.4.md')).isDirectory(), true);
    console.log('ok - the endpoint creates, validates, and refuses to overwrite');
  } finally {
    await controls.stop();
    process.chdir(originalCwd);
  }
}

async function main(): Promise<void> {
  let failed = 0;
  for (const entry of tests) {
    try {
      await entry.fn();
      console.log(`ok - ${entry.name}`);
    } catch (error) {
      failed += 1;
      console.error(`not ok - ${entry.name}`);
      console.error(error instanceof Error ? error.stack : String(error));
    }
  }
  try {
    await testCreateEndpoint();
  } catch (error) {
    failed += 1;
    console.error('not ok - /api/cycles/create');
    console.error(error instanceof Error ? error.stack : String(error));
  }
  for (const dir of CREATED) fs.rmSync(dir, { recursive: true, force: true });
  if (failed > 0) {
    console.error(`${failed} test(s) failed.`);
    process.exit(1);
  }
  console.log(`All ${tests.length} cycle-create tests passed.`);
}

await main();
