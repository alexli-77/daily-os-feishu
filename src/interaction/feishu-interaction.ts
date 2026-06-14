import {
  Domain,
  LoggerLevel,
  createLarkChannel,
  type CardActionEvent,
  type LarkChannel,
  type NormalizedMessage,
} from '@larksuiteoapi/node-sdk';
import type { AppConfig, WorkflowName } from '../config/schema.js';
import { handleDailyOsCommand, parseDailyOsCommand } from './daily-os-command.js';
import { PendingQueue } from './pending-queue.js';
import { runWorkflow } from '../workflows/run-workflow.js';
import { decideFeishuAccess, decideFeishuControl, type FeishuAccessDecision } from './access-policy.js';
import { isDecisionCalibrationChat, startDecisionOnboarding } from '../decision/onboarding.js';
import { runDecisionCalibrationAgent } from '../decision/calibration-agent.js';
import { ensureFeishuSession } from './session-catalog.js';
import {
  agentModeControlEffect,
  agentWorkdir,
  startFeishuAgentModeRun,
  type FeishuAgentModeEvent,
  type FeishuAgentModeRun,
} from './agent-mode.js';
import { AgentRunCardController, parseAgentRunCardAction, type AgentRunCardStatus } from './run-card.js';
import {
  appendConfirmedProgress,
  collectProgressCandidates,
  confirmedEntriesFromCandidates,
  formatProgressCandidates,
} from '../progress/capture.js';
import { parseProgressCardAction, renderProgressConfirmationCard } from '../progress/card.js';
import { todayInTimezone } from '../utils/date.js';
import { appendDailyMemory, appendFeedbackLog, readLatestWorkflowOutput, readWorkflowDetailCache } from '../storage/memory.js';
import { formatLatestWorkflowDetails, formatWorkflowSummaryForFeishu } from '../workflows/summary.js';
import { handlePendingBackgroundSuggestionReply } from '../service/background-suggestions.js';
import { renderFeishuWorkflowCard } from '../connectors/feishu-sdk.js';

interface FeishuInteractionControls {
  stop: () => Promise<void>;
}

type ChatMode = 'p2p' | 'group' | 'topic';

interface ActiveAgentRun {
  run: FeishuAgentModeRun;
  card?: AgentRunCardController;
  scopeId: string;
}

type ConfigProvider = AppConfig | (() => AppConfig);

type WorkflowCardCommand = {
  command: 'details' | 'progress' | 'chat todo' | 'chat review' | 'confirm_todo' | 'confirm_review' | 'revise_todo';
  detailId?: string;
};

const CARD_ACTION_DEDUPE_MS = 30_000;

function runtimeConfigReader(config: ConfigProvider): () => AppConfig {
  return typeof config === 'function' ? config : () => config;
}

export async function startFeishuInteraction(configProvider: ConfigProvider): Promise<FeishuInteractionControls> {
  const getConfig = runtimeConfigReader(configProvider);
  const cfg = getConfig().interaction.feishu;
  if (!cfg.enabled) {
    throw new Error('interaction.feishu.enabled is false. Enable it in config/config.yaml before starting the Feishu interaction layer.');
  }

  const appId = process.env.LARK_APP_ID;
  const appSecret = process.env.LARK_APP_SECRET;
  if (!appId || !appSecret) throw new Error('LARK_APP_ID and LARK_APP_SECRET are required for Feishu interaction.');

  const channel = createLarkChannel({
    appId,
    appSecret,
    domain: Domain.Feishu,
    source: 'daily-os-feishu',
    loggerLevel: LoggerLevel.warn,
    includeRawEvent: true,
    safety: { chatQueue: { enabled: false } },
    policy: {
      dmMode: 'open',
      requireMention: false,
      respondToMentionAll: false,
    },
    outbound: {
      streamThrottleMs: 400,
    },
    wsConfig: {
      pingTimeout: 3,
    },
    handshakeTimeoutMs: 8_000,
  });

  const chatModes = new Map<string, ChatMode>();
  const activeAgentRuns = new Map<string, ActiveAgentRun>();
  const recentCardActions = new Map<string, number>();
  const queue = new PendingQueue<NormalizedMessage>(cfg.debounce_ms, (scope, batch) => {
    queue.block(scope);
    void runBatch({ config: getConfig(), channel, batch, scope, chatModes, activeAgentRuns })
      .catch(async (error) => {
        const last = batch[batch.length - 1];
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[interaction] ${scope} failed: ${message}`);
        if (last) await replyToMessage(channel, last, `Daily OS 执行失败：${message}`, 'text');
      })
      .finally(() => queue.unblock(scope));
  });

  channel.on({
    message: async (message) => {
      await intakeMessage({ config: getConfig(), channel, message, queue, chatModes, activeAgentRuns });
    },
    cardAction: (event) => {
      if (!claimCardAction(recentCardActions, event)) {
        console.log(`[interaction] skipped duplicate card action ${event.chatId}/${event.messageId}`);
        return;
      }
      void handleCardAction({ config: getConfig(), channel, event, queue, chatModes, activeAgentRuns }).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[interaction] card action failed ${event.chatId}/${event.messageId}: ${message}`);
        void channel
          .send(event.chatId, { text: `卡片操作执行失败：${message}` }, { replyTo: event.messageId })
          .catch((sendError) => {
            console.error(`[interaction] failed to report card action error: ${sendError instanceof Error ? sendError.message : String(sendError)}`);
          });
      });
    },
    reject: (event) => {
      console.warn(`[interaction] rejected ${event.chatId}/${event.messageId}: ${event.reason}`);
    },
    reconnecting: () => {
      console.warn('[interaction] Feishu websocket reconnecting...');
    },
    reconnected: () => {
      console.log('[interaction] Feishu websocket reconnected.');
    },
    error: (error) => {
      console.error(`[interaction] Feishu websocket error: ${error.message}`);
    },
  });

  await channel.connect();
  console.log('daily-os-feishu 飞书交互层已启动。');
  if (getConfig().decision.onboarding.auto_create_on_setup) {
    try {
      const result = await startDecisionOnboarding(getConfig(), { channel });
      console.log(`[interaction] 决策校准群${result.created ? '已创建' : '已准备好'}：${result.chatId}`);
    } catch (error) {
      console.warn(`[interaction] 跳过决策校准初始化：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return {
    stop: async () => {
      await channel.disconnect();
    },
  };
}

async function intakeMessage(input: {
  config: AppConfig;
  channel: LarkChannel;
  message: NormalizedMessage;
  queue: PendingQueue<NormalizedMessage>;
  chatModes: Map<string, ChatMode>;
  activeAgentRuns: Map<string, ActiveAgentRun>;
}): Promise<void> {
  if (!input.config.interaction.feishu.enabled) return;
  const mode = await resolveChatMode(input.channel, input.message.chatId, input.chatModes, input.message.chatType);
  const scope = scopeFor(input.message, mode);
  const access = decideFeishuAccess(input.config, {
    senderOpenId: input.message.senderId,
    chatId: input.message.chatId,
    chatType: input.message.chatType,
  });
  const isCalibrationChat = isDecisionCalibrationChat(input.config, input.message.chatId);
  if (isStopText(input.message.content) && input.activeAgentRuns.has(scope)) {
    if (!access.ok && !isCalibrationChat) {
      await replyToMessage(input.channel, input.message, `权限不足：${access.reason}`, input.config.interaction.feishu.reply_mode);
      return;
    }
    await stopAgentRun(input.activeAgentRuns, scope);
    await replyToMessage(input.channel, input.message, '已请求停止当前 Codex 任务。', input.config.interaction.feishu.reply_mode);
    return;
  }
  if (!access.ok && !isCalibrationChat) {
    console.warn(`[interaction] denied ${scope}; sender=${input.message.senderId.slice(-6)}; reason=${access.reason}`);
    if (input.message.chatType === 'p2p') await replyToMessage(input.channel, input.message, '当前飞书用户尚未启用 Daily OS。', 'text');
    return;
  }

  if (
    !isCalibrationChat &&
    input.message.chatType !== 'p2p' &&
    input.config.interaction.feishu.require_mention_in_groups &&
    !input.message.mentionedBot &&
    !shouldAcceptUnmentionedGroupMessage(input.message, input.config.interaction.feishu.command_prefix, input.config.interaction.feishu.agent_mode.enabled)
  ) {
    return;
  }

  const queued = input.queue.push(scope, input.message);
  console.log(`[interaction] queued ${scope}; size=${queued}`);
}

async function runBatch(input: {
  config: AppConfig;
  channel: LarkChannel;
  batch: NormalizedMessage[];
  scope: string;
  chatModes: Map<string, ChatMode>;
  activeAgentRuns: Map<string, ActiveAgentRun>;
}): Promise<void> {
  const last = input.batch[input.batch.length - 1];
  if (!last) return;

  const text = input.batch.map((message) => message.content).join('\n').trim();
  const isCalibrationChat = isDecisionCalibrationChat(input.config, last.chatId);
  const agentWorkdirPath = input.config.interaction.feishu.agent_mode.enabled ? agentWorkdir(input.config) : undefined;
  const scopeDescriptor = {
    scopeKey: input.scope,
    chatId: last.chatId,
    chatType: last.chatType,
    mode: last.threadId ? 'topic' : last.chatType,
    ...(last.threadId ? { threadId: last.threadId } : {}),
  } as const;
  const session = ensureFeishuSession(input.config, scopeDescriptor, { workdir: agentWorkdirPath });
  const commandPrefix = input.config.interaction.feishu.command_prefix;
  const commandText = isCalibrationChat && looksLikeBarePolicyCommand(text) ? `${commandPrefix} ${text}` : text;
  const command = parseDailyOsCommand(commandText, commandPrefix);
  const accessDecision = commandAccessDecision(input.config, last, isCalibrationChat);
  if (command.type === 'ignore' && isProgressConfirmationReply(text)) {
    const control = decideFeishuControl(input.config, accessDecision, { effect: 'memory_write' });
    if (!control.ok) {
      await replyToMessage(input.channel, last, `权限不足：${control.reason}`, input.config.interaction.feishu.reply_mode);
      console.log(`[interaction] denied ${input.scope}; command=progress-confirm-reply; reason=${control.reason}`);
      return;
    }
    const date = todayInTimezone(input.config);
    const progress = await collectProgressCandidates(input.config, date);
    const ledgerPath = appendConfirmedProgress(input.config, date, confirmedEntriesFromCandidates(progress.candidates));
    await replyToMessage(
      input.channel,
      last,
      progress.candidates.length > 0 ? `已确认 ${progress.candidates.length} 条今日进展，并写入：${ledgerPath}` : '没有可写入的进展候选；可能候选已经为空。',
      input.config.interaction.feishu.reply_mode,
    );
    console.log(`[interaction] handled ${input.scope}; command=progress-confirm-reply`);
    return;
  }
  if (command.type === 'status') {
    await sendStatusCard(input.channel, last, input.config);
    console.log(`[interaction] handled ${input.scope}; command=status-card`);
    return;
  }
  if (command.type === 'progress') {
    const date = todayInTimezone(input.config);
    const progress = await collectProgressCandidates(input.config, date);
    await input.channel.send(
      last.chatId,
      { card: renderProgressConfirmationCard(input.config, progress) },
      {
        replyTo: last.messageId,
        ...(last.threadId ? { replyInThread: true } : {}),
      },
    );
    console.log(`[interaction] handled ${input.scope}; command=progress-card`);
    return;
  }
  if (command.type === 'calibrate') {
    const control = decideFeishuControl(input.config, accessDecision, { effect: 'interaction_admin' });
    if (!control.ok) {
      await replyToMessage(input.channel, last, `权限不足：${control.reason}`, input.config.interaction.feishu.reply_mode);
      console.log(`[interaction] denied ${input.scope}; command=calibrate; reason=${control.reason}`);
      return;
    }
    const result = await startDecisionOnboarding(input.config, { channel: input.channel });
    await replyToMessage(
      input.channel,
      last,
      [
        result.created ? '已创建决策校准群。' : '决策校准群已准备好。',
        '',
        `群名称：${result.chatName}`,
        `群 ID：${result.chatId}`,
        '',
        '请到这个群里继续校准决策规则，方便之后查看和确认长期规则。',
      ].join('\n'),
      input.config.interaction.feishu.reply_mode,
    );
    console.log(`[interaction] handled ${input.scope}; command=calibrate; chat=${result.chatId}`);
    return;
  }

  if (isCalibrationChat && command.type !== 'ignore') {
    const result = await handleDailyOsCommand({
      config: input.config,
      messageId: last.messageId,
      text: commandText,
      source: `feishu-decision-calibration:${input.scope}`,
      prefix: commandPrefix,
      sendWorkflowOutput: false,
      accessDecision,
      sessionScopeId: session.scope_id,
      stopAgentRun: async () => stopAgentRun(input.activeAgentRuns, input.scope),
      reply: async (reply) => {
        await replyToMessage(input.channel, last, reply, input.config.interaction.feishu.reply_mode);
      },
    });
    if (result.handled) {
      console.log(`[interaction] handled ${input.scope}; command=${result.command.type}`);
      return;
    }
  }

  if (isCalibrationChat) {
    const reply = await runDecisionCalibrationAgent(input.config, {
      text,
      chatId: last.chatId,
      senderOpenId: last.senderId,
      messageId: last.messageId,
    });
    await replyToMessage(input.channel, last, reply, input.config.interaction.feishu.reply_mode);
    console.log(`[interaction] handled ${input.scope}; command=decision-calibration`);
    return;
  }

  const result = await handleDailyOsCommand({
    config: input.config,
    messageId: last.messageId,
    text,
    source: `feishu-interaction:${input.scope}`,
    prefix: input.config.interaction.feishu.command_prefix,
    sendWorkflowOutput: false,
    accessDecision,
    sessionScopeId: session.scope_id,
    stopAgentRun: async () => stopAgentRun(input.activeAgentRuns, input.scope),
    reply: async (reply) => {
      await replyToMessage(input.channel, last, reply, input.config.interaction.feishu.reply_mode);
    },
  });

  if (result.handled) {
    console.log(`[interaction] handled ${input.scope}; command=${result.command.type}`);
    return;
  }

  const suggestionReply = handlePendingBackgroundSuggestionReply(input.config, text, {
    messageId: last.messageId,
    source: `feishu-interaction:${input.scope}`,
  });
  if (suggestionReply.handled) {
    if (suggestionReply.reply) await replyToMessage(input.channel, last, suggestionReply.reply, input.config.interaction.feishu.reply_mode);
    console.log(`[interaction] handled ${input.scope}; command=background-suggestion-reply`);
    return;
  }

  if (isWorkflowRevisionFollowUp(last, text)) {
    const control = decideFeishuControl(input.config, accessDecision, { effect: 'memory_write' });
    if (!control.ok) {
      await replyToMessage(input.channel, last, `权限不足：${control.reason}`, input.config.interaction.feishu.reply_mode);
      console.log(`[interaction] denied ${input.scope}; command=workflow-revision-follow-up; reason=${control.reason}`);
      return;
    }
    const workflow = revisionWorkflowForText(text);
    const date = todayInTimezone(input.config);
    appendDailyMemory(input.config, workflow, date, `用户提出修改意见：${text}`);
    appendFeedbackLog(input.config, text, {
      message_id: last.messageId,
      source: `feishu-interaction:${input.scope}`,
      workflow,
    });
    const nextCommand = workflow === 'daily_plan' ? 'plan' : workflow === 'daily_review' ? 'review' : 'weekly';
    await replyToMessage(
      input.channel,
      last,
      `收到，我已把这条修改意见写入${revisionWorkflowLabel(workflow)}上下文。请点卡片里的「重新生成」，或发送 ${input.config.interaction.feishu.command_prefix} ${nextCommand}，我会按这条意见重新整理。`,
      input.config.interaction.feishu.reply_mode,
    );
    console.log(`[interaction] handled ${input.scope}; command=workflow-revision-follow-up`);
    return;
  }

  if (input.config.interaction.feishu.agent_mode.enabled) {
    const control = decideFeishuControl(input.config, accessDecision, {
      effect: agentModeControlEffect(input.config),
      workspacePath: agentWorkdir(input.config),
    });
    if (!control.ok) {
      await replyToMessage(input.channel, last, `权限不足：${control.reason}`, input.config.interaction.feishu.reply_mode);
      console.log(`[interaction] denied ${input.scope}; command=agent-mode; reason=${control.reason}`);
      return;
    }
    const pendingEvents: FeishuAgentModeEvent[] = [];
    let card: AgentRunCardController | undefined;
    const run = await startFeishuAgentModeRun({
      config: input.config,
      text,
      access: accessDecision,
      session,
      onEvent: (event) => {
        if (card) card.record(toCardEvent(event));
        else pendingEvents.push(event);
      },
      bridge: {
        chatId: last.chatId,
        chatType: last.chatType,
        senderId: last.senderId,
        ...(last.threadId ? { threadId: last.threadId } : {}),
        messageIds: input.batch.map((message) => message.messageId),
        scopeId: session.scope_id,
        scopeHash: session.scope_hash,
        source: 'feishu',
      },
    });
    card = new AgentRunCardController({
      config: input.config,
      channel: input.channel,
      message: last,
      runId: run.runId,
      scopeId: session.scope_id,
      title: 'Codex 正在处理飞书请求',
    });
    input.activeAgentRuns.set(input.scope, { run, card, scopeId: session.scope_id });
    await card.send();
    for (const event of pendingEvents) card.record(toCardEvent(event));
    await card.flushPending();
    try {
      const output = await run.done;
      if (output.threadId) {
        ensureFeishuSession(input.config, scopeDescriptor, {
          workdir: agentWorkdir(input.config),
          codexSessionId: output.threadId,
        });
      }
      await card.finalize(finalStatusForReply(output.reply), output.reply);
      console.log(`[interaction] handled ${input.scope}; command=agent-mode; run=${run.runId}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await card.finalize('failed', message);
      console.error(`[interaction] ${input.scope} agent-mode failed: ${message}`);
    } finally {
      input.activeAgentRuns.delete(input.scope);
    }
  }
}

function looksLikeBarePolicyCommand(text: string): boolean {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return /^(?:候选规则|待确认规则|保存规则|确认规则|拒绝规则|放弃规则)(?:\s|$)/.test(normalized);
}

function commandAccessDecision(config: AppConfig, message: NormalizedMessage, isCalibrationChat: boolean): FeishuAccessDecision {
  const decision = decideFeishuAccess(config, {
    senderOpenId: message.senderId,
    chatId: message.chatId,
    chatType: message.chatType,
  });
  if (decision.ok || !isCalibrationChat) return decision;
  return { ok: true, role: 'allowed_chat' };
}

function isStopText(text: string): boolean {
  const normalized = text.replace(/\s+/g, ' ').trim().toLowerCase();
  return normalized === '/stop' || normalized === 'stop' || normalized === 'daily-os stop' || normalized === '停止' || normalized === '停止当前任务';
}

function shouldAcceptUnmentionedGroupMessage(message: NormalizedMessage, prefix: string, allowFreeformReplies: boolean): boolean {
  const normalized = message.content.replace(/\s+/g, ' ').trim();
  if (!normalized) return false;
  if (isGeneratedDailyOsText(normalized)) return false;
  if (normalized.toLowerCase().startsWith(`${prefix.toLowerCase()} `) || normalized.toLowerCase() === prefix.toLowerCase()) return true;
  if (!message.replyToMessageId && !message.threadId) return false;
  if (allowFreeformReplies) return true;
  return isProgressConfirmationReply(normalized) || isDetailReply(normalized) || isLikelyWorkflowRevisionText(normalized);
}

function isProgressConfirmationReply(text: string): boolean {
  const normalized = text.replace(/\s+/g, ' ').trim().toLowerCase();
  return ['确认', '确认全部', '通过', '可以', '写入', '记账', 'ok', 'okay', 'yes', 'y'].includes(normalized);
}

function isDetailReply(text: string): boolean {
  const normalized = text.replace(/\s+/g, ' ').trim().toLowerCase();
  return ['详情', '查看详情', '全文', '完整内容', 'details', 'detail'].includes(normalized);
}

function isWorkflowRevisionFollowUp(message: NormalizedMessage, text: string): boolean {
  return Boolean((message.replyToMessageId || message.threadId) && !isGeneratedDailyOsText(text) && isLikelyWorkflowRevisionText(text));
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
    normalized.startsWith('<card title="Daily OS">') ||
    normalized.startsWith('老板，我在后台看了') ||
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

async function stopAgentRun(activeRuns: Map<string, ActiveAgentRun>, scope: string): Promise<boolean> {
  const active = activeRuns.get(scope);
  if (!active) return false;
  await active.card?.markStopping();
  await active.run.stop();
  return true;
}

async function stopAgentRunByScopeOrId(
  activeRuns: Map<string, ActiveAgentRun>,
  scope: string,
  scopeId: string,
  runId: string,
): Promise<boolean> {
  const active = activeRuns.get(scope) || [...activeRuns.values()].find((candidate) => candidate.scopeId === scopeId && candidate.run.runId === runId);
  if (!active) return false;
  await active.card?.markStopping();
  await active.run.stop();
  return true;
}

function toCardEvent(event: FeishuAgentModeEvent): { type: 'started' | 'thread' | 'progress' | 'stderr' | 'final'; message: string } {
  if (event.type === 'started' || event.type === 'thread' || event.type === 'stderr') return { type: event.type, message: event.message };
  if (event.type === 'completed' || event.type === 'failed' || event.type === 'stopped' || event.type === 'timeout') {
    return { type: 'final', message: event.message };
  }
  return { type: 'progress', message: event.message };
}

function finalStatusForReply(reply: string): Exclude<AgentRunCardStatus, 'running' | 'stopping'> {
  if (/超时|timeout/i.test(reply)) return 'timeout';
  if (/停止|stopped|stop/i.test(reply)) return 'stopped';
  return 'success';
}

async function handleCardAction(input: {
  config: AppConfig;
  channel: LarkChannel;
  event: CardActionEvent;
  queue: PendingQueue<NormalizedMessage>;
  chatModes: Map<string, ChatMode>;
  activeAgentRuns: Map<string, ActiveAgentRun>;
}): Promise<void> {
  if (!input.config.interaction.feishu.enabled) return;
  const progressAction = parseProgressCardAction(input.event.action.value, input.config);
  if (progressAction) {
    await handleProgressCardAction({ ...input, action: progressAction });
    return;
  }
  const agentAction = parseAgentRunCardAction(input.event.action.value, input.config);
  if (agentAction) {
    await handleAgentRunCardAction({ ...input, action: agentAction });
    return;
  }
  const commandAction = parseWorkflowCardCommand(input.event.action.value);
  if (commandAction) {
    await handleWorkflowCardCommand({ ...input, command: commandAction });
    return;
  }
  const action = parseCardAction(input.event.action.value);
  if (!action) return;
  const access = decideFeishuAccess(input.config, {
    senderOpenId: input.event.operator.openId,
    chatId: input.event.chatId,
    chatType: 'group',
  });
  if (!access.ok) {
    console.warn(`[interaction] denied card action ${input.event.chatId}; operator=${input.event.operator.openId.slice(-6)}; reason=${access.reason}`);
    return;
  }
  const control = decideFeishuControl(input.config, access, { effect: 'workflow_trigger' });
  if (!control.ok) {
    await input.channel.send(input.event.chatId, { text: `权限不足：${control.reason}` }, { replyTo: input.event.messageId });
    return;
  }

  await input.channel.send(input.event.chatId, { text: `正在运行 ${action.replaceAll('_', ' ')}...` }, { replyTo: input.event.messageId });
  const output = await runWorkflow(input.config, action, { send: false });
  const summary = formatWorkflowSummaryForFeishu(action, todayInTimezone(input.config), output, undefined, input.config);
  await input.channel.send(input.event.chatId, { card: renderFeishuWorkflowCard(summary, { workflow: action, date: todayInTimezone(input.config) }) }, { replyTo: input.event.messageId });
}

async function handleWorkflowCardCommand(input: {
  config: AppConfig;
  channel: LarkChannel;
  event: CardActionEvent;
  activeAgentRuns: Map<string, ActiveAgentRun>;
  command: WorkflowCardCommand;
}): Promise<void> {
  const access = decideFeishuAccess(input.config, {
    senderOpenId: input.event.operator.openId,
    chatId: input.event.chatId,
    chatType: 'group',
  });
  if (!access.ok) {
    console.warn(`[interaction] denied card command ${input.event.chatId}; operator=${input.event.operator.openId.slice(-6)}; reason=${access.reason}`);
    return;
  }
  if (input.command.command === 'details') {
    const detail = input.command.detailId ? readWorkflowDetailCache(input.config, input.command.detailId) : readLatestWorkflowOutput(input.config);
    await input.channel.send(
      input.event.chatId,
      toSendInput(detail ? formatLatestWorkflowDetails(detail) : '老板，目前还没有可展开的最近一次计划/复盘详情。', input.config.interaction.feishu.reply_mode),
      { replyTo: input.event.messageId },
    );
    console.log(`[interaction] handled ${input.event.chatId}; card-command=details; cached=${Boolean(input.command.detailId)}`);
    return;
  }
  if (input.command.command === 'confirm_todo') {
    const date = todayInTimezone(input.config);
    appendDailyMemory(input.config, 'daily_plan', date, '用户已确认今日安排。日复盘时需要用最近一次今日计划作为对照依据。');
    await input.channel.send(input.event.chatId, { text: '收到，今日安排已确认。我会在今日复盘时按这张计划对照完成情况。' }, { replyTo: input.event.messageId });
    console.log(`[interaction] handled ${input.event.chatId}; card-command=confirm_todo`);
    return;
  }
  if (input.command.command === 'confirm_review') {
    const date = todayInTimezone(input.config);
    appendDailyMemory(input.config, 'daily_review', date, '用户确认今日复盘无异议。今天的完成项、暂缓项和后续动作可以按这版记录。');
    await input.channel.send(input.event.chatId, { text: '收到，今日复盘已确认无异议。我会按这版记录今天的进展和未闭环事项。' }, { replyTo: input.event.messageId });
    console.log(`[interaction] handled ${input.event.chatId}; card-command=confirm_review`);
    return;
  }
  if (input.command.command === 'revise_todo') {
    await input.channel.send(
      input.event.chatId,
      {
        text: [
          '可以，直接告诉我你想怎么改。',
          '',
          '例如：',
          '今天先不做 LEO-12，改成优先处理导师邮件。',
          '或者：把 LEO-12 降级，明天再跟进。',
          '',
          '我收到后会先回你确认，并把修改意见写入今天的上下文。之后点「重新生成」或发送 daily-os plan，我会按新意见重排。',
        ].join('\n'),
      },
      { replyTo: input.event.messageId },
    );
    console.log(`[interaction] handled ${input.event.chatId}; card-command=revise_todo`);
    return;
  }
  if (input.command.command === 'progress') {
    const date = todayInTimezone(input.config);
    const progress = await collectProgressCandidates(input.config, date);
    await input.channel.send(input.event.chatId, { card: renderProgressConfirmationCard(input.config, progress) }, { replyTo: input.event.messageId });
    console.log(`[interaction] handled ${input.event.chatId}; card-command=progress-card`);
    return;
  }
  const result = await handleDailyOsCommand({
    config: input.config,
    messageId: input.event.messageId,
    text: `${input.config.interaction.feishu.command_prefix} ${input.command.command}`,
    source: `feishu-card:${input.event.chatId}`,
    prefix: input.config.interaction.feishu.command_prefix,
    sendWorkflowOutput: false,
    accessDecision: access,
    sessionScopeId: input.event.chatId,
    stopAgentRun: async () => stopAgentRun(input.activeAgentRuns, input.event.chatId),
    reply: async (reply) => {
      await input.channel.send(input.event.chatId, toSendInput(reply, input.config.interaction.feishu.reply_mode), {
        replyTo: input.event.messageId,
      });
    },
  });
  if (result.handled) console.log(`[interaction] handled ${input.event.chatId}; card-command=${result.command.type}`);
}

async function handleProgressCardAction(input: {
  config: AppConfig;
  channel: LarkChannel;
  event: CardActionEvent;
  action: { action: 'confirm_all' | 'ignore_all' | 'details' | 'review'; date: string; candidateIds: string[] };
}): Promise<void> {
  const access = decideFeishuAccess(input.config, {
    senderOpenId: input.event.operator.openId,
    chatId: input.event.chatId,
    chatType: 'group',
  });
  if (!access.ok) {
    console.warn(`[interaction] denied progress card action ${input.event.chatId}; operator=${input.event.operator.openId.slice(-6)}; reason=${access.reason}`);
    return;
  }
  const control = decideFeishuControl(input.config, access, { effect: 'memory_write' });
  if (!control.ok) {
    await input.channel.send(input.event.chatId, { text: `权限不足：${control.reason}` }, { replyTo: input.event.messageId });
    return;
  }

  const result = await collectProgressCandidates(input.config, input.action.date);
  const selected = result.candidates.filter((candidate) => input.action.candidateIds.includes(candidate.id));
  if (input.action.action === 'confirm_all') {
    const ledgerPath = appendConfirmedProgress(input.config, input.action.date, confirmedEntriesFromCandidates(selected));
    await input.channel.send(
      input.event.chatId,
      {
        text:
          selected.length > 0
            ? `已确认 ${selected.length} 条今日进展，并写入：${ledgerPath}`
            : '没有可写入的进展候选；可能候选已经变化或为空。',
      },
      { replyTo: input.event.messageId },
    );
    return;
  }
  if (input.action.action === 'details' || input.action.action === 'review') {
    await input.channel.send(input.event.chatId, toSendInput(formatProgressCandidates(result), input.config.interaction.feishu.reply_mode), {
      replyTo: input.event.messageId,
    });
    return;
  }
  await input.channel.send(input.event.chatId, { text: '好的，这次不写入今日进展账本。' }, { replyTo: input.event.messageId });
}

async function handleAgentRunCardAction(input: {
  config: AppConfig;
  channel: LarkChannel;
  event: CardActionEvent;
  queue: PendingQueue<NormalizedMessage>;
  chatModes: Map<string, ChatMode>;
  activeAgentRuns: Map<string, ActiveAgentRun>;
  action: { action: 'stop' | 'followup'; runId: string; scopeId: string; text?: string };
}): Promise<void> {
  const mode = await resolveChatMode(input.channel, input.event.chatId, input.chatModes, 'group');
  const threadId = mode === 'topic' ? await lookupMessageThreadId(input.channel, input.event.messageId) : undefined;
  const scope = mode === 'topic' && threadId ? `${input.event.chatId}:${threadId}` : input.event.chatId;
  const access = decideFeishuAccess(input.config, {
    senderOpenId: input.event.operator.openId,
    chatId: input.event.chatId,
    chatType: mode === 'p2p' ? 'p2p' : 'group',
  });
  if (!access.ok) {
    console.warn(`[interaction] denied agent card action ${input.event.chatId}; operator=${input.event.operator.openId.slice(-6)}; reason=${access.reason}`);
    return;
  }
  if (input.action.action === 'stop') {
    const stopped = await stopAgentRunByScopeOrId(input.activeAgentRuns, scope, input.action.scopeId, input.action.runId);
    await input.channel.send(input.event.chatId, { text: stopped ? '已请求停止当前 Codex 任务。' : '当前没有可停止的 Codex 任务。' }, { replyTo: input.event.messageId });
    return;
  }

  const synthetic: NormalizedMessage = {
    messageId: input.event.messageId,
    chatId: input.event.chatId,
    chatType: mode === 'p2p' ? 'p2p' : 'group',
    senderId: input.event.operator.openId,
    senderName: input.event.operator.name,
    content: `[card-callback] ${JSON.stringify({ action: input.action.action, run_id: input.action.runId, text: input.action.text || '继续讨论' })}`,
    rawContentType: 'card_action',
    resources: [],
    mentions: [],
    mentionAll: false,
    mentionedBot: true,
    createTime: Date.now(),
    ...(threadId ? { threadId } : {}),
  };
  console.log(`[interaction] queued ${scope}; source=agent-card-callback`);
  const queued = input.queue.push(scope, synthetic);
  await input.channel.send(input.event.chatId, { text: `已加入后续消息队列（${queued}）。` }, { replyTo: input.event.messageId });
}

async function lookupMessageThreadId(channel: LarkChannel, messageId: string): Promise<string | undefined> {
  try {
    const response = (await channel.rawClient.im.v1.message.get({
      path: { message_id: messageId },
    })) as { data?: { items?: { thread_id?: string }[] } };
    return response.data?.items?.[0]?.thread_id;
  } catch (error) {
    console.warn(`[interaction] failed to resolve card thread: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

async function sendStatusCard(channel: LarkChannel, message: NormalizedMessage, config: AppConfig): Promise<void> {
  await channel.send(
    message.chatId,
    {
      card: {
        config: { wide_screen_mode: true },
        header: {
          template: 'green',
          title: { tag: 'plain_text', content: 'Daily OS' },
        },
        elements: [
          {
            tag: 'markdown',
            content: [
              '**Daily OS 飞书交互层正在运行。**',
              '',
              `命令前缀：\`${config.interaction.feishu.command_prefix}\``,
              '你可以点击下面按钮，或直接在这个聊天里发送命令。',
            ].join('\n'),
          },
          {
            tag: 'action',
            actions: [
              cardButton('Plan', 'daily_plan', 'primary'),
              cardButton('Review', 'daily_review', 'default'),
              cardButton('Weekly', 'weekly_review', 'default'),
            ],
          },
        ],
      },
    },
    {
      replyTo: message.messageId,
      ...(message.threadId ? { replyInThread: true } : {}),
    },
  );
}

function cardButton(label: string, action: WorkflowName, type: 'primary' | 'default'): object {
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: label },
    type,
    value: { daily_os_action: action },
  };
}

function parseCardAction(value: unknown): WorkflowName | null {
  if (!value || typeof value !== 'object') return null;
  const raw = (value as { daily_os_action?: unknown }).daily_os_action;
  if (raw === 'daily_plan' || raw === 'daily_review' || raw === 'weekly_review') return raw;
  return null;
}

function parseWorkflowCardCommand(value: unknown): WorkflowCardCommand | null {
  if (!value || typeof value !== 'object') return null;
  const raw = (value as { daily_os_command?: unknown }).daily_os_command;
  if (
    raw === 'details' ||
    raw === 'progress' ||
    raw === 'chat todo' ||
    raw === 'chat review' ||
    raw === 'confirm_todo' ||
    raw === 'confirm_review' ||
    raw === 'revise_todo'
  ) {
    const detailId = (value as { detail_id?: unknown }).detail_id;
    return { command: raw, ...(typeof detailId === 'string' && detailId ? { detailId } : {}) };
  }
  return null;
}

function claimCardAction(recent: Map<string, number>, event: CardActionEvent): boolean {
  const now = Date.now();
  for (const [key, expiresAt] of recent) {
    if (expiresAt <= now) recent.delete(key);
  }
  const key = cardActionKey(event);
  if (recent.has(key)) return false;
  recent.set(key, now + CARD_ACTION_DEDUPE_MS);
  return true;
}

function cardActionKey(event: CardActionEvent): string {
  return [event.chatId, event.messageId, event.operator.openId, stableStringify(event.action.value)].join(':');
}

function stableStringify(value: unknown): string {
  if (!value || typeof value !== 'object') return String(value);
  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right));
  return JSON.stringify(Object.fromEntries(entries));
}

async function replyToMessage(channel: LarkChannel, message: NormalizedMessage, text: string, mode: 'markdown' | 'text'): Promise<void> {
  const chatMode = message.threadId ? 'topic' : message.chatType;
  await channel.send(message.chatId, toSendInput(text, mode), {
    replyTo: message.messageId,
    ...(chatMode === 'topic' ? { replyInThread: true } : {}),
  });
}

function toSendInput(text: string, mode: 'markdown' | 'text'): { markdown: string } | { text: string } {
  return mode === 'markdown' ? { markdown: text } : { text };
}

async function resolveChatMode(channel: LarkChannel, chatId: string, cache: Map<string, ChatMode>, fallback: 'p2p' | 'group'): Promise<ChatMode> {
  const cached = cache.get(chatId);
  if (cached) return cached;
  try {
    const mode = await channel.getChatMode(chatId);
    cache.set(chatId, mode);
    return mode;
  } catch {
    cache.set(chatId, fallback);
    return fallback;
  }
}

function scopeFor(message: NormalizedMessage, mode: ChatMode): string {
  return mode === 'topic' && message.threadId ? `${message.chatId}:${message.threadId}` : message.chatId;
}
