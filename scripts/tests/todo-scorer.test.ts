/**
 * LEO-209 todo scorer / feedback / daily-plan JSON tests.
 *
 * Independent, dependency-free runner (run with: `tsx scripts/tests/todo-scorer.test.ts`).
 * Covers: four-source normalization + dedupe, weighted scoring + ranking, OKR
 * link vs weekly-hit weighting, daily-plan JSON parse + graceful fallback, and
 * feedback ledger persistence + top-3 adoption stats.
 *
 * Runs inside a throwaway workdir (process.chdir) so the feedback jsonl, the
 * scorer-weights override, and the local OKR files never touch the real repo.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { AppConfig } from '../../src/config/schema.js';
import type { Evidence } from '../../src/workflows/types.js';
import {
  buildScoredTodos,
  normalizeCandidates,
  scoreAndRank,
  scoreCandidate,
  type TodoCandidate,
} from '../../src/todo/scorer.js';
import { DEFAULT_SCORER_WEIGHTS } from '../../src/todo/scorer-config.js';
import { getAdoptionStats, listTodoFeedback, recordTodoFeedback, recordTodoPresented } from '../../src/todo/feedback.js';
import { extractDailyPlanTodos, parseDailyPlanTodoPlan } from '../../src/workflows/summary.js';

type TestFn = () => void | Promise<void>;
const tests: Array<{ name: string; fn: TestFn }> = [];
function test(name: string, fn: TestFn): void {
  tests.push({ name, fn });
}

const config = {} as AppConfig;
const DATE = '2026-07-17';
const NOW = new Date('2026-07-17T00:00:00');

function makeEvidence(): Evidence {
  return {
    generated_at: NOW.toISOString(),
    date: DATE,
    sources: {
      todo_inbox: {
        state: 'available',
        data: {
          open: [
            { id: 'a1', text: '给客户 A 发合同确认邮件', created_at: '2026-07-14T09:00:00Z' },
            { id: 'a2', text: '随手记：买咖啡豆', created_at: '2026-07-17T08:00:00Z' },
          ],
        },
      },
      linear: {
        state: 'available',
        data: {
          items: [
            { identifier: 'LEO-142', title: 'todo 评分器', priority: 1, dueDate: '2026-07-10' },
            { identifier: 'LEO-150', title: 'portfolio 首页部署', priority: 2, dueDate: '2026-07-17' },
          ],
        },
      },
      vault_scan: {
        state: 'available',
        data: {
          candidates: [
            { path: 'notes/paper.md', title: '读完 XX 论文', summary: '写要点', priority: 'p2' },
            { path: 'notes/contract.md', title: '给客户 A 发合同确认邮件', summary: '重复项' },
          ],
        },
      },
      weekly_priorities: {
        state: 'available',
        data: {
          items: [
            { scope: '🐶', okr: 'O1', item: 'build in public 每天发一条' },
            { scope: '🐶', item: '已完成的项 ✅ 跳过' },
          ],
        },
      },
    },
  };
}

// --- scoring ---------------------------------------------------------------

test('scoreCandidate applies the weighted formula per component', () => {
  const overdue: TodoCandidate = { id: 'x', title: 'overdue task', source: 'linear', dueDate: '2026-07-10', priority: 'Urgent (1)' };
  const { score, breakdown } = scoreCandidate(overdue, DEFAULT_SCORER_WEIGHTS, NOW);
  assert.equal(breakdown.overdue, 35);
  assert.equal(breakdown.linearPriority, 20);
  assert.equal(breakdown.dueWithin24h, undefined, 'overdue and dueWithin24h are mutually exclusive');
  assert.equal(score, 55);

  const carry: TodoCandidate = { id: 'y', title: 'old', source: 'todo_inbox', carryOverDays: 10 };
  assert.equal(scoreCandidate(carry, DEFAULT_SCORER_WEIGHTS, NOW).breakdown.carryOver, 15, 'carry-over is capped at 15');

  const calendar: TodoCandidate = { id: 'z', title: 'soon', source: 'todo_inbox', calendarProximityMin: 90 };
  assert.equal(scoreCandidate(calendar, DEFAULT_SCORER_WEIGHTS, NOW).breakdown.calendarWithin2h, 15);
});

test('scoreAndRank orders by score and returns top-N with sequential ranks', () => {
  const candidates: TodoCandidate[] = [
    { id: 'low', title: 'low', source: 'vault' },
    { id: 'high', title: 'high', source: 'linear', dueDate: '2026-07-10', priority: 'Urgent (1)' },
    { id: 'mid', title: 'mid', source: 'linear', priority: 'High (2)' },
  ];
  const ranked = scoreAndRank(candidates, { weights: DEFAULT_SCORER_WEIGHTS, now: NOW, topN: 2 });
  assert.equal(ranked.length, 2, 'top-N slices to 2');
  assert.deepEqual(ranked.map((r) => r.id), ['high', 'mid']);
  assert.deepEqual(ranked.map((r) => r.rank), [1, 2]);
  assert.ok(ranked[0].score > ranked[1].score);
  assert.ok(ranked[0].breakdown.overdue === 35);
});

// --- normalization + dedupe ------------------------------------------------

test('normalizeCandidates pulls all four sources and drops completed weekly items', () => {
  const candidates = normalizeCandidates({ config, evidence: makeEvidence(), date: DATE, now: NOW });
  const sources = new Set(candidates.map((c) => c.source));
  assert.ok(sources.has('todo_inbox') && sources.has('linear') && sources.has('vault') && sources.has('weekly_priorities'));
  assert.ok(!candidates.some((c) => c.title.includes('✅')), 'completed weekly items are excluded');
});

test('dedupe merges the duplicate "客户 A 合同" across todo_inbox and vault, keeping higher-priority source', () => {
  const candidates = normalizeCandidates({ config, evidence: makeEvidence(), date: DATE, now: NOW });
  const contractMatches = candidates.filter((c) => c.title.includes('客户 A'));
  assert.equal(contractMatches.length, 1, 'the same contract task appears once');
  assert.equal(contractMatches[0].source, 'todo_inbox', 'todo_inbox outranks vault in the merge');
});

test('OKR-linked candidate scores higher than a Feishu weekly-only hit', () => {
  withOkrFile('| O1-KR1 | Ship portfolio site to production | done | not-done | 0% | 2026-07-16 |', () => {
    const linked: TodoCandidate = { id: 'l', title: '推进 O1-KR1 相关工作', source: 'vault' };
    const enriched = normalizeCandidates({
      config,
      evidence: {
        generated_at: NOW.toISOString(),
        date: DATE,
        sources: { vault_scan: { state: 'available', data: { candidates: [{ path: 'p.md', title: '推进 O1-KR1 相关工作' }] } } },
      },
      date: DATE,
      now: NOW,
    });
    assert.equal(enriched[0].okrKrId, 'O1-KR1', 'candidate is linked to the real KR id');
    const linkedScore = scoreCandidate(enriched[0], DEFAULT_SCORER_WEIGHTS, NOW).score;
    const weeklyScore = scoreCandidate({ ...linked, okrKrId: undefined, weeklyOkrHit: true }, DEFAULT_SCORER_WEIGHTS, NOW).score;
    assert.equal(linkedScore, 12);
    assert.equal(weeklyScore, 6);
    assert.ok(linkedScore > weeklyScore);
  });
});

test('buildScoredTodos returns a ranked top with breakdowns end-to-end', () => {
  const result = buildScoredTodos(config, makeEvidence(), DATE, { now: NOW });
  assert.ok(result.top.length >= 3);
  assert.equal(result.top[0].rank, 1);
  assert.ok(result.total_candidates >= result.top.length);
  // The overdue Urgent Linear task should top the list.
  assert.ok(result.top[0].id.includes('LEO-142'));
  assert.ok(result.top[0].breakdown.overdue === 35);
});

// --- daily-plan JSON parse + fallback --------------------------------------

test('parseDailyPlanTodoPlan parses clean JSON and normalizes ranks', () => {
  const plan = parseDailyPlanTodoPlan('{"todos":[{"rank":2,"text":"B","candidateId":"linear:LEO-2"},{"rank":1,"text":"A","candidateId":"linear:LEO-1"}],"note":"hi"}');
  assert.ok(plan);
  assert.deepEqual(plan!.todos.map((t) => t.text), ['A', 'B'], 'todos are sorted by rank');
  assert.deepEqual(plan!.todos.map((t) => t.rank), [1, 2], 'ranks are renumbered from 1');
  assert.equal(plan!.note, 'hi');
});

test('parseDailyPlanTodoPlan tolerates a ```json fenced block', () => {
  const plan = parseDailyPlanTodoPlan('```json\n{"todos":[{"rank":1,"text":"A","candidateId":"c1"}]}\n```');
  assert.ok(plan);
  assert.equal(plan!.todos[0].candidateId, 'c1');
});

test('parseDailyPlanTodoPlan degrades to null on non-JSON so callers fall back to legacy path', () => {
  assert.equal(parseDailyPlanTodoPlan('老板，今天先看这几件事：\n1. 做 A\n2. 做 B'), null);
  assert.equal(parseDailyPlanTodoPlan('{"todos": "not-an-array"}'), null);
  assert.deepEqual(extractDailyPlanTodos('not json at all'), []);
});

// --- feedback ledger + adoption -------------------------------------------

test('recordTodoFeedback + getAdoptionStats compute top-3 adoption rate', () => {
  withTmpWorkdir(() => {
    recordTodoPresented(config, DATE, [
      { candidateId: 'c1', rank: 1 },
      { candidateId: 'c2', rank: 2 },
      { candidateId: 'c3', rank: 3 },
      { candidateId: 'c4', rank: 4 },
    ]);
    recordTodoFeedback(config, { date: DATE, event: 'complete', candidateId: 'c1', rank: 1 });
    recordTodoFeedback(config, { date: DATE, event: 'complete', candidateId: 'c3', rank: 3 });
    recordTodoFeedback(config, { date: DATE, event: 'defer', candidateId: 'c2', rank: 2 });

    const entries = listTodoFeedback(config);
    assert.equal(entries.filter((e) => e.event === 'present').length, 4);
    assert.equal(entries.filter((e) => e.event === 'complete').length, 2);

    const stats = getAdoptionStats(config);
    assert.equal(stats.top3Presented, 3);
    assert.equal(stats.top3Completed, 2, 'c1 and c3 were top-3 and completed');
    assert.equal(Math.round(stats.top3AdoptionRate * 100) / 100, 0.67);
  });
});

// --- helpers ---------------------------------------------------------------

function withTmpWorkdir(fn: () => void): void {
  const cwd = process.cwd();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-scorer-'));
  fs.mkdirSync(path.join(dir, 'data', 'runtime'), { recursive: true });
  process.chdir(dir);
  try {
    fn();
  } finally {
    process.chdir(cwd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function withOkrFile(krRow: string, fn: () => void): void {
  withTmpWorkdir(() => {
    const okrDir = path.join(process.cwd(), 'memory-vault', 'default', '10_OKR');
    fs.mkdirSync(okrDir, { recursive: true });
    fs.writeFileSync(
      path.join(okrDir, 'current-okr.md'),
      ['## Objective O1: Ship', '', '| KR ID | Description | Target | Current | Progress | Updated |', '| --- | --- | --- | --- | --- | --- |', krRow, ''].join('\n'),
    );
    fn();
  });
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
