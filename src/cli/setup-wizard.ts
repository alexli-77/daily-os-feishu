import fs from 'node:fs';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { addUser, findUser, setPassword } from '../ui/auth.js';

/**
 * LEO-235 — first-run onboarding wizard, layered on top of the existing `setup`
 * command. The heavy lifting is a set of pure helpers (below, easy to unit test)
 * plus a thin readline IO layer. When stdin is not a TTY (CI, `npm run setup` in
 * a pipe) the caller falls back to the non-interactive file-seeding behavior, so
 * the wizard never blocks automation.
 *
 * The wizard is idempotent: it reads the current config/.env/admin state and, for
 * anything already configured, offers keep vs overwrite instead of clobbering.
 *
 * The admin password is never written in plaintext — it is salted + scrypt-hashed
 * into the embedded SQLite account store via src/ui/auth.ts (addUser/setPassword).
 */

export type LlmProviderChoice = 'anthropic' | 'openai';

/** The .env variable that carries the BYOK API key for the chosen provider. */
export function apiKeyEnvVar(provider: LlmProviderChoice): 'ANTHROPIC_API_KEY' | 'OPENAI_API_KEY' {
  return provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY';
}

/**
 * Sensible default model per provider.
 * - anthropic: `default` resolves to claude-sonnet-5 in the agent, so keep it symbolic.
 * - openai: the model string is sent verbatim to the API, so a concrete id is required.
 */
export function defaultModelFor(provider: LlmProviderChoice): string {
  return provider === 'anthropic' ? 'default' : 'gpt-4o';
}

/**
 * Rewrite only `llm.provider` and `llm.model` inside the `llm:` block, preserving
 * every other line (and inline comments). Scoped to the block so it never touches
 * the unrelated `provider:` / `model:` keys elsewhere in the config.
 */
export function updateLlmInYaml(yamlText: string, provider: LlmProviderChoice, model: string): string {
  const lines = yamlText.split('\n');
  const start = lines.findIndex((line) => /^llm:\s*$/.test(line));
  if (start === -1) {
    throw new Error('Could not find an `llm:` block in the config file.');
  }
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    // Next top-level key (column 0, non-comment) closes the block.
    if (/^\S/.test(lines[index])) {
      end = index;
      break;
    }
  }
  let sawProvider = false;
  let sawModel = false;
  for (let index = start + 1; index < end; index += 1) {
    const providerMatch = lines[index].match(/^(\s*provider:\s*)(?:"[^"]*"|'[^']*'|\S+)(\s*(?:#.*)?)$/);
    if (providerMatch) {
      lines[index] = `${providerMatch[1]}"${provider}"${providerMatch[2]}`;
      sawProvider = true;
      continue;
    }
    const modelMatch = lines[index].match(/^(\s*model:\s*)(?:"[^"]*"|'[^']*'|\S+)(\s*(?:#.*)?)$/);
    if (modelMatch) {
      lines[index] = `${modelMatch[1]}"${model}"${modelMatch[2]}`;
      sawModel = true;
    }
  }
  if (!sawProvider || !sawModel) {
    throw new Error('The `llm:` block is missing a `provider:` or `model:` key.');
  }
  return lines.join('\n');
}

/** Read `.env`-style key/value pairs, ignoring comments and blank lines. */
export function parseEnv(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const [key, ...rest] = line.split('=');
    values[key.trim()] = rest.join('=').replace(/^"|"$/g, '');
  }
  return values;
}

/**
 * Upsert the given keys into existing `.env` text: rewrite in place when the key
 * already has a line, append otherwise. Untouched lines (including comments) are
 * preserved so the wizard never rewrites the whole file.
 */
export function upsertEnv(text: string, patch: Record<string, string>): string {
  const remaining = new Set(Object.keys(patch));
  const lines = text.split('\n');
  const out = lines.map((rawLine) => {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) return rawLine;
    const key = trimmed.split('=')[0].trim();
    if (!remaining.has(key)) return rawLine;
    remaining.delete(key);
    return `${key}=${patch[key]}`;
  });
  // Drop a single trailing empty line so we can append cleanly, then re-add it.
  while (out.length > 0 && out[out.length - 1] === '') out.pop();
  for (const key of Object.keys(patch)) {
    if (remaining.has(key)) out.push(`${key}=${patch[key]}`);
  }
  return `${out.join('\n')}\n`;
}

export interface FeishuAnswers {
  larkAppId: string;
  larkAppSecret: string;
  feishuChatId: string;
}

/** Only carry non-empty Feishu values into the env patch (blank = keep existing). */
export function buildFeishuEnvPatch(answers: FeishuAnswers): Record<string, string> {
  const patch: Record<string, string> = {};
  if (answers.larkAppId.trim()) patch.LARK_APP_ID = answers.larkAppId.trim();
  if (answers.larkAppSecret.trim()) patch.LARK_APP_SECRET = answers.larkAppSecret.trim();
  if (answers.feishuChatId.trim()) patch.FEISHU_CHAT_ID = answers.feishuChatId.trim();
  return patch;
}

/** Generate a URL-safe random password for the "generate" admin path. */
export function generatePassword(): string {
  return crypto.randomBytes(12).toString('base64url');
}

// --- thin IO layer ----------------------------------------------------------

export function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

interface Prompter {
  ask(question: string): Promise<string>;
  close(): void;
}

function createPrompter(): Prompter {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return {
    ask: (question: string) => new Promise<string>((resolve) => rl.question(question, resolve)),
    close: () => rl.close(),
  };
}

async function askYesNo(prompter: Prompter, question: string, defaultYes: boolean): Promise<boolean> {
  const suffix = defaultYes ? ' [Y/n] ' : ' [y/N] ';
  const answer = (await prompter.ask(`${question}${suffix}`)).trim().toLowerCase();
  if (!answer) return defaultYes;
  return answer === 'y' || answer === 'yes';
}

export interface WizardOptions {
  configPath: string;
  envPath: string;
}

/**
 * Interactive first-run wizard. Assumes the base files already exist (the caller
 * runs the non-interactive seeding first). Returns nothing; all effects are the
 * config/.env writes and the SQLite admin record.
 */
export async function runSetupWizard(options: WizardOptions): Promise<void> {
  const prompter = createPrompter();
  try {
    console.log('');
    console.log('daily-os 首次配置向导 (Ctrl+C 可随时退出，已写入的部分会保留)');
    console.log('');

    await runAdminStep(prompter);
    await runLlmStep(prompter, options);
    await runFeishuStep(prompter, options);

    printNextSteps();
  } finally {
    prompter.close();
  }
}

async function runAdminStep(prompter: Prompter): Promise<void> {
  console.log('1) 管理台 admin 账号');
  const existing = findUser('admin');
  if (existing) {
    const reset = await askYesNo(prompter, '   admin 已存在，是否重置密码？', false);
    if (!reset) {
      console.log('   保留现有 admin 密码。');
      console.log('');
      return;
    }
  }
  const useGenerated = await askYesNo(prompter, '   自动生成一个随机强密码？(否则手动输入)', true);
  let password: string;
  let generated = false;
  if (useGenerated) {
    password = generatePassword();
    generated = true;
  } else {
    password = (await prompter.ask('   输入 admin 密码 (至少 8 位): ')).trim();
    while (password.length < 8) {
      password = (await prompter.ask('   密码太短，至少 8 位，请重新输入: ')).trim();
    }
  }
  if (existing) {
    setPassword('admin', password);
  } else {
    addUser('admin', password, 'admin');
  }
  console.log(`   已保存 admin 密码 (scrypt 加盐哈希存入 SQLite，未落明文)。`);
  if (generated) {
    console.log('   ================================================');
    console.log('   管理台登录: 用户名 admin');
    console.log(`   初始密码:   ${password}`);
    console.log('   请立即记录并在首次登录后修改。');
    console.log('   ================================================');
  }
  console.log('');
}

async function runLlmStep(prompter: Prompter, options: WizardOptions): Promise<void> {
  console.log('2) LLM provider + API key (BYOK)');
  const providerAnswer = (await prompter.ask('   选择 provider [anthropic/openai] (默认 anthropic): '))
    .trim()
    .toLowerCase();
  const provider: LlmProviderChoice = providerAnswer === 'openai' ? 'openai' : 'anthropic';
  const envKey = apiKeyEnvVar(provider);

  const envText = fs.existsSync(options.envPath) ? fs.readFileSync(options.envPath, 'utf8') : '';
  const currentEnv = parseEnv(envText);
  const hasKey = Boolean(currentEnv[envKey]);

  let keyPatch: Record<string, string> = {};
  if (hasKey) {
    const replace = await askYesNo(prompter, `   ${envKey} 已配置，是否覆盖？`, false);
    if (replace) {
      const key = (await prompter.ask(`   粘贴新的 ${envKey}: `)).trim();
      if (key) keyPatch[envKey] = key;
    }
  } else {
    const key = (await prompter.ask(`   粘贴 ${envKey} (回车跳过，可稍后填入 .env): `)).trim();
    if (key) keyPatch[envKey] = key;
  }

  const defaultModel = defaultModelFor(provider);
  const modelAnswer = (await prompter.ask(`   模型 (回车用默认 ${defaultModel}): `)).trim();
  const model = modelAnswer || defaultModel;

  const configText = fs.readFileSync(options.configPath, 'utf8');
  fs.writeFileSync(options.configPath, updateLlmInYaml(configText, provider, model), 'utf8');

  if (Object.keys(keyPatch).length > 0) {
    fs.writeFileSync(options.envPath, upsertEnv(envText, keyPatch), 'utf8');
    try {
      fs.chmodSync(options.envPath, 0o600);
    } catch {
      // best-effort owner-only
    }
    console.log(`   已写入 llm.provider=${provider}, llm.model=${model}, ${envKey} 已保存到 .env。`);
  } else {
    console.log(`   已写入 llm.provider=${provider}, llm.model=${model}。`);
    if (!hasKey) console.log(`   ⚠ 未填写 ${envKey}；程序化调度前请在 .env 补上，否则每次 workflow 会失败。`);
  }
  console.log('');
}

async function runFeishuStep(prompter: Prompter, options: WizardOptions): Promise<void> {
  console.log('3) 飞书配置 (可选，跳过后控制台 + web chat 仍可用)');
  const configure = await askYesNo(prompter, '   现在配置飞书凭据？', false);
  if (!configure) {
    console.log('   已跳过飞书。控制台 (http://127.0.0.1:14573) 和 web chat 不受影响。');
    console.log('');
    return;
  }
  const larkAppId = await prompter.ask('   LARK_APP_ID (cli_/app id): ');
  const larkAppSecret = await prompter.ask('   LARK_APP_SECRET: ');
  const feishuChatId = await prompter.ask('   FEISHU_CHAT_ID (oc_...，回车跳过): ');
  const patch = buildFeishuEnvPatch({ larkAppId, larkAppSecret, feishuChatId });
  if (Object.keys(patch).length === 0) {
    console.log('   未输入任何飞书值，跳过。');
    console.log('');
    return;
  }
  const envText = fs.existsSync(options.envPath) ? fs.readFileSync(options.envPath, 'utf8') : '';
  fs.writeFileSync(options.envPath, upsertEnv(envText, patch), 'utf8');
  try {
    fs.chmodSync(options.envPath, 0o600);
  } catch {
    // best-effort owner-only
  }
  console.log(`   已保存飞书凭据到 .env: ${Object.keys(patch).join(', ')}。`);
  console.log('');
}

function printNextSteps(): void {
  const uiHost = process.env.DAILY_OS_UI_HOST || '127.0.0.1';
  const uiPort = process.env.DAILY_OS_UI_PORT || '14573';
  console.log('配置完成。下一步：');
  console.log('  - 启动全部本地功能:   npm run start');
  console.log('  - 或仅启动控制台:     npm run ui');
  console.log('  - Docker / Linux:     docker compose up -d --build');
  console.log(`  - 控制台地址:         http://${uiHost === '0.0.0.0' ? '127.0.0.1' : uiHost}:${uiPort}`);
  console.log('  - 用 admin 账号登录，进入 web chat 即可对话。');
  console.log('');
}
