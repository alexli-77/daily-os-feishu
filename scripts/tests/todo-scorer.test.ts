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

test('Linear board state is weighted: In Progress > In Review > untouched', () => {
  const base: TodoCandidate = { id: 'p', title: 'CUTTO-938 四联编辑器设计 demo', source: 'linear', priority: 'High (2)' };
  const inProgress = { ...base, stateName: 'In Progress', stateType: 'started' };
  const inReview = { ...base, id: 'r', stateName: 'In Review', stateType: 'started' };
  const untouched = { ...base, id: 'u', stateName: 'Todo', stateType: 'unstarted' };

  assert.equal(scoreCandidate(inProgress, DEFAULT_SCORER_WEIGHTS, NOW).breakdown.linearState, 15);
  assert.equal(scoreCandidate(inReview, DEFAULT_SCORER_WEIGHTS, NOW).breakdown.linearState, 8);
  assert.equal(scoreCandidate(untouched, DEFAULT_SCORER_WEIGHTS, NOW).breakdown.linearState, undefined);

  // A candidate with no state at all (older evidence, non-Linear source) is unchanged.
  assert.equal(scoreCandidate(base, DEFAULT_SCORER_WEIGHTS, NOW).score, 12);
});

test('a due date 2 days out scores above no due date at all (72h tier)', () => {
  const inThreeDays: TodoCandidate = { id: 'd', title: '封面 Figma 模板', source: 'linear', dueDate: '2026-07-19' };
  const noDue: TodoCandidate = { id: 'n', title: '封面 Figma 模板', source: 'linear' };
  const { breakdown } = scoreCandidate(inThreeDays, DEFAULT_SCORER_WEIGHTS, NOW);
  assert.equal(breakdown.dueWithin72h, 12);
  assert.equal(breakdown.dueWithin24h, undefined, 'the 24h and 72h tiers are mutually exclusive');
  assert.ok(scoreCandidate(inThreeDays, DEFAULT_SCORER_WEIGHTS, NOW).score > scoreCandidate(noDue, DEFAULT_SCORER_WEIGHTS, NOW).score);

  const tomorrow: TodoCandidate = { ...inThreeDays, dueDate: '2026-07-18' };
  assert.equal(scoreCandidate(tomorrow, DEFAULT_SCORER_WEIGHTS, NOW).breakdown.dueWithin24h, 25, 'the tighter tier still wins');
});

test('the CUTTO-942 case: an In Progress Medium due in 2 days beats an In Review High with no due date', () => {
  // 942 scored 0 before board state and the 72h tier existed, so it never even
  // reached the candidate pool handed to the model — the exact reported bug.
  const inProgressMedium: TodoCandidate = {
    id: 'linear:CUTTO-942',
    title: 'CUTTO-942 封面 Figma 模板',
    source: 'linear',
    priority: 'Medium (3)',
    dueDate: '2026-07-19',
    stateName: 'In Progress',
    stateType: 'started',
  };
  const inReviewHigh: TodoCandidate = {
    id: 'linear:CUTTO-919',
    title: 'CUTTO-919 中文官网',
    source: 'linear',
    priority: 'High (2)',
    stateName: 'In Review',
    stateType: 'started',
  };
  const ranked = scoreAndRank([inReviewHigh, inProgressMedium], { weights: DEFAULT_SCORER_WEIGHTS, now: NOW });
  assert.deepEqual(ranked.map((item) => item.id), ['linear:CUTTO-942', 'linear:CUTTO-919']);
  assert.equal(ranked[0].score, 27);
  assert.equal(ranked[1].score, 20);
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

test('normalizeCandidates carries the Linear board state onto the candidate', () => {
  const candidates = normalizeCandidates({
    config,
    evidence: {
      generated_at: NOW.toISOString(),
      date: DATE,
      sources: {
        linear: {
          state: 'available',
          data: {
            items: [
              { identifier: 'CUTTO-942', title: '封面 Figma 模板', priority: 3, state: { name: 'In Progress', type: 'started' } },
              { identifier: 'CUTTO-784', title: '竞品体验报告', priority: 0 },
            ],
          },
        },
      },
    },
    date: DATE,
    now: NOW,
  });
  assert.equal(candidates[0].stateName, 'In Progress');
  assert.equal(candidates[0].stateType, 'started');
  assert.equal(candidates[1].stateName, undefined, 'an item without state stays state-less rather than defaulting');
});

test('dedupe merges the duplicate "客户 A 合同" across todo_inbox and vault, keeping higher-priority source', () => {
  const candidates = normalizeCandidates({ config, evidence: makeEvidence(), date: DATE, now: NOW });
  const contractMatches = candidates.filter((c) => c.title.includes('客户 A'));
  assert.equal(contractMatches.length, 1, 'the same contract task appears once');
  assert.equal(contractMatches[0].source, 'todo_inbox', 'todo_inbox outranks vault in the merge');
});

test('a Feishu priority row and its Linear twin merge on the issue key, not on wording', () => {
  const candidates = normalizeCandidates({
    config,
    evidence: {
      generated_at: NOW.toISOString(),
      date: DATE,
      sources: {
        linear: { state: 'available', data: { items: [{ identifier: 'CUTTO-777', title: 'PRD & Demo', priority: 2 }] } },
        weekly_priorities: {
          state: 'available',
          data: {
            items: [
              { scope: '🐧', okr: 'O1', item: '整理人物与大纲组件的 PRD 与 Demo，发关梦龙审核并确认修改项（CUTTO-777）' },
              // Two distinct actions against one issue must NOT collapse into one.
              { scope: '🐧', okr: 'O1', item: '完成 Montreal 视频 4K 终版（CUTTO-301）' },
              { scope: '🐧', okr: 'O1', item: '重录 30 秒内产品宣传 Demo（CUTTO-301）' },
            ],
          },
        },
      },
    },
    date: DATE,
    now: NOW,
  });

  const merged = candidates.filter((item) => /CUTTO-777/.test(item.title));
  assert.equal(merged.length, 1, 'the weekly row and the Linear issue are one candidate');
  assert.equal(merged[0].source, 'linear', 'Linear outranks weekly_priorities in the merge');
  assert.equal(merged[0].weeklyOkrHit, true, 'the weekly OKR signal survives the merge');
  assert.equal(candidates.filter((item) => /CUTTO-301/.test(item.title)).length, 2, 'same-source siblings stay separate');
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

// --- completed todos are never re-proposed ---------------------------------

test('a candidate ticked complete is dropped from the next plan (Feishu ✅ / console 完成)', () => {
  withTmpWorkdir(() => {
    const before = buildScoredTodos(config, makeEvidence(), DATE, { now: NOW });
    const target = before.top[0].id;
    // The user ticks ✅ on today's card; the ledger records a `complete` event.
    recordTodoFeedback(config, { date: DATE, event: 'complete', candidateId: target, rank: 1, source: 'feishu-card' });
    // The next plan must not re-propose it, even though the source still reports it.
    const after = buildScoredTodos(config, makeEvidence(), DATE, { now: NOW });
    assert.ok(!after.top.some((item) => item.id === target), 'completed candidate is gone from the ranked top');
    assert.equal(after.total_candidates, before.total_candidates - 1, 'it is removed from the pool, not just demoted');
  });
});

test('completion is terminal: still excluded on a later day, not just the day it was ticked', () => {
  withTmpWorkdir(() => {
    const target = buildScoredTodos(config, makeEvidence(), DATE, { now: NOW }).top[0].id;
    recordTodoFeedback(config, { date: DATE, event: 'complete', candidateId: target, rank: 1, source: 'feishu-card' });
    const laterDate = '2026-07-24';
    const later = buildScoredTodos(config, makeEvidence(), laterDate, { now: new Date(`${laterDate}T00:00:00`) });
    assert.ok(!later.top.some((item) => item.id === target), 'a week later it is still excluded');
  });
});

test('a deferred candidate is NOT dropped — only completion removes it', () => {
  withTmpWorkdir(() => {
    const before = buildScoredTodos(config, makeEvidence(), DATE, { now: NOW });
    const target = before.top[0].id;
    recordTodoFeedback(config, { date: DATE, event: 'defer', candidateId: target, rank: 1, source: 'feishu-card' });
    const after = buildScoredTodos(config, makeEvidence(), DATE, { now: NOW });
    assert.ok(after.top.some((item) => item.id === target), 'deferring keeps the todo in play for tomorrow');
  });
});

test('a done inbox item is not a candidate: only `open` items feed the plan', () => {
  // Guards the console "My todos → Done" path, which must write the inbox ledger's
  // own status through. `todoInboxEvidence()` only puts `open` items in `data.open`,
  // so a done item never reaches the scorer.
  const evidence = makeEvidence();
  const inbox = evidence.sources.todo_inbox as { state: string; data: { open: Array<{ id: string; text: string }> } };
  const doneId = inbox.data.open[0].id;
  inbox.data.open = inbox.data.open.filter((item) => item.id !== doneId); // status: done -> excluded from `open`
  const after = buildScoredTodos(config, evidence, DATE, { now: NOW });
  assert.ok(!after.top.some((item) => item.id === `todo_inbox:${doneId}`), 'the done inbox item is not planned');
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
