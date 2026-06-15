import type { AppConfig, WorkflowName } from '../config/schema.js';
import { appendDailyMemory, appendFeedbackLog, appendLongTermMemory, readLatestWorkflowOutput } from '../storage/memory.js';
import { runWorkflow, runWorkflowDetailed } from '../workflows/run-workflow.js';
import { collectEvidence } from '../workflows/evidence.js';
import { formatLatestWorkflowDetails, formatWorkflowSummaryForFeishu } from '../workflows/summary.js';
import { decisionCalibrationPrompt, decisionPolicyStatusText } from '../decision/policy.js';
import {
  confirmPolicyCandidate,
  formatPolicyCandidateList,
  listPolicyCandidates,
  rejectPolicyCandidate,
} from '../decision/candidates.js';
import { decideFeishuControl, type FeishuAccessDecision, type FeishuControlEffect } from './access-policy.js';
import { clearFeishuSession } from './session-catalog.js';
import { collectProgressCandidates, formatProgressCandidates } from '../progress/capture.js';
import { todayInTimezone } from '../utils/date.js';
import { analyzeChatContext, formatChatContextAnalysis, type ChatAnalysisMode } from '../chat/context-analysis.js';
import { formatRecentWorkflowRuns, listRecentWorkflowRuns } from '../workflows/run-ledger.js';
import { markWorkflowRunFailed, markWorkflowRunSucceeded } from '../workflows/run-ledger.js';

export type ParsedDailyOsCommand =
  | { type: 'ignore' }
  | { type: 'status' }
  | { type: 'policy' }
  | { type: 'policy_candidates' }
  | { type: 'new_session' }
  | { type: 'stop_agent' }
  | { type: 'details' }
  | { type: 'chat_analysis'; mode?: ChatAnalysisMode }
  | { type: 'progress' }
  | { type: 'confirm_policy_candidate'; id?: string }
  | { type: 'reject_policy_candidate'; id: string; reason?: string }
  | { type: 'calibrate' }
  | { type: 'remember'; text: string }
  | { type: 'feedback'; text: string }
  | { type: 'revision_request'; workflow: WorkflowName; text: string }
  | { type: 'workflow'; workflow: WorkflowName };

export interface DailyOsCommandContext {
  config: AppConfig;
  messageId: string;
  text: string;
  source: string;
  prefix: string;
  reply: (text: string) => Promise<void>;
  sendWorkflowCard?: (input: { workflow: WorkflowName; date: string; text: string; summary: string }) => Promise<void>;
  sendWorkflowOutput?: boolean;
  runWorkflowForCommand?: typeof runWorkflow;
  collectEvidenceForSummary?: typeof collectEvidence;
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

  const revision = parseRevisionRequest(normalized);
  if (revision) return revision;

  if (['help', 'status', '状态', '帮助'].includes(lower)) return { type: 'status' };
  if (['new', 'new session', '新会话', '重开会话'].includes(lower)) return { type: 'new_session' };
  if (['stop', '停止', '停止当前任务'].includes(lower)) return { type: 'stop_agent' };
  if (['details', 'detail', '全文', '完整内容', '查看详情'].includes(lower)) return { type: 'details' };
  const chatCommand = parseChatAnalysisCommand(normalized);
  if (chatCommand) {
    return chatCommand;
  }
  if (['progress', '进展', '今日进展', '进展确认'].includes(lower)) return { type: 'progress' };
  if (['policy', 'decision policy', '规则', '决策规则'].includes(lower)) return { type: 'policy' };
  if (['candidates', 'policy candidates', '候选规则', '待确认规则'].includes(lower)) return { type: 'policy_candidates' };
  const confirmCandidate = parseConfirmCandidateCommand(normalized);
  if (confirmCandidate) return confirmCandidate;
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

export function dailyOsStatusText(prefix: string, config?: AppConfig): string {
  const lines = [
    'Daily OS 正在运行。',
    '',
    ...(config ? [formatRecentWorkflowRuns(listRecentWorkflowRuns(config, 5)), ''] : []),
    '可用命令：',
    `- ${prefix} status`,
    `- ${prefix} new`,
    `- ${prefix} stop`,
    `- ${prefix} details`,
    `- ${prefix} chat [todo|review]`,
    `- ${prefix} progress`,
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
  ];
  return lines.join('\n');
}

export async function runParsedDailyOsCommand(context: DailyOsCommandContext, command: ParsedDailyOsCommand): Promise<void> {
  switch (command.type) {
    case 'status':
      await context.reply(dailyOsStatusText(context.prefix, context.config));
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
    case 'details': {
      const latest = readLatestWorkflowOutput(context.config);
      await context.reply(latest ? formatLatestWorkflowDetails(latest) : '老板，目前还没有可展开的最近一次计划/复盘详情。');
      return;
    }
    case 'chat_analysis': {
      if (!context.config.chat_analysis.enabled) {
        await context.reply('chat_analysis.enabled=false；聊天上下文分析已禁用。');
        return;
      }
      const date = todayInTimezone(context.config);
      await context.reply(formatChatContextAnalysis(await analyzeChatContext(context.config, date, command.mode || context.config.chat_analysis.default_mode)));
      return;
    }
    case 'progress': {
      const date = todayInTimezone(context.config);
      await context.reply(formatProgressCandidates(await collectProgressCandidates(context.config, date)));
      return;
    }
    case 'confirm_policy_candidate': {
      const candidateId = command.id || listPolicyCandidates(context.config, 'pending')[0]?.id;
      if (!candidateId) {
        await context.reply('当前没有待确认的候选规则。');
        return;
      }
      const candidate = confirmPolicyCandidate(context.config, candidateId);
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
    case 'revision_request': {
      appendDailyMemory(context.config, command.workflow, todayInTimezone(context.config), `用户提出修改意见：${command.text}`);
      appendFeedbackLog(context.config, command.text, { message_id: context.messageId, source: context.source, workflow: command.workflow });
      const nextCommand = command.workflow === 'daily_plan' ? 'plan' : command.workflow === 'daily_review' ? 'review' : 'weekly';
      await context.reply(`收到，我已记录这条修改意见。请点卡片里的「重新生成」，或发送 ${context.prefix} ${nextCommand}，我会按这条意见重新整理。`);
      return;
    }
    case 'workflow': {
      const date = todayInTimezone(context.config);
      await context.reply(`Running ${command.workflow.replaceAll('_', ' ')}...`);
      const sendViaConfiguredOutput = (context.sendWorkflowOutput ?? false) && !context.sendWorkflowCard;
      const result = context.runWorkflowForCommand
        ? {
            text: await context.runWorkflowForCommand(context.config, command.workflow, { send: sendViaConfiguredOutput }),
            run: null,
          }
        : await runWorkflowDetailed(context.config, command.workflow, {
            send: sendViaConfiguredOutput,
            trigger: 'feishu_command',
            source: context.source,
          });
      const output = result.text;
      const evidence =
        command.workflow === 'weekly_review' && (context.sendWorkflowCard || !sendViaConfiguredOutput)
          ? await (context.collectEvidenceForSummary || collectEvidence)(context.config, date)
          : undefined;
      const summary = formatWorkflowSummaryForFeishu(command.workflow, date, output, evidence, context.config);
      if (context.sendWorkflowCard) {
        try {
          await context.sendWorkflowCard({ workflow: command.workflow, date, text: output, summary });
          if (result.run) {
            markWorkflowRunSucceeded(context.config, result.run, { enabled: true, provider: 'feishu_interaction', mode: 'card', status: 'succeeded' });
          }
        } catch (error) {
          if (result.run) markWorkflowRunFailed(context.config, result.run, error, { sendFailed: true });
          throw error;
        }
      } else if (!sendViaConfiguredOutput) {
        await context.reply(summary);
      }
      return;
    }
    case 'ignore':
      return;
  }
}

function parseRevisionRequest(text: string): Extract<ParsedDailyOsCommand, { type: 'revision_request' }> | null {
  const patterns: Array<[RegExp, WorkflowName]> = [
    [/^(?:修改|调整)(?:今日安排|今天安排|日计划|今日计划)[:：\s]*(.+)$/i, 'daily_plan'],
    [/^(?:修改|调整)(?:今日复盘|日复盘)[:：\s]*(.+)$/i, 'daily_review'],
    [/^(?:修改|调整)(?:周计划|周复盘|下周安排)[:：\s]*(.+)$/i, 'weekly_review'],
  ];
  for (const [pattern, workflow] of patterns) {
    const match = text.match(pattern);
    const body = match?.[1]?.trim();
    if (body) return { type: 'revision_request', workflow, text: body };
  }
  return null;
}

function splitCandidateIdAndReason(text: string): { id: string; reason?: string } {
  const [id = '', ...rest] = text.trim().split(/\s+/);
  const reason = rest.join(' ').replace(/^(?:because|原因[:：]?)/i, '').trim();
  return { id, ...(reason ? { reason } : {}) };
}

function parseConfirmCandidateCommand(text: string): Extract<ParsedDailyOsCommand, { type: 'confirm_policy_candidate' }> | null {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (/^(?:save|confirm)(?:\s+rule)?$/i.test(normalized) || /^(?:保存规则|确认规则|确认保存|保存)$/i.test(normalized)) {
    return { type: 'confirm_policy_candidate' };
  }
  const match =
    normalized.match(/^(?:save|confirm)\s+(?:rule\s+)?(.+)$/i) ||
    normalized.match(/^(?:确认保存|保存规则|确认规则)[:：]?\s*(?:daily-os\s+)?(?:保存规则|确认规则)?\s*(.+)$/i);
  const id = match?.[1]?.trim().replace(/[`"'。]+$/g, '');
  return id ? { type: 'confirm_policy_candidate', id } : null;
}

function parseChatAnalysisCommand(text: string): ParsedDailyOsCommand | null {
  const normalized = text.replace(/\s+/g, ' ').trim();
  const lower = normalized.toLowerCase();
  const match =
    lower.match(/^(?:chat|chat analysis|context|context analysis)(?:\s+(manual|todo|review))?$/) ||
    normalized.match(/^(?:聊天分析|上下文分析|变更建议)(?:\s*(手动|todo|待办|计划|review|复盘))?$/);
  if (!match) return null;
  return { type: 'chat_analysis', ...(match[1] ? { mode: normalizeChatAnalysisMode(match[1]) } : {}) };
}

function normalizeChatAnalysisMode(value: string): ChatAnalysisMode {
  const normalized = value.toLowerCase();
  if (normalized === 'todo' || normalized === '待办' || normalized === '计划') return 'todo';
  if (normalized === 'review' || normalized === '复盘') return 'review';
  return 'manual';
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
    case 'details':
    case 'progress':
    case 'chat_analysis':
      return 'read';
    case 'workflow':
      return 'workflow_trigger';
    case 'remember':
    case 'feedback':
    case 'revision_request':
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
