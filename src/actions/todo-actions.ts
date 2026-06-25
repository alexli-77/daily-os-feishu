import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { AppConfig } from '../config/schema.js';
import { openTodoInboxItems, type TodoInboxItem } from '../todo/inbox.js';

export type TodoAiActionProvider = 'codex' | 'claude' | 'hermes' | 'manual';
export type TodoAiActionKind = 'email_draft' | 'doc_draft' | 'research_brief' | 'code_change' | 'checklist' | 'workflow_handoff';
export type TodoAiActionStatus = 'drafted' | 'confirmed';
export type TodoAiActionSafety = 'draft_only' | 'external_write_blocked';

export type TodoAiActionCommand =
  | { type: 'list' }
  | { type: 'draft'; target: string }
  | { type: 'confirm'; target: string };

export interface TodoAiActionCandidate {
  index: number;
  todo: TodoInboxItem;
  kind: TodoAiActionKind;
  provider: TodoAiActionProvider;
  title: string;
  reason: string;
  safety: TodoAiActionSafety;
}

export interface TodoAiActionRecord {
  id: string;
  created_at: string;
  updated_at: string;
  todo_id: string;
  todo_text: string;
  kind: TodoAiActionKind;
  provider: TodoAiActionProvider;
  status: TodoAiActionStatus;
  safety: TodoAiActionSafety;
  title: string;
  draft: string;
  source: string;
  message_id?: string;
}

export function parseTodoAiActionCommand(text: string): TodoAiActionCommand | null {
  const normalized = text.replace(/\s+/g, ' ').trim();
  const lower = normalized.toLowerCase();
  if (['actions', 'todo actions', 'ai actions', '可执行任务', 'ai 可执行任务', 'ai可执行任务', '能让 ai 做什么', '能让ai做什么'].includes(lower)) {
    return { type: 'list' };
  }

  const draft =
    normalized.match(/^(?:action\s+draft|draft\s+action|prepare\s+action|ai\s+draft)[:：]?\s*(.+)$/i) ||
    normalized.match(/^(?:让\s*ai\s*做|准备执行|生成执行草稿|起草执行)[:：]?\s*(.+)$/i);
  if (draft?.[1]?.trim()) return { type: 'draft', target: draft[1].trim() };

  const confirm =
    normalized.match(/^(?:action\s+confirm|confirm\s+action)[:：]?\s*(.+)$/i) ||
    normalized.match(/^(?:确认执行|确认这个执行草稿)[:：]?\s*(.+)$/i);
  if (confirm?.[1]?.trim()) return { type: 'confirm', target: confirm[1].trim() };

  return null;
}

export function listTodoAiActionCandidates(config: AppConfig): TodoAiActionCandidate[] {
  if (!config.ai_actions.enabled) return [];
  return openTodoInboxItems(config)
    .filter((item) => item.type !== 'note' && item.type !== 'time_boundary')
    .map((todo, index) => {
      const kind = classifyTodoAction(todo);
      return {
        index: index + 1,
        todo,
        kind,
        provider: config.ai_actions.default_provider,
        title: actionTitle(todo, kind),
        reason: actionReason(kind),
        safety: config.ai_actions.dry_run ? 'draft_only' : 'external_write_blocked',
      };
    });
}

export function formatTodoAiActionCandidates(config: AppConfig): string {
  if (!config.ai_actions.enabled) return 'ai_actions.enabled=false；AI 可执行任务已禁用。';
  const candidates = listTodoAiActionCandidates(config);
  if (!candidates.length) return '目前 Todo Inbox 里没有适合交给 AI 起草的 open todo。';

  return [
    '这些 Todo 可以先让 AI 起草，但当前版本不会自动外发或写入外部系统。',
    '',
    ...candidates.map(
      (candidate) =>
        `${candidate.index}. ${kindLabel(candidate.kind)} | ${providerLabel(candidate.provider)}：${candidate.title}\n` +
        `   原因：${candidate.reason}\n` +
        `   准备草稿：daily-os action draft ${candidate.index}`,
    ),
  ].join('\n');
}

export function prepareTodoAiActionDraft(
  config: AppConfig,
  target: string,
  meta: { source: string; messageId?: string } = { source: 'manual' },
): { handled: boolean; reply: string; action?: TodoAiActionRecord } {
  if (!config.ai_actions.enabled) return { handled: true, reply: 'ai_actions.enabled=false；AI 可执行任务已禁用。' };
  const candidate = findCandidate(config, target);
  if (!candidate) return { handled: true, reply: `没有找到可起草的 open todo：${target}` };

  const now = new Date().toISOString();
  const action: TodoAiActionRecord = {
    id: `act-${now.replace(/[-:.TZ]/g, '').slice(0, 14)}-${crypto.randomBytes(3).toString('hex')}`,
    created_at: now,
    updated_at: now,
    todo_id: candidate.todo.id,
    todo_text: candidate.todo.text,
    kind: candidate.kind,
    provider: candidate.provider,
    status: 'drafted',
    safety: 'draft_only',
    title: candidate.title,
    draft: buildActionDraft(candidate),
    source: meta.source,
    ...(meta.messageId ? { message_id: meta.messageId } : {}),
  };
  appendActionRecord(config, action);

  return {
    handled: true,
    action,
    reply: [
      `已生成 AI 执行草稿：${action.id}`,
      '',
      `类型：${kindLabel(action.kind)}；建议执行器：${providerLabel(action.provider)}`,
      '安全边界：当前只生成草稿，不会自动外发，也不会自动改外部系统。',
      '',
      action.draft,
      '',
      `确认这个草稿：daily-os action confirm ${action.id}`,
    ].join('\n'),
  };
}

export function confirmTodoAiActionDraft(config: AppConfig, target: string): { handled: boolean; reply: string; action?: TodoAiActionRecord } {
  if (!config.ai_actions.enabled) return { handled: true, reply: 'ai_actions.enabled=false；AI 可执行任务已禁用。' };
  const action = findActionRecord(config, target);
  if (!action) return { handled: true, reply: `没有找到 AI 执行草稿：${target}` };

  const now = new Date().toISOString();
  const confirmed: TodoAiActionRecord = {
    ...action,
    updated_at: now,
    status: 'confirmed',
  };
  appendActionRecord(config, confirmed);
  return {
    handled: true,
    action: confirmed,
    reply: [
      `已确认 AI 执行草稿：${confirmed.id}`,
      '',
      '下一步：把这段草稿交给对应执行器处理。',
      `建议执行器：${providerLabel(confirmed.provider)}`,
      '当前 Daily OS 仍不会自动外发邮件、修改文档或执行代码。',
    ].join('\n'),
  };
}

export function listTodoAiActionRecords(config: AppConfig): TodoAiActionRecord[] {
  const ledgerPath = path.resolve(config.ai_actions.ledger_path);
  if (!fs.existsSync(ledgerPath)) return [];
  return fs
    .readFileSync(ledgerPath, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as TodoAiActionRecord;
      } catch {
        return null;
      }
    })
    .filter((record): record is TodoAiActionRecord => Boolean(record?.id && record.todo_id && record.draft));
}

function findCandidate(config: AppConfig, target: string): TodoAiActionCandidate | null {
  const candidates = listTodoAiActionCandidates(config);
  const normalized = normalizeMatchText(target);
  const index = Number.parseInt(target, 10);
  if (Number.isInteger(index) && index > 0) return candidates[index - 1] || null;
  return (
    candidates.find((candidate) => candidate.todo.id === target || candidate.todo.id.endsWith(target)) ||
    candidates.find((candidate) => normalizeMatchText(candidate.todo.text).includes(normalized)) ||
    null
  );
}

function findActionRecord(config: AppConfig, target: string): TodoAiActionRecord | null {
  const normalized = normalizeMatchText(target);
  const records = listTodoAiActionRecords(config).reverse();
  return (
    records.find((record) => record.id === target || record.id.endsWith(target)) ||
    records.find((record) => normalizeMatchText(record.title).includes(normalized)) ||
    null
  );
}

function appendActionRecord(config: AppConfig, record: TodoAiActionRecord): void {
  const ledgerPath = path.resolve(config.ai_actions.ledger_path);
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  fs.appendFileSync(ledgerPath, `${JSON.stringify(record)}\n`, 'utf8');
}

function classifyTodoAction(todo: TodoInboxItem): TodoAiActionKind {
  const text = todo.text.toLowerCase();
  if (/邮件|email|mail|回复|联系|导师|heng li|bei/.test(text)) return 'email_draft';
  if (/代码|修复|bug|测试|test|pr|github|实现|release/.test(text)) return 'code_change';
  if (/文档|doc|weekly|portfolio|页面|方案|整理|feishu/.test(text)) return 'doc_draft';
  if (/报销|费用|清单|checklist|材料|申请|预约|提交/.test(text)) return 'checklist';
  if (todo.type === 'reminder') return 'workflow_handoff';
  return 'research_brief';
}

function actionTitle(todo: TodoInboxItem, kind: TodoAiActionKind): string {
  if (kind === 'email_draft') return `${todo.text}：起草邮件/回复草稿`;
  if (kind === 'code_change') return `${todo.text}：整理实现步骤和验证清单`;
  if (kind === 'doc_draft') return `${todo.text}：起草文档更新内容`;
  if (kind === 'checklist') return `${todo.text}：生成办理清单`;
  if (kind === 'workflow_handoff') return `${todo.text}：生成提醒和下一步`;
  return `${todo.text}：整理研究/执行 brief`;
}

function actionReason(kind: TodoAiActionKind): string {
  if (kind === 'email_draft') return '这类任务通常可以先由 AI 准备草稿，再由用户检查发送。';
  if (kind === 'code_change') return '这类任务适合先拆成执行步骤、风险点和测试清单。';
  if (kind === 'doc_draft') return '这类任务适合先由 AI 起草结构和候选内容。';
  if (kind === 'checklist') return '这类任务适合先生成提交前 checklist，避免漏材料。';
  if (kind === 'workflow_handoff') return '这类任务适合生成提醒和可执行下一步。';
  return '这类任务适合先整理成简短背景、目标和下一步。';
}

function buildActionDraft(candidate: TodoAiActionCandidate): string {
  const common = [`目标：${candidate.todo.text}`, `产物：${candidate.title}`];
  if (candidate.kind === 'email_draft') {
    return [...common, '草稿要求：语气自然、简洁；先说明背景，再列出需要对方确认的 3-5 个问题；最后给出下一步时间点。'].join('\n');
  }
  if (candidate.kind === 'code_change') {
    return [...common, '草稿要求：列出改动范围、不可做的危险动作、验证命令和回滚点；实现前先确认是否会影响 launchd 服务。'].join('\n');
  }
  if (candidate.kind === 'doc_draft') {
    return [...common, '草稿要求：先列现状，再列要补的条目；每条都说明来源、需要确认的人和完成标准。'].join('\n');
  }
  if (candidate.kind === 'checklist') {
    return [...common, '草稿要求：列出提交前材料、入口、截止时间、缺失项和完成后如何标记 done。'].join('\n');
  }
  if (candidate.kind === 'workflow_handoff') {
    return [...common, '草稿要求：把提醒改写成明确时间、地点/对象、下一步动作和完成判断。'].join('\n');
  }
  return [...common, '草稿要求：整理背景、关键信息、可选路径、建议下一步和需要用户确认的问题。'].join('\n');
}

function kindLabel(kind: TodoAiActionKind): string {
  if (kind === 'email_draft') return '邮件草稿';
  if (kind === 'doc_draft') return '文档草稿';
  if (kind === 'research_brief') return '研究 brief';
  if (kind === 'code_change') return '代码任务';
  if (kind === 'checklist') return '办理清单';
  return '提醒交接';
}

function providerLabel(provider: TodoAiActionProvider): string {
  if (provider === 'codex') return 'Codex';
  if (provider === 'claude') return 'Claude';
  if (provider === 'hermes') return 'Hermes';
  return '手动';
}

function normalizeMatchText(value: string): string {
  return value.replace(/[“”"'`。 ，,；;:：#]/g, '').toLowerCase();
}
