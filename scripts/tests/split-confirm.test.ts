/**
 * Split confirmation: priorities and retro review are separate decisions.
 *
 * They shipped chained to one confirmation, which meant a single click wrote
 * into two different cells — and the review was never displayed before it
 * happened, so it was signed blind. Web chat has no cards, so the two Feishu
 * buttons are two text commands there; both channels offer the same split.
 */
import assert from 'node:assert/strict';

import { parseDailyOsCommand } from '../../src/interaction/daily-os-command.js';

type TestFn = () => void | Promise<void>;
const tests: Array<{ name: string; fn: TestFn }> = [];
function test(name: string, fn: TestFn): void {
  tests.push({ name, fn });
}

const parse = (text: string) => parseDailyOsCommand(`daily-os ${text}`, 'daily-os');

test('the review has its own command, separate from the priorities', () => {
  assert.deepEqual(parse('确认写入 review'), { type: 'write_review', confirm: true });
  assert.deepEqual(parse('写入 review'), { type: 'write_review', confirm: false });
  assert.deepEqual(parse('confirm write review'), { type: 'write_review', confirm: true });
});

test('the priorities command is unchanged', () => {
  assert.deepEqual(parse('确认写回'), { type: 'writeback', target: 'feishu', confirm: true });
  assert.deepEqual(parse('写回'), { type: 'writeback', target: 'feishu', confirm: false });
  assert.deepEqual(parse('确认写回 okr'), { type: 'writeback', target: 'okr', confirm: true });
});

test('an unconfirmed review command is a read, so it can preview safely', () => {
  const command = parse('写入 review');
  assert.equal(command.type === 'write_review' && command.confirm, false);
});

test('a sentence merely containing "review" does not trigger a write', () => {
  // Same guard the writeback parser has: only exact shapes are commands.
  for (const text of ['帮我 review 一下这段代码', 'review the plan please', '这次 review 写得不错']) {
    assert.notEqual(parse(text).type, 'write_review', `must not be a command: ${text}`);
  }
});

test('review and writeback do not shadow each other', () => {
  assert.equal(parse('确认写回').type, 'writeback');
  assert.equal(parse('确认写入 review').type, 'write_review');
});

test('bare `review` still runs the daily review workflow, not the write', () => {
  // `review` was already a bare keyword for daily_review. A looser pattern here
  // would have silently hijacked it into a document write.
  const command = parse('review');
  assert.notEqual(command.type, 'write_review');
});

test('web chat accepts the new commands bare, without the daily-os prefix', async () => {
  const { autoPrefixCommand } = await import('../../src/ui/chat.js');
  for (const text of ['写入 review', '确认写入 review']) {
    const prefixed = autoPrefixCommand(text, 'daily-os');
    assert.ok(prefixed.startsWith('daily-os '), `must auto-prefix: ${text} -> ${prefixed}`);
    assert.equal(parseDailyOsCommand(prefixed, 'daily-os').type, 'write_review');
  }
});

async function run(): Promise<void> {
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
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

void run();
