import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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

export type FeishuControlEffect =
  | 'read'
  | 'workflow_trigger'
  | 'memory_write'
  | 'policy_write'
  | 'interaction_admin'
  | 'workspace_read'
  | 'workspace_write'
  | 'full_control';

export interface FeishuControlRequest {
  effect: FeishuControlEffect;
  workspacePath?: string;
}

export interface FeishuControlDecision {
  ok: boolean;
  reason?: string;
  requiresConfirmation: boolean;
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

export function decideFeishuControl(config: AppConfig, access: FeishuAccessDecision, request: FeishuControlRequest): FeishuControlDecision {
  if (!access.ok) return { ok: false, reason: access.reason || 'Feishu sender is not allowed', requiresConfirmation: false };

  if (access.role === 'allowed_chat' && !['read', 'workflow_trigger'].includes(request.effect)) {
    return {
      ok: false,
      reason: 'allowed_chat can trigger read/workflow commands only; durable writes require owner/admin/allowed_user',
      requiresConfirmation: false,
    };
  }

  if (['policy_write', 'interaction_admin', 'full_control'].includes(request.effect) && !['owner', 'admin'].includes(access.role)) {
    return {
      ok: false,
      reason: `${request.effect} requires owner or admin`,
      requiresConfirmation: false,
    };
  }

  const accessLevel = config.interaction.feishu.security.access_level;
  if (request.effect === 'workspace_read') {
    return workspaceDecision(config, request.workspacePath, false);
  }
  if (request.effect === 'workspace_write') {
    if (accessLevel === 'read_only') {
      return { ok: false, reason: 'workspace writes are blocked while access_level=read_only', requiresConfirmation: false };
    }
    return workspaceDecision(config, request.workspacePath, true);
  }
  if (request.effect === 'full_control') {
    if (accessLevel !== 'full') {
      return { ok: false, reason: 'full control requires access_level=full', requiresConfirmation: false };
    }
    return { ok: true, requiresConfirmation: true };
  }

  return { ok: true, requiresConfirmation: ['memory_write', 'policy_write', 'interaction_admin'].includes(request.effect) };
}

export function isAllowedWorkspace(config: AppConfig, workspacePath: string): boolean {
  const normalizedWorkspace = normalizeWorkspacePath(workspacePath);
  if (!normalizedWorkspace) return false;
  return config.interaction.feishu.security.allowed_workspaces.some((allowed) => {
    const normalizedAllowed = normalizeWorkspacePath(allowed);
    return Boolean(
      normalizedAllowed &&
        (normalizedWorkspace === normalizedAllowed || normalizedWorkspace.startsWith(`${normalizedAllowed}${path.sep}`)),
    );
  });
}

export function feishuSafetyWarnings(config: AppConfig): string[] {
  if (!config.interaction.feishu.enabled) return [];
  const warnings: string[] = [];
  const security = config.interaction.feishu.security;
  if (!hasAnyAccessRule(config)) warnings.push('remote messages are denied until owner/user/chat allow-list is configured');
  if (security.access_level === 'workspace' && security.allowed_workspaces.length === 0) {
    warnings.push('access_level=workspace requires at least one allowed workspace path before workspace writes can run');
  }
  if (security.access_level === 'full') warnings.push('access_level=full should only be used for trusted private deployments');
  if (!config.interaction.feishu.require_mention_in_groups && security.allowed_chat_ids.length > 0) {
    warnings.push('group mention requirement is disabled; every message in allowed chats can be considered by the interaction layer');
  }
  const agent = config.interaction.feishu.agent_mode;
  if (agent.enabled && agent.sandbox !== 'read-only' && security.allowed_workspaces.length === 0) {
    warnings.push('agent_mode write-capable sandbox should be paired with allowed_workspaces');
  }
  if (agent.enabled && agent.sandbox === 'danger-full-access') {
    warnings.push('agent_mode sandbox=danger-full-access can run destructive commands; use only for trusted private deployments');
  }
  return warnings;
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

function workspaceDecision(config: AppConfig, workspacePath: string | undefined, write: boolean): FeishuControlDecision {
  const accessLevel = config.interaction.feishu.security.access_level;
  if (!workspacePath?.trim()) {
    return { ok: false, reason: 'workspace path is required for workspace access', requiresConfirmation: false };
  }
  if (accessLevel === 'full') return { ok: true, requiresConfirmation: write };
  if (write && accessLevel !== 'workspace') {
    return { ok: false, reason: `workspace access requires access_level=workspace or full, current=${accessLevel}`, requiresConfirmation: false };
  }
  if (config.interaction.feishu.security.allowed_workspaces.length > 0 && !isAllowedWorkspace(config, workspacePath)) {
    return { ok: false, reason: 'workspace path is outside interaction.feishu.security.allowed_workspaces', requiresConfirmation: false };
  }
  return { ok: true, requiresConfirmation: write };
}

function normalizeWorkspacePath(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const expanded = trimmed === '~' ? os.homedir() : trimmed.startsWith(`~${path.sep}`) ? path.join(os.homedir(), trimmed.slice(2)) : trimmed;
  const absolute = path.resolve(expanded);
  try {
    return fs.realpathSync.native(absolute);
  } catch {
    return absolute;
  }
}

function containsId(values: string[], id: string): boolean {
  return values.map(normalizeId).includes(id);
}

function normalizeId(value: string): string {
  return value.trim().toLowerCase();
}
