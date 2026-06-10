import type { AppConfig } from '../config/schema.js';
import { captureChromeSnapshot } from '../connectors/chrome-collector.js';

export interface ChromeSnapshotServiceControls {
  stop: () => Promise<void>;
}

export function startChromeSnapshotService(config: AppConfig): ChromeSnapshotServiceControls {
  const source = config.sources.chrome_snapshot;
  if (!source.enabled || !source.capture.enabled) {
    return { stop: async () => undefined };
  }

  let running = false;
  const capture = async (reason: string): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const result = await captureChromeSnapshot(config);
      const detail = result.status.ok ? `${result.status.visible_tab_count}/${result.status.tab_count} tabs` : result.status.error || result.status.detail;
      console.log(`[chrome] snapshot ${reason}: ${detail}`);
    } catch (error) {
      console.warn(`[chrome] snapshot ${reason} failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      running = false;
    }
  };

  void capture('startup');
  const intervalMs = Math.max(1, source.capture.background_interval_minutes) * 60_000;
  const timer = setInterval(() => void capture('background'), intervalMs);
  return {
    stop: async () => {
      clearInterval(timer);
    },
  };
}
