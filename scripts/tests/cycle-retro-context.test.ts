/**
 * LEO-279 — a retro written in the Cycles page reaches the next planning run.
 *
 * Independent, tsx-runnable:  npx tsx scripts/tests/cycle-retro-context.test.ts
 *
 * The failure this guards against is not "the retro is missing from the input
 * pack" — it was already in there, inside the Memory Repository Files dump.
 * life-review-os reads only the first 20,000 characters of the pack, and that
 * dump starts around offset 29-59k depending on how much daily memory exists,
 * so the retro was present and never once read. Two earlier blocks (the OKR
 * chain and the Linear snapshot) had to be moved up for exactly this reason.
 *
 * So the assertions that matter here are positional: the block is inside the
 * cut, and it did not push anything that was already inside the cut out of it.
 *
 * Everything runs against a temp vault; no real config or vault is touched, and
 * nothing here needs network access.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

import { AppConfigSchema, type AppConfig } from '../../src/config/schema.js';
import { writeSection } from '../../src/cycles/file.js';
import { recentLocalRetros, renderLocalRetroBlock } from '../../src/cycles/context.js';
import { buildSkillInputPack } from '../../src/skills/runner.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** life-review-os: `fs.readFileSync(dailyOsInputPath).slice(0, 20000)`. */
const PROMPT_CUT = 20000;

type TestFn = () => void | Promise<void>;
const tests: Array<{ name: string; fn: TestFn }> = [];
function test(name: string, fn: TestFn): void {
  tests.push({ name, fn });
}

const CREATED: string[] = [];

function tempConfig(): AppConfig {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-os-retroctx-'));
  CREATED.push(vault);
  const parsed = yaml.load(fs.readFileSync(path.join(REPO_ROOT, 'config', 'config.example.yaml'), 'utf8')) as Record<string, any>;
  parsed.memory.repository_path = vault;
  return AppConfigSchema.parse(parsed);
}

const RETRO_A = '😄状态\n情绪：正常\n👍🏻做的好\n八月的 MIT 全部完成\n💪🏻待改进\n口播连续两周 0 条';
const RETRO_B = '😄状态\n情绪：偏低\n👍🏻做的好\n搬家收尾了\n💪🏻待改进\n投递还是没开始';
const RETRO_C = '😄状态\n情绪：一般\n👍🏻做的好\n七月的旧复盘\n💪🏻待改进\n旧的待改进';

// --- selection ----------------------------------------------------------------

test('the newest cycle with a retro comes first', () => {
  const config = tempConfig();
  writeSection(config, '2026-07-27_7.27-8.9', 'retro', RETRO_C, 'user');
  writeSection(config, '2026-08-24_8.24-9.6', 'retro', RETRO_A, 'user');
  writeSection(config, '2026-08-10_8.10-8.23', 'retro', RETRO_B, 'user');

  const entries = recentLocalRetros(config);
  assert.equal(entries[0].label, '8.24-9.6');
  assert.equal(entries[1].label, '8.10-8.23');
});

test('a cycle with no retro is skipped, not listed as empty', () => {
  const config = tempConfig();
  writeSection(config, '2026-09-07_9.7-9.20', '要务', '- 只有要务，还没写复盘', 'planner');
  writeSection(config, '2026-08-10_8.10-8.23', 'retro', RETRO_B, 'user');

  const entries = recentLocalRetros(config);
  assert.equal(entries.length, 1, 'the retro-less newer cycle is not an entry');
  assert.equal(entries[0].label, '8.10-8.23');
});

test('a retro that was written and then cleared is skipped too', () => {
  const config = tempConfig();
  writeSection(config, '2026-08-24_8.24-9.6', 'retro', '   \n  \n', 'user');
  writeSection(config, '2026-08-10_8.10-8.23', 'retro', RETRO_B, 'user');
  assert.deepEqual(recentLocalRetros(config).map((entry) => entry.label), ['8.10-8.23']);
});

test('at most two cycles are carried, so the block cannot grow without bound', () => {
  const config = tempConfig();
  for (const id of ['2026-06-29_6.29-7.12', '2026-07-13_7.13-7.26', '2026-07-27_7.27-8.9', '2026-08-10_8.10-8.23']) {
    writeSection(config, id, 'retro', RETRO_B, 'user');
  }
  assert.equal(recentLocalRetros(config).length, 2);
});

test('an over-long retro is truncated and says so', () => {
  const config = tempConfig();
  writeSection(config, '2026-08-10_8.10-8.23', 'retro', `😄状态\n${'很长的复盘。'.repeat(500)}`, 'user');
  const [entry] = recentLocalRetros(config);
  assert.equal(entry.truncated, true);
  assert.ok(entry.retro.length < 1700, `kept ${entry.retro.length} chars`);
  assert.match(entry.retro, /已截断/, 'a truncated retro must not look complete');
});

test('two over-long retros stay inside the total budget', () => {
  const config = tempConfig();
  writeSection(config, '2026-07-27_7.27-8.9', 'retro', '很长'.repeat(2000), 'user');
  writeSection(config, '2026-08-10_8.10-8.23', 'retro', '很长'.repeat(2000), 'user');
  const total = recentLocalRetros(config).reduce((sum, entry) => sum + entry.retro.length, 0);
  assert.ok(total <= 3400, `two capped retros totalled ${total}`);
});

test('an empty vault yields nothing rather than throwing', () => {
  assert.deepEqual(recentLocalRetros(tempConfig()), []);
});

// --- rendering ----------------------------------------------------------------

test('each entry is headed by its cycle label', () => {
  const config = tempConfig();
  writeSection(config, '2026-08-10_8.10-8.23', 'retro', RETRO_B, 'user');
  const block = renderLocalRetroBlock(recentLocalRetros(config));
  assert.match(block, /^### 8\.10-8\.23/m, block.slice(0, 80));
  assert.ok(block.includes('搬家收尾了'), 'the retro body is carried verbatim');
});

test('the heading carries the mode and when it was written', () => {
  const config = tempConfig();
  writeSection(config, '2026-08-10_8.10-8.23', 'retro', RETRO_B, 'user', { now: '2026-08-24T09:00:00.000Z' });
  const block = renderLocalRetroBlock(recentLocalRetros(config));
  assert.match(block, /biweekly/, block.slice(0, 100));
  assert.match(block, /更新于 2026-08-24/, block.slice(0, 100));
});

test('nothing to say renders as an empty string, not a bare heading', () => {
  assert.equal(renderLocalRetroBlock([]), '');
});

// --- the part that actually failed before: position in the pack ---------------

async function testPackPlacement(): Promise<void> {
  const config = tempConfig();
  writeSection(config, '2026-08-10_8.10-8.23', 'retro', RETRO_B, 'user');
  const pack = await buildSkillInputPack(config, {
    skillId: 'weekly-review',
    mode: 'biweekly',
    userText: '',
    source: 'test',
    messageId: 'm',
  });

  const at = (heading: string): number => pack.indexOf(heading);
  const block = at('## Local Cycle Retro');

  test('the block is in the pack at all', () => {
    assert.ok(block >= 0, 'no Local Cycle Retro block');
  });

  test('the block is inside the 20,000 characters life-review-os reads', () => {
    assert.ok(block < PROMPT_CUT, `block starts at ${block}`);
  });

  test('the retro text itself is inside the cut, not just the heading', () => {
    const body = pack.indexOf('投递还是没开始');
    assert.ok(body >= 0 && body < PROMPT_CUT, `retro body at ${body}`);
  });

  test('the block does not displace the OKR chain or the Linear blocks', () => {
    for (const heading of ['## Local OKR Chain', '## Linear Issue Snapshot', '## Linear Issue Notes']) {
      const offset = at(heading);
      assert.ok(offset >= 0 && offset < block, `${heading} at ${offset} must still precede the retro block at ${block}`);
      assert.ok(offset < PROMPT_CUT, `${heading} was pushed past the cut, to ${offset}`);
    }
  });

  test('the block sits ahead of the blocks it is more important than', () => {
    assert.ok(block < at('## Latest Workflow'), 'retro must come before Latest Workflow');
    assert.ok(block < at('## Memory Repository Files'), 'and long before the dump it was previously buried in');
  });

  test('the block tells the planner the local copy wins over Feishu', () => {
    const text = pack.slice(block, at('## Latest Workflow'));
    assert.match(text, /权威来源/, 'without this the planner keeps preferring the Feishu cell');
    assert.match(text, /飞书/, 'the conflict rule has to name the other source');
  });

  const bare = tempConfig();
  const emptyPack = await buildSkillInputPack(bare, {
    skillId: 'weekly-review',
    mode: 'biweekly',
    userText: '',
    source: 'test',
    messageId: 'm',
  });

  test('with no local retro the block degrades to an explicit placeholder', () => {
    const offset = emptyPack.indexOf('## Local Cycle Retro');
    assert.ok(offset >= 0 && offset < PROMPT_CUT, 'the heading is still emitted');
    assert.match(emptyPack.slice(offset, emptyPack.indexOf('## Latest Workflow')), /no local retro written yet/);
  });
}

async function run(): Promise<void> {
  await testPackPlacement();
  let passed = 0;
  let failed = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      passed += 1;
      console.log(`  ✓ ${name}`);
    } catch (error) {
      failed += 1;
      console.error(`  ✗ ${name}`);
      console.error(`    ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  for (const dir of CREATED) fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

void run();
