import fs from 'node:fs';
import path from 'node:path';
import type { AppConfig } from '../config/schema.js';
import { writeFileAtomic } from '../utils/atomic-write.js';

/**
 * LEO-209 — todo feedback ledger.
 *
 * Records how the user reacts to the ranked daily todo card (present /
 * complete / defer / reorder) so the scorer can eventually close the loop and
 * reweight. Appends are atomic (read-modify-writeFileAtomic) so a crash mid
 * write never corrupts the ledger.
 */
export type TodoFeedbackEvent = 'present' | 'complete' | 'defer' | 'reorder';

export interface TodoFeedbackEntry {
  ts: string;
  date: string;
  event: TodoFeedbackEvent;
  candidateId: string;
  rank: number;
  source?: string;
  note?: string;
}

export const TODO_FEEDBACK_PATH = 'data/runtime/todo-feedback.jsonl';

function ledgerPath(_config: AppConfig): string {
  return path.resolve(TODO_FEEDBACK_PATH);
}

export function recordTodoFeedback(config: AppConfig, entry: Omit<TodoFeedbackEntry, 'ts'> & { ts?: string }): void {
  const full: TodoFeedbackEntry = { ts: entry.ts ?? new Date().toISOString(), ...entry };
  appendEntries(config, [full]);
}

/**
 * Log that a ranked set of todos was shown to the user. This is the denominator
 * for adoption stats.
 */
export function recordTodoPresented(
  config: AppConfig,
  date: string,
  todos: Array<{ candidateId: string; rank: number; source?: string }>,
): void {
  if (todos.length === 0) return;
  const ts = new Date().toISOString();
  appendEntries(
    config,
    todos.map((todo) => ({
      ts,
      date,
      event: 'present' as const,
      candidateId: todo.candidateId,
      rank: todo.rank,
      ...(todo.source ? { source: todo.source } : {}),
    })),
  );
}

export function listTodoFeedback(config: AppConfig): TodoFeedbackEntry[] {
  const file = ledgerPath(config);
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as TodoFeedbackEntry;
      } catch {
        return null;
      }
    })
    .filter((entry): entry is TodoFeedbackEntry => Boolean(entry && entry.candidateId && entry.event));
}

export interface TodoAdoptionStats {
  totalPresented: number;
  totalCompleted: number;
  top3Presented: number;
  top3Completed: number;
  /** Fraction of presented top-3 todos that were later completed. */
  top3AdoptionRate: number;
}

/**
 * Reserved for the feedback loop: how often the user actually completes the
 * top-3 ranked todos we surface. `top3AdoptionRate` is 0 when nothing has been
 * presented yet.
 */
export function getAdoptionStats(config: AppConfig): TodoAdoptionStats {
  const entries = listTodoFeedback(config);
  const presented = entries.filter((entry) => entry.event === 'present');
  const completed = new Set(entries.filter((entry) => entry.event === 'complete').map((entry) => entry.candidateId));
  const top3Presented = new Set(presented.filter((entry) => entry.rank <= 3).map((entry) => entry.candidateId));
  const top3Completed = [...top3Presented].filter((id) => completed.has(id)).length;
  return {
    totalPresented: new Set(presented.map((entry) => entry.candidateId)).size,
    totalCompleted: completed.size,
    top3Presented: top3Presented.size,
    top3Completed,
    top3AdoptionRate: top3Presented.size === 0 ? 0 : top3Completed / top3Presented.size,
  };
}

function appendEntries(config: AppConfig, entries: TodoFeedbackEntry[]): void {
  if (entries.length === 0) return;
  const file = ledgerPath(config);
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const addition = `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`;
  writeFileAtomic(file, existing.length && !existing.endsWith('\n') ? `${existing}\n${addition}` : `${existing}${addition}`);
}
