import { AppType, Client, Domain, LoggerLevel } from '@larksuiteoapi/node-sdk';
import type { WorkflowName } from '../config/schema.js';

export type FeishuSdkSendMode = 'markdown' | 'text';

export interface FeishuSdkMessageOptions {
  workflow?: WorkflowName;
  date?: string;
  detailId?: string;
}

export interface FeishuSkillCardOptions {
  skillId: string;
  mode: string;
  provider: string;
  inputPackPath: string;
  draftOnly: boolean;
}

export interface FeishuSdkStatus {
  ok: boolean;
  missing: string[];
  detail?: string;
}

export function feishuSdkStatus(): FeishuSdkStatus {
  const missing = ['LARK_APP_ID', 'LARK_APP_SECRET'].filter((key) => !process.env[key]);
  return {
    ok: missing.length === 0,
    missing,
    detail:
      missing.length === 0
        ? 'SDK credentials are configured'
        : `Missing ${missing.join(', ')} for Feishu SDK output`,
  };
}

export async function sendFeishuSdkMessage(input: {
  chatId: string;
  text: string;
  mode: FeishuSdkSendMode;
  options?: FeishuSdkMessageOptions;
}): Promise<void> {
  const client = createFeishuClient();
  const message = sdkMessagePayload(input.text, input.mode, input.options);
  const result = await client.im.v1.message.create({
    params: { receive_id_type: 'chat_id' },
    data: {
      receive_id: input.chatId,
      msg_type: message.msgType,
      content: message.content,
    },
  });
  if (result.code && result.code !== 0) {
    throw new Error(`Feishu SDK send failed: ${result.code} ${result.msg || ''}`.trim());
  }
}

export async function sendFeishuSdkCard(input: { chatId: string; card: object }): Promise<void> {
  const client = createFeishuClient();
  const result = await client.im.v1.message.create({
    params: { receive_id_type: 'chat_id' },
    data: {
      receive_id: input.chatId,
      msg_type: 'interactive',
      content: JSON.stringify(input.card),
    },
  });
  if (result.code && result.code !== 0) {
    throw new Error(`Feishu SDK card send failed: ${result.code} ${result.msg || ''}`.trim());
  }
}

export async function createFeishuSdkPrivateChat(input: {
  name: string;
  description: string;
  ownerOpenId: string;
}): Promise<string> {
  const client = createFeishuClient();
  const result = await client.im.v1.chat.create({
    data: {
      name: input.name,
      description: input.description,
      chat_mode: 'group',
      chat_type: 'private',
      user_id_list: [input.ownerOpenId],
    },
    params: {
      user_id_type: 'open_id',
      set_bot_manager: true,
    },
  });
  if (result.code && result.code !== 0) {
    throw new Error(`Feishu SDK chat.create failed: ${result.code} ${result.msg || ''}`.trim());
  }
  const chatId = result.data?.chat_id;
  if (!chatId) throw new Error(`Feishu SDK chat.create returned no chat_id: ${JSON.stringify(result).slice(0, 300)}`);
  return chatId;
}

function createFeishuClient(): Client {
  const appId = process.env.LARK_APP_ID;
  const appSecret = process.env.LARK_APP_SECRET;
  if (!appId || !appSecret) {
    throw new Error('LARK_APP_ID and LARK_APP_SECRET are required for Feishu SDK output');
  }
  return new Client({
    appId,
    appSecret,
    appType: AppType.SelfBuild,
    domain: Domain.Feishu,
    loggerLevel: LoggerLevel.warn,
  });
}

function sdkMessagePayload(text: string, mode: FeishuSdkSendMode, options?: FeishuSdkMessageOptions): { msgType: string; content: string } {
  if (mode === 'text') return textPayload(text);
  const card = renderFeishuWorkflowCard(text, options);
  const content = JSON.stringify(card);
  // Feishu card bodies are stricter than text messages. When a workflow is
  // unexpectedly large, prefer delivering the message over failing the run.
  if (Buffer.byteLength(content, 'utf8') > 25_000) return textPayload(text);
  return { msgType: 'interactive', content };
}

export function renderFeishuWorkflowCard(text: string, options?: FeishuSdkMessageOptions): object {
  const workflow = options?.workflow;
  const actions = workflow ? workflowActions(workflow, options) : [];
  return {
    config: { wide_screen_mode: true },
    header: {
      template: headerTemplate(workflow),
      title: { tag: 'plain_text', content: cardTitle(workflow) },
    },
    elements: [
      {
        tag: 'markdown',
        content: stripTextOnlyInstructions(text),
      },
      ...(actions.length > 0
        ? [
            { tag: 'hr' },
            { tag: 'action', actions },
            { tag: 'note', elements: [{ tag: 'plain_text', content: '想看原因点详情；想改安排点调整；按钮不可用时直接回复 daily-os details。' }] },
          ]
        : []),
    ],
  };
}

export function renderFeishuSkillCard(text: string, options: FeishuSkillCardOptions): object {
  return {
    config: { wide_screen_mode: true },
    header: {
      template: 'purple',
      title: { tag: 'plain_text', content: `Skill: ${options.skillId}` },
    },
    elements: [
      {
        tag: 'markdown',
        content: [
          stripTextOnlyInstructions(text),
          '',
          '> 本次是草稿模式：还没有写回 Feishu 文档。',
        ].join('\n'),
      },
      { tag: 'hr' },
      {
        tag: 'markdown',
        content: [`Provider：${options.provider}`, `Mode：${options.mode}`, `Input pack：${options.inputPackPath}`].join('\n'),
      },
      {
        tag: 'action',
        actions: [
          cardButton('确认写回', { daily_os_skill_action: 'confirm_writeback', skill_id: options.skillId, mode: options.mode }, 'primary'),
          cardButton('重新生成', { daily_os_skill_action: 'rerun', skill_id: options.skillId, mode: options.mode }, 'default'),
          cardButton('不写回', { daily_os_skill_action: 'dismiss', skill_id: options.skillId, mode: options.mode }, 'default'),
        ],
      },
      {
        tag: 'note',
        elements: [
          {
            tag: 'plain_text',
            content: '写回按钮目前只做确认入口；真正写回 Feishu doc 的执行流会在下一步接入。',
          },
        ],
      },
    ],
  };
}

function workflowActions(workflow: WorkflowName, options?: FeishuSdkMessageOptions): object[] {
  const actions: object[] = [cardButton('看详情', { daily_os_command: 'details', ...(options?.detailId ? { detail_id: options.detailId } : {}) }, 'primary')];
  if (workflow === 'daily_plan') {
    actions.push(cardButton('就按这个来', { daily_os_command: 'confirm_todo' }, 'default'));
    actions.push(cardButton('我要调整', { daily_os_command: 'revise_todo' }, 'default'));
    actions.push(cardButton('今晚复盘', { daily_os_action: 'daily_review' }, 'default'));
  }
  if (workflow === 'daily_review') {
    actions.push(cardButton('无异议，确认复盘', { daily_os_command: 'confirm_review' }, 'default'));
  }
  actions.push(cardButton('重排一次', { daily_os_action: workflow }, 'default'));
  return actions;
}

function cardButton(label: string, value: Record<string, string>, type: 'primary' | 'default'): object {
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: label },
    type,
    value,
  };
}

function cardTitle(workflow?: WorkflowName): string {
  if (workflow === 'daily_plan') return '今日安排';
  if (workflow === 'daily_review') return '今日复盘';
  if (workflow === 'weekly_review') return '本周复盘';
  return 'Daily OS';
}

function headerTemplate(workflow?: WorkflowName): string {
  if (workflow === 'daily_plan') return 'blue';
  if (workflow === 'daily_review') return 'green';
  if (workflow === 'weekly_review') return 'purple';
  return 'wathet';
}

function stripTextOnlyInstructions(text: string): string {
  return text
    .split('\n')
    .filter((line) => !/完整内容我已经保存。需要展开时/.test(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function textPayload(text: string): { msgType: string; content: string } {
  return {
    msgType: 'text',
    content: JSON.stringify({ text }),
  };
}
