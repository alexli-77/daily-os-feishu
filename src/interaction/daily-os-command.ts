import type { AppConfig, WorkflowName } from '../config/schema.js';
import { appendFeedbackLog, appendLongTermMemory } from '../storage/memory.js';
import { runWorkflow } from '../workflows/run-workflow.js';

export type ParsedDailyOsCommand =
  | { type: 'ignore' }
  | { type: 'status' }
  | { type: 'remember'; text: string }
  | { type: 'feedback'; text: string }
  | { type: 'workflow'; workflow: WorkflowName };

export interface DailyOsCommandContext {
  config: AppConfig;
  messageId: string;
  text: string;
  source: string;
  prefix: string;
  reply: (text: string) => Promise<void>;
  sendWorkflowOutput?: boolean;
}

export async function handleDailyOsCommand(context: DailyOsCommandContext): Promise<{ handled: boolean; command: ParsedDailyOsCommand }> {
  const command = parseDailyOsCommand(context.text, context.prefix);
  if (command.type === 'ignore') return { handled: false, command };

  await runParsedDailyOsCommand(context, command);
  return { handled: true, command };
}

export function parseDailyOsCommand(text: string, prefix: string): ParsedDailyOsCommand {
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

  if (['help', 'status', '状态', '帮助'].includes(lower)) return { type: 'status' };
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

export function dailyOsStatusText(prefix: string): string {
  return [
    'Daily OS is running.',
    '',
    'Commands:',
    `- ${prefix} status`,
    `- ${prefix} remember <text>`,
    `- ${prefix} feedback <text>`,
    `- ${prefix} plan`,
    `- ${prefix} review`,
    `- ${prefix} weekly`,
  ].join('\n');
}

export async function runParsedDailyOsCommand(context: DailyOsCommandContext, command: ParsedDailyOsCommand): Promise<void> {
  switch (command.type) {
    case 'status':
      await context.reply(dailyOsStatusText(context.prefix));
      return;
    case 'remember':
      if (!command.text) {
        await context.reply(`Nothing to remember. Send: ${context.prefix} remember <text>`);
        return;
      }
      appendLongTermMemory(context.config, command.text, `${context.source}:${context.messageId}`);
      await context.reply('Remembered.');
      return;
    case 'feedback':
      if (!command.text) {
        await context.reply(`Feedback is empty. Send: ${context.prefix} feedback <text>`);
        return;
      }
      appendFeedbackLog(context.config, command.text, { message_id: context.messageId, source: context.source });
      await context.reply('Feedback saved.');
      return;
    case 'workflow': {
      await context.reply(`Running ${command.workflow.replaceAll('_', ' ')}...`);
      const output = await runWorkflow(context.config, command.workflow, { send: context.sendWorkflowOutput ?? false });
      if (!(context.sendWorkflowOutput ?? false)) await context.reply(output);
      return;
    }
    case 'ignore':
      return;
  }
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
