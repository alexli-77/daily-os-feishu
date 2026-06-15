import type { AppConfig } from '../config/schema.js';
import { collectFeishu } from '../connectors/lark-cli.js';
import { collectGitHub } from '../connectors/github.js';
import { collectLinear } from '../connectors/linear.js';
import { collectSnapshots } from '../connectors/snapshots.js';
import { collectVault } from '../connectors/vault-gate.js';
import { readProgressLedger } from '../progress/capture.js';
import type { Evidence, EvidenceSource } from './types.js';
import { extractWeeklyPrioritiesFromFeishuDocs } from './weekly-priorities.js';

export async function collectEvidence(config: AppConfig, date: string): Promise<Evidence> {
  const [vault, snapshots, feishu, github, linear] = await Promise.all([
    collectVault(config, date),
    collectSnapshots(config),
    collectFeishu(config, date),
    collectGitHub(config),
    collectLinear(config),
  ]);
  const sources: Record<string, EvidenceSource> = {
    ...vault,
    ...snapshots,
    ...feishu,
    github,
    linear,
    progress_ledger: config.progress.enabled
      ? {
          state: readProgressLedger(config, date).trim() ? 'available' : 'empty',
          data: readProgressLedger(config, date),
        }
      : { state: 'disabled' },
  };

  return {
    generated_at: new Date().toISOString(),
    date,
    sources: {
      ...sources,
      weekly_priorities: extractWeeklyPrioritiesFromFeishuDocs(sources.feishu_docs, date),
    },
  };
}
