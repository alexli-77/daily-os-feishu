import type { AppConfig, WorkflowName } from '../config/schema.js';
import { appendFeedbackLog, appendLongTermMemory } from '../storage/memory.js';
import { runWorkflow } from '../workflows/run-workflow.js';
import { decisionCalibrationPrompt, decisionPolicyStatusText } from '../decision/policy.js';
import {
  confirmPolicyCandidate,
  formatPolicyCandidateList,
  listPolicyCandidates,
  rejectPolicyCandidate,
} from '../decision/candidates.js';
import { decideFeishuControl, type FeishuAccessDecision, type FeishuControlEffect } from './access-policy.js';
import { clearFeishuSession } from './session-catalog.js';

export type ParsedDailyOsCommand =
  | { type: 'ignore' }
  | { type: 'status' }
  | { type: 'policy' }
  | { type: 'policy_candidates' }
  | { type: 'new_session' }
  | { type: 'stop_agent' }
  | { type: 'confirm_policy_candidate'; id: string }
  | { type: 'reject_policy_candidate'; id: string; reason?: string }
  | { type: 'calibrate' }
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
  accessDecision?: FeishuAccessDecision;
  sessionScopeId?: string;
  stopAgentRun?: () => Promise<boolean>;
}

export async function handleDailyOsCommand(context: DailyOsCommandContext): Promise<{ handled: boolean; command: ParsedDailyOsCommand }> {
  const command = parseDailyOsCommand(context.text, context.prefix);
  if (command.type === 'ignore') return { handled: false, command };

  const authorization = authorizeRemoteCommand(context, command);
  if (!authorization.ok) {
    await context.reply(`权限不足：${authorization.reason}`);
    return { handled: true, command };
  }

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
  if (['new', 'new session', '新会话', '重开会话'].includes(lower)) return { type: 'new_session' };
  if (['stop', '停止', '停止当前任务'].includes(lower)) return { type: 'stop_agent' };
  if (['policy', 'decision policy', '规则', '决策规则'].includes(lower)) return { type: 'policy' };
  if (['candidates', 'policy candidates', '候选规则', '待确认规则'].includes(lower)) return { type: 'policy_candidates' };
  const confirmCandidate = normalized.match(/^(?:save|confirm)\s+(?:rule\s+)?(.+)$/i) || normalized.match(/^(?:保存规则|确认规则)\s*(.+)$/);
  if (confirmCandidate?.[1]?.trim()) return { type: 'confirm_policy_candidate', id: confirmCandidate[1].trim() };
  const rejectCandidate = normalized.match(/^(?:reject|dismiss)\s+(?:rule\s+)?(.+)$/i) || normalized.match(/^(?:拒绝规则|放弃规则)\s*(.+)$/);
  if (rejectCandidate?.[1]?.trim()) {
    const { id, reason } = splitCandidateIdAndReason(rejectCandidate[1].trim());
    return { type: 'reject_policy_candidate', id, reason };
  }
  if (['calibrate', 'decision calibrate', '校准', '决策校准', '开始校准'].includes(lower)) return { type: 'calibrate' };
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
    'Daily OS 正在运行。',
    '',
    '可用命令：',
    `- ${prefix} status`,
    `- ${prefix} new`,
    `- ${prefix} stop`,
    `- ${prefix} remember <text>`,
    `- ${prefix} feedback <text>`,
    `- ${prefix} policy`,
    `- ${prefix} candidates`,
    `- ${prefix} 保存规则 <候选ID>`,
    `- ${prefix} 拒绝规则 <候选ID>`,
    `- ${prefix} calibrate`,
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
    case 'policy':
      await context.reply(decisionPolicyStatusText(context.config));
      return;
    case 'policy_candidates':
      await context.reply(formatPolicyCandidateList(listPolicyCandidates(context.config, 'pending')));
      return;
    case 'new_session':
      if (!context.sessionScopeId) {
        await context.reply('当前命令没有绑定远程会话 scope。');
        return;
      }
      clearFeishuSession(context.config, context.sessionScopeId);
      await context.reply('已开启新的 Daily OS 远程会话。');
      return;
    case 'stop_agent': {
      const stopped = context.stopAgentRun ? await context.stopAgentRun() : false;
      await context.reply(stopped ? '已停止当前 Codex 任务。' : '当前没有正在运行的 Codex 任务。');
      return;
    }
    case 'confirm_policy_candidate': {
      const candidate = confirmPolicyCandidate(context.config, command.id);
      await context.reply(
        [
          `已保存长期决策规则：${candidate.rule.id}`,
          '',
          candidate.rule.description,
          '',
          '后续日计划、Todo 分流、日复盘和周复盘会读取 memory repository 里的 `decision-policy.yaml` 与 `decision-policy.md`。',
        ].join('\n'),
      );
      return;
    }
    case 'reject_policy_candidate': {
      const candidate = rejectPolicyCandidate(context.config, command.id, command.reason);
      await context.reply(`已拒绝候选规则：${candidate.id}`);
      return;
    }
    case 'calibrate':
      await context.reply(decisionCalibrationPrompt(context.config));
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

function splitCandidateIdAndReason(text: string): { id: string; reason?: string } {
  const [id = '', ...rest] = text.trim().split(/\s+/);
  const reason = rest.join(' ').replace(/^(?:because|原因[:：]?)/i, '').trim();
  return { id, ...(reason ? { reason } : {}) };
}

function authorizeRemoteCommand(context: DailyOsCommandContext, command: ParsedDailyOsCommand): { ok: boolean; reason?: string } {
  if (!context.accessDecision) return { ok: true };
  const effect = commandEffect(command);
  const decision = decideFeishuControl(context.config, context.accessDecision, { effect });
  return decision.ok ? { ok: true } : { ok: false, reason: decision.reason };
}

function commandEffect(command: ParsedDailyOsCommand): FeishuControlEffect {
  switch (command.type) {
    case 'status':
    case 'policy':
    case 'policy_candidates':
    case 'new_session':
    case 'stop_agent':
      return 'read';
    case 'workflow':
      return 'workflow_trigger';
    case 'remember':
    case 'feedback':
      return 'memory_write';
    case 'confirm_policy_candidate':
    case 'reject_policy_candidate':
      return 'policy_write';
    case 'calibrate':
      return 'interaction_admin';
    case 'ignore':
      return 'read';
  }
}

function stripPrefix(text: string, prefix: string): string | null {
  const normalized = text.trim();
  if (normalized.toLowerCase() === '/new') return 'new';
  if (normalized.toLowerCase() === '/stop') return 'stop';
  const prefixes = [prefix, `/${prefix}`, `@${prefix}`].map((value) => value.toLowerCase());
  const lower = normalized.toLowerCase();

  for (const candidate of prefixes) {
    if (lower === candidate) return 'status';
    if (lower.startsWith(`${candidate} `)) return normalized.slice(candidate.length).trim();
    if (lower.startsWith(`${candidate}:`)) return normalized.slice(candidate.length + 1).trim();
  }

  return null;
}
