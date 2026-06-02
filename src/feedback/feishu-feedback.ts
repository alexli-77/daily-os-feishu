import fs from 'node:fs';
import path from 'node:path';
import type { AppConfig, WorkflowName } from '../config/schema.js';
import { listFeishuMessages, sendFeishuFeedbackReply, type FeishuMessage } from '../connectors/lark-cli.js';
import { appendFeedbackLog, appendLongTermMemory } from '../storage/memory.js';
import { runWorkflow } from '../workflows/run-workflow.js';

interface FeedbackState {
  processed_ids: string[];
  updated_at?: string;
}

type ParsedCommand =
  | { type: 'ignore' }
  | { type: 'status' }
  | { type: 'remember'; text: string }
  | { type: 'feedback'; text: string }
  | { type: 'workflow'; workflow: WorkflowName };

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

    const command = parseCommand(message.text, feedback.command_prefix);
    if (command.type === 'ignore') {
      ignored += 1;
      seen.add(message.id);
      continue;
    }

    await handleCommand(config, message, command, options.send ?? true);
    processed += 1;
    seen.add(message.id);
  }

  saveState(config, {
    processed_ids: Array.from(seen).slice(-200),
    updated_at: new Date().toISOString(),
  });

  return { checked: messages.length, processed, ignored };
}

function parseCommand(text: string, prefix: string): ParsedCommand {
  const body = stripPrefix(text, prefix);
  if (!body) return { type: 'ignore' };

  const normalized = body.replace(/\s+/g, ' ').trim();
  const lower = normalized.toLowerCase();

  for (const marker of ['remember ', '记住']) {
    if (lower.startsWith(marker) || normalized.startsWith(marker)) {
      return { type: 'remember', text: normalized.slice(marker.length).trim() };
    }
  }

  for (const marker of ['feedback ', '反馈']) {
    if (lower.startsWith(marker) || normalized.startsWith(marker)) {
      return { type: 'feedback', text: normalized.slice(marker.length).trim() };
    }
  }

  if (['status', '状态'].includes(lower)) return { type: 'status' };
  if (/^(rerun\s+)?(plan|daily plan)$/.test(lower) || ['日计划', '今日计划', '重跑今日计划'].includes(normalized)) {
    return { type: 'workflow', workflow: 'daily_plan' };
  }
  if (/^(rerun\s+)?(review|daily review)$/.test(lower) || ['日复盘', '今日复盘', '重跑日复盘'].includes(normalized)) {
    return { type: 'workflow', workflow: 'daily_review' };
  }
  if (/^(rerun\s+)?(weekly|weekly review)$/.test(lower) || ['周复盘', '重跑周复盘'].includes(normalized)) {
    return { type: 'workflow', workflow: 'weekly_review' };
  }

  return { type: 'ignore' };
}

function stripPrefix(text: string, prefix: string): string | null {
  const normalized = text.trim();
  const prefixes = [prefix, `/${prefix}`, `@${prefix}`].map((value) => value.toLowerCase());
  const lower = normalized.toLowerCase();

  for (const candidate of prefixes) {
    if (lower === candidate) return 'status';
    if (lower.startsWith(`${candidate} `)) return normalized.slice(candidate.length).trim();
    if (lower.startsWith(`${candidate}:`)) return normalized.slice(candidate.length + 1).trim();
  }

  return null;
}

async function handleCommand(config: AppConfig, message: FeishuMessage, command: ParsedCommand, send: boolean): Promise<void> {
  switch (command.type) {
    case 'status':
      if (send) await sendFeishuFeedbackReply(config, 'Daily OS is running. Commands: status, remember, feedback, plan, review, weekly.');
      return;
    case 'remember':
      if (!command.text) {
        if (send) await sendFeishuFeedbackReply(config, 'Nothing to remember. Send: daily-os remember <text>');
        return;
      }
      appendLongTermMemory(config, command.text, `feishu:${message.id}`);
      if (send) await sendFeishuFeedbackReply(config, 'Remembered.');
      return;
    case 'feedback':
      if (!command.text) {
        if (send) await sendFeishuFeedbackReply(config, 'Feedback is empty. Send: daily-os feedback <text>');
        return;
      }
      appendFeedbackLog(config, command.text, { message_id: message.id });
      if (send) await sendFeishuFeedbackReply(config, 'Feedback saved.');
      return;
    case 'workflow':
      if (send) await sendFeishuFeedbackReply(config, `Running ${command.workflow.replaceAll('_', ' ')}...`);
      await runWorkflow(config, command.workflow, { send });
      return;
    case 'ignore':
      return;
  }
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
