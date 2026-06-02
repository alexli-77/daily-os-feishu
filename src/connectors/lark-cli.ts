import type { AppConfig } from '../config/schema.js';
import { addDays } from '../utils/date.js';
import { commandExists, runCommand } from '../utils/command.js';
import type { EvidenceSource } from '../workflows/types.js';
import { sourceFromResult } from '../workflows/types.js';

export async function checkLarkCli(): Promise<EvidenceSource> {
  if (!(await commandExists('lark-cli'))) return { state: 'missing', detail: 'lark-cli is not installed or not in PATH' };
  const result = await runCommand('lark-cli', ['--help'], { timeoutMs: 5000 });
  return result.ok ? { state: 'available' } : { state: 'error', detail: result.stderr || result.stdout };
}

export async function collectFeishu(config: AppConfig, date: string): Promise<Record<string, EvidenceSource>> {
  const cfg = config.sources.feishu;
  if (!cfg.enabled) return { feishu: { state: 'disabled' } };
  const out: Record<string, EvidenceSource> = {};

  if (cfg.calendar.enabled) {
    const end = addDays(date, cfg.calendar.days);
    out.feishu_calendar = await runLarkJson(['calendar', '+agenda', '--start', date, '--end', end, '--format', 'json', '--as', 'user']);
  } else {
    out.feishu_calendar = { state: 'disabled' };
  }

  if (cfg.tasks.enabled) {
    const args = ['task', '+get-my-tasks', '--page-limit', String(cfg.tasks.page_limit), '--format', 'json', '--as', 'user'];
    if (!cfg.tasks.include_completed) args.push('--complete=false');
    out.feishu_tasks = await runLarkJson(args);
  } else {
    out.feishu_tasks = { state: 'disabled' };
  }

  if (cfg.docs.enabled) {
    const docs: Record<string, unknown> = {};
    for (const doc of cfg.docs.documents) {
      const result = await runLarkJson(['docs', '+fetch', '--doc', doc.token, '--as', 'user']);
      docs[doc.name] = result;
    }
    out.feishu_docs = sourceFromResult(docs);
  } else {
    out.feishu_docs = { state: 'disabled' };
  }

  if (cfg.im_history.enabled) {
    const chatId = process.env[cfg.im_history.chat_id_env];
    out.feishu_im_history = chatId
      ? await runLarkJson(['im', '+chat-messages-list', '--chat-id', chatId, '--page-size', String(cfg.im_history.limit), '--as', 'user'])
      : { state: 'missing', detail: `${cfg.im_history.chat_id_env} is not configured` };
  } else {
    out.feishu_im_history = { state: 'disabled' };
  }

  return out;
}

async function runLarkJson(args: string[]): Promise<EvidenceSource> {
  const result = await runCommand('lark-cli', args, { timeoutMs: 30000 });
  if (!result.ok) return { state: 'error', detail: (result.stderr || result.stdout).slice(0, 2000) };
  try {
    return sourceFromResult(JSON.parse(result.stdout));
  } catch {
    return sourceFromResult(result.stdout.trim());
  }
}

export async function sendFeishuMessage(config: AppConfig, text: string): Promise<void> {
  const output = config.output.feishu;
  if (!output.enabled) return;
  const chatId = process.env[output.chat_id_env];
  if (!chatId) throw new Error(`${output.chat_id_env} is required to send Feishu output`);
  const flag = output.send_mode === 'markdown' ? '--markdown' : '--text';
  const result = await runCommand(
    'lark-cli',
    ['im', '+messages-send', '--chat-id', chatId, flag, text, '--as', output.identity],
    { timeoutMs: 30000 },
  );
  if (!result.ok) throw new Error(`Failed to send Feishu message: ${(result.stderr || result.stdout).slice(0, 2000)}`);
}
