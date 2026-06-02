import type { AppConfig } from '../config/schema.js';
import { collectFeishu } from '../connectors/lark-cli.js';
import { collectGitHub } from '../connectors/github.js';
import { collectLinear } from '../connectors/linear.js';
import { collectSnapshots } from '../connectors/snapshots.js';
import { collectVault } from '../connectors/vault-gate.js';
import type { Evidence } from './types.js';

export async function collectEvidence(config: AppConfig, date: string): Promise<Evidence> {
  const [vault, snapshots, feishu, github, linear] = await Promise.all([
    collectVault(config),
    collectSnapshots(config),
    collectFeishu(config, date),
    collectGitHub(config.sources.github.enabled),
    collectLinear(config),
  ]);

  return {
    generated_at: new Date().toISOString(),
    date,
    sources: {
      ...vault,
      ...snapshots,
      ...feishu,
      github,
      linear,
    },
  };
}
