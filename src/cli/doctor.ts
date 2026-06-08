import fs from 'node:fs';
import type { AppConfig } from '../config/schema.js';
import { commandExists, runCommand } from '../utils/command.js';
import { checkLarkCli } from '../connectors/lark-cli.js';
import { feishuSdkStatus } from '../connectors/feishu-sdk.js';
import { defaultMemoryRepositoryPath, resolveMemoryRepositoryPath } from '../storage/memory.js';
import { feishuSafetyWarnings, hasAnyAccessRule, summarizeFeishuAccess } from '../interaction/access-policy.js';
import { decisionPolicyFiles } from '../decision/policy.js';
import { feishuSessionCatalogPath } from '../interaction/session-catalog.js';

export interface DoctorCheck {
  name: string;
  ok: boolean;
  level?: 'ok' | 'warning' | 'missing';
  detail?: string;
}

export async function runDoctor(config: AppConfig, configPath = 'config/config.yaml'): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];

  checks.push({ name: configPath, ok: fs.existsSync(configPath) });
  const needsLarkCli = usesLarkCliFeishu(config);
  if (needsLarkCli) {
    checks.push({ name: 'lark-cli', ...(await toCheck('lark-cli', checkLarkCli())) });
  } else {
    checks.push({
      name: 'lark-cli',
      ok: true,
      level: 'warning',
      detail: 'not required for the currently enabled Feishu SDK-only features',
    });
  }

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

  if (needsLarkCli) {
    checks.push(await larkCliAuthCheck());
  }

  if (config.interaction.feishu.enabled) {
    checks.push({ name: 'LARK_APP_ID', ok: Boolean(process.env.LARK_APP_ID), detail: 'required only for Feishu websocket interaction' });
    checks.push({ name: 'LARK_APP_SECRET', ok: Boolean(process.env.LARK_APP_SECRET), detail: 'required only for Feishu websocket interaction' });
  }

  if (config.interaction.feishu.enabled) {
    checks.push({
      name: 'Feishu interaction layer',
      ok: true,
      detail: `prefix=${config.interaction.feishu.command_prefix}, debounce=${config.interaction.feishu.debounce_ms}ms`,
    });
    checks.push({
      name: 'Feishu session catalog',
      ok: true,
      detail: feishuSessionCatalogPath(config),
    });
    checks.push(
      hasAnyAccessRule(config)
        ? {
            name: 'Feishu interaction access policy',
            ok: true,
            level: config.interaction.feishu.security.access_level === 'full' ? 'warning' : 'ok',
            detail:
              config.interaction.feishu.security.access_level === 'full'
                ? `${summarizeFeishuAccess(config)}; full access should only be used for trusted private deployments`
                : summarizeFeishuAccess(config),
          }
        : {
            name: 'Feishu interaction access policy',
            ok: false,
            level: 'missing',
            detail: `configure ${config.interaction.feishu.security.owner_open_id_env}, allowed_user_open_ids, or allowed_chat_ids before remote control will process messages`,
          },
    );
    for (const warning of feishuSafetyWarnings(config)) {
      checks.push({
        name: 'Feishu interaction safety',
        ok: true,
        level: 'warning',
        detail: warning,
      });
    }
  }

  if (config.output.feishu.enabled) {
    checks.push({ name: config.output.feishu.chat_id_env, ok: Boolean(process.env[config.output.feishu.chat_id_env]) });
    if (config.output.feishu.provider === 'sdk' || config.output.feishu.provider === 'auto') {
      const status = feishuSdkStatus();
      checks.push({
        name: 'Feishu SDK output',
        ok: status.ok || config.output.feishu.provider === 'auto',
        level: status.ok ? 'ok' : config.output.feishu.provider === 'auto' ? 'warning' : 'missing',
        detail: status.ok ? 'will send through official Feishu SDK' : `${status.detail}; ${config.output.feishu.provider === 'auto' ? 'will fall back to lark-cli' : 'required by output.feishu.provider=sdk'}`,
      });
    }
  }

  const memoryRepositoryPath = resolveMemoryRepositoryPath(config);
  checks.push({
    name: config.memory.repository_path.trim() ? 'memory.repository_path' : 'memory.repository_path (default)',
    ok: fs.existsSync(memoryRepositoryPath),
    detail: config.memory.repository_path.trim()
      ? memoryRepositoryPath
      : `使用内置模板：${defaultMemoryRepositoryPath()}`,
  });

  if (config.decision.enabled) {
    const policy = decisionPolicyFiles(config);
    checks.push({
      name: 'decision policy files',
      ok: fs.existsSync(policy.policyPath) && fs.existsSync(policy.notesPath),
      level: fs.existsSync(policy.policyPath) && fs.existsSync(policy.notesPath) ? 'ok' : 'warning',
      detail: `policy=${policy.policyPath}, notes=${policy.notesPath}`,
    });
    if (config.decision.onboarding.enabled) {
      const statePath = config.decision.onboarding.state_path;
      const hasDecisionChat = Boolean(process.env[config.decision.onboarding.chat_id_env]) || fs.existsSync(statePath);
      checks.push({
        name: config.decision.onboarding.chat_id_env,
        ok: hasDecisionChat,
        level: hasDecisionChat ? 'ok' : 'warning',
        detail: '开始决策校准前不是必填项',
      });
      if (!hasDecisionChat && !feishuSdkStatus().ok) {
        checks.push({
          name: 'decision onboarding transport',
          ok: true,
          level: 'warning',
          detail: 'configure LARK_APP_ID/LARK_APP_SECRET for SDK group creation, or keep lark-cli available for the fallback path',
        });
      }
    }
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

function usesLarkCliFeishu(config: AppConfig): boolean {
  const outputNeedsLarkCli = config.output.feishu.enabled && config.output.feishu.provider !== 'sdk' && !feishuSdkStatus().ok;
  return Boolean(outputNeedsLarkCli || config.feedback.feishu.enabled || config.sources.feishu.enabled);
}

async function larkCliAuthCheck(): Promise<DoctorCheck> {
  const result = await runCommand('lark-cli', ['auth', 'status'], { timeoutMs: 10000 });
  if (!result.ok) {
    return {
      name: 'lark-cli auth',
      ok: false,
      detail: `Run \`lark-cli config init\` and \`lark-cli auth login\`, then rerun checks. ${(result.stderr || result.stdout).slice(0, 500)}`.trim(),
    };
  }
  const text = result.stdout || result.stderr;
  const hasUser = /"user"\s*:\s*\{[\s\S]*?"available"\s*:\s*true/.test(text);
  const hasBot = /"bot"\s*:\s*\{[\s\S]*?"available"\s*:\s*true/.test(text);
  return {
    name: 'lark-cli auth',
    ok: hasUser || hasBot,
    detail: hasUser || hasBot ? `已登录身份：${[hasUser ? 'user' : '', hasBot ? 'bot' : ''].filter(Boolean).join(', ')}` : '没有可用的 user 或 bot 身份',
  };
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
