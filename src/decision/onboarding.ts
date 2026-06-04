import fs from 'node:fs';
import path from 'node:path';
import type { LarkChannel } from '@larksuiteoapi/node-sdk';
import type { AppConfig } from '../config/schema.js';
import { runCommand } from '../utils/command.js';
import { decisionCalibrationPrompt, ensureDecisionPolicyFiles } from './policy.js';

export interface DecisionOnboardingResult {
  chatId: string;
  chatName: string;
  created: boolean;
  ownerOpenId: string;
  welcomeText: string;
}

export async function startDecisionOnboarding(
  config: AppConfig,
  options: { envPath?: string; channel?: LarkChannel } = {},
): Promise<DecisionOnboardingResult> {
  if (!config.decision.enabled || !config.decision.onboarding.enabled) {
    throw new Error('decision.onboarding.enabled is false.');
  }

  ensureDecisionPolicyFiles(config);

  const chatEnv = config.decision.onboarding.chat_id_env;
  const existingChatId = process.env[chatEnv]?.trim() || readOnboardingState(config).chatId;
  const ownerOpenId = await resolveOwnerOpenId(config);
  const chatName = config.decision.onboarding.chat_name;
  const welcomeText = onboardingWelcomeText(config);

  if (existingChatId) {
    process.env[chatEnv] = existingChatId;
    if (options.envPath) writeEnvValue(options.envPath, chatEnv, existingChatId);
    await sendWelcomeMessage(existingChatId, welcomeText, options.channel);
    return { chatId: existingChatId, chatName, created: false, ownerOpenId, welcomeText };
  }

  const chatId = options.channel
    ? await createDecisionChatWithChannel(options.channel, chatName, ownerOpenId)
    : await createDecisionChatWithLarkCli(chatName, ownerOpenId);

  process.env[chatEnv] = chatId;
  writeOnboardingState(config, { chatId, chatName, ownerOpenId, createdAt: new Date().toISOString() });
  if (options.envPath) writeEnvValue(options.envPath, chatEnv, chatId);

  await sendWelcomeMessage(chatId, welcomeText, options.channel);
  return { chatId, chatName, created: true, ownerOpenId, welcomeText };
}

function readOnboardingState(config: AppConfig): { chatId?: string } {
  const statePath = path.resolve(config.decision.onboarding.state_path);
  if (!fs.existsSync(statePath)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const chatId = (parsed as { chatId?: unknown }).chatId;
    return typeof chatId === 'string' && chatId.trim() ? { chatId: chatId.trim() } : {};
  } catch {
    return {};
  }
}

function writeOnboardingState(
  config: AppConfig,
  state: { chatId: string; chatName: string; ownerOpenId: string; createdAt: string },
): void {
  const statePath = path.resolve(config.decision.onboarding.state_path);
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

export function onboardingWelcomeText(config: AppConfig): string {
  return [
    `# ${config.decision.onboarding.chat_name}`,
    '',
    decisionCalibrationPrompt(config),
    '',
    '建议回复：',
    '',
    '> 我们开始吧。先问我第一个校准问题。',
  ].join('\n');
}

async function createDecisionChatWithChannel(channel: LarkChannel, name: string, ownerOpenId: string): Promise<string> {
  const result = await channel.rawClient.im.v1.chat.create({
    data: {
      name,
      description: 'Daily OS 决策校准群',
      chat_mode: 'group',
      chat_type: 'private',
      user_id_list: [ownerOpenId],
    },
    params: {
      user_id_type: 'open_id',
    },
  });
  const chatId = findStringKey(result, 'chat_id');
  if (!chatId) throw new Error(`chat.create returned no chat_id: ${JSON.stringify(result).slice(0, 300)}`);
  return chatId;
}

async function createDecisionChatWithLarkCli(name: string, ownerOpenId: string): Promise<string> {
  const result = await runCommand(
    'lark-cli',
    [
      'im',
      '+chat-create',
      '--name',
      name,
      '--description',
      'Daily OS 决策校准群',
      '--chat-mode',
      'group',
      '--type',
      'private',
      '--users',
      ownerOpenId,
      '--set-bot-manager',
      '--format',
      'json',
      '--as',
      'bot',
    ],
    { timeoutMs: 30000 },
  );
  if (!result.ok) {
    throw new Error(
      [
        'Failed to create Feishu decision calibration chat.',
        '请确认 lark-cli bot 身份已登录，并且飞书应用已开通 im:chat 权限。',
        (result.stderr || result.stdout).slice(0, 1000),
      ].join('\n'),
    );
  }
  const parsed = parseJson(result.stdout);
  const chatId = findStringKey(parsed, 'chat_id');
  if (!chatId) throw new Error(`lark-cli chat-create returned no chat_id: ${result.stdout.slice(0, 500)}`);
  return chatId;
}

async function sendWelcomeMessage(chatId: string, welcomeText: string, channel?: LarkChannel): Promise<void> {
  if (channel) {
    await channel.send(chatId, { markdown: welcomeText });
    return;
  }

  const result = await runCommand(
    'lark-cli',
    ['im', '+messages-send', '--chat-id', chatId, '--markdown', welcomeText, '--as', 'bot'],
    { timeoutMs: 30000 },
  );
  if (!result.ok) {
    throw new Error(`决策校准群已准备好，但发送欢迎消息失败：${(result.stderr || result.stdout).slice(0, 1000)}`);
  }
}

async function resolveOwnerOpenId(config: AppConfig): Promise<string> {
  const envKey = config.decision.onboarding.owner_open_id_env || config.interaction.feishu.security.owner_open_id_env;
  const configured = process.env[envKey]?.trim();
  if (configured) return configured;

  const result = await runCommand('lark-cli', ['auth', 'status'], { timeoutMs: 10000 });
  const parsed = parseJson(result.stdout || result.stderr);
  const openId = findStringKey(parsed?.identities, 'openId') || findStringKey(parsed?.identities, 'open_id');
  if (openId) return openId;

  throw new Error(`需要 owner open_id。请设置 ${envKey}，或运行 lark-cli auth login 后在 UI 中执行 Auto configure from lark-cli。`);
}

function writeEnvValue(envPath: string, key: string, value: string): void {
  const absolute = path.resolve(envPath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  const lines = fs.existsSync(absolute) ? fs.readFileSync(absolute, 'utf8').split('\n') : [];
  let updated = false;
  const next = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) return line;
    const [currentKey] = trimmed.split('=');
    if (currentKey !== key) return line;
    updated = true;
    return `${key}=${quoteEnv(value)}`;
  });
  if (!updated) next.push(`${key}=${quoteEnv(value)}`);
  fs.writeFileSync(absolute, `${next.filter((line, index) => index < next.length - 1 || line.length > 0).join('\n')}\n`, 'utf8');
}

function quoteEnv(value: string): string {
  if (/^[A-Za-z0-9_./:@-]+$/.test(value)) return value;
  return JSON.stringify(value);
}

function parseJson(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function findStringKey(value: unknown, key: string): string {
  if (!value || typeof value !== 'object') return '';
  if (Array.isArray(value)) return value.map((item) => findStringKey(item, key)).find(Boolean) || '';
  const record = value as Record<string, unknown>;
  const direct = record[key];
  if (typeof direct === 'string' && direct.trim()) return direct.trim();
  for (const nested of Object.values(record)) {
    const found = findStringKey(nested, key);
    if (found) return found;
  }
  return '';
}
