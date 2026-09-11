/**
 * Keeping the prompt inside a context window.
 *
 * Independent, tsx-runnable:  npx tsx scripts/tests/evidence-budget.test.ts
 *
 * The bug these cover was a silent, total failure: evidence reached 685k
 * characters, the assembled prompt 868k, and every scheduled `daily_plan` died
 * on the agent's own 180s timeout while the user simply never got a morning
 * plan. Two halves to the fix — stop the GitHub connector from carrying a raw
 * REST payload around, and give the prompt a budget it degrades into instead of
 * a cliff it falls off — so both halves are pinned here.
 *
 * Pure functions over hand-built fixtures: no network, no config, no clock.
 */
import assert from 'node:assert/strict';

import { leanIssues } from '../../src/connectors/github.js';
import { fitEvidenceToBudget } from '../../src/workflows/evidence-budget.js';
import type { Evidence } from '../../src/workflows/types.js';

type TestFn = () => void | Promise<void>;
const tests: Array<{ name: string; fn: TestFn }> = [];
function test(name: string, fn: TestFn): void {
  tests.push({ name, fn });
}

function rawIssue(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 142,
    title: 'todo scorer normalisation',
    state: 'open',
    html_url: 'https://github.com/acme/app/issues/142',
    body: 'x'.repeat(24_000),
    user: { login: 'josie', id: 1, avatar_url: 'https://…', gravatar_id: '', followers_url: 'https://…', gists_url: 'https://…' },
    labels: [{ id: 9, name: 'bug', color: 'ff0000' }, 'legacy-string-label'],
    assignees: [{ login: 'josie' }, { login: 'leon' }],
    comments: 3,
    created_at: '2026-09-01T00:00:00Z',
    updated_at: '2026-09-10T00:00:00Z',
    labels_url: 'https://…',
    events_url: 'https://…',
    timeline_url: 'https://…',
    repository_url: 'https://…',
    node_id: 'I_kwDO',
    performed_via_github_app: null,
    reactions: { url: 'https://…', total_count: 0, '+1': 0, '-1': 0 },
    ...over,
  };
}

function evidenceWith(sources: Evidence['sources']): Evidence {
  return { generated_at: '2026-09-11T12:00:00Z', date: '2026-09-11', sources };
}

const size = (value: unknown): number => JSON.stringify(value ?? null).length;

// --- the GitHub projection --------------------------------------------------

test('a projected issue keeps what a plan can act on', () => {
  const [issue] = leanIssues([rawIssue()]);
  assert.equal(issue?.number, 142);
  assert.equal(issue?.title, 'todo scorer normalisation');
  assert.equal(issue?.state, 'open');
  assert.equal(issue?.url, 'https://github.com/acme/app/issues/142');
  assert.equal(issue?.author, 'josie');
  assert.deepEqual(issue?.assignees, ['josie', 'leon']);
  assert.equal(issue?.comments, 3);
  assert.equal(issue?.updated_at, '2026-09-10T00:00:00Z');
});

test('labels survive as names, whether they arrive as objects or bare strings', () => {
  const [issue] = leanIssues([rawIssue()]);
  assert.deepEqual(issue?.labels, ['bug', 'legacy-string-label']);
});

test('the addressing and bookkeeping fields are gone', () => {
  const serialised = JSON.stringify(leanIssues([rawIssue()]));
  for (const noise of ['labels_url', 'events_url', 'timeline_url', 'repository_url', 'node_id', 'performed_via_github_app', 'reactions', 'gravatar_id', 'avatar_url']) {
    assert.ok(!serialised.includes(noise), `${noise} should not reach the evidence`);
  }
});

test('a long body is truncated and says so', () => {
  const [issue] = leanIssues([rawIssue()]);
  assert.equal(issue?.body_truncated, true);
  assert.ok((issue?.body?.length ?? 0) < 600, 'body should be cut to roughly the limit');
});

test('a short body is kept whole, with no truncation marker', () => {
  const [issue] = leanIssues([rawIssue({ body: 'one line' })]);
  assert.equal(issue?.body, 'one line');
  assert.equal(issue?.body_truncated, undefined);
});

test('an empty body is omitted rather than carried as an empty string', () => {
  const [issue] = leanIssues([rawIssue({ body: '   ' })]);
  assert.equal(issue?.body, undefined);
});

test('a pull request is marked as one', () => {
  const [plain] = leanIssues([rawIssue()]);
  const [pr] = leanIssues([rawIssue({ pull_request: { url: 'https://…' }, draft: true })]);
  assert.equal(plain?.is_pull_request, false);
  assert.equal(pr?.is_pull_request, true);
  assert.equal(pr?.draft, true);
});

test('the projection shrinks a real-sized issue by more than an order of magnitude', () => {
  const raw = rawIssue();
  assert.ok(size(raw) > 24_000, 'fixture should be representative of the payload that broke this');
  assert.ok(size(leanIssues([raw])) < 1_200, `projected issue was ${size(leanIssues([raw]))} chars`);
});

test('a malformed payload yields no issues instead of throwing', () => {
  assert.deepEqual(leanIssues(null), []);
  assert.deepEqual(leanIssues({ message: 'Not Found' }), []);
  assert.deepEqual(leanIssues(['nonsense', 42]), []);
});

// --- the evidence budget ----------------------------------------------------

test('small evidence passes through untouched and reports nothing', () => {
  const evidence = evidenceWith({ todo_inbox: { state: 'available', data: { open: ['ship the thing'] } } });
  const result = fitEvidenceToBudget(evidence, 'daily_plan');
  assert.deepEqual(result.notes, []);
  assert.deepEqual(result.evidence, evidence);
  assert.equal(result.after, result.before);
});

test('daily_plan drops the completed-issue sidecar; daily_review keeps it', () => {
  const build = (): Evidence =>
    evidenceWith({
      linear: { state: 'available', data: { items: [{ id: 'LEO-1' }], recently_completed: [{ id: 'LEO-0', title: 'y'.repeat(400) }] } },
    });

  const planned = fitEvidenceToBudget(build(), 'daily_plan');
  assert.ok(!JSON.stringify(planned.evidence).includes('recently_completed'));
  assert.ok(planned.notes.some((note) => note.includes('recently_completed')));

  const reviewed = fitEvidenceToBudget(build(), 'daily_review');
  assert.ok(JSON.stringify(reviewed.evidence).includes('recently_completed'));
});

test('trimming for the prompt never edits the evidence the ledger and console show', () => {
  const evidence = evidenceWith({
    linear: { state: 'available', data: { items: [], recently_completed: [{ id: 'LEO-0' }] } },
    feishu_work_docs: { state: 'available', data: { doc: 'z'.repeat(50_000) } },
  });
  const before = JSON.stringify(evidence);
  fitEvidenceToBudget(evidence, 'daily_plan');
  assert.equal(JSON.stringify(evidence), before, 'the input evidence was mutated');
});

test('a document-sized string is capped, and the cap is announced', () => {
  const evidence = evidenceWith({ feishu_work_docs: { state: 'available', data: { 'Doc 1': 'z'.repeat(160_000) } } });
  const result = fitEvidenceToBudget(evidence, 'daily_plan');
  assert.ok(result.after < 12_000, `docs source was still ${result.after} chars`);
  assert.ok(result.notes.some((note) => note.includes('feishu_work_docs') && note.includes('截断')));
});

test('an oversized list source is thinned, not deleted', () => {
  const messages = Array.from({ length: 50 }, (_, i) => ({ id: i, text: `message ${i} ${'m'.repeat(900)}` }));
  const evidence = evidenceWith({ feishu_work_im_history: { state: 'available', data: { data: { items: messages } } } });
  const result = fitEvidenceToBudget(evidence, 'daily_plan');

  const kept = result.evidence.sources.feishu_work_im_history;
  assert.equal(kept?.state, 'available', 'the source should survive');
  const serialised = JSON.stringify(kept);
  assert.ok(serialised.includes('message 0'), 'the leading messages should be the ones kept');
  assert.ok(size(kept) < 14_000, `im history was still ${size(kept)} chars`);
  assert.ok(result.notes.some((note) => note.includes('丢掉') && note.includes('feishu_work_im_history')));
});

test('a single huge string is cut by the string cap, before eviction is ever considered', () => {
  const evidence = evidenceWith({ chrome_snapshot: { state: 'available', data: { blob: 'q'.repeat(400_000) } } });
  const result = fitEvidenceToBudget(evidence, 'daily_plan', 20_000);
  assert.equal(result.evidence.sources.chrome_snapshot?.state, 'available', 'capping should have been enough');
  assert.ok(result.notes.some((note) => note.includes('chrome_snapshot') && note.includes('截断')));
  assert.ok(!result.notes.some((note) => note.includes('整源裁掉')));
});

test('a source that is neither long strings nor lists is evicted, and the eviction is reported', () => {
  // Thousands of short keys on an object: every string is under the cap, and
  // there is no array to thin. Eviction is the only tool left.
  const wide = Object.fromEntries(Array.from({ length: 4_000 }, (_, i) => [`tab_${i}`, `t${i}`]));
  const evidence = evidenceWith({
    chrome_snapshot: { state: 'available', data: wide },
    todo_inbox: { state: 'available', data: { open: ['ship the thing'] } },
  });
  const result = fitEvidenceToBudget(evidence, 'daily_plan', 20_000);
  assert.ok(result.after <= 20_000, `evidence was still ${result.after} chars`);
  assert.equal(result.evidence.sources.todo_inbox?.state, 'available', 'the useful source should be the last to go');
  assert.ok(result.notes.some((note) => note.includes('chrome_snapshot') && note.includes('整源裁掉')));
});

test('eviction never wastes itself on sources too small to matter', () => {
  const wide = Object.fromEntries(Array.from({ length: 4_000 }, (_, i) => [`tab_${i}`, `t${i}`]));
  const evidence = evidenceWith({
    feishu_minutes_bot_tasks: { state: 'disabled' },
    local_files: { state: 'disabled' },
    chrome_snapshot: { state: 'available', data: wide },
  });
  const result = fitEvidenceToBudget(evidence, 'daily_plan', 20_000);
  assert.equal(result.evidence.sources.feishu_minutes_bot_tasks?.state, 'disabled');
  assert.equal(result.evidence.sources.local_files?.state, 'disabled');
  assert.ok(!result.notes.some((note) => note.includes('local_files')), 'a 20-character source is not worth a note');
});

test('everything removed leaves a note — a budget that trims in silence is the original bug', () => {
  const evidence = evidenceWith({
    linear: { state: 'available', data: { items: [], recently_completed: [{ id: 'LEO-0', title: 'y'.repeat(400) }] } },
    feishu_work_docs: { state: 'available', data: { doc: 'z'.repeat(90_000) } },
  });
  const result = fitEvidenceToBudget(evidence, 'daily_plan');
  assert.ok(result.after < result.before);
  assert.ok(result.notes.length >= 2, `expected a note per removal, got ${result.notes.length}`);
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
