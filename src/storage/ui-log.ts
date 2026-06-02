import fs from 'node:fs';
import path from 'node:path';

const LOG_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_DETAIL_LENGTH = 500;
const UI_LOG_PATH = path.resolve('data/logs/ui-network.jsonl');

export type UiLogLevel = 'info' | 'warning' | 'error';
export type UiLogStatus = 'started' | 'success' | 'error' | 'ok';

export interface UiLogEntry {
  timestamp: string;
  level: UiLogLevel;
  event: 'network' | 'action';
  status: UiLogStatus;
  method?: string;
  path?: string;
  action?: string;
  status_code?: number;
  duration_ms?: number;
  detail?: string;
}

export function appendUiLog(entry: Omit<UiLogEntry, 'timestamp'> & { timestamp?: string }): void {
  ensureLogDir();
  pruneUiLogs();
  const next: UiLogEntry = {
    timestamp: entry.timestamp || new Date().toISOString(),
    ...entry,
    detail: entry.detail ? sanitizeLogText(entry.detail) : undefined,
  };
  fs.appendFileSync(UI_LOG_PATH, `${JSON.stringify(next)}\n`, 'utf8');
}

export function readUiLogs(limit = 200): UiLogEntry[] {
  ensureLogDir();
  pruneUiLogs();
  if (!fs.existsSync(UI_LOG_PATH)) return [];
  return fs
    .readFileSync(UI_LOG_PATH, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map(parseLogLine)
    .filter((entry): entry is UiLogEntry => Boolean(entry))
    .slice(-limit)
    .reverse();
}

export function clearUiLogs(): void {
  ensureLogDir();
  fs.writeFileSync(UI_LOG_PATH, '', 'utf8');
}

function pruneUiLogs(): void {
  if (!fs.existsSync(UI_LOG_PATH)) return;
  const cutoff = Date.now() - LOG_RETENTION_MS;
  const kept = fs
    .readFileSync(UI_LOG_PATH, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map(parseLogLine)
    .filter((entry): entry is UiLogEntry => Boolean(entry))
    .filter((entry) => Date.parse(entry.timestamp) >= cutoff);
  fs.writeFileSync(UI_LOG_PATH, kept.map((entry) => JSON.stringify(entry)).join('\n') + (kept.length ? '\n' : ''), 'utf8');
}

function parseLogLine(line: string): UiLogEntry | null {
  try {
    const parsed = JSON.parse(line) as Partial<UiLogEntry>;
    if (!parsed.timestamp || !parsed.event || !parsed.status || !parsed.level) return null;
    return parsed as UiLogEntry;
  } catch {
    return null;
  }
}

function sanitizeLogText(text: string): string {
  return text
    .replace(/(OPENAI_API_KEY|GITHUB_TOKEN|LINEAR_API_KEY|VAULT_GATE_TOKEN|LARK_APP_SECRET)=\S+/g, '$1=[redacted]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, 'Bearer [redacted]')
    .replace(/gh[pousr]_[A-Za-z0-9_]+/g, '[redacted-github-token]')
    .replace(/lin_api_[A-Za-z0-9_-]+/g, '[redacted-linear-token]')
    .replace(/sk-[A-Za-z0-9_-]+/g, '[redacted-openai-token]')
    .slice(0, MAX_DETAIL_LENGTH);
}

function ensureLogDir(): void {
  fs.mkdirSync(path.dirname(UI_LOG_PATH), { recursive: true });
}
