/**
 * My todos History / Deferred retention tests.
 *
 * Independent, dependency-free runner (run with:
 * `tsx scripts/tests/todo-inbox-history.test.ts`). Covers the console's History
 * (done) and Deferred lists: a one-month retention window, the purge that retires
 * anything older, and restore-to-open — including the feedback-ledger side of
 * restore, which must clear the completed state so a restored todo can be planned
 * again instead of staying permanently excluded by the scorer.
 *
 * Runs inside a throwaway workdir (process.chdir) so the inbox ledger, the vault
 * note and the feedback jsonl never touch the real repo.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { AppConfig } from '../../src/config/schema.js';
import type { TodoInboxItem } from '../../src/todo/inbox.js';
import {
  listTodoInboxHistory,
  openTodoInboxItems,
  purgeExpiredTodoInboxHistory,
  TODO_HISTORY_RETENTION_DAYS,
  updateTodoInboxItemById,
} from '../../src/todo/inbox.js';
import { getCompletedCandidateIds, recordTodoFeedback } from '../../src/todo/feedback.js';

type TestFn = () => void | Promise<void>;
const tests: Array<{ name: string; fn: TestFn }> = [];
function test(name: string, fn: TestFn): void {
  tests.push({ name, fn });
}

const NOW = new Date('2026-08-04T12:00:00Z');
const DAY_MS = 24 * 60 * 60 * 1000;

function makeConfig(): AppConfig {
  return {
    todo_inbox: {
      enabled: true,
      ledger_path: './data/runtime/todo-inbox.jsonl',
      vault_path: './data/memory/daily-os-todo.md',
      vault_relative_path: '',
    },
    sources: { vault: { local_path: '' } },
  } as unknown as AppConfig;
}

/** Seed the inbox ledger directly so we control each item's updated_at. */
function seed(config: AppConfig, items: Array<Partial<TodoInboxItem> & { id: string; status: TodoInboxItem['status']; updated_at: string }>): void {
  const ledger = path.resolve(config.todo_inbox.ledger_path);
  fs.mkdirSync(path.dirname(ledger), { recursive: true });
  const lines = items.map((item) =>
    JSON.stringify({
      created_at: item.updated_at,
      source: 'test',
      raw_text: item.text ?? item.id,
      text: item.text ?? item.id,
      type: 'todo',
      ...item,
    }),
  );
  fs.writeFileSync(ledger, `${lines.join('\n')}\n`, 'utf8');
}

function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * DAY_MS).toISOString();
}

function withTmpWorkdir(fn: () => void): void {
  const cwd = process.cwd();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-inbox-history-'));
  fs.mkdirSync(path.join(dir, 'data', 'runtime'), { recursive: true });
  process.chdir(dir);
  try {
    fn();
  } finally {
    process.chdir(cwd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// --- retention window -------------------------------------------------------

test('History and Deferred list only the last month, newest first', () => {
  withTmpWorkdir(() => {
    const config = makeConfig();
    seed(config, [
      { id: 'd-old', status: 'done', updated_at: daysAgo(40), text: '一个月前完成' },
      { id: 'd-recent', status: 'done', updated_at: daysAgo(2), text: '前天完成' },
      { id: 'd-yesterday', status: 'done', updated_at: daysAgo(1), text: '昨天完成' },
      { id: 'f-recent', status: 'deferred', updated_at: daysAgo(3), text: '延期的' },
      { id: 'o-1', status: 'open', updated_at: daysAgo(1), text: '还没做' },
    ]);
    const done = listTodoInboxHistory(config, 'done', NOW);
    assert.deepEqual(done.map((item) => item.id), ['d-yesterday', 'd-recent'], 'newest first, older-than-a-month excluded');
    const deferred = listTodoInboxHistory(config, 'deferred', NOW);
    assert.deepEqual(deferred.map((item) => item.id), ['f-recent'], 'deferred list is separate from done');
    assert.deepEqual(openTodoInboxItems(config).map((item) => item.id), ['o-1'], 'open list is unaffected');
  });
});

test('purge retires entries past the retention window and leaves the rest alone', () => {
  withTmpWorkdir(() => {
    const config = makeConfig();
    seed(config, [
      { id: 'd-old', status: 'done', updated_at: daysAgo(TODO_HISTORY_RETENTION_DAYS + 5) },
      { id: 'f-old', status: 'deferred', updated_at: daysAgo(TODO_HISTORY_RETENTION_DAYS + 1) },
      { id: 'd-recent', status: 'done', updated_at: daysAgo(1) },
      { id: 'o-1', status: 'open', updated_at: daysAgo(90) },
    ]);
    assert.equal(purgeExpiredTodoInboxHistory(config, NOW), 2, 'both expired entries are retired');
    assert.deepEqual(listTodoInboxHistory(config, 'done', NOW).map((item) => item.id), ['d-recent']);
    assert.deepEqual(listTodoInboxHistory(config, 'deferred', NOW).map((item) => item.id), []);
    assert.deepEqual(openTodoInboxItems(config).map((item) => item.id), ['o-1'], 'an old *open* todo is never purged');
    assert.equal(purgeExpiredTodoInboxHistory(config, NOW), 0, 'purge is idempotent');
  });
});

// --- restore ----------------------------------------------------------------

test('restoring a done todo puts it back in the open list and out of History', () => {
  withTmpWorkdir(() => {
    const config = makeConfig();
    seed(config, [{ id: 'd-1', status: 'done', updated_at: daysAgo(1), text: '缴纳学费' }]);
    updateTodoInboxItemById(config, 'd-1', { status: 'open' });
    assert.deepEqual(openTodoInboxItems(config).map((item) => item.id), ['d-1'], 'back to open');
    assert.deepEqual(listTodoInboxHistory(config, 'done', NOW).map((item) => item.id), [], 'gone from History');
  });
});

test('a reopen clears the completed state so the restored todo can be planned again', () => {
  withTmpWorkdir(() => {
    const config = makeConfig();
    const candidateId = 'todo_inbox:d-1';
    recordTodoFeedback(config, { date: '2026-08-03', event: 'complete', candidateId, rank: 1, source: 'console' });
    assert.ok(getCompletedCandidateIds(config).has(candidateId), 'completed while it was done');
    recordTodoFeedback(config, { date: '2026-08-04', event: 'reopen', candidateId, rank: 0, source: 'console-my-todos' });
    assert.ok(!getCompletedCandidateIds(config).has(candidateId), 'restore makes it eligible for planning again');
  });
});

test('completing again after a reopen re-excludes it (last event wins)', () => {
  withTmpWorkdir(() => {
    const config = makeConfig();
    const candidateId = 'todo_inbox:d-1';
    recordTodoFeedback(config, { date: '2026-08-01', event: 'complete', candidateId, rank: 1 });
    recordTodoFeedback(config, { date: '2026-08-02', event: 'reopen', candidateId, rank: 0 });
    recordTodoFeedback(config, { date: '2026-08-03', event: 'complete', candidateId, rank: 1 });
    assert.ok(getCompletedCandidateIds(config).has(candidateId), 'the latest complete/reopen wins');
  });
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
  console.log(`\ntodo-inbox-history.test: ${passed}/${passed + failed} passed`);
  if (failed > 0) process.exit(1);
}

void run();
