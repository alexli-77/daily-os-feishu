/**
 * The user's ordering of today's plan, laid back over the model's.
 *
 * Independent, tsx-runnable:  npx tsx scripts/tests/plan-order.test.ts
 *
 * Worth testing as a pure function rather than through the endpoint, because
 * every interesting case is a *disagreement* between two lists that were
 * written at different times — the ledger says where five rows go, and the plan
 * on disk has since gained a sixth, lost one, or been rerun entirely. Those are
 * ordinary days, not edge cases, and none of them are visible in a test that
 * reorders a list and reads it straight back.
 *
 * The property that matters most: `rank` is half the ledger key every client
 * sends back with complete / defer / update. If two rows come out claiming the
 * same rank, two different rows write to the same ledger slot.
 */
import assert from 'node:assert/strict';

import { applyUserOrder } from '../../src/ui/server.js';
import type { DailyPlanTodo } from '../../src/workflows/summary.js';

type TestFn = () => void;
const tests: Array<{ name: string; fn: TestFn }> = [];
function test(name: string, fn: TestFn): void {
  tests.push({ name, fn });
}

/** The shape `extractDailyPlanTodos` produces: ranked 1..n, in model order. */
function plan(...ids: string[]): DailyPlanTodo[] {
  return ids.map((candidateId, index) => ({ rank: index + 1, text: `任务 ${candidateId}`, candidateId }));
}

function order(todos: DailyPlanTodo[]): string[] {
  return todos.map((todo) => todo.candidateId);
}

test('with nothing recorded, the model order is untouched', () => {
  const todos = plan('a', 'b', 'c');
  assert.deepEqual(order(applyUserOrder(todos, new Map())), ['a', 'b', 'c']);
});

test('a recorded order wins over the model order', () => {
  const todos = plan('a', 'b', 'c');
  const userRank = new Map([['c', 1], ['a', 2], ['b', 3]]);
  assert.deepEqual(order(applyUserOrder(todos, userRank)), ['c', 'a', 'b']);
});

test('rank is rewritten to 1..n, so no two rows share a ledger key', () => {
  const todos = plan('a', 'b', 'c');
  const result = applyUserOrder(todos, new Map([['c', 1], ['a', 2], ['b', 3]]));
  assert.deepEqual(result.map((todo) => todo.rank), [1, 2, 3]);
});

// A rerun between the reorder and the read is the common way this happens: the
// ledger knows nothing about the new row. Falling back to its model rank keeps
// it next to the row the model put it next to — here it followed `b`, and it
// still follows `b` — which beats both dropping it and pinning it to the top.
test('a row the ledger has never seen lands beside where the model put it', () => {
  const todos = plan('a', 'b', 'new', 'c');
  // The user moved c to the front, back when the plan was a/b/c.
  const userRank = new Map([['c', 1], ['a', 2], ['b', 3]]);
  assert.deepEqual(order(applyUserOrder(todos, userRank)), ['c', 'a', 'b', 'new']);
});

test('a recorded row that is no longer in the plan is simply absent', () => {
  const todos = plan('a', 'c');
  const userRank = new Map([['c', 1], ['a', 2], ['b', 3]]);
  const result = applyUserOrder(todos, userRank);
  assert.deepEqual(order(result), ['c', 'a']);
  assert.deepEqual(result.map((todo) => todo.rank), [1, 2]);
});

// Two entries can collide when a new row's model rank equals a recorded rank.
// Without a tie-break the sort is free to swap them on every read, and a list
// that reshuffles when nothing happened is worse than one in the wrong order.
test('ties keep arrival order rather than shuffling between reads', () => {
  const todos = plan('a', 'b', 'c');
  const userRank = new Map([['c', 2]]);
  const once = order(applyUserOrder(todos, userRank));
  const twice = order(applyUserOrder(todos, userRank));
  assert.deepEqual(once, twice);
  assert.deepEqual(once, ['a', 'b', 'c']);
});

test('estimates and text survive the reorder', () => {
  const todos: DailyPlanTodo[] = [
    { rank: 1, text: '写 PR', candidateId: 'a', minutes: 45 },
    { rank: 2, text: '看论文', candidateId: 'b' },
  ];
  const result = applyUserOrder(todos, new Map([['b', 1], ['a', 2]]));
  assert.deepEqual(result, [
    { rank: 1, text: '看论文', candidateId: 'b' },
    { rank: 2, text: '写 PR', candidateId: 'a', minutes: 45 },
  ]);
});

export function testPlanOrder(): void {
  for (const { name, fn } of tests) {
    fn();
    console.log(`  PASS  ${name}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  testPlanOrder();
  console.log(`\n${tests.length} passed.`);
}
