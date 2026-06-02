import fs from 'node:fs';
import type { AppConfig } from '../config/schema.js';
import { commandExists } from '../utils/command.js';
import { checkLarkCli } from '../connectors/lark-cli.js';

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

export async function runDoctor(config: AppConfig, configPath = 'config/config.yaml'): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];

  checks.push({ name: configPath, ok: fs.existsSync(configPath) });
  checks.push({ name: 'lark-cli', ...(await toCheck('lark-cli', checkLarkCli())) });

  if (config.llm.provider === 'codex') {
    const codexBin = process.env.CODEX_BIN || 'codex';
    checks.push({ name: `Codex CLI (${codexBin})`, ok: await commandExists(codexBin) });
  } else {
    checks.push({ name: 'OPENAI_API_KEY', ok: Boolean(process.env.OPENAI_API_KEY) });
  }

  if (config.output.feishu.enabled) {
    checks.push({ name: config.output.feishu.chat_id_env, ok: Boolean(process.env[config.output.feishu.chat_id_env]) });
  }

  if (config.sources.vault.enabled) {
    if (config.sources.vault.provider === 'remote') {
      const remote = config.sources.vault.remote;
      checks.push({ name: remote.base_url_env, ok: Boolean(process.env[remote.base_url_env]) });
      checks.push({ name: remote.token_env, ok: Boolean(process.env[remote.token_env]) });
    } else {
      checks.push({ name: 'vault.local_path', ok: fs.existsSync(config.sources.vault.local_path), detail: config.sources.vault.local_path });
    }
  }

  if (config.sources.github.enabled) checks.push({ name: 'GITHUB_TOKEN', ok: Boolean(process.env.GITHUB_TOKEN) });
  if (config.sources.linear.enabled) checks.push({ name: 'LINEAR_API_KEY', ok: Boolean(process.env.LINEAR_API_KEY) });

  return checks;
}

async function toCheck(name: string, checkPromise: Promise<{ state: string; detail?: string }>): Promise<Omit<DoctorCheck, 'name'>> {
  const result = await checkPromise;
  return { ok: result.state === 'available', detail: result.detail };
}

export function formatDoctor(checks: DoctorCheck[]): string {
  return checks
    .map((check) => `${check.ok ? 'OK' : 'MISSING'} ${check.name}${check.detail ? ` - ${check.detail}` : ''}`)
    .join('\n');
}
