import fs from 'node:fs';
import path from 'node:path';
import type { AppConfig } from '../config/schema.js';
import { listFeishuMessages, sendFeishuFeedbackReply, type FeishuMessage } from '../connectors/lark-cli.js';
import { handleDailyOsCommand } from '../interaction/daily-os-command.js';
import { handlePendingBackgroundSuggestionReply } from '../service/background-suggestions.js';

interface FeedbackState {
  processed_ids: string[];
  updated_at?: string;
}

export interface FeedbackPollResult {
  checked: number;
  processed: number;
  ignored: number;
}

export async function pollFeishuFeedback(config: AppConfig, options: { send?: boolean } = {}): Promise<FeedbackPollResult> {
  const feedback = config.feedback.feishu;
  if (!feedback.enabled) return { checked: 0, processed: 0, ignored: 0 };

  const state = loadState(config);
  const seen = new Set(state.processed_ids);
  const messages = await listFeishuMessages(config, feedback.poll_limit);
  let processed = 0;
  let ignored = 0;

  for (const message of messages.reverse()) {
    if (seen.has(message.id)) continue;

    const result = await handleCommand(config, message, options.send ?? true);
    if (!result.handled) {
      ignored += 1;
      seen.add(message.id);
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
  if (!suggestionReply.handled) return commandResult;
  if (send && suggestionReply.reply) await sendFeishuFeedbackReply(config, suggestionReply.reply);
  return { handled: true };
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
