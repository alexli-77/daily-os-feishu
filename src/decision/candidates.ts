import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import yaml from 'js-yaml';
import type { AppConfig } from '../config/schema.js';
import { decisionPolicyFiles, ensureDecisionPolicyFiles } from './policy.js';

export type PolicyCandidateStatus = 'pending' | 'confirmed' | 'rejected';

export interface PolicyRuleDraft {
  id?: string;
  description: string;
  applies_to?: string[];
  when?: Record<string, unknown>;
  then?: Record<string, unknown>;
  reason?: string;
}

export interface PolicyRule {
  id: string;
  status: 'active';
  description: string;
  applies_to: string[];
  when: Record<string, unknown>;
  then: Record<string, unknown>;
  reason?: string;
  created_at: string;
  confirmed_at: string;
}

export interface PolicyCandidate {
  id: string;
  status: PolicyCandidateStatus;
  created_at: string;
  updated_at: string;
  source: {
    chat_id: string;
    message_id: string;
    sender_open_id: string;
  };
  raw_user_text: string;
  assistant_reply: string;
  rule: PolicyRuleDraft & { id: string };
  rejection_reason?: string;
  confirmed_at?: string;
  rejected_at?: string;
}

interface CandidateStore {
  version: 1;
  candidates: PolicyCandidate[];
}

interface PolicyDocument {
  version?: number;
  updated_at?: string | null;
  status?: string;
  rules?: unknown;
  [key: string]: unknown;
}

export interface CreatePolicyCandidateInput {
  chatId: string;
  messageId: string;
  senderOpenId: string;
  rawUserText: string;
  assistantReply: string;
  rule: PolicyRuleDraft;
}

export function listPolicyCandidates(config: AppConfig, status?: PolicyCandidateStatus): PolicyCandidate[] {
  ensureDecisionPolicyFiles(config);
  const store = readCandidateStore(config);
  return store.candidates.filter((candidate) => !status || candidate.status === status);
}

export function createPolicyCandidate(config: AppConfig, input: CreatePolicyCandidateInput): PolicyCandidate {
  ensureDecisionPolicyFiles(config);
  const store = readCandidateStore(config);
  const now = new Date().toISOString();
  const id = newPolicyCandidateId();
  const ruleId = normalizeRuleId(input.rule.id) || `rule-${id.slice('pol-'.length)}`;
  const candidate: PolicyCandidate = {
    id,
    status: 'pending',
    created_at: now,
    updated_at: now,
    source: {
      chat_id: input.chatId,
      message_id: input.messageId,
      sender_open_id: input.senderOpenId,
    },
    raw_user_text: input.rawUserText,
    assistant_reply: input.assistantReply,
    rule: {
      id: ruleId,
      description: input.rule.description.trim(),
      applies_to: sanitizeAppliesTo(input.rule.applies_to),
      when: sanitizeRecord(input.rule.when, { event: 'decision_context_matches' }),
      then: sanitizeRecord(input.rule.then, { preference: input.rule.description.trim() }),
      ...(input.rule.reason?.trim() ? { reason: input.rule.reason.trim() } : {}),
    },
  };

  store.candidates.unshift(candidate);
  writeCandidateStore(config, store);
  appendCandidateAudit(config, candidate, 'created');
  return candidate;
}

export function confirmPolicyCandidate(config: AppConfig, id: string): PolicyCandidate {
  ensureDecisionPolicyFiles(config);
  const store = readCandidateStore(config);
  const candidate = findCandidate(store, id);
  if (candidate.status === 'confirmed') return candidate;
  if (candidate.status === 'rejected') throw new Error(`候选规则 ${candidate.id} 已被拒绝，不能再保存。`);

  const now = new Date().toISOString();
  candidate.status = 'confirmed';
  candidate.updated_at = now;
  candidate.confirmed_at = now;
  writeCandidateStore(config, store);
  appendConfirmedRule(config, candidate);
  appendCandidateAudit(config, candidate, 'confirmed');
  return candidate;
}

export function rejectPolicyCandidate(config: AppConfig, id: string, reason?: string): PolicyCandidate {
  ensureDecisionPolicyFiles(config);
  const store = readCandidateStore(config);
  const candidate = findCandidate(store, id);
  if (candidate.status === 'confirmed') throw new Error(`候选规则 ${candidate.id} 已保存为长期规则，不能再拒绝。`);
  const now = new Date().toISOString();
  candidate.status = 'rejected';
  candidate.updated_at = now;
  candidate.rejected_at = now;
  if (reason?.trim()) candidate.rejection_reason = reason.trim();
  writeCandidateStore(config, store);
  appendCandidateAudit(config, candidate, 'rejected');
  return candidate;
}

export function formatPolicyCandidate(candidate: PolicyCandidate): string {
  return [
    `- ${candidate.id} [${candidate.status}]`,
    `  规则：${candidate.rule.description}`,
    `  适用：${candidate.rule.applies_to?.join(', ') || 'daily_plan, todo, review, weekly_review'}`,
    candidate.rule.reason ? `  原因：${candidate.rule.reason}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export function formatPolicyCandidateList(candidates: PolicyCandidate[]): string {
  if (candidates.length === 0) return '当前没有待确认的候选规则。';
  return [
    '待确认候选规则：',
    '',
    ...candidates.map(formatPolicyCandidate),
    '',
    '确认保存：`daily-os 保存规则 <候选ID>`',
    '拒绝候选：`daily-os 拒绝规则 <候选ID>`',
    '在决策校准群里也可以省略 `daily-os` 前缀。',
  ].join('\n');
}

export function policyCandidateStorePath(config: AppConfig): string {
  const files = decisionPolicyFiles(config);
  const parsed = path.parse(files.candidatesPath);
  return path.join(parsed.dir, `${parsed.name}.json`);
}

function readCandidateStore(config: AppConfig): CandidateStore {
  const storePath = policyCandidateStorePath(config);
  if (!fs.existsSync(storePath)) return { version: 1, candidates: [] };
  try {
    const parsed = JSON.parse(fs.readFileSync(storePath, 'utf8')) as Partial<CandidateStore>;
    return {
      version: 1,
      candidates: Array.isArray(parsed.candidates) ? parsed.candidates.filter(isPolicyCandidate) : [],
    };
  } catch {
    return { version: 1, candidates: [] };
  }
}

function writeCandidateStore(config: AppConfig, store: CandidateStore): void {
  const storePath = policyCandidateStorePath(config);
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.writeFileSync(storePath, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
}

function appendConfirmedRule(config: AppConfig, candidate: PolicyCandidate): void {
  const files = decisionPolicyFiles(config);
  const rawPolicy = fs.existsSync(files.policyPath) ? fs.readFileSync(files.policyPath, 'utf8') : '';
  const document = (yaml.load(rawPolicy) || {}) as PolicyDocument;
  const existingRules = Array.isArray(document.rules) ? document.rules : [];
  const rule: PolicyRule = {
    id: candidate.rule.id,
    status: 'active',
    description: candidate.rule.description,
    applies_to: sanitizeAppliesTo(candidate.rule.applies_to),
    when: sanitizeRecord(candidate.rule.when, { event: 'decision_context_matches' }),
    then: sanitizeRecord(candidate.rule.then, { preference: candidate.rule.description }),
    ...(candidate.rule.reason ? { reason: candidate.rule.reason } : {}),
    created_at: candidate.created_at,
    confirmed_at: candidate.confirmed_at || new Date().toISOString(),
  };
  const nextRules = existingRules.filter((item) => !isObject(item) || item.id !== rule.id);
  nextRules.push(rule);
  const nextDocument: PolicyDocument = {
    version: typeof document.version === 'number' ? document.version : 1,
    ...document,
    updated_at: rule.confirmed_at,
    status: 'active',
    rules: nextRules,
  };
  fs.writeFileSync(files.policyPath, yaml.dump(nextDocument, { lineWidth: 120, noRefs: true }), 'utf8');
  appendPolicyNotes(files.notesPath, candidate);
}

function appendPolicyNotes(notesPath: string, candidate: PolicyCandidate): void {
  fs.mkdirSync(path.dirname(notesPath), { recursive: true });
  const lines = [
    '',
    `## 已确认规则：${candidate.rule.id}`,
    '',
    `- 时间：${candidate.confirmed_at || new Date().toISOString()}`,
    `- 描述：${candidate.rule.description}`,
    `- 适用：${candidate.rule.applies_to?.join(', ') || 'daily_plan, todo, review, weekly_review'}`,
  ];
  if (candidate.rule.reason) lines.push(`- 原因：${candidate.rule.reason}`);
  lines.push('');
  fs.appendFileSync(
    notesPath,
    lines.join('\n'),
    'utf8',
  );
}

function appendCandidateAudit(config: AppConfig, candidate: PolicyCandidate, event: 'created' | 'confirmed' | 'rejected'): void {
  const files = decisionPolicyFiles(config);
  fs.mkdirSync(path.dirname(files.candidatesPath), { recursive: true });
  const timestamp = new Date().toISOString();
  fs.appendFileSync(
    files.candidatesPath,
    [
      '',
      `## ${timestamp} ${event}: ${candidate.id}`,
      '',
      `status: ${candidate.status}`,
      `rule_id: ${candidate.rule.id}`,
      '',
      '```json',
      JSON.stringify(candidate, null, 2),
      '```',
      '',
    ].join('\n'),
    'utf8',
  );
}

function findCandidate(store: CandidateStore, id: string): PolicyCandidate {
  const normalized = id.trim();
  const candidate = store.candidates.find((item) => item.id === normalized);
  if (!candidate) throw new Error(`没有找到候选规则：${normalized}`);
  return candidate;
}

function newPolicyCandidateId(): string {
  const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  return `pol-${timestamp}-${randomUUID().slice(0, 8)}`;
}

function normalizeRuleId(raw: string | undefined): string | null {
  if (!raw) return null;
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
  return /^[a-z0-9][a-z0-9-]{2,80}$/.test(normalized) ? normalized : null;
}

function sanitizeAppliesTo(value: unknown): string[] {
  const fallback = ['daily_plan', 'todo', 'daily_review', 'weekly_review'];
  if (!Array.isArray(value)) return fallback;
  const cleaned = value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean);
  return cleaned.length > 0 ? Array.from(new Set(cleaned)) : fallback;
}

function sanitizeRecord(value: unknown, fallback: Record<string, unknown>): Record<string, unknown> {
  if (!isObject(value) || Array.isArray(value)) return fallback;
  return value;
}

function isPolicyCandidate(value: unknown): value is PolicyCandidate {
  if (!isObject(value)) return false;
  return (
    typeof value.id === 'string' &&
    ['pending', 'confirmed', 'rejected'].includes(String(value.status)) &&
    isObject(value.rule) &&
    typeof value.rule.id === 'string' &&
    typeof value.rule.description === 'string'
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
