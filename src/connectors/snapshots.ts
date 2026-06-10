import type { AppConfig } from '../config/schema.js';
import { captureChromeSnapshot } from './chrome-collector.js';
import { readJsonIfExists, readTextIfExists } from './file.js';
import { sourceFromResult, type EvidenceSource } from '../workflows/types.js';

export async function collectSnapshots(config: AppConfig): Promise<Record<string, EvidenceSource>> {
  const out: Record<string, EvidenceSource> = {};

  if (config.sources.chrome_snapshot.enabled) {
    if (config.sources.chrome_snapshot.capture.enabled && config.sources.chrome_snapshot.capture.refresh_on_collect) {
      await captureChromeSnapshot(config);
    }
    const tabs = readTextIfExists(config.sources.chrome_snapshot.tabs_path);
    const status = readJsonIfExists(config.sources.chrome_snapshot.status_path);
    out.chrome_snapshot = sourceFromResult({
      tabs: tabs.ok ? tabs.content : null,
      status: status.ok ? status.content : null,
      missing: [tabs.ok ? null : tabs.reason, status.ok ? null : status.reason].filter(Boolean),
    });
  } else {
    out.chrome_snapshot = { state: 'disabled' };
  }

  if (config.sources.apple_calendar_snapshot.enabled) {
    const calendar = readJsonIfExists(config.sources.apple_calendar_snapshot.path);
    out.apple_calendar_snapshot = calendar.ok ? sourceFromResult(calendar.content) : { state: 'missing', detail: calendar.reason };
  } else {
    out.apple_calendar_snapshot = { state: 'disabled' };
  }

  if (config.sources.local_files.enabled) {
    const files: Record<string, string | null> = {};
    for (const file of config.sources.local_files.files) {
      const result = readTextIfExists(file.path);
      files[file.name] = result.ok ? result.content : null;
    }
    out.local_files = sourceFromResult(files);
  } else {
    out.local_files = { state: 'disabled' };
  }

  return out;
}
