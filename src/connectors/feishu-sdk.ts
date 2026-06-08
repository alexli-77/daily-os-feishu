import { AppType, Client, Domain, LoggerLevel } from '@larksuiteoapi/node-sdk';

export type FeishuSdkSendMode = 'markdown' | 'text';

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
}): Promise<void> {
  const client = createFeishuClient();
  const message = sdkMessagePayload(input.text, input.mode);
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

function sdkMessagePayload(text: string, mode: FeishuSdkSendMode): { msgType: string; content: string } {
  if (mode === 'text') return textPayload(text);
  const card = {
    config: { wide_screen_mode: true },
    elements: [
      {
        tag: 'markdown',
        content: text,
      },
    ],
  };
  const content = JSON.stringify(card);
  // Feishu card bodies are stricter than text messages. When a workflow is
  // unexpectedly large, prefer delivering the message over failing the run.
  if (Buffer.byteLength(content, 'utf8') > 25_000) return textPayload(text);
  return { msgType: 'interactive', content };
}

function textPayload(text: string): { msgType: string; content: string } {
  return {
    msgType: 'text',
    content: JSON.stringify({ text }),
  };
}
