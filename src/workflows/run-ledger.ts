import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { AppConfig, WorkflowName } from '../config/schema.js';

export type WorkflowRunTrigger = 'scheduler' | 'cli' | 'ui' | 'feishu_command' | 'card_action' | 'unknown';
export type WorkflowRunStatus = 'running' | 'succeeded' | 'failed';
export type WorkflowSendStatus = 'pending' | 'succeeded' | 'failed' | 'skipped';

export interface WorkflowRunRecord {
  id: string;
  workflow: WorkflowName;
  trigger: WorkflowRunTrigger;
  source?: string;
  date: string;
  status: WorkflowRunStatus;
  started_at: string;
  completed_at?: string;
  output_chars?: number;
  detail_id?: string;
  send: {
    enabled: boolean;
    provider?: string;
    mode?: string;
    status: WorkflowSendStatus;
    error?: string;
  };
  error?: string;
}

export function startWorkflowRun(
  config: AppConfig,
  input: {
    workflow: WorkflowName;
    trigger?: WorkflowRunTrigger;
    source?: string;
    date: string;
    sendEnabled: boolean;
    provider?: string;
    mode?: string;
  },
): WorkflowRunRecord {
  const record: WorkflowRunRecord = {
    id: `run_${new Date().toISOString().replace(/[-:.TZ]/g, '')}_${crypto.randomUUID().slice(0, 8)}`,
    workflow: input.workflow,
    trigger: input.trigger || 'unknown',
    ...(input.source ? { source: sanitizeSingleLine(input.source, 140) } : {}),
    date: input.date,
    status: 'running',
    started_at: new Date().toISOString(),
    send: {
      enabled: input.sendEnabled,
      ...(input.provider ? { provider: input.provider } : {}),
      ...(input.mode ? { mode: input.mode } : {}),
      status: input.sendEnabled ? 'pending' : 'skipped',
    },
  };
  safeWriteRun(config, record);
  return record;
}

export function markWorkflowRunGenerated(
  config: AppConfig,
  run: WorkflowRunRecord,
  input: { outputChars: number; detailId?: string },
): WorkflowRunRecord {
  const next: WorkflowRunRecord = {
    ...run,
    output_chars: input.outputChars,
    ...(input.detailId ? { detail_id: input.detailId } : {}),
  };
  safeWriteRun(config, next);
  return next;
}

export function markWorkflowRunSucceeded(config: AppConfig, run: WorkflowRunRecord, send?: Partial<WorkflowRunRecord['send']>): WorkflowRunRecord {
  const next: WorkflowRunRecord = {
    ...run,
    status: 'succeeded',
    completed_at: new Date().toISOString(),
    send: {
      ...run.send,
      ...(send || {}),
      status: send?.status || run.send.status,
    },
  };
  if (!next.send.enabled) next.send.status = 'skipped';
  safeWriteRun(config, next);
  return next;
}

export function markWorkflowRunFailed(
  config: AppConfig,
  run: WorkflowRunRecord,
  error: unknown,
  input: { sendFailed?: boolean } = {},
): WorkflowRunRecord {
  const errorText = sanitizeError(error);
  const next: WorkflowRunRecord = {
    ...run,
    status: 'failed',
    completed_at: new Date().toISOString(),
    error: errorText,
    send: {
      ...run.send,
      ...(input.sendFailed ? { status: 'failed' as const, error: errorText } : {}),
    },
  };
  safeWriteRun(config, next);
  return next;
}

export function listRecentWorkflowRuns(config: AppConfig, limit = 5): WorkflowRunRecord[] {
  const dir = workflowRunsDir(config);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .reverse()
    .slice(0, Math.max(0, limit))
    .map((name) => readRun(path.join(dir, name)))
    .filter((record): record is WorkflowRunRecord => Boolean(record));
}

export function formatRecentWorkflowRuns(runs: WorkflowRunRecord[]): string {
  if (runs.length === 0) return '最近还没有 workflow 运行记录。';
  return [
    '最近 workflow 运行：',
    '',
    ...runs.map((run, index) => {
      const send = run.send.enabled ? `${run.send.status}${run.send.mode ? `/${run.send.mode}` : ''}` : 'skipped';
      const error = run.error ? `；${run.error}` : '';
      return `${index + 1}. ${run.workflow} | ${run.trigger} | ${run.status} | send=${send} | ${run.started_at}${error}`;
    }),
  ].join('\n');
}

function safeWriteRun(config: AppConfig, record: WorkflowRunRecord): void {
  try {
    const dir = workflowRunsDir(config);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${record.started_at.slice(0, 10)}-${record.id}.json`), JSON.stringify(record, null, 2), 'utf8');
    pruneOldRuns(dir);
  } catch (error) {
    console.warn(`[workflow-run-ledger] failed to write run record: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function readRun(filePath: string): WorkflowRunRecord | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as WorkflowRunRecord;
    if (!parsed || typeof parsed.id !== 'string' || typeof parsed.workflow !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

function workflowRunsDir(config: AppConfig): string {
  return path.resolve(config.memory.workflow_runs_dir);
}

function sanitizeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return sanitizeSingleLine(raw, 500);
}

function sanitizeSingleLine(value: string, limit: number): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, limit);
}

function pruneOldRuns(dir: string): void {
  const entries = fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .reverse();
  for (const name of entries.slice(200)) {
    fs.rmSync(path.join(dir, name), { force: true });
  }
}
