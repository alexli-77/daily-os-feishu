import fs from 'node:fs';
import path from 'node:path';
import type { AppConfig } from '../config/schema.js';
import { runCommand } from '../utils/command.js';

interface RawChromeTab {
  windowIndex: number;
  tabIndex: number;
  active: boolean;
  title: string;
  url: string;
}

export interface ChromeTabSnapshot {
  window_index: number;
  tab_index: number;
  active: boolean;
  title: string;
  url: string;
  host: string;
  matched: boolean;
}

export interface ChromeSnapshotStatus {
  ok: boolean;
  generated_at: string;
  method: string;
  tab_count: number;
  visible_tab_count: number;
  active_tab?: ChromeTabSnapshot;
  allowlist: string[];
  blocklist: string[];
  detail?: string;
  error?: string;
}

export interface ChromeSnapshotCaptureResult {
  status: ChromeSnapshotStatus;
  tabs: ChromeTabSnapshot[];
}

export async function captureChromeSnapshot(config: AppConfig): Promise<ChromeSnapshotCaptureResult> {
  const source = config.sources.chrome_snapshot;
  const generatedAt = new Date().toISOString();
  if (!source.enabled) {
    const result = {
      status: baseStatus(config, generatedAt, {
        ok: false,
        detail: 'chrome_snapshot.enabled=false',
      }),
      tabs: [],
    };
    writeChromeSnapshot(config, result);
    return result;
  }
  if (!source.capture.enabled) {
    const result = {
      status: baseStatus(config, generatedAt, {
        ok: false,
        detail: 'chrome_snapshot.capture.enabled=false',
      }),
      tabs: [],
    };
    writeChromeSnapshot(config, result);
    return result;
  }

  const raw = await runCommand('osascript', ['-l', 'JavaScript', '-e', CHROME_TABS_SCRIPT], {
    timeoutMs: source.capture.timeout_ms,
  });
  if (!raw.ok) {
    const result = {
      status: baseStatus(config, generatedAt, {
        ok: false,
        error: friendlyChromeError(raw.stderr || raw.stdout || `osascript exited with code ${raw.code}`),
      }),
      tabs: [],
    };
    writeChromeSnapshot(config, result);
    return result;
  }

  const parsed = parseRawTabs(raw.stdout);
  const tabs = parsed
    .map((tab) => normalizeTab(config, tab))
    .filter((tab): tab is ChromeTabSnapshot => Boolean(tab))
    .filter((tab) => isAllowedTab(config, tab))
    .slice(0, source.capture.max_tabs);
  const activeTab = tabs.find((tab) => tab.active);
  const result = {
    status: baseStatus(config, generatedAt, {
      ok: true,
      tab_count: parsed.length,
      visible_tab_count: tabs.length,
      ...(activeTab ? { active_tab: activeTab } : {}),
      detail: tabs.length === 0 ? 'Chrome is available, but no tabs matched the configured filters.' : undefined,
    }),
    tabs,
  };
  writeChromeSnapshot(config, result);
  return result;
}

export function writeChromeSnapshot(config: AppConfig, result: ChromeSnapshotCaptureResult): void {
  const source = config.sources.chrome_snapshot;
  writeJson(source.status_path, result.status);
  writeJson(source.tabs_json_path, {
    generated_at: result.status.generated_at,
    tabs: result.tabs,
  });
  writeText(source.tabs_path, formatTabsText(result));
}

function baseStatus(
  config: AppConfig,
  generatedAt: string,
  overrides: Partial<ChromeSnapshotStatus>,
): ChromeSnapshotStatus {
  const source = config.sources.chrome_snapshot;
  return {
    ok: overrides.ok ?? false,
    generated_at: generatedAt,
    method: source.capture.method,
    tab_count: overrides.tab_count ?? 0,
    visible_tab_count: overrides.visible_tab_count ?? 0,
    allowlist: source.capture.allowlist,
    blocklist: source.capture.blocklist,
    ...(overrides.active_tab ? { active_tab: overrides.active_tab } : {}),
    ...(overrides.detail ? { detail: overrides.detail } : {}),
    ...(overrides.error ? { error: overrides.error } : {}),
  };
}

function parseRawTabs(stdout: string): RawChromeTab[] {
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  const parsed = JSON.parse(trimmed) as unknown;
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((item) => (isRawChromeTab(item) ? [item] : []));
}

function isRawChromeTab(value: unknown): value is RawChromeTab {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.windowIndex === 'number' &&
    typeof record.tabIndex === 'number' &&
    typeof record.active === 'boolean' &&
    typeof record.title === 'string' &&
    typeof record.url === 'string'
  );
}

function normalizeTab(config: AppConfig, tab: RawChromeTab): ChromeTabSnapshot | null {
  const url = sanitizeUrl(tab.url, config.sources.chrome_snapshot.capture.include_url_query);
  if (!url) return null;
  const host = safeHost(url);
  return {
    window_index: tab.windowIndex,
    tab_index: tab.tabIndex,
    active: tab.active,
    title: compact(tab.title, 180),
    url,
    host,
    matched: matchesAny(`${host} ${url} ${tab.title}`, config.sources.chrome_snapshot.capture.allowlist),
  };
}

function isAllowedTab(config: AppConfig, tab: ChromeTabSnapshot): boolean {
  const haystack = `${tab.host} ${tab.url} ${tab.title}`;
  const { allowlist, blocklist } = config.sources.chrome_snapshot.capture;
  if (matchesAny(haystack, blocklist)) return false;
  return allowlist.length === 0 || matchesAny(haystack, allowlist);
}

function matchesAny(value: string, patterns: string[]): boolean {
  const normalized = value.toLowerCase();
  return patterns.some((pattern) => {
    const trimmed = pattern.trim().toLowerCase();
    return Boolean(trimmed) && normalized.includes(trimmed);
  });
}

function sanitizeUrl(value: string, includeQuery: boolean): string | null {
  try {
    const parsed = new URL(value);
    parsed.username = '';
    parsed.password = '';
    parsed.hash = '';
    if (!includeQuery) parsed.search = '';
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function safeHost(value: string): string {
  try {
    return new URL(value).host;
  } catch {
    return '';
  }
}

function formatTabsText(result: ChromeSnapshotCaptureResult): string {
  const lines = [
    `generated_at: ${result.status.generated_at}`,
    `status: ${result.status.ok ? 'ok' : 'missing'}`,
    `method: ${result.status.method}`,
    `tabs: ${result.status.visible_tab_count}/${result.status.tab_count}`,
  ];
  if (result.status.detail) lines.push(`detail: ${result.status.detail}`);
  if (result.status.error) lines.push(`error: ${result.status.error}`);
  if (result.tabs.length > 0) {
    lines.push('');
    for (const tab of result.tabs) {
      lines.push(`${tab.active ? '* ' : '- '}${tab.title || '(untitled)'}`);
      lines.push(`  url: ${tab.url}`);
      lines.push(`  host: ${tab.host}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true });
  fs.writeFileSync(path.resolve(filePath), `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function writeText(filePath: string, value: string): void {
  fs.mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true });
  fs.writeFileSync(path.resolve(filePath), value, 'utf8');
}

function compact(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}…` : normalized;
}

function friendlyChromeError(value: string): string {
  const compacted = compact(value, 600);
  if (/not authorized|not allowed|osascript is not allowed|automation/i.test(compacted)) {
    return 'macOS has not granted Automation permission to read Chrome tabs. Open System Settings -> Privacy & Security -> Automation and allow this app/terminal to control Google Chrome.';
  }
  if (/Application isn't running|Can.t get application|not found/i.test(compacted)) {
    return 'Google Chrome is not running or is not installed.';
  }
  return compacted || 'Chrome snapshot capture failed.';
}

const CHROME_TABS_SCRIPT = `
(() => {
  const chrome = Application('Google Chrome');
  if (!chrome.running()) {
    throw new Error('Google Chrome is not running.');
  }
  const output = [];
  const windows = chrome.windows();
  for (let windowIndex = 0; windowIndex < windows.length; windowIndex += 1) {
    const win = windows[windowIndex];
    const activeTab = win.activeTab();
    const tabs = win.tabs();
    for (let tabIndex = 0; tabIndex < tabs.length; tabIndex += 1) {
      const tab = tabs[tabIndex];
      output.push({
        windowIndex: windowIndex + 1,
        tabIndex: tabIndex + 1,
        active: tab.id() === activeTab.id(),
        title: tab.title() || '',
        url: tab.url() || ''
      });
    }
  }
  return JSON.stringify(output);
})();
`;
