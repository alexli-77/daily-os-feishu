/**
 * LEO-232 daily-review reconciliation tests.
 *
 * Independent, dependency-free runner (run with:
 * `tsx scripts/tests/daily-review-reconcile.test.ts`). Covers:
 *  - reconciliation JSON parse + render (done/N counting, ticked items forced to
 *    done via injected feedback);
 *  - parse failure -> legacy grouped render fallback (console.warn);
 *  - no daily_plan that day -> legacy fallback;
 *  - carry-over persistence + scorer carryOverDays streak computation;
 *  - the "confirm review" carry-over selection (open-only) that the card action
 *    persists to the ledger.
 *
 * Runs inside a throwaway workdir (process.chdir) so the feedback jsonl never
 * touches the real repo.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { AppConfig } from '../../src/config/schema.js';
import type { Evidence } from '../../src/workflows/types.js';
import {
  parseDailyReviewReconciliation,
  renderDailyReviewReconciliationSummary,
  selectCarryOverCandidateIds,
  formatWorkflowSummaryForFeishu,
} from '../../src/workflows/summary.js';
import { buildScoredTodos } from '../../src/todo/scorer.js';
import { DEFAULT_SCORER_WEIGHTS } from '../../src/todo/scorer-config.js';
import { getCarryOverDaysById, listTodoFeedback, recordCarryOver } from '../../src/todo/feedback.js';

type TestFn = () => void | Promise<void>;
const tests: Array<{ name: string; fn: TestFn }> = [];
function test(name: string, fn: TestFn): void {
  tests.push({ name, fn });
}

const config = {} as AppConfig;
const DATE = '2026-07-20';

const RECON_JSON = JSON.stringify({
  reconciliation: [
    { candidateId: 'linear:LEO-1', text: '把 LEO-1 推进到可验收', status: 'done', evidence: 'PR #42 已合并' },
    { candidateId: 'linear:LEO-2', text: '整理导师邮件', status: 'progressed', evidence: '写了草稿，未发送' },
    { candidateId: 'vault:notes/a.md', text: '读完 XX 论文', status: 'open', evidence: '看不到完成证据' },
    { candidateId: 'todo_inbox:t4', text: '联系客户 A', status: 'open', evidence: '今天没动' },
    { candidateId: 'linear:LEO-5', text: '修复登录 bug', status: 'done', evidence: '已上线' },
    { candidateId: 'weekly:0:x', text: 'build in public 发一条', status: 'open', evidence: '没发' },
  ],
  carry_over: ['vault:notes/a.md', 'todo_inbox:t4', 'weekly:0:x'],
  note: '今天最大的进展是登录修复上线',
});

// --- parse + render --------------------------------------------------------

test('parseDailyReviewReconciliation parses the strict JSON and normalizes statuses', () => {
  const recon = parseDailyReviewReconciliation(RECON_JSON);
  assert.ok(recon);
  assert.equal(recon!.reconciliation.length, 6);
  assert.deepEqual(recon!.carryOver, ['vault:notes/a.md', 'todo_inbox:t4', 'weekly:0:x']);
  assert.equal(recon!.note, '今天最大的进展是登录修复上线');
  // an unknown status degrades to "open"
  const weird = parseDailyReviewReconciliation('{"reconciliation":[{"candidateId":"c","text":"x","status":"maybe"}]}');
  assert.equal(weird!.reconciliation[0].status, 'open');
});

test('render counts done/N and shows carry-over footer', () => {
  const recon = parseDailyReviewReconciliation(RECON_JSON)!;
  const card = renderDailyReviewReconciliationSummary(recon);
  assert.match(card, /✅ 完成 2\/6/, 'two of six are done from the JSON');
  assert.match(card, /🔨 整理导师邮件/, 'progressed rows use the 🔨 icon');
  assert.match(card, /⏳ 读完 XX 论文/, 'open rows use the ⏳ icon');
  assert.match(card, /明天继续 3 项/, 'carry-over footer counts the open carry items');
  assert.match(card, /今天最大的进展是登录修复上线/, 'note is surfaced');
});

test('a ticked (completed) candidateId is forced to done and cannot be re-judged', () => {
  const recon = parseDailyReviewReconciliation(RECON_JSON)!;
  // The model marked vault:notes/a.md as "open", but the user ticked it complete.
  const completed = new Set(['vault:notes/a.md']);
  const card = renderDailyReviewReconciliationSummary(recon, completed);
  assert.match(card, /✅ 完成 3\/6/, 'forced-done bumps the count from 2 to 3');
  assert.match(card, /✅ 读完 XX 论文/, 'the ticked item now renders as done');
});

// --- degradation matrix ----------------------------------------------------

test('formatWorkflowSummaryForFeishu uses the reconciliation card for reconciliation JSON', () => {
  const card = formatWorkflowSummaryForFeishu('daily_review', DATE, RECON_JSON);
  assert.match(card, /✅ 完成 2\/6/, 'the new card is chosen when the output is reconciliation JSON');
});

test('parse failure degrades to the legacy grouped render (console.warn)', () => {
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args.join(' '));
  try {
    const legacyText = '## 已完成 / 已推进\n- 完成了 A\n\n## 没完成 / 未闭环\n- B 还没做';
    const card = formatWorkflowSummaryForFeishu('daily_review', DATE, legacyText);
    assert.doesNotMatch(card, /✅ 完成 \d+\/\d+/, 'no reconciliation header on the legacy path');
    assert.ok(warnings.some((w) => w.includes('falling back to legacy grouped render')), 'a warning is logged');
  } finally {
    console.warn = originalWarn;
  }
});

test('empty reconciliation (no plan that day) degrades to legacy render', () => {
  // When no daily_plan ran, the prompt emits an empty reconciliation array.
  assert.equal(parseDailyReviewReconciliation('{"reconciliation":[],"carry_over":[]}'), null, 'empty list parses to null');
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args.join(' '));
  try {
    const card = formatWorkflowSummaryForFeishu('daily_review', DATE, '{"reconciliation":[],"carry_over":[]}');
    assert.doesNotMatch(card, /✅ 完成 \d+\/\d+/);
    assert.ok(warnings.some((w) => w.includes('falling back to legacy grouped render')));
  } finally {
    console.warn = originalWarn;
  }
});

// --- confirm-review carry-over selection -----------------------------------

test('selectCarryOverCandidateIds keeps only open carry items', () => {
  const recon = parseDailyReviewReconciliation(
    JSON.stringify({
      reconciliation: [
        { candidateId: 'a', text: 'A', status: 'done' },
        { candidateId: 'b', text: 'B', status: 'open' },
        { candidateId: 'c', text: 'C', status: 'open' },
      ],
      // 'a' is done but wrongly listed for carry-over; it must be dropped.
      carry_over: ['a', 'b', 'c'],
    }),
  )!;
  assert.deepEqual(selectCarryOverCandidateIds(recon), ['b', 'c']);
});

// --- carry-over ledger + scorer streak -------------------------------------

test('recordCarryOver persists open items and getCarryOverDaysById computes the streak', () => {
  withTmpWorkdir(() => {
    // LEO-9 carried three consecutive days -> streak 3.
    recordCarryOver(config, '2026-07-18', ['linear:LEO-9']);
    recordCarryOver(config, '2026-07-19', ['linear:LEO-9']);
    recordCarryOver(config, '2026-07-20', ['linear:LEO-9', 'vault:v']);
    // A same-day re-click is idempotent (no duplicate entry).
    recordCarryOver(config, '2026-07-20', ['linear:LEO-9']);

    const entries = listTodoFeedback(config).filter((e) => e.event === 'carry_over');
    assert.equal(entries.filter((e) => e.candidateId === 'linear:LEO-9').length, 3, 'no duplicate same-day entry');

    const map = getCarryOverDaysById(config);
    assert.equal(map.get('linear:LEO-9'), 3, 'three consecutive days');
    assert.equal(map.get('vault:v'), 1, 'single day is streak 1');
  });
});

test('a broken streak resets to the consecutive run ending at the most recent date', () => {
  withTmpWorkdir(() => {
    recordCarryOver(config, '2026-07-15', ['x']); // gap before the recent run
    recordCarryOver(config, '2026-07-19', ['x']);
    recordCarryOver(config, '2026-07-20', ['x']);
    assert.equal(getCarryOverDaysById(config).get('x'), 2, 'only the trailing 19->20 run counts');
  });
});

test('scorer consumes carry-over streak: a deferred task climbs via carryOverDays', () => {
  withTmpWorkdir(() => {
    // Five-day carry-over on a Linear task with no other signal.
    for (const day of ['16', '17', '18', '19', '20']) recordCarryOver(config, `2026-07-${day}`, ['linear:LEO-77']);
    const evidence: Evidence = {
      generated_at: `${DATE}T00:00:00Z`,
      date: DATE,
      sources: {
        linear: {
          state: 'available',
          data: { items: [{ identifier: 'LEO-77', title: '长期拖延的任务' }] },
        },
      },
    };
    const result = buildScoredTodos(config, evidence, DATE, { weights: DEFAULT_SCORER_WEIGHTS });
    const scored = result.top.find((t) => t.id === 'linear:LEO-77');
    assert.ok(scored, 'the task is scored');
    // 5 days * 5/day, capped at 15.
    assert.equal(scored!.carryOverDays, 5);
    assert.equal(scored!.breakdown.carryOver, 15, 'carry-over contributes the capped 15 points');
    assert.equal(scored!.score, 15);
  });
});

test('scorer is unchanged when there are no carry-over records (backward compatible)', () => {
  withTmpWorkdir(() => {
    const evidence: Evidence = {
      generated_at: `${DATE}T00:00:00Z`,
      date: DATE,
      sources: { linear: { state: 'available', data: { items: [{ identifier: 'LEO-1', title: 'x' }] } } },
    };
    const result = buildScoredTodos(config, evidence, DATE, { carryOverDaysById: new Map() });
    const scored = result.top.find((t) => t.id === 'linear:LEO-1');
    assert.ok(scored);
    assert.equal(scored!.breakdown.carryOver, undefined, 'no carry-over signal without records');
  });
});

// --- helpers ---------------------------------------------------------------

function withTmpWorkdir(fn: () => void): void {
  const cwd = process.cwd();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-review-reconcile-'));
  fs.mkdirSync(path.join(dir, 'data', 'runtime'), { recursive: true });
  process.chdir(dir);
  try {
    fn();
  } finally {
    process.chdir(cwd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

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
