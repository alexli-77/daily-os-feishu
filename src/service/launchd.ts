import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AppConfig, WorkflowName } from '../config/schema.js';
import { runCommand } from '../utils/command.js';
import { runWorkflow } from '../workflows/run-workflow.js';
import { collectProgressCandidates, hasConfirmedProgress, type ProgressCandidate } from '../progress/capture.js';
import { renderProgressConfirmationCard } from '../progress/card.js';
import { sendFeishuCard } from '../connectors/lark-cli.js';
import { runBackgroundSuggestions } from './background-suggestions.js';
import { pollFeishuFeedback } from '../feedback/feishu-feedback.js';

const LABEL = 'com.daily-os-feishu.agent';
const SCHEDULER_STATE_PATH = './data/memory/scheduler-state.json';
const SCHEDULER_LOCK_DIR = './data/runtime/scheduler-locks';
const RETRY_DELAY_MINUTES = 15;

export interface LaunchAgentStatus {
  label: string;
  plistPath: string;
  installed: boolean;
  registered: boolean;
}

type ConfigProvider = AppConfig | (() => AppConfig);

interface SchedulerRuntimeState {
  fired: Set<string>;
  retryAfter: Map<string, number>;
}

export async function installLaunchAgent(repoRoot = process.cwd()): Promise<string> {
  const plistPath = launchAgentPath();
  const logsDir = path.join(repoRoot, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });
  const scriptPath = path.join(repoRoot, 'dist', 'index.js');
  const plist = buildPlist(repoRoot, scriptPath, logsDir);
  fs.writeFileSync(plistPath, plist);
  await runCommand('launchctl', ['bootout', `gui/${process.getuid?.()}`, plistPath], { timeoutMs: 10000 });
  const result = await runCommand('launchctl', ['bootstrap', `gui/${process.getuid?.()}`, plistPath], { timeoutMs: 10000 });
  if (!result.ok) throw new Error(result.stderr || result.stdout);
  return plistPath;
}

export async function uninstallLaunchAgent(): Promise<string> {
  const plistPath = launchAgentPath();
  await runCommand('launchctl', ['bootout', `gui/${process.getuid?.()}`, plistPath], { timeoutMs: 10000 });
  if (fs.existsSync(plistPath)) fs.unlinkSync(plistPath);
  return plistPath;
}

export async function getLaunchAgentStatus(): Promise<LaunchAgentStatus> {
  const plistPath = launchAgentPath();
  const result = await runCommand('launchctl', ['print', `gui/${process.getuid?.()}/${LABEL}`], { timeoutMs: 5000 });
  return {
    label: LABEL,
    plistPath,
    installed: fs.existsSync(plistPath),
    registered: result.ok,
  };
}

export async function runScheduler(config: ConfigProvider): Promise<void> {
  const state: SchedulerRuntimeState = {
    fired: readSchedulerState(),
    retryAfter: new Map(),
  };
  await safeTick(config, state);
  setInterval(() => void safeTick(config, state), 60_000);
}

async function safeTick(configProvider: ConfigProvider, state: SchedulerRuntimeState): Promise<void> {
  try {
    await tick(configProvider, state);
  } catch (error) {
    console.error(`[scheduler] tick failed: ${error instanceof Error ? error.stack || error.message : String(error)}`);
  }
}

async function tick(configProvider: ConfigProvider, state: SchedulerRuntimeState): Promise<void> {
  const config = readRuntimeConfig(configProvider);
  const now = new Date();
  const time = timeInZone(now, config.user.timezone);
  const date = dateInZone(now, config.user.timezone);
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone: config.user.timezone, weekday: 'short' }).format(now).toUpperCase();

  const schedule: Array<{ workflow: WorkflowName; enabled: boolean; time: string; weekday?: string }> = [
    { workflow: 'daily_plan', ...config.workflows.daily_plan },
    { workflow: 'daily_review', ...config.workflows.daily_review },
    { workflow: 'weekly_review', ...config.workflows.weekly_review },
  ];

  for (const item of schedule) {
    if (!item.enabled || !isWorkflowDue(config, item.workflow, time, item.time)) continue;
    if (item.weekday && item.weekday.slice(0, 3).toUpperCase() !== weekday) continue;
    const key = `${date}:${item.workflow}:${item.time}`;
    if (state.fired.has(key) || isRetryBlocked(state, key, now)) continue;
    if (!claimFired(state, key)) continue;
    try {
      await runWorkflow(config, item.workflow);
      clearRetry(state, key);
    } catch (error) {
      unmarkFired(state, key);
      scheduleRetry(state, key, now);
      console.error(error instanceof Error ? error.stack || error.message : String(error));
    }
  }

  if (config.progress.enabled && isProgressReminderDue(config, time)) {
    const key = `${date}:progress_reminder:${config.progress.no_progress_reminder_time}`;
    if (!state.fired.has(key) && !isRetryBlocked(state, key, now)) {
      if (claimFired(state, key)) {
        try {
          if (!hasConfirmedProgress(config, date)) {
            const result = await collectProgressCandidates(config, date);
            await sendFeishuCard(config, renderProgressConfirmationCard(config, result), progressReminderText(result.candidates));
          }
          clearRetry(state, key);
        } catch (error) {
          unmarkFired(state, key);
          scheduleRetry(state, key, now);
          console.error(error instanceof Error ? error.stack || error.message : String(error));
        }
      }
    }
  }

  if (config.background_suggestions.enabled) {
    try {
      await runBackgroundSuggestions(config, now);
    } catch (error) {
      console.error(`[scheduler] background suggestions failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (config.feedback.feishu.enabled) {
    try {
      const result = await pollFeishuFeedback(config, { workflowRevisionsOnly: true, markIgnored: false });
      if (result.processed > 0) console.log(`[scheduler] processed ${result.processed} Feishu revision reply via polling fallback`);
    } catch (error) {
      console.error(`[scheduler] Feishu feedback polling failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

function readRuntimeConfig(config: ConfigProvider): AppConfig {
  return typeof config === 'function' ? config() : config;
}

function timeInZone(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

function dateInZone(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function isWorkflowDue(config: AppConfig, workflow: WorkflowName, currentTime: string, scheduledTime: string): boolean {
  const current = minutesFromTime(currentTime);
  const scheduled = minutesFromTime(scheduledTime);
  if (current === null || scheduled === null || current < scheduled) return false;
  if (workflow !== 'daily_plan') return true;
  const review = minutesFromTime(config.workflows.daily_review.time);
  return review === null || review <= scheduled || current < review;
}

function isProgressReminderDue(config: AppConfig, currentTime: string): boolean {
  const current = minutesFromTime(currentTime);
  const scheduled = minutesFromTime(config.progress.no_progress_reminder_time);
  if (current === null || scheduled === null || current < scheduled) return false;
  const review = minutesFromTime(config.workflows.daily_review.time);
  return review === null || review <= scheduled || current < review;
}

function minutesFromTime(value: string): number | null {
  const match = value.match(/^(\d{2}):(\d{2})$/);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return hours * 60 + minutes;
}

function readSchedulerState(): Set<string> {
  if (!fs.existsSync(SCHEDULER_STATE_PATH)) return new Set();
  try {
    const parsed = JSON.parse(fs.readFileSync(SCHEDULER_STATE_PATH, 'utf8')) as { fired?: unknown };
    if (!Array.isArray(parsed.fired)) return new Set();
    return new Set(parsed.fired.filter((key): key is string => typeof key === 'string'));
  } catch {
    return new Set();
  }
}

function claimFired(state: SchedulerRuntimeState, key: string): boolean {
  if (state.fired.has(key)) return false;

  const lockPath = acquireSchedulerLock(key);
  if (!lockPath) return false;
  try {
    const fired = readSchedulerState();
    if (fired.has(key)) {
      state.fired = fired;
      return false;
    }
    fired.add(key);
    writeSchedulerState(fired);
    state.fired = fired;
    return true;
  } finally {
    releaseSchedulerLock(lockPath);
  }
}

function unmarkFired(state: SchedulerRuntimeState, key: string): void {
  const lockPath = acquireSchedulerLock(key);
  if (!lockPath) {
    state.fired.delete(key);
    return;
  }
  try {
    const fired = readSchedulerState();
    fired.delete(key);
    writeSchedulerState(fired);
    state.fired = fired;
  } finally {
    releaseSchedulerLock(lockPath);
  }
}

function writeSchedulerState(fired: Set<string>): void {
  const recent = [...fired].filter((item) => isRecentSchedulerKey(item));
  fs.mkdirSync(path.dirname(SCHEDULER_STATE_PATH), { recursive: true });
  fs.writeFileSync(SCHEDULER_STATE_PATH, JSON.stringify({ fired: recent }, null, 2), 'utf8');
}

function acquireSchedulerLock(key: string): string | null {
  fs.mkdirSync(SCHEDULER_LOCK_DIR, { recursive: true });
  const lockPath = path.join(SCHEDULER_LOCK_DIR, `${hashSchedulerKey(key)}.lock`);
  try {
    const fd = fs.openSync(lockPath, 'wx');
    fs.closeSync(fd);
    return lockPath;
  } catch (error) {
    if (isFileExistsError(error)) return null;
    throw error;
  }
}

function releaseSchedulerLock(lockPath: string): void {
  fs.rmSync(lockPath, { force: true });
}

function hashSchedulerKey(key: string): string {
  let hash = 0;
  for (let index = 0; index < key.length; index += 1) {
    hash = (hash * 31 + key.charCodeAt(index)) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function isFileExistsError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && (error as { code?: unknown }).code === 'EEXIST');
}

function isRetryBlocked(state: SchedulerRuntimeState, key: string, now: Date): boolean {
  const retryAt = state.retryAfter.get(key);
  if (!retryAt) return false;
  if (now.getTime() >= retryAt) {
    state.retryAfter.delete(key);
    return false;
  }
  return true;
}

function scheduleRetry(state: SchedulerRuntimeState, key: string, now: Date): void {
  const retryAt = now.getTime() + RETRY_DELAY_MINUTES * 60_000;
  state.retryAfter.set(key, retryAt);
  console.warn(`[scheduler] ${key} failed; will retry after ${new Date(retryAt).toISOString()}`);
}

function clearRetry(state: SchedulerRuntimeState, key: string): void {
  state.retryAfter.delete(key);
}

function isRecentSchedulerKey(key: string): boolean {
  const match = key.match(/^(\d{4}-\d{2}-\d{2}):/);
  if (!match) return true;
  const timestamp = Date.parse(`${match[1]}T00:00:00Z`);
  return Number.isFinite(timestamp) && Date.now() - timestamp < 14 * 24 * 60 * 60 * 1000;
}

function progressReminderText(candidates: ProgressCandidate[]): string {
  if (candidates.length > 0) {
    return [
      '老板，我帮您看了一下，今天还没有确认过的进展记录。',
      '',
      '我发现了几条可能算作今日进展的线索，但这些还不能直接当事实，需要您批示确认：',
      '',
      ...candidates.slice(0, 5).map((candidate, index) => `${index + 1}. ${candidate.title}`),
      '',
      '您可以在飞书里发送：`daily-os progress`，我会把候选项发出来让您确认写入。',
    ].join('\n');
  }

  return [
    '老板，我帮您检查了一下，今天还没有看到已确认的进展记录。',
    '',
    '如果今天已经推进了事情，请您直接回复一句，例如：',
    '`daily-os remember 今天进展：完成了 XXX，下一步是 XXX`',
    '',
    '我会把它作为后续日复盘和周复盘的依据。请您批示。',
  ].join('\n');
}

function launchAgentPath(): string {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
}

function buildPlist(repoRoot: string, scriptPath: string, logsDir: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>WorkingDirectory</key>
  <string>${repoRoot}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${escapeXml(process.env.PATH || '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin')}</string>
  </dict>
  <key>ProgramArguments</key>
  <array>
    <string>${process.execPath}</string>
    <string>${scriptPath}</string>
    <string>start</string>
    <string>--no-open</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${path.join(logsDir, 'launchd.out.log')}</string>
  <key>StandardErrorPath</key>
  <string>${path.join(logsDir, 'launchd.err.log')}</string>
</dict>
</plist>
`;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
