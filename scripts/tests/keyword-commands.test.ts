import assert from 'node:assert/strict';
import { autoPrefixCommand } from '../../src/ui/chat.js';
import { parseDailyOsCommand } from '../../src/interaction/daily-os-command.js';

// Web-chat bare keywords / aliases, including trailing text after a colon —
// `biweekly : <context>` regressed once (fell through to free-form), so the
// full pipeline (autoPrefix -> parse) is pinned here.

const P = 'daily-os';

function run(text: string) {
  return parseDailyOsCommand(autoPrefixCommand(text, P), P) as Record<string, unknown>;
}

try {
  testBareKeywords();
  testAliases();
  testTrailingText();
  testFreeformUntouched();
  console.log('keyword-commands.test.ts: all tests passed');
} catch (error) {
  console.error(error);
  process.exit(1);
}

function testBareKeywords(): void {
  assert.deepEqual(run('plan'), { type: 'workflow', workflow: 'daily_plan' });
  assert.deepEqual(run('review'), { type: 'workflow', workflow: 'daily_review' });
  assert.deepEqual(run('weekly'), { type: 'workflow', workflow: 'weekly_review' });
  assert.equal(run('progress').type, 'progress');
}

function testAliases(): void {
  assert.deepEqual(run('biweekly'), { type: 'skill_run', skillId: 'weekly-review', mode: 'biweekly' });
  assert.deepEqual(run('双周复盘'), { type: 'skill_run', skillId: 'weekly-review', mode: 'biweekly' });
}

function testTrailingText(): void {
  // The exact message that regressed.
  const bi = run('biweekly : 7.27 日做hearing test。O1-KR1 三条路径文档尚未完成，保持 0%');
  assert.equal(bi.type, 'skill_run');
  assert.equal(bi.mode, 'biweekly');
  assert.match(String(bi.text), /hearing test/);

  const plan = run('plan：今天优先做简历');
  assert.deepEqual(plan, { type: 'workflow', workflow: 'daily_plan', text: '今天优先做简历' });
  assert.equal(run('review : 补充今天做了体检').type, 'workflow');
  assert.deepEqual(run('weekly : 下周聚焦投递'), { type: 'workflow', workflow: 'weekly_review', text: '下周聚焦投递' });
}

function testFreeformUntouched(): void {
  // Colon sentences whose head is not a keyword must never become commands.
  for (const text of ['帮我 plan : 一下明天', '总结一下 : 今天的工作', 'planning: my day']) {
    assert.equal(run(text).type, 'ignore', `must stay free-form: ${text}`);
  }
}
