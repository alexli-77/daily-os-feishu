/**
 * Linear issue notes in the skill input pack.
 *
 * Independent, dependency-free runner (run with: `tsx scripts/tests/linear-notes.test.ts`).
 *
 * Regression this locks down: the planner used to see nothing but issue titles,
 * so a priority carried forward kept restating the original framing even after
 * the issue's own comments had revised the target. Titles are written once at
 * creation; description and comments are what the user actually edits.
 */
import assert from 'node:assert/strict';

import { linearIssueNotes, linearIssueSnapshot } from '../../src/skills/runner.js';
import type { EvidenceSource } from '../../src/workflows/types.js';

type TestFn = () => void | Promise<void>;
const tests: Array<{ name: string; fn: TestFn }> = [];
function test(name: string, fn: TestFn): void {
  tests.push({ name, fn });
}

function source(items: unknown[], recentlyCompleted: unknown[] = []): EvidenceSource {
  return { state: 'available', data: { source: 'linear-api', items, recently_completed: recentlyCompleted } };
}

const started = {
  identifier: 'LEO-197',
  title: '换汇补加元缺口：~13,000 CAD 至 6 个月储备线',
  description: '来自 2026-06 账本快照分析：加元侧月赤字 1,690 CAD。\n\n## 完成标准\n\n* 换入 ~13,000 CAD',
  priority: 2,
  state: { name: 'In Progress', type: 'started' },
  dueDate: '2026-09-01',
  comments: {
    nodes: [
      { body: '执行清单已产出：备足 63,500 CNY。', createdAt: '2026-07-16T02:48:03.921Z' },
      { body: '进展（2026-08-15）：已累计换汇 8,000 CAD（原目标 13,000）。储备线上调至 ≈26,000，仍缺约 10,000。', createdAt: '2026-08-15T20:55:01.904Z' },
    ],
  },
};

test('linearIssueNotes surfaces description and comments for started issues', () => {
  const notes = linearIssueNotes(source([started]));
  assert.match(notes, /### LEO-197 换汇补加元缺口/);
  assert.match(notes, /描述：来自 2026-06 账本快照分析/);
  assert.match(notes, /仍缺约 10,000/);
});

test('comments are newest first so truncation keeps the latest progress', () => {
  const notes = linearIssueNotes(source([started]));
  const latest = notes.indexOf('2026-08-15');
  const older = notes.indexOf('2026-07-16');
  assert.ok(latest > -1 && older > -1, 'both comments present');
  assert.ok(latest < older, 'newest comment must come first');
});

test('note bodies are flattened to one line so the pack stays parseable', () => {
  const notes = linearIssueNotes(source([started]));
  for (const line of notes.split('\n')) {
    assert.ok(!/^\s*$/.test(line) || line === '', 'no stray blank-ish lines inside an entry');
  }
  assert.ok(!notes.includes('## 完成标准\n'), 'markdown newlines inside a description must be collapsed');
});

test('only started issues get notes: backlog and closed work has no progress to read', () => {
  const backlog = { ...started, identifier: 'LEO-900', state: { name: 'Backlog', type: 'unstarted' } };
  const done = { ...started, identifier: 'LEO-901', state: { name: 'Done', type: 'completed' } };
  const notes = linearIssueNotes(source([backlog], [done]));
  assert.equal(notes, '');
});

test('issues with neither description nor comments are skipped entirely', () => {
  const bare = { identifier: 'LEO-902', title: 'Bare', state: { name: 'In Progress', type: 'started' } };
  assert.equal(linearIssueNotes(source([bare])), '');
});

test('the one-line snapshot keeps its 6-column contract when notes are present', () => {
  // life-review-os parses this block positionally; adding notes must not shift it.
  const line = linearIssueSnapshot(source([started])).split('\n')[0];
  const parts = line.split('|').map((part) => part.trim());
  assert.equal(parts.length, 6);
  assert.equal(parts[0], 'LEO-197');
  assert.equal(parts[1], 'In Progress');
  assert.equal(parts[2], 'started');
  assert.equal(parts[3], 'High');
  assert.equal(parts[4], '2026-09-01');
  assert.match(parts[5], /^换汇补加元缺口/);
});

test('an unavailable or malformed linear source degrades to an empty block', () => {
  assert.equal(linearIssueNotes(undefined), '');
  assert.equal(linearIssueNotes({ state: 'error', detail: 'boom' }), '');
  assert.equal(linearIssueNotes({ state: 'available', data: { items: [null, 42, {}] } }), '');
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
