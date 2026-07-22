/**
 * daily_plan "first post of the day" retry tests.
 *
 * Independent, dependency-free runner (run with:
 * `tsx scripts/tests/daily-plan-retry.test.ts`). Covers the fix for the morning
 * daily_plan landing garbage: when the model returns unparseable LEO-209 JSON
 * (truncated at the token cap, or otherwise malformed) the run must retry in place
 * — automating the manual "重排一次" — instead of persisting/sending an unusable
 * plan (which also left that evening's daily_review with nothing to reconcile).
 */
import assert from 'node:assert/strict';

import type { AgentInput } from '../../src/agent/openai-agent.js';
import type { AppConfig } from '../../src/config/schema.js';
import type { Evidence } from '../../src/workflows/types.js';
import type { MemoryBundle } from '../../src/storage/memory.js';
import type { WorkflowName } from '../../src/config/schema.js';
import { runAgentWithNonEmptyOutput } from '../../src/workflows/run-workflow.js';

type TestFn = () => void | Promise<void>;
const tests: Array<{ name: string; fn: TestFn }> = [];
function test(name: string, fn: TestFn): void {
  tests.push({ name, fn });
}

const VALID_PLAN = JSON.stringify({
  todos: [
    { rank: 1, text: '把决策文档写出第一版', candidateId: 'linear:LEO-97' },
    { rank: 2, text: '系统过一遍 Agent loop、ReAct、function calling', candidateId: 'linear:LEO-98' },
  ],
  note: '先清逾期再做新任务',
});

// A response cut off mid-array at the token cap — exactly the first-post garbage.
const TRUNCATED_PLAN = '{ "todos": [ { "rank": 1, "text": "写决策文档", "candidateId": "LEO-97" }, { "rank": 2, "text": "系统过一遍 Agent loop、ReAc';

function input(workflow: WorkflowName): AgentInput {
  return {
    config: {} as AppConfig,
    workflow,
    date: '2026-07-22',
    evidence: {} as Evidence,
    memory: {} as MemoryBundle,
  };
}

/** A fake agent runner that returns/throws a scripted sequence, one per attempt. */
function scriptedRunner(steps: Array<{ text: string } | { throw: string }>): {
  run: (input: AgentInput) => Promise<string>;
  calls: () => number;
} {
  let i = 0;
  return {
    calls: () => i,
    run: async () => {
      const step = steps[Math.min(i, steps.length - 1)];
      i += 1;
      if ('throw' in step) throw new Error(step.throw);
      return step.text;
    },
  };
}

// --- daily_plan structured-contract retry -----------------------------------

test('daily_plan retries a truncated first attempt and lands the valid plan', async () => {
  const runner = scriptedRunner([{ text: TRUNCATED_PLAN }, { text: VALID_PLAN }]);
  const out = await runAgentWithNonEmptyOutput(input('daily_plan'), runner.run);
  assert.equal(out, VALID_PLAN, 'the second, valid plan is returned');
  assert.equal(runner.calls(), 2, 'exactly one retry was needed');
});

test('daily_plan retries a thrown (max_tokens) first attempt, then lands', async () => {
  const runner = scriptedRunner([
    { throw: 'Anthropic API truncated the response at max_tokens=8192; output is incomplete.' },
    { text: VALID_PLAN },
  ]);
  const out = await runAgentWithNonEmptyOutput(input('daily_plan'), runner.run);
  assert.equal(out, VALID_PLAN);
  assert.equal(runner.calls(), 2);
});

test('daily_plan retries an empty first attempt, then lands', async () => {
  const runner = scriptedRunner([{ text: '   ' }, { text: VALID_PLAN }]);
  const out = await runAgentWithNonEmptyOutput(input('daily_plan'), runner.run);
  assert.equal(out, VALID_PLAN);
  assert.equal(runner.calls(), 2);
});

test('daily_plan that never parses throws after all attempts — never persists garbage', async () => {
  const runner = scriptedRunner([{ text: TRUNCATED_PLAN }]);
  await assert.rejects(
    () => runAgentWithNonEmptyOutput(input('daily_plan'), runner.run),
    /structured contract/,
  );
  assert.equal(runner.calls(), 3, 'all three attempts were used before giving up');
});

test('weekly_review prose is returned as-is (no structured contract to revalidate)', async () => {
  const prose = '## 本周复盘\n- 完成了 A\n- B 还没做';
  const runner = scriptedRunner([{ text: prose }]);
  const out = await runAgentWithNonEmptyOutput(input('weekly_review'), runner.run);
  assert.equal(out, prose, 'free-form prose is accepted on the first attempt');
  assert.equal(runner.calls(), 1, 'no needless retry for prose workflows');
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
  console.log(`\ndaily-plan-retry.test: ${passed}/${passed + failed} passed`);
  if (failed > 0) process.exit(1);
}

void run();
