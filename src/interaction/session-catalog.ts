import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { AppConfig } from '../config/schema.js';

export interface FeishuScopeDescriptor {
  scopeKey: string;
  chatId: string;
  chatType: 'p2p' | 'group';
  mode: 'p2p' | 'group' | 'topic';
  threadId?: string;
}

export interface FeishuSessionRecord {
  scope_id: string;
  scope_hash: string;
  chat_id: string;
  chat_type: 'p2p' | 'group';
  mode: 'p2p' | 'group' | 'topic';
  thread_id?: string;
  codex_session_id?: string;
  workdir?: string;
  policy_signature: string;
  created_at: string;
  updated_at: string;
  archived_at?: string;
  archive_reason?: string;
}

interface FeishuSessionCatalog {
  version: 1;
  active: Record<string, FeishuSessionRecord>;
  archived: FeishuSessionRecord[];
}

export function ensureFeishuSession(
  config: AppConfig,
  descriptor: FeishuScopeDescriptor,
  options: { workdir?: string; codexSessionId?: string } = {},
): FeishuSessionRecord {
  const catalog = readCatalog(config);
  const scopeId = scopeIdFor(descriptor.scopeKey);
  const now = new Date().toISOString();
  const nextPolicySignature = policySignature(config);
  const nextWorkdir = normalizeOptionalPath(options.workdir);
  const existing = catalog.active[scopeId];

  if (existing && (existing.policy_signature !== nextPolicySignature || normalizeOptionalPath(existing.workdir) !== nextWorkdir)) {
    archiveRecord(catalog, existing, existing.policy_signature !== nextPolicySignature ? 'policy_changed' : 'workdir_changed');
    delete catalog.active[scopeId];
  }

  const current = catalog.active[scopeId];
  if (current) {
    current.updated_at = now;
    if (options.codexSessionId) current.codex_session_id = options.codexSessionId;
    writeCatalog(config, catalog);
    return current;
  }

  const created: FeishuSessionRecord = {
    scope_id: scopeId,
    scope_hash: hashValue(descriptor.scopeKey),
    chat_id: descriptor.chatId,
    chat_type: descriptor.chatType,
    mode: descriptor.mode,
    ...(descriptor.threadId ? { thread_id: descriptor.threadId } : {}),
    ...(options.codexSessionId ? { codex_session_id: options.codexSessionId } : {}),
    ...(nextWorkdir ? { workdir: nextWorkdir } : {}),
    policy_signature: nextPolicySignature,
    created_at: now,
    updated_at: now,
  };
  catalog.active[scopeId] = created;
  writeCatalog(config, catalog);
  return created;
}

export function clearFeishuSession(config: AppConfig, scopeId: string, reason = 'manual_new'): boolean {
  const catalog = readCatalog(config);
  const existing = catalog.active[scopeId];
  if (!existing) return false;
  archiveRecord(catalog, existing, reason);
  delete catalog.active[scopeId];
  writeCatalog(config, catalog);
  return true;
}

export function activeFeishuSession(config: AppConfig, scopeId: string): FeishuSessionRecord | null {
  const catalog = readCatalog(config);
  return catalog.active[scopeId] || null;
}

export function feishuSessionCatalogPath(config: AppConfig): string {
  return path.resolve(config.interaction.feishu.session_catalog_path);
}

export function scopeIdFor(scopeKey: string): string {
  return `fs_${hashValue(scopeKey).slice(0, 24)}`;
}

function readCatalog(config: AppConfig): FeishuSessionCatalog {
  const catalogPath = feishuSessionCatalogPath(config);
  if (!fs.existsSync(catalogPath)) return { version: 1, active: {}, archived: [] };
  try {
    const parsed = JSON.parse(fs.readFileSync(catalogPath, 'utf8')) as Partial<FeishuSessionCatalog>;
    return {
      version: 1,
      active: isObject(parsed.active) ? filterRecords(parsed.active) : {},
      archived: Array.isArray(parsed.archived) ? parsed.archived.filter(isSessionRecord).slice(-100) : [],
    };
  } catch {
    return { version: 1, active: {}, archived: [] };
  }
}

function writeCatalog(config: AppConfig, catalog: FeishuSessionCatalog): void {
  const catalogPath = feishuSessionCatalogPath(config);
  fs.mkdirSync(path.dirname(catalogPath), { recursive: true });
  const trimmed = { ...catalog, archived: catalog.archived.slice(-100) };
  fs.writeFileSync(catalogPath, `${JSON.stringify(trimmed, null, 2)}\n`, 'utf8');
}

function archiveRecord(catalog: FeishuSessionCatalog, record: FeishuSessionRecord, reason: string): void {
  catalog.archived.push({
    ...record,
    archived_at: new Date().toISOString(),
    archive_reason: reason,
  });
}

function filterRecords(value: Record<string, unknown>): Record<string, FeishuSessionRecord> {
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, FeishuSessionRecord] => isSessionRecord(entry[1])));
}

function isSessionRecord(value: unknown): value is FeishuSessionRecord {
  return (
    isObject(value) &&
    typeof value.scope_id === 'string' &&
    typeof value.scope_hash === 'string' &&
    typeof value.chat_id === 'string' &&
    typeof value.chat_type === 'string' &&
    typeof value.mode === 'string' &&
    typeof value.policy_signature === 'string' &&
    typeof value.created_at === 'string' &&
    typeof value.updated_at === 'string'
  );
}

function policySignature(config: AppConfig): string {
  const security = config.interaction.feishu.security;
  return hashValue(
    JSON.stringify({
      command_prefix: config.interaction.feishu.command_prefix,
      require_mention_in_groups: config.interaction.feishu.require_mention_in_groups,
      access_level: security.access_level,
      allowed_workspaces: security.allowed_workspaces.map(normalizeOptionalPath).sort(),
      llm_provider: config.llm.provider,
      llm_model: config.llm.model,
    }),
  );
}

function normalizeOptionalPath(value: string | undefined): string | undefined {
  return value?.trim() ? path.resolve(value) : undefined;
}

function hashValue(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
