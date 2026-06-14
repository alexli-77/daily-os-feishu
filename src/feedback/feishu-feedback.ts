import fs from 'node:fs';
import path from 'node:path';
import type { AppConfig, WorkflowName } from '../config/schema.js';
import { listFeishuMessages, sendFeishuFeedbackReply, type FeishuMessage } from '../connectors/lark-cli.js';
import { handleDailyOsCommand } from '../interaction/daily-os-command.js';
import { handlePendingBackgroundSuggestionReply } from '../service/background-suggestions.js';
import { appendDailyMemory, appendFeedbackLog } from '../storage/memory.js';
import { todayInTimezone } from '../utils/date.js';

interface FeedbackState {
  processed_ids: string[];
  updated_at?: string;
}

export interface FeedbackPollResult {
  checked: number;
  processed: number;
  ignored: number;
}

export async function pollFeishuFeedback(
  config: AppConfig,
  options: { send?: boolean; workflowRevisionsOnly?: boolean; markIgnored?: boolean } = {},
): Promise<FeedbackPollResult> {
  const feedback = config.feedback.feishu;
  if (!feedback.enabled) return { checked: 0, processed: 0, ignored: 0 };

  const state = loadState(config);
  const seen = new Set(state.processed_ids);
  const messages = await listFeishuMessages(config, feedback.poll_limit);
  let processed = 0;
  let ignored = 0;

  for (const message of messages.reverse()) {
    if (seen.has(message.id)) continue;

    const result = options.workflowRevisionsOnly
      ? await handleWorkflowRevision(config, message, options.send ?? true)
      : await handleCommand(config, message, options.send ?? true);
    if (!result.handled) {
      ignored += 1;
      if (options.markIgnored ?? true) seen.add(message.id);
      continue;
    }
    processed += 1;
    seen.add(message.id);
  }

  saveState(config, {
    processed_ids: Array.from(seen).slice(-200),
    updated_at: new Date().toISOString(),
  });

  return { checked: messages.length, processed, ignored };
}

async function handleCommand(config: AppConfig, message: FeishuMessage, send: boolean): Promise<{ handled: boolean }> {
  const commandResult = await handleDailyOsCommand({
    config,
    messageId: message.id,
    text: message.text,
    source: 'feishu-poll',
    prefix: config.feedback.feishu.command_prefix,
    sendWorkflowOutput: send,
    reply: async (text) => {
      if (send) await sendFeishuFeedbackReply(config, text);
    },
  });
  if (commandResult.handled) return commandResult;

  const suggestionReply = handlePendingBackgroundSuggestionReply(config, message.text, {
    messageId: message.id,
    source: 'feishu-poll',
  });
  if (suggestionReply.handled) {
    if (send && suggestionReply.reply) await sendFeishuFeedbackReply(config, suggestionReply.reply);
    return { handled: true };
  }

  const revision = await handleWorkflowRevision(config, message, send);
  if (revision.handled) return revision;

  return commandResult;
}

async function handleWorkflowRevision(config: AppConfig, message: FeishuMessage, send: boolean): Promise<{ handled: boolean }> {
  if (isGeneratedDailyOsText(message.text)) return { handled: false };
  if (!isLikelyWorkflowRevisionText(message.text)) return { handled: false };
  if (isMessageAlreadyLogged(config, message.id)) return { handled: true };
  const workflow = revisionWorkflowForText(message.text);
  appendDailyMemory(config, workflow, todayInTimezone(config), `用户提出修改意见：${message.text}`);
  appendFeedbackLog(config, message.text, {
    message_id: message.id,
    source: 'feishu-poll',
    workflow,
  });
  if (send) {
    const nextCommand = workflow === 'daily_plan' ? 'plan' : workflow === 'daily_review' ? 'review' : 'weekly';
    await sendFeishuFeedbackReply(
      config,
      `收到，我已把这条修改意见写入${revisionWorkflowLabel(workflow)}上下文。请发送 ${config.feedback.feishu.command_prefix} ${nextCommand}，我会按这条意见重新整理。`,
    );
  }
  return { handled: true };
}

function isMessageAlreadyLogged(config: AppConfig, messageId: string): boolean {
  const logPath = path.resolve(config.feedback.feishu.log_path);
  if (!fs.existsSync(logPath)) return false;
  return fs.readFileSync(logPath, 'utf8').includes(`message_id: ${messageId}`);
}

function isLikelyWorkflowRevisionText(text: string): boolean {
  const normalized = text.replace(/\s+/g, ' ').trim().toLowerCase();
  if (normalized.length < 4) return false;
  if (/^daily-os\s+(plan|review|weekly|details|progress|status)\b/i.test(normalized)) return false;
  return /修改|调整|改成|降级|优先|不做|先做|安排|计划|复盘|review|weekly|周报|周复盘|本周|今天|明天|leo-\d+/i.test(normalized);
}

function isGeneratedDailyOsText(text: string): boolean {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return false;
  return (
    normalized.startsWith('收到，我已把这条修改意见写入') ||
    normalized.startsWith('Running ') ||
    normalized.startsWith('老板，我帮您') ||
    normalized.startsWith('老板您好') ||
    normalized.startsWith('老板，我把') ||
    normalized.includes('请发送 daily-os weekly，我会按这条意见重新整理') ||
    normalized.includes('请发送 daily-os plan，我会按这条意见重新整理') ||
    normalized.includes('请发送 daily-os review，我会按这条意见重新整理') ||
    normalized.includes('请点卡片里的「重新生成」') ||
    normalized.includes('如果下周安排要改，直接回复') ||
    normalized.includes('您看下周先按这个节奏走可以吗？')
  );
}

function revisionWorkflowForText(text: string): WorkflowName {
  const normalized = text.replace(/\s+/g, ' ').trim().toLowerCase();
  if (/weekly|周报|周复盘|本周/.test(normalized)) return 'weekly_review';
  if (/复盘|review/.test(normalized)) return 'daily_review';
  return 'daily_plan';
}

function revisionWorkflowLabel(workflow: WorkflowName): string {
  if (workflow === 'weekly_review') return '本周复盘';
  if (workflow === 'daily_review') return '今日复盘';
  return '今日安排';
}

function loadState(config: AppConfig): FeedbackState {
  const statePath = path.resolve(config.feedback.feishu.state_path);
  if (!fs.existsSync(statePath)) return { processed_ids: [] };
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8')) as Partial<FeedbackState>;
    return { processed_ids: Array.isArray(parsed.processed_ids) ? parsed.processed_ids.filter(isString) : [] };
  } catch {
    return { processed_ids: [] };
  }
}

function saveState(config: AppConfig, state: FeedbackState): void {
  const statePath = path.resolve(config.feedback.feishu.state_path);
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}
