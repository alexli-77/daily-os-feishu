import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AppConfig } from '../config/schema.js';
import { runCommand } from '../utils/command.js';

type SkillEntry = AppConfig['skills']['registry'][number];

export interface LifeReviewOsRunResult {
  runId: string;
  draft: string;
  writeback?: LifeReviewOsWriteback;
}

interface LifeReviewOsWriteback {
  doc_label?: string;
  target_week?: string;
  task_header?: string;
  action?: 'append_to_existing_empty_column' | 'insert_columns';
  ready?: boolean;
  items?: LifeReviewOsWritebackItem[];
}

interface LifeReviewOsWritebackItem {
  text?: string;
  target_row?: number | null;
  target_row_label?: string;
  is_mit?: boolean;
}

export interface LifeReviewOsWritebackPreview {
  token: string;
  skillId: string;
  mode: string;
  target: {
    docLabel: string;
    weekLabel: string;
    taskHeader: string;
    action: 'append_to_existing_empty_column' | 'insert_columns';
  };
  items: Array<{ text: string; targetRowLabel: string; isMit: boolean }>;
}

export interface LifeReviewOsWritebackResult {
  taskHeader: string;
  itemCount: number;
  skippedCount: number;
  insertedColumns: boolean;
  alreadyWritten: boolean;
}

export function isLifeReviewOsEntry(entry: SkillEntry): boolean {
  return entry.id === 'weekly-review' && Boolean(resolveLifeReviewOsCli(entry));
}

export async function runLifeReviewOsSkill(input: {
  entry: SkillEntry;
  mode: string;
  provider: 'codex' | 'claude';
  userText: string;
  inputPackPath: string;
}): Promise<LifeReviewOsRunResult> {
  const cli = requireLifeReviewOsCli(input.entry);
  const args = [cli, 'run', input.mode, '--json', '--provider', input.provider, '--daily-os-input', input.inputPackPath];
  if (input.userText.trim()) args.push('--user-text', input.userText.trim());
  const result = await runCommand('node', args, { cwd: lifeReviewOsRoot(cli), timeoutMs: 660000 });
  const parsed = parseLifeReviewOsJson(result.stdout, result.stderr, 'run', result.ok);
  return {
    runId: stringValue(parsed.run_id),
    draft: stripWritebackJsonBlock(stringValue(parsed.draft)),
    writeback: asWriteback(parsed.writeback),
  };
}

export async function prepareLifeReviewOsWriteback(input: {
  config: AppConfig;
  skillId: string;
  mode?: string;
  runId?: string;
}): Promise<LifeReviewOsWritebackPreview> {
  const entry = skillEntry(input.config, input.skillId);
  const runId = input.runId || readLatestStoredRunId(input.config, input.skillId, input.mode || 'weekly');
  if (!runId) throw new Error('No recent weekly-review run found. Run `daily-os weekly deep` first.');
  const parsed = await callLifeReviewOs(entry, ['preview', '--run-id', runId, '--json'], 'preview');
  const writeback = asWriteback(parsed.writeback);
  assertWritebackReady(writeback);
  return {
    token: runId,
    skillId: input.skillId,
    mode: input.mode || stringValue(parsed.mode) || 'weekly',
    target: {
      docLabel: stringValue(writeback.doc_label) || 'Weekly',
      weekLabel: stringValue(writeback.target_week),
      taskHeader: stringValue(writeback.task_header),
      action: writeback.action || 'append_to_existing_empty_column',
    },
    items: (writeback.items || []).map((item) => ({
      text: stringValue(item.text),
      targetRowLabel: stringValue(item.target_row_label),
      isMit: Boolean(item.is_mit),
    })),
  };
}

export async function executeLifeReviewOsWriteback(config: AppConfig, skillId: string, runId: string): Promise<LifeReviewOsWritebackResult> {
  const entry = skillEntry(config, skillId);
  const parsed = await callLifeReviewOs(entry, ['writeback', '--run-id', runId, '--json'], 'writeback');
  return {
    taskHeader: stringValue(parsed.task_header),
    itemCount: numberValue(parsed.item_count),
    skippedCount: numberValue(parsed.skipped_count),
    insertedColumns: Boolean(parsed.inserted_columns),
    alreadyWritten: Boolean(parsed.already_written),
  };
}

function assertWritebackReady(writeback: LifeReviewOsWriteback): void {
  const items = writeback.items || [];
  const unmapped = items.filter((item) => typeof item.target_row !== 'number');
  if (!writeback.ready || items.length === 0 || unmapped.length > 0) {
    const sample = unmapped
      .slice(0, 3)
      .map((item) => stringValue(item.text))
      .filter(Boolean)
      .join('；');
    throw new Error(sample ? `写回预检失败：有要务无法对应到第一列 OKR 行：${sample}` : '写回预检失败：没有可按 OKR 行写回的下周要务。');
  }
}

async function callLifeReviewOs(entry: SkillEntry, args: string[], label: string): Promise<Record<string, unknown>> {
  const cli = requireLifeReviewOsCli(entry);
  const result = await runCommand('node', [cli, ...args], { cwd: lifeReviewOsRoot(cli), timeoutMs: 300000 });
  return parseLifeReviewOsJson(result.stdout, result.stderr, label, result.ok);
}

function parseLifeReviewOsJson(stdout: string, stderr: string, label: string, ok: boolean): Record<string, unknown> {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(stdout) as Record<string, unknown>;
  } catch {
    throw new Error(`life-review-os ${label} returned invalid JSON: ${(stderr || stdout).slice(0, 1000)}`);
  }
  if (!ok || parsed.ok === false) {
    throw new Error(`life-review-os ${label} failed: ${stringValue(parsed.error) || (stderr || stdout).slice(0, 1000)}`);
  }
  return parsed;
}

function requireLifeReviewOsCli(entry: SkillEntry): string {
  const cli = resolveLifeReviewOsCli(entry);
  if (!cli) throw new Error('life-review-os CLI not found. Set weekly-review workdir to the life-review-os repo or install bin/life-review-os.mjs in the skill folder.');
  return cli;
}

function resolveLifeReviewOsCli(entry: SkillEntry): string {
  const candidates = [
    process.env.LIFE_REVIEW_OS_CLI || '',
    path.join(skillWorkdir(entry), 'bin/life-review-os.mjs'),
    path.join(path.dirname(expandPath(entry.path)), 'bin/life-review-os.mjs'),
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) || '';
}

function lifeReviewOsRoot(cliPath: string): string {
  return path.resolve(path.dirname(cliPath), '..');
}

function skillEntry(config: AppConfig, skillId: string): SkillEntry {
  const entry = config.skills.registry.find((candidate) => candidate.id === skillId);
  if (!entry) throw new Error(`Skill not configured: ${skillId}`);
  return entry;
}

function readLatestStoredRunId(config: AppConfig, skillId: string, mode: string): string {
  const filePath = path.resolve(config.skills.inputs_dir, '_skill-runs.json');
  if (!fs.existsSync(filePath)) return '';
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Array<Record<string, unknown>>;
    const latest = parsed
      .filter((run) => run.skillId === skillId && run.mode === mode && typeof run.runId === 'string')
      .sort((left, right) => stringValue(right.createdAt).localeCompare(stringValue(left.createdAt)))[0];
    return typeof latest?.runId === 'string' ? latest.runId : '';
  } catch {
    return '';
  }
}

function skillWorkdir(entry: SkillEntry): string {
  if (entry.workdir.trim()) return expandPath(entry.workdir);
  return path.dirname(expandPath(entry.path));
}

function expandPath(value: string): string {
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return path.resolve(value);
}

function asWriteback(value: unknown): LifeReviewOsWriteback {
  return value && typeof value === 'object' ? (value as LifeReviewOsWriteback) : {};
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : value == null ? '' : String(value);
}

function numberValue(value: unknown): number {
  return typeof value === 'number' ? value : typeof value === 'string' ? Number(value) || 0 : 0;
}

/**
 * Strip only the Feishu `writeback_plan` fenced JSON block from a life-review-os
 * draft, processing one ```json fence at a time so a co-located biweekly
 * `kr_progress` block always survives. Removing the block per-fence (rather than
 * with a single spanning regex) is what keeps a kr_progress block that appears
 * before the writeback_plan block from being swallowed — that block is the only
 * channel the Feishu biweekly flow has to reach the local-OKR write-back card
 * (LEO-109). Any fence that itself carries `kr_progress` is kept verbatim.
 */
export function stripWritebackJsonBlock(value: string): string {
  return value
    .replace(/```json\s*([\s\S]*?)```/gi, (match, body: string) =>
      /"writeback_plan"/.test(body) && !/"kr_progress"/.test(body) ? '' : match,
    )
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
