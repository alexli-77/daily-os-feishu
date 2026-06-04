import type { AppConfig } from '../config/schema.js';

export interface FeishuAccessSubject {
  senderOpenId: string;
  chatId: string;
  chatType: 'p2p' | 'group';
}

export interface FeishuAccessDecision {
  ok: boolean;
  role: 'owner' | 'admin' | 'allowed_user' | 'allowed_chat' | 'denied';
  reason?: string;
}

export function decideFeishuAccess(config: AppConfig, subject: FeishuAccessSubject): FeishuAccessDecision {
  const security = config.interaction.feishu.security;
  const ownerOpenId = process.env[security.owner_open_id_env]?.trim();
  const sender = normalizeId(subject.senderOpenId);
  const chat = normalizeId(subject.chatId);

  if (ownerOpenId && sender === normalizeId(ownerOpenId)) return { ok: true, role: 'owner' };
  if (containsId(security.admin_open_ids, sender)) return { ok: true, role: 'admin' };
  if (containsId(security.allowed_user_open_ids, sender)) return { ok: true, role: 'allowed_user' };
  if (containsId(security.allowed_chat_ids, chat)) return { ok: true, role: 'allowed_chat' };

  return {
    ok: false,
    role: 'denied',
    reason: hasAnyAccessRule(config) ? 'not in Feishu interaction allowlist' : 'no Feishu interaction allowlist configured',
  };
}

export function hasAnyAccessRule(config: AppConfig): boolean {
  const security = config.interaction.feishu.security;
  return Boolean(
    process.env[security.owner_open_id_env]?.trim() ||
      security.admin_open_ids.length > 0 ||
      security.allowed_user_open_ids.length > 0 ||
      security.allowed_chat_ids.length > 0,
  );
}

export function summarizeFeishuAccess(config: AppConfig): string {
  const security = config.interaction.feishu.security;
  const parts = [
    `access=${security.access_level}`,
    `owner_env=${security.owner_open_id_env}${process.env[security.owner_open_id_env] ? ':set' : ':missing'}`,
    `admins=${security.admin_open_ids.length}`,
    `users=${security.allowed_user_open_ids.length}`,
    `chats=${security.allowed_chat_ids.length}`,
    `workspaces=${security.allowed_workspaces.length}`,
  ];
  return parts.join(', ');
}

function containsId(values: string[], id: string): boolean {
  return values.map(normalizeId).includes(id);
}

function normalizeId(value: string): string {
  return value.trim().toLowerCase();
}
