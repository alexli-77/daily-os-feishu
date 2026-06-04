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
import { decideFeishuAccess } from './access-policy.js';

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
        if (last) await replyToMessage(channel, last, `Daily OS failed: ${message}`, 'text');
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
  console.log('daily-os-feishu Feishu interaction layer started.');

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
  if (!access.ok) {
    console.warn(`[interaction] denied ${scope}; sender=${input.message.senderId.slice(-6)}; reason=${access.reason}`);
    if (input.message.chatType === 'p2p') await replyToMessage(input.channel, input.message, 'Daily OS is not enabled for this Feishu user.', 'text');
    return;
  }

  if (input.message.chatType !== 'p2p' && input.config.interaction.feishu.require_mention_in_groups && !input.message.mentionedBot) {
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
  const command = parseDailyOsCommand(text, input.config.interaction.feishu.command_prefix);
  if (command.type === 'status') {
    await sendStatusCard(input.channel, last, input.config);
    console.log(`[interaction] handled ${input.scope}; command=status-card`);
    return;
  }

  const result = await handleDailyOsCommand({
    config: input.config,
    messageId: last.messageId,
    text,
    source: `feishu-interaction:${input.scope}`,
    prefix: input.config.interaction.feishu.command_prefix,
    sendWorkflowOutput: false,
    reply: async (reply) => {
      await replyToMessage(input.channel, last, reply, input.config.interaction.feishu.reply_mode);
    },
  });

  if (result.handled) {
    console.log(`[interaction] handled ${input.scope}; command=${result.command.type}`);
  }
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

  await input.channel.send(input.event.chatId, { text: `Running ${action.replaceAll('_', ' ')}...` }, { replyTo: input.event.messageId });
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
              '**Daily OS interaction layer is running.**',
              '',
              `Command prefix: \`${config.interaction.feishu.command_prefix}\``,
              'Use the buttons below or send a command in this chat.',
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
