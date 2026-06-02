import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AppConfig, WorkflowName } from '../config/schema.js';
import { runCommand } from '../utils/command.js';
import { runWorkflow } from '../workflows/run-workflow.js';

const LABEL = 'com.daily-os-feishu.agent';

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

export async function runScheduler(config: AppConfig): Promise<void> {
  const fired = new Set<string>();
  await tick(config, fired);
  setInterval(() => void tick(config, fired), 60_000);
}

async function tick(config: AppConfig, fired: Set<string>): Promise<void> {
  const now = new Date();
  const time = new Intl.DateTimeFormat('en-CA', {
    timeZone: config.user.timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(now);
  const date = new Intl.DateTimeFormat('en-CA', {
    timeZone: config.user.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone: config.user.timezone, weekday: 'short' }).format(now).toUpperCase();

  const schedule: Array<{ workflow: WorkflowName; enabled: boolean; time: string; weekday?: string }> = [
    { workflow: 'daily_plan', ...config.workflows.daily_plan },
    { workflow: 'daily_review', ...config.workflows.daily_review },
    { workflow: 'weekly_review', ...config.workflows.weekly_review },
  ];

  for (const item of schedule) {
    if (!item.enabled || item.time !== time) continue;
    if (item.weekday && item.weekday.slice(0, 3).toUpperCase() !== weekday) continue;
    const key = `${date}:${item.workflow}:${item.time}`;
    if (fired.has(key)) continue;
    fired.add(key);
    try {
      await runWorkflow(config, item.workflow);
    } catch (error) {
      console.error(error instanceof Error ? error.stack || error.message : String(error));
    }
  }
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
  <key>ProgramArguments</key>
  <array>
    <string>${process.execPath}</string>
    <string>${scriptPath}</string>
    <string>service</string>
    <string>run</string>
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
