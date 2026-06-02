import fs from 'node:fs';
import type { AppConfig } from '../config/schema.js';
import { commandExists, runCommand } from '../utils/command.js';
import { checkLarkCli } from '../connectors/lark-cli.js';

export interface DoctorCheck {
  name: string;
  ok: boolean;
  level?: 'ok' | 'warning' | 'missing';
  detail?: string;
}

export async function runDoctor(config: AppConfig, configPath = 'config/config.yaml'): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];

  checks.push({ name: configPath, ok: fs.existsSync(configPath) });
  checks.push({ name: 'lark-cli', ...(await toCheck('lark-cli', checkLarkCli())) });

  if (config.llm.provider === 'codex') {
    const codexBin = process.env.CODEX_BIN || 'codex';
    const codexEnv = codexProcessEnv();
    const exists = await commandExists(codexBin, codexEnv);
    checks.push({
      name: `Codex CLI (${codexBin})`,
      ok: exists,
      detail: exists ? codexHomeDetail() : 'Set CODEX_BIN to the Codex CLI path, or install Codex CLI and make it available in PATH.',
    });
    if (exists) checks.push(await codexLoginCheck(codexBin, codexEnv));
  } else {
    checks.push({ name: 'OPENAI_API_KEY', ok: Boolean(process.env.OPENAI_API_KEY) });
  }

  if (usesFeishu(config)) {
    checks.push({ name: 'LARK_APP_ID', ok: Boolean(process.env.LARK_APP_ID), detail: 'Feishu Developer Platform App ID' });
    checks.push({ name: 'LARK_APP_SECRET', ok: Boolean(process.env.LARK_APP_SECRET), detail: 'Feishu Developer Platform App Secret' });
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

  if (config.sources.feishu.enabled) {
    const profiles = config.sources.feishu.profiles;
    if (profiles.length > 0) {
      for (const profile of profiles) {
        if (profile.enabled && profile.im_history.enabled) {
          checks.push({
            name: `${profile.id}.im_history.${profile.im_history.chat_id_env}`,
            ok: Boolean(process.env[profile.im_history.chat_id_env]),
          });
        }
      }
    } else if (config.sources.feishu.im_history.enabled) {
      checks.push({
        name: `feishu.im_history.${config.sources.feishu.im_history.chat_id_env}`,
        ok: Boolean(process.env[config.sources.feishu.im_history.chat_id_env]),
      });
    }
  }

  if (config.sources.github.enabled) checks.push({ name: 'GITHUB_TOKEN', ok: Boolean(process.env.GITHUB_TOKEN) });
  if (config.sources.linear.enabled) {
    checks.push(
      process.env.LINEAR_API_KEY
        ? { name: 'LINEAR_API_KEY', ok: true, level: 'ok' }
        : {
            name: 'LINEAR_API_KEY',
            ok: true,
            level: 'warning',
            detail: 'not configured; Codex Linear fallback will be used',
          },
    );
  }

  return checks;
}

function codexProcessEnv(): NodeJS.ProcessEnv {
  return { ...process.env };
}

function codexHomeDetail(): string {
  return process.env.CODEX_HOME ? `CODEX_HOME=${process.env.CODEX_HOME}` : 'using default Codex home';
}

async function codexLoginCheck(codexBin: string, env: NodeJS.ProcessEnv): Promise<DoctorCheck> {
  const result = await runCommand(codexBin, ['login', 'status'], { timeoutMs: 10000, env });
  if (result.ok) {
    return {
      name: 'Codex login',
      ok: true,
      detail: (result.stdout || result.stderr).trim() || 'authenticated',
    };
  }
  return {
    name: 'Codex login',
    ok: false,
    detail: `Run \`${codexBin} login\` in Terminal, then rerun checks. ${(result.stderr || result.stdout).trim()}`.trim(),
  };
}

function usesFeishu(config: AppConfig): boolean {
  return Boolean(config.output.feishu.enabled || config.feedback.feishu.enabled || config.sources.feishu.enabled);
}

async function toCheck(name: string, checkPromise: Promise<{ state: string; detail?: string }>): Promise<Omit<DoctorCheck, 'name'>> {
  const result = await checkPromise;
  return { ok: result.state === 'available', detail: result.detail };
}

export function formatDoctor(checks: DoctorCheck[]): string {
  return checks
    .map((check) => `${formatCheckLevel(check)} ${check.name}${check.detail ? ` - ${check.detail}` : ''}`)
    .join('\n');
}

function formatCheckLevel(check: DoctorCheck): string {
  if (check.level === 'warning') return 'WARNING';
  return check.ok ? 'OK' : 'MISSING';
}
