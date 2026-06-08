import type { AppConfig } from '../config/schema.js';
import { collectEvidence } from '../workflows/evidence.js';
import type { Evidence, EvidenceSource } from '../workflows/types.js';
import { loadMemory } from '../storage/memory.js';
import { addDays } from '../utils/date.js';

export type ChatSuggestionKind =
  | 'new_task'
  | 'reschedule'
  | 'completion'
  | 'blocker'
  | 'owner_assignment'
  | 'calendar_update'
  | 'document_update'
  | 'conflict';

export type ChatSuggestionTarget = 'todo' | 'daily_plan' | 'calendar' | 'document' | 'linear' | 'memory' | 'review';

export interface ChatContextSuggestion {
  id: string;
  kind: ChatSuggestionKind;
  title: string;
  summary: string;
  targets: ChatSuggestionTarget[];
  confidence: 'low' | 'medium' | 'high';
  owner?: string;
  due?: string;
  evidence: string;
  why: string;
}

export interface ChatContextAnalysisResult {
  date: string;
  mode: ChatAnalysisMode;
  window_label: string;
  suggestions: ChatContextSuggestion[];
  inspected_messages: number;
  unavailable_sources: string[];
}

export type ChatAnalysisMode = 'manual' | 'todo' | 'review';

interface ChatMessageSignal {
  id: string;
  text: string;
  source: string;
  createdAt?: Date;
}

export async function analyzeChatContext(config: AppConfig, date: string, mode = config.chat_analysis.default_mode): Promise<ChatContextAnalysisResult> {
  const evidence = await collectEvidence(config, date);
  const window = chatAnalysisWindow(config, date, mode);
  const messages = filterMessagesByWindow(extractFeishuMessages(evidence), window).slice(0, chatAnalysisMessageLimit(config));
  const context = buildContextIndex(evidence, config);
  const suggestions = messages
    .flatMap((message) => suggestionsFromMessage(message, context))
    .filter((suggestion, index, all) => all.findIndex((candidate) => candidate.id === suggestion.id) === index)
    .sort((a, b) => confidenceRank(b.confidence) - confidenceRank(a.confidence))
    .slice(0, config.chat_analysis.max_suggestions);

  return {
    date,
    mode,
    window_label: window.label,
    suggestions,
    inspected_messages: messages.length,
    unavailable_sources: unavailableSources(evidence),
  };
}

export function formatChatContextAnalysis(result: ChatContextAnalysisResult): string {
  const lines = [
    `# 聊天上下文建议 - ${result.date}`,
    '',
    `模式：${modeLabel(result.mode)}`,
    `时间窗：${result.window_label}`,
    `已检查 ${result.inspected_messages} 条飞书消息。`,
  ];

  if (result.suggestions.length === 0) {
    lines.push('', '暂时没有识别到需要调整 todo、日历或文档的聊天信号。');
  } else {
    lines.push('', '我识别到这些可能需要处理的变化：');
    result.suggestions.forEach((suggestion, index) => {
      lines.push(
        '',
        `${index + 1}. ${kindLabel(suggestion.kind)}：${suggestion.title}`,
        `   - 建议处理：${suggestion.summary}`,
        `   - 目标位置：${suggestion.targets.map(targetLabel).join('、')}`,
        `   - 置信度：${confidenceLabel(suggestion.confidence)}`,
      );
      if (suggestion.owner) lines.push(`   - 负责人：${suggestion.owner}`);
      if (suggestion.due) lines.push(`   - 时间/截止：${suggestion.due}`);
      lines.push(`   - 依据：${suggestion.evidence}`, `   - 原因：${suggestion.why}`);
    });
  }

  if (result.unavailable_sources.length > 0) {
    lines.push('', `缺失/不可用来源：${result.unavailable_sources.join('；')}`);
  }
  lines.push('', '这些只是建议，不会自动修改任务、日历、文档或 Linear。确认后再执行写入。');
  return lines.join('\n');
}

function suggestionsFromMessage(message: ChatMessageSignal, context: string): ChatContextSuggestion[] {
  const text = normalizeText(message.text);
  if (!text || isDailyOsGeneratedText(text)) return [];

  const kind = classifyMessage(text);
  if (!kind) return [];

  const owner = extractOwner(text);
  const due = extractDue(text);
  const targets = inferTargets(kind, text);
  const conflict = hasContextOverlap(text, context) && ['reschedule', 'completion', 'blocker'].includes(kind);
  const confidence = confidenceFor(kind, text, conflict);
  const title = summarizeTitle(text);
  const suggestions: ChatContextSuggestion[] = [
    {
      id: suggestionId(`${kind}:${title}:${message.source}`),
      kind,
      title,
      summary: summaryFor(kind, text),
      targets,
      confidence,
      ...(owner ? { owner } : {}),
      ...(due ? { due } : {}),
      evidence: text.slice(0, 220),
      why: whyFor(kind, conflict),
    },
  ];

  if (conflict) {
    suggestions.push({
      id: suggestionId(`conflict:${title}:${message.source}`),
      kind: 'conflict',
      title,
      summary: '这条聊天信号可能和现有计划、任务或记录里的同名事项不一致，建议人工确认后更新。',
      targets: ['daily_plan', 'todo', 'review'],
      confidence: confidence === 'high' ? 'high' : 'medium',
      ...(owner ? { owner } : {}),
      ...(due ? { due } : {}),
      evidence: text.slice(0, 220),
      why: '聊天里出现延期、完成或阻塞信号，同时现有 evidence 中能找到相似事项。',
    });
  }

  return suggestions;
}

function extractFeishuMessages(evidence: Evidence): ChatMessageSignal[] {
  const out: ChatMessageSignal[] = [];
  for (const [sourceName, source] of Object.entries(evidence.sources)) {
    if (!sourceName.includes('im_history') || source.state !== 'available') continue;
    for (const raw of collectMessageRecords(source.data)) {
      const text = extractText(raw);
      if (!text.trim()) continue;
      const createdAt = extractTimestamp(raw);
      out.push({
        id: extractId(raw) || suggestionId(`${sourceName}:${text}`),
        text,
        source: sourceName,
        ...(createdAt ? { createdAt } : {}),
      });
    }
  }
  return out;
}

interface ChatWindow {
  label: string;
  start?: Date;
  end?: Date;
  requireTimestamp: boolean;
}

function chatAnalysisWindow(config: AppConfig, date: string, mode: ChatAnalysisMode): ChatWindow {
  if (mode === 'todo') {
    const start = zonedDateTime(addDays(date, -1), '00:00', config.user.timezone);
    const plan = zonedDateTime(date, config.workflows.daily_plan.time, config.user.timezone);
    return {
      start,
      end: plan,
      requireTimestamp: true,
      label: `${addDays(date, -1)} 00:00 -> ${date} ${config.workflows.daily_plan.time} (${config.user.timezone})`,
    };
  }
  if (mode === 'review') {
    const start = zonedDateTime(date, config.workflows.daily_plan.time, config.user.timezone);
    const review = zonedDateTime(date, config.workflows.daily_review.time, config.user.timezone);
    const now = new Date();
    const end = now < review ? now : review;
    return {
      start,
      end,
      requireTimestamp: true,
      label: `${date} ${config.workflows.daily_plan.time} -> ${formatWindowEnd(end, config.user.timezone)} (${config.user.timezone})`,
    };
  }
  return {
    requireTimestamp: false,
    label: `最近 ${chatAnalysisMessageLimit(config)} 条已配置 IM history 消息`,
  };
}

function filterMessagesByWindow(messages: ChatMessageSignal[], window: ChatWindow): ChatMessageSignal[] {
  return messages.filter((message) => {
    if (!window.start && !window.end) return true;
    if (!message.createdAt) return !window.requireTimestamp;
    if (window.start && message.createdAt < window.start) return false;
    if (window.end && message.createdAt > window.end) return false;
    return true;
  });
}

function chatAnalysisMessageLimit(config: AppConfig): number {
  return config.chat_analysis.lookback_messages || config.chat_analysis.max_messages;
}

function collectMessageRecords(value: unknown): unknown[] {
  if (Array.isArray(value)) return value.flatMap(collectMessageRecords);
  if (!value || typeof value !== 'object') return [];
  const record = value as Record<string, unknown>;
  const directText = extractText(record);
  const directId = extractId(record);
  const nested = ['items', 'messages', 'data', 'list']
    .flatMap((key) => collectMessageRecords(record[key]))
    .filter(Boolean);
  if (directText && (directId || hasMessageShape(record))) return [record, ...nested];
  return nested;
}

function hasMessageShape(record: Record<string, unknown>): boolean {
  return ['content', 'text', 'message', 'body'].some((key) => key in record);
}

function buildContextIndex(evidence: Evidence, config: AppConfig): string {
  const memory = loadMemory(config);
  const sourceText = Object.entries(evidence.sources)
    .filter(([key, source]) => !key.includes('im_history') && source.state === 'available')
    .map(([key, source]) => `${key}\n${sourcePreview(source)}`)
    .join('\n\n');
  const memoryText = [
    memory.longTerm,
    ...memory.recentDaily.map((entry) => entry.content),
    ...memory.repository.map((entry) => entry.content),
  ].join('\n\n');
  return normalizeText(`${sourceText}\n\n${memoryText}`).slice(0, 60000);
}

function sourcePreview(source: EvidenceSource): string {
  if (typeof source.data === 'string') return source.data.slice(0, 8000);
  try {
    return JSON.stringify(source.data).slice(0, 8000);
  } catch {
    return '';
  }
}

function unavailableSources(evidence: Evidence): string[] {
  return Object.entries(evidence.sources)
    .filter(([, source]) => source.state === 'missing' || source.state === 'error')
    .map(([name, source]) => `${name}${source.detail ? ` (${source.detail})` : ''}`)
    .slice(0, 8);
}

function classifyMessage(text: string): ChatSuggestionKind | null {
  if (/(延期|推迟|改到|改成|下周|明天|今天先不|先不做|postpone|reschedule|defer)/i.test(text)) return 'reschedule';
  if (/(完成了|已完成|搞定|done|finished|merged|上线|发布)/i.test(text)) return 'completion';
  if (/(阻塞|卡住|blocked|blocker|不能继续|等.+确认|缺少|权限不够)/i.test(text)) return 'blocker';
  if (/(负责|跟进|owner|assign|assigned|交给|由.+做)/i.test(text)) return 'owner_assignment';
  if (/(会议|日程|calendar|meeting|约|改时间|明天.*点|今天.*点|下周.*点)/i.test(text)) return 'calendar_update';
  if (/(文档|doc|docs|PRD|方案|记录|补充到|写到|更新.*文档)/i.test(text)) return 'document_update';
  if (/(todo|待办|任务|需要|帮我|麻烦|请|要做|下一步|follow.?up|action item)/i.test(text)) return 'new_task';
  return null;
}

function inferTargets(kind: ChatSuggestionKind, text: string): ChatSuggestionTarget[] {
  const targets = new Set<ChatSuggestionTarget>();
  if (kind === 'calendar_update' || /(会议|日程|calendar|meeting|约|点)/i.test(text)) targets.add('calendar');
  if (kind === 'document_update' || /(文档|doc|PRD|方案|记录)/i.test(text)) targets.add('document');
  if (/(Linear|issue|工单|LEO-|CUTTO-|任务)/i.test(text)) targets.add('linear');
  if (kind === 'completion' || kind === 'reschedule' || kind === 'blocker' || kind === 'conflict') targets.add('daily_plan');
  if (kind !== 'document_update' && kind !== 'calendar_update') targets.add('todo');
  if (kind === 'completion' || kind === 'blocker' || kind === 'conflict') targets.add('review');
  targets.add('memory');
  return [...targets];
}

function confidenceFor(kind: ChatSuggestionKind, text: string, conflict: boolean): 'low' | 'medium' | 'high' {
  let score = conflict ? 2 : 1;
  if (extractDue(text)) score += 1;
  if (extractOwner(text)) score += 1;
  if (/(必须|今天|明天|下周|截止|DDL|urgent|P0|P1|高优|客户)/i.test(text)) score += 1;
  if (kind === 'new_task' && !/(todo|待办|任务|需要|请|帮我|action item)/i.test(text)) score -= 1;
  if (score >= 4) return 'high';
  if (score >= 2) return 'medium';
  return 'low';
}

function hasContextOverlap(text: string, context: string): boolean {
  const keywords = extractKeywords(text);
  if (keywords.length === 0) return false;
  const normalizedContext = context.toLowerCase();
  return keywords.some((keyword) => normalizedContext.includes(keyword.toLowerCase()));
}

function extractKeywords(text: string): string[] {
  const issueKeys = text.match(/[A-Z][A-Z0-9]+-\d+/g) || [];
  const zhTerms = Array.from(text.matchAll(/[\p{Script=Han}A-Za-z0-9_-]{3,20}/gu))
    .map((match) => match[0])
    .filter((term) => !STOP_TERMS.has(term.toLowerCase()))
    .slice(0, 8);
  return [...issueKeys, ...zhTerms];
}

const STOP_TERMS = new Set([
  'daily',
  'today',
  'todo',
  '需要',
  '任务',
  '今天',
  '明天',
  '下周',
  '这个',
  '那个',
  '一下',
  '可以',
  '我们',
  '你们',
]);

function extractOwner(text: string): string | undefined {
  const patterns = [
    /(?:负责人|owner|assignee)[:：]\s*([\p{Script=Han}A-Za-z0-9_.-]{1,30})/iu,
    /([\p{Script=Han}A-Za-z0-9_.-]{1,30})\s*(?:负责|跟进|来做)/u,
    /(?:交给|由)\s*([\p{Script=Han}A-Za-z0-9_.-]{1,30})\s*(?:做|负责|跟进)?/u,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1] && isLikelyOwner(match[1])) return match[1];
  }
  return undefined;
}

function isLikelyOwner(value: string): boolean {
  const owner = value.trim();
  if (!owner || owner.length > 30) return false;
  if (/(现有|规则|不能|作为|完整|今天|明天|这个|那个|需要|任务|文档|日历|计划)/.test(owner)) return false;
  return true;
}

function extractDue(text: string): string | undefined {
  const patterns = [
    /(今天|明天|后天|本周[一二三四五六日天]?|下周[一二三四五六日天]?|周[一二三四五六日天]|月底|上午|下午|晚上|今晚|明早)/,
    /(\d{1,2}[\/.-]\d{1,2}(?:[\/.-]\d{2,4})?)/,
    /(\d{1,2}\s*(?:点|:)\s*\d{0,2})/,
    /(?:deadline|due|DDL|截止)[:：]?\s*([^\s,，。；;]{1,30})/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

function summaryFor(kind: ChatSuggestionKind, text: string): string {
  switch (kind) {
    case 'new_task':
      return '建议新增为待办，或与现有任务合并后进入今日/明日计划。';
    case 'reschedule':
      return '建议检查今日计划和待办，把相关事项推迟、移出 MIT，或改成新的截止时间。';
    case 'completion':
      return '建议确认是否要把相关待办标记完成，并写入今日进展/日复盘。';
    case 'blocker':
      return '建议把它标记为阻塞项，并明确需要谁解除阻塞。';
    case 'owner_assignment':
      return '建议更新负责人或 follow-up 归属，避免责任停留在聊天里。';
    case 'calendar_update':
      return '建议检查是否需要创建或调整日历事件。';
    case 'document_update':
      return '建议检查是否需要更新飞书文档、方案或会议记录。';
    case 'conflict':
      return '建议人工确认聊天中的新决定是否覆盖现有计划。';
  }
}

function whyFor(kind: ChatSuggestionKind, conflict: boolean): string {
  const base: Record<ChatSuggestionKind, string> = {
    new_task: '聊天里出现待办、请求或下一步信号。',
    reschedule: '聊天里出现延期、改期或暂缓信号。',
    completion: '聊天里出现完成、合并、发布或搞定信号。',
    blocker: '聊天里出现阻塞、权限、等待确认或无法推进信号。',
    owner_assignment: '聊天里出现负责人或跟进人信号。',
    calendar_update: '聊天里出现会议、日程或时间安排信号。',
    document_update: '聊天里出现文档、方案或记录更新信号。',
    conflict: '聊天内容可能和现有计划或任务状态不一致。',
  };
  return conflict ? `${base[kind]} 同时 evidence 中存在相似事项，建议确认是否冲突。` : base[kind];
}

function summarizeTitle(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .replace(/^daily-os\s+/i, '')
    .slice(0, 80);
}

function normalizeText(text: string): string {
  return text
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function isDailyOsGeneratedText(text: string): boolean {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return (
    /^(?:\/?daily-os|@daily-os)\b/i.test(normalized) ||
    /^(#\s*)?(今日计划|日复盘|周复盘|聊天上下文建议|今日进展候选|Daily OS 正在运行|Codex 正在处理)/i.test(normalized) ||
    /^老板[，,]?(?:您好)?[，,]?我帮您(?:整理|检查|看了|确认|分析)/.test(normalized) ||
    /^老板[，,]?这是最近一次\s*(今日计划|日复盘|周复盘)/.test(normalized) ||
    /^\d{4}-\d{2}-\d{2}\s+(今日计划|日复盘|聊天上下文建议)/.test(normalized) ||
    /\*\*(MIT|Main Plan|Missing Sources|What changed today)\*\*/i.test(normalized) ||
    /完整内容我已经保存/.test(normalized) ||
    /需要展开时[，,]?请回复/.test(normalized) ||
    /今天还没有确认过的进展记录/.test(normalized) ||
    /这些还不能直接当事实[，,]?需要您批示确认/.test(normalized) ||
    /这些只是建议，不会自动修改任务、日历、文档或 Linear/.test(normalized)
  );
}

function extractId(raw: unknown): string {
  if (!raw || typeof raw !== 'object') return '';
  const record = raw as Record<string, unknown>;
  for (const key of ['message_id', 'messageId', 'id']) {
    const value = record[key];
    if (typeof value === 'string') return value;
  }
  return '';
}

function extractTimestamp(raw: unknown): Date | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const record = raw as Record<string, unknown>;
  for (const key of ['create_time', 'createTime', 'created_at', 'createdAt', 'timestamp', 'send_time', 'update_time']) {
    const date = dateFromTimestampValue(record[key]);
    if (date) return date;
  }
  return undefined;
}

function dateFromTimestampValue(value: unknown): Date | undefined {
  if (typeof value === 'number') {
    const ms = value < 10_000_000_000 ? value * 1000 : value;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? undefined : date;
  }
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (/^\d+$/.test(trimmed)) return dateFromTimestampValue(Number(trimmed));
  const date = new Date(trimmed);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function extractText(value: unknown): string {
  if (typeof value === 'string') {
    const parsed = tryParseJson(value);
    return parsed ? extractText(parsed) : value;
  }
  if (Array.isArray(value)) return value.map(extractText).filter(Boolean).join(' ');
  if (!value || typeof value !== 'object') return '';
  const record = value as Record<string, unknown>;
  const direct = [record.text, record.content, record.title, record.message, record.body]
    .map(extractText)
    .filter(Boolean)
    .join(' ');
  if (direct) return direct;
  return '';
}

function tryParseJson(value: string): unknown | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return null;
  }
}

function suggestionId(seed: string): string {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) >>> 0;
  }
  return `cs_${hash.toString(16).padStart(8, '0')}`;
}

function confidenceRank(value: 'low' | 'medium' | 'high'): number {
  return value === 'high' ? 3 : value === 'medium' ? 2 : 1;
}

function kindLabel(kind: ChatSuggestionKind): string {
  const labels: Record<ChatSuggestionKind, string> = {
    new_task: '新增待办',
    reschedule: '计划变更',
    completion: '完成信号',
    blocker: '阻塞信号',
    owner_assignment: '负责人变更',
    calendar_update: '日历建议',
    document_update: '文档建议',
    conflict: '潜在冲突',
  };
  return labels[kind];
}

function targetLabel(target: ChatSuggestionTarget): string {
  const labels: Record<ChatSuggestionTarget, string> = {
    todo: '待办',
    daily_plan: '今日计划',
    calendar: '日历',
    document: '文档',
    linear: 'Linear',
    memory: '记忆库',
    review: '复盘',
  };
  return labels[target];
}

function confidenceLabel(confidence: 'low' | 'medium' | 'high'): string {
  if (confidence === 'high') return '高';
  if (confidence === 'medium') return '中';
  return '低';
}

function modeLabel(mode: ChatAnalysisMode): string {
  if (mode === 'todo') return '制定 Todo';
  if (mode === 'review') return '日复盘';
  return '手动分析';
}

function formatWindowEnd(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

function zonedDateTime(date: string, time: string, timeZone: string): Date {
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  const desired = Date.UTC(year, month - 1, day, hour || 0, minute || 0, 0);
  const utcGuess = new Date(desired);
  const actual = zonedPartsAsUtc(utcGuess, timeZone);
  return new Date(utcGuess.getTime() - (actual - desired));
}

function zonedPartsAsUtc(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const part = (type: string): number => Number(parts.find((item) => item.type === type)?.value || 0);
  return Date.UTC(part('year'), part('month') - 1, part('day'), part('hour'), part('minute'), part('second'));
}
