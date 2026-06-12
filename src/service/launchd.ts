import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AppConfig, WorkflowName } from '../config/schema.js';
import { runCommand } from '../utils/command.js';
import { runWorkflow } from '../workflows/run-workflow.js';
import { collectProgressCandidates, hasConfirmedProgress, type ProgressCandidate } from '../progress/capture.js';
import { renderProgressConfirmationCard } from '../progress/card.js';
import { sendFeishuCard } from '../connectors/lark-cli.js';

const LABEL = 'com.daily-os-feishu.agent';
const SCHEDULER_STATE_PATH = './data/memory/scheduler-state.json';
const CATCH_UP_WINDOW_MINUTES = 180;

export interface LaunchAgentStatus {
  label: string;
  plistPath: string;
  installed: boolean;
  registered: boolean;
}

type ConfigProvider = AppConfig | (() => AppConfig);

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
  const fired = readSchedulerState();
  await safeTick(config, fired);
  setInterval(() => void safeTick(config, fired), 60_000);
}

async function safeTick(configProvider: ConfigProvider, fired: Set<string>): Promise<void> {
  try {
    await tick(configProvider, fired);
  } catch (error) {
    console.error(`[scheduler] tick failed: ${error instanceof Error ? error.stack || error.message : String(error)}`);
  }
}

async function tick(configProvider: ConfigProvider, fired: Set<string>): Promise<void> {
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
    if (!item.enabled || !isDue(time, item.time)) continue;
    if (item.weekday && item.weekday.slice(0, 3).toUpperCase() !== weekday) continue;
    const key = `${date}:${item.workflow}:${item.time}`;
    if (fired.has(key)) continue;
    markFired(fired, key);
    try {
      await runWorkflow(config, item.workflow);
    } catch (error) {
      console.error(error instanceof Error ? error.stack || error.message : String(error));
    }
  }

  if (config.progress.enabled && isDue(time, config.progress.no_progress_reminder_time)) {
    const key = `${date}:progress_reminder:${config.progress.no_progress_reminder_time}`;
    if (!fired.has(key)) {
      markFired(fired, key);
      try {
        if (!hasConfirmedProgress(config, date)) {
          const result = await collectProgressCandidates(config, date);
          await sendFeishuCard(config, renderProgressConfirmationCard(config, result), progressReminderText(result.candidates));
        }
      } catch (error) {
        console.error(error instanceof Error ? error.stack || error.message : String(error));
      }
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

function isDue(currentTime: string, scheduledTime: string): boolean {
  const current = minutesFromTime(currentTime);
  const scheduled = minutesFromTime(scheduledTime);
  if (current === null || scheduled === null) return false;
  const diff = current - scheduled;
  return diff >= 0 && diff <= CATCH_UP_WINDOW_MINUTES;
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

function markFired(fired: Set<string>, key: string): void {
  fired.add(key);
  const recent = [...fired].filter((item) => isRecentSchedulerKey(item));
  fs.mkdirSync(path.dirname(SCHEDULER_STATE_PATH), { recursive: true });
  fs.writeFileSync(SCHEDULER_STATE_PATH, JSON.stringify({ fired: recent }, null, 2), 'utf8');
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
