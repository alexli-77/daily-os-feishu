import fs from 'node:fs';
import path from 'node:path';
import type { AppConfig } from '../config/schema.js';
import { collectEvidence } from '../workflows/evidence.js';
import type { Evidence, EvidenceSource } from '../workflows/types.js';
import { todayInTimezone, addDays } from '../utils/date.js';
import { runCommand } from '../utils/command.js';
import { openTodoInboxItems } from '../todo/inbox.js';

export type CalendarDraftPeriod = 'week' | 'today';

export interface CalendarDraftResult {
  period: CalendarDraftPeriod;
  date: string;
  command: string;
  inputPath: string;
  markdown: string;
  draft?: CalendarDraft;
  taskCount: number;
  existingEventCount: number;
}

export interface CalendarDraft {
  draftId: string;
  mode: string;
  period: string;
  timezone: string;
  events: CalendarDraftEvent[];
  warnings: string[];
  writeback?: { supported?: boolean; reason?: string };
}

export interface CalendarDraftEvent {
  title: string;
  start: string;
  end: string;
  type: string;
  sourceTaskIds: string[];
  confidence: string;
  warnings: string[];
}

interface CalendarDraftInput {
  period: 'week' | 'day';
  timezone: string;
  policy: Record<string, unknown>;
  tasks: CalendarTask[];
  existingEvents: CalendarExistingEvent[];
  constraints: { startDate: string; days: number };
  evidence: Record<string, unknown>;
}

interface CalendarTask {
  id: string;
  title: string;
  type: 'deep_work' | 'admin' | 'review';
  priority: 'P0' | 'P1' | 'P2' | 'P3';
  estimatedMinutes: number;
  source: string;
  dueDate?: string;
  preferredDate?: string;
}

interface CalendarExistingEvent {
  title: string;
  start: string;
  end: string;
}

export async function runCalendarDraft(config: AppConfig, period: CalendarDraftPeriod): Promise<CalendarDraftResult> {
  if (!config.calendar.enabled) throw new Error('calendar.enabled=false；Calendar bridge is disabled.');

  const date = todayInTimezone(config);
  const evidence = await collectEvidence(config, date);
  const input = buildCalendarDraftInput(config, evidence, period, date);
  const inputPath = writeCalendarInput(config, input);
  const command = period === 'week' ? 'draft-week' : 'draft-day';
  const args = [resolveCalendarCliPath(config), command, '--input', inputPath, '--format', 'both'];

  if (config.calendar.engine.policy_file.trim()) args.push('--policy-file', config.calendar.engine.policy_file.trim());
  if (config.calendar.engine.routines_file.trim()) args.push('--routines-file', config.calendar.engine.routines_file.trim());

  const result = await runCommand(config.calendar.engine.command, args, {
    cwd: resolveCalendarWorkdir(config),
    timeoutMs: config.calendar.engine.timeout_ms,
    env: process.env,
  });
  if (!result.ok) {
    throw new Error(`calendar-planning-os failed: ${(result.stderr || result.stdout).slice(0, 2000)}`);
  }

  return {
    period,
    date,
    command: `${config.calendar.engine.command} ${args.join(' ')}`,
    inputPath,
    markdown: result.stdout.trim(),
    draft: parseDraftFromCliOutput(result.stdout),
    taskCount: input.tasks.length,
    existingEventCount: input.existingEvents.length,
  };
}

export function buildCalendarDraftInput(config: AppConfig, evidence: Evidence, period: CalendarDraftPeriod, date: string): CalendarDraftInput {
  const tasks = collectCalendarTasks(config, evidence, date).slice(0, config.calendar.draft.max_tasks);
  return {
    period: period === 'week' ? 'week' : 'day',
    timezone: config.user.timezone,
    policy: defaultCalendarPolicy(),
    tasks,
    existingEvents: collectExistingCalendarEvents(evidence),
    constraints: {
      startDate: period === 'week' ? startOfWeek(date) : date,
      days: period === 'week' ? config.calendar.draft.week_days : 1,
    },
    evidence: {
      generatedAt: evidence.generated_at,
      date: evidence.date,
      sources: Object.fromEntries(Object.entries(evidence.sources).map(([name, source]) => [name, source.state])),
    },
  };
}

export function formatCalendarDraftForFeishu(result: CalendarDraftResult): string {
  const title = result.period === 'week' ? '本周日历草稿' : '今日日历草稿';
  const draft = result.draft;
  const events = draft?.events || [];
  const lines = [
    `# ${title}`,
    '',
    '这是日程草稿，还没有写入任何日历。',
    '',
    `任务：${result.taskCount} 个；已有日程：${result.existingEventCount} 个；生成 block：${events.length} 个。`,
    '',
    '**建议时间块**',
    ...(events.length ? events.slice(0, 12).map((event) => `- ${formatEventTime(event)} ${event.title}`) : ['- 暂时没有生成可放入日历的时间块。']),
  ];
  if (draft?.warnings?.length) {
    lines.push('', '**需要注意**', ...draft.warnings.slice(0, 5).map((warning) => `- ${warning}`));
  }
  lines.push('', '你可以先看这版是否合理。确认只表示“这版草稿可用”，不会写入 Feishu / Apple / Google Calendar。');
  return lines.join('\n');
}

function collectCalendarTasks(config: AppConfig, evidence: Evidence, date: string): CalendarTask[] {
  const tasks: CalendarTask[] = [];
  const weekly = evidence.sources.weekly_priorities;
  if (weekly?.state === 'available' && isRecord(weekly.data) && Array.isArray(weekly.data.items)) {
    weekly.data.items.forEach((item, index) => {
      const text = weeklyPriorityText(item);
      if (!text) return;
      tasks.push({
        id: `weekly-${index + 1}`,
        title: text,
        type: inferTaskType(text),
        priority: index === 0 ? 'P0' : 'P1',
        estimatedMinutes: inferEstimatedMinutes(text),
        source: 'feishu-weekly',
      });
    });
  }

  if (config.todo_inbox.enabled) {
    for (const item of openTodoInboxItems(config)) {
      tasks.push({
        id: item.id,
        title: item.text,
        type: item.type === 'reminder' || item.type === 'time_boundary' ? 'admin' : inferTaskType(item.text),
        priority: 'P1',
        estimatedMinutes: item.type === 'reminder' ? 15 : inferEstimatedMinutes(item.text),
        source: 'todo-inbox',
        ...(item.due_hint && /(今天|今晚|上午|下午|中午|晚上)/.test(item.due_hint) ? { preferredDate: date } : {}),
      });
    }
  }

  const linear = evidence.sources.linear;
  if (linear?.state === 'available') {
    for (const item of linearIssueItems(linear).slice(0, 6)) {
      const title = readString(item, 'title') || readString(item, 'identifier');
      if (!title) continue;
      tasks.push({
        id: readString(item, 'identifier') || `linear-${tasks.length + 1}`,
        title,
        type: inferTaskType(title),
        priority: linearPriority(readString(item, 'priority')),
        estimatedMinutes: inferEstimatedMinutes(title),
        source: 'linear',
        ...(readString(item, 'dueDate') ? { dueDate: readString(item, 'dueDate') } : {}),
      });
    }
  }

  return dedupeTasks(tasks);
}

function collectExistingCalendarEvents(evidence: Evidence): CalendarExistingEvent[] {
  const events: CalendarExistingEvent[] = [];
  for (const [name, source] of Object.entries(evidence.sources)) {
    if (!name.includes('calendar') || source.state !== 'available') continue;
    visit(source.data, (value) => {
      if (!isRecord(value)) return;
      const start = readString(value, 'start') || readString(value, 'startTime') || readString(value, 'start_time');
      const end = readString(value, 'end') || readString(value, 'endTime') || readString(value, 'end_time');
      if (!looksLikeDateTime(start) || !looksLikeDateTime(end)) return;
      events.push({
        title: readString(value, 'summary') || readString(value, 'title') || readString(value, 'name') || 'Existing calendar event',
        start,
        end,
      });
    });
  }
  return events.slice(0, 40);
}

function writeCalendarInput(config: AppConfig, input: CalendarDraftInput): string {
  const inputPath = path.resolve(config.calendar.engine.input_path);
  fs.mkdirSync(path.dirname(inputPath), { recursive: true });
  fs.writeFileSync(inputPath, JSON.stringify(input, null, 2), 'utf8');
  return inputPath;
}

function resolveCalendarCliPath(config: AppConfig): string {
  const cliPath = config.calendar.engine.cli_path.trim();
  if (!cliPath) throw new Error('calendar.engine.cli_path is empty.');
  return path.isAbsolute(cliPath) ? cliPath : path.resolve(resolveCalendarWorkdir(config), cliPath);
}

function resolveCalendarWorkdir(config: AppConfig): string {
  const workdir = config.calendar.engine.workdir.trim();
  return workdir ? path.resolve(workdir) : process.cwd();
}

function parseDraftFromCliOutput(output: string): CalendarDraft | undefined {
  const match = output.match(/```json\s*([\s\S]*?)```/);
  if (!match?.[1]) return undefined;
  try {
    return JSON.parse(match[1]) as CalendarDraft;
  } catch {
    return undefined;
  }
}

function defaultCalendarPolicy(): Record<string, unknown> {
  return {
    deepWorkWindows: ['09:30-11:30', '15:30-17:00'],
    adminWindows: ['14:00-15:00', '16:30-17:00'],
    reviewWindows: ['20:00-20:30'],
    maxDeepWorkBlocksPerDay: 2,
    maxAdminBlocksPerDay: 2,
    maxReviewBlocksPerDay: 1,
    maxDraftedMinutesPerDay: 300,
    defaultBufferMinutes: 30,
    includeBuffers: true,
  };
}

function startOfWeek(date: string): string {
  const parsed = new Date(`${date}T00:00:00Z`);
  const day = parsed.getUTCDay();
  return addDays(date, day === 0 ? -6 : 1 - day);
}

function weeklyPriorityText(item: unknown): string {
  if (typeof item === 'string') return item.trim();
  if (!isRecord(item)) return '';
  const itemText = readString(item, 'item') || readString(item, 'title') || readString(item, 'text');
  const okr = readString(item, 'okr');
  return [okr, itemText].filter(Boolean).join('：').slice(0, 180);
}

function linearIssueItems(source: EvidenceSource): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  visit(source.data, (value) => {
    if (isRecord(value) && (typeof value.identifier === 'string' || typeof value.title === 'string')) out.push(value);
  });
  return out;
}

function dedupeTasks(tasks: CalendarTask[]): CalendarTask[] {
  const seen = new Set<string>();
  return tasks.filter((task) => {
    const key = `${task.source}:${task.title}`.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function inferTaskType(text: string): CalendarTask['type'] {
  if (/(review|复盘|检查|核对|确认|整理|报销|邮件|follow[- ]?up|回复)/i.test(text)) return 'admin';
  if (/(计划|weekly|日程|calendar|总结)/i.test(text)) return 'review';
  return 'deep_work';
}

function inferEstimatedMinutes(text: string): number {
  if (/(邮件|报销|确认|检查|核对|follow[- ]?up|回复)/i.test(text)) return 30;
  if (/(复盘|review|整理|计划|总结)/i.test(text)) return 45;
  return 90;
}

function linearPriority(value: string): CalendarTask['priority'] {
  const normalized = value.toUpperCase();
  if (normalized === 'P0' || normalized === 'URGENT' || normalized === '1') return 'P0';
  if (normalized === 'P1' || normalized === 'HIGH' || normalized === '2') return 'P1';
  if (normalized === 'P2' || normalized === 'MEDIUM' || normalized === '3') return 'P2';
  return 'P3';
}

function formatEventTime(event: CalendarDraftEvent): string {
  return `${event.start.slice(5, 16).replace('T', ' ')}-${event.end.slice(11, 16)}`;
}

function visit(value: unknown, fn: (value: unknown) => void): void {
  fn(value);
  if (Array.isArray(value)) {
    for (const item of value) visit(item, fn);
    return;
  }
  if (!isRecord(value)) return;
  for (const child of Object.values(value)) visit(child, fn);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function readString(value: Record<string, unknown>, key: string): string {
  const raw = value[key];
  return typeof raw === 'string' ? raw.trim() : '';
}

function looksLikeDateTime(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value);
}
