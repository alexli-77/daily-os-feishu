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

interface FeishuInteractionControls {
  stop: () => Promise<void>;
}

type ChatMode = 'p2p' | 'group' | 'topic';

export async function startFeishuInteraction(config: AppConfig): Promise<FeishuInteractionControls> {
  const cfg = config.interaction.feishu;
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
  const queue = new PendingQueue<NormalizedMessage>(cfg.debounce_ms, (scope, batch) => {
    queue.block(scope);
    void runBatch({ config, channel, batch, scope, chatModes })
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
      await intakeMessage({ config, channel, message, queue, chatModes });
    },
    cardAction: async (event) => {
      await handleCardAction({ config, channel, event, chatModes });
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
  if (config.decision.onboarding.auto_create_on_setup) {
    try {
      const result = await startDecisionOnboarding(config, { channel });
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
}): Promise<void> {
  const mode = await resolveChatMode(input.channel, input.message.chatId, input.chatModes, input.message.chatType);
  const scope = scopeFor(input.message, mode);
  const access = decideFeishuAccess(input.config, {
    senderOpenId: input.message.senderId,
    chatId: input.message.chatId,
    chatType: input.message.chatType,
  });
  const isCalibrationChat = isDecisionCalibrationChat(input.config, input.message.chatId);
  if (!access.ok && !isCalibrationChat) {
    console.warn(`[interaction] denied ${scope}; sender=${input.message.senderId.slice(-6)}; reason=${access.reason}`);
    if (input.message.chatType === 'p2p') await replyToMessage(input.channel, input.message, '当前飞书用户尚未启用 Daily OS。', 'text');
    return;
  }

  if (!isCalibrationChat && input.message.chatType !== 'p2p' && input.config.interaction.feishu.require_mention_in_groups && !input.message.mentionedBot) {
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
}): Promise<void> {
  const last = input.batch[input.batch.length - 1];
  if (!last) return;

  const text = input.batch.map((message) => message.content).join('\n').trim();
  const isCalibrationChat = isDecisionCalibrationChat(input.config, last.chatId);
  const session = ensureFeishuSession(input.config, {
    scopeKey: input.scope,
    chatId: last.chatId,
    chatType: last.chatType,
    mode: last.threadId ? 'topic' : last.chatType,
    ...(last.threadId ? { threadId: last.threadId } : {}),
  });
  const commandPrefix = input.config.interaction.feishu.command_prefix;
  const commandText = isCalibrationChat && looksLikeBarePolicyCommand(text) ? `${commandPrefix} ${text}` : text;
  const command = parseDailyOsCommand(commandText, commandPrefix);
  const accessDecision = commandAccessDecision(input.config, last, isCalibrationChat);
  if (command.type === 'status') {
    await sendStatusCard(input.channel, last, input.config);
    console.log(`[interaction] handled ${input.scope}; command=status-card`);
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
    reply: async (reply) => {
      await replyToMessage(input.channel, last, reply, input.config.interaction.feishu.reply_mode);
    },
  });

  if (result.handled) {
    console.log(`[interaction] handled ${input.scope}; command=${result.command.type}`);
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

async function handleCardAction(input: {
  config: AppConfig;
  channel: LarkChannel;
  event: CardActionEvent;
  chatModes: Map<string, ChatMode>;
}): Promise<void> {
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
  await input.channel.send(input.event.chatId, toSendInput(output, input.config.interaction.feishu.reply_mode), { replyTo: input.event.messageId });
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
