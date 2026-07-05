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
  engine: 'external' | 'builtin';
}

export interface CalendarBridgeTestResult {
  ok: boolean;
  workdir: string;
  cliPath: string;
  inputPath: string;
  engine: 'external' | 'builtin';
  message: string;
  stdoutPreview?: string;
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
  const engine = resolveCalendarEngine(config);
  if (engine === 'builtin') {
    const draft = runBuiltinCalendarDraft(input, period, date);
    return {
      period,
      date,
      command: 'builtin calendar draft engine',
      inputPath,
      markdown: formatBuiltinDraftMarkdown(draft, period),
      draft,
      taskCount: input.tasks.length,
      existingEventCount: input.existingEvents.length,
      engine,
    };
  }

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
    engine,
  };
}

export async function testCalendarBridge(config: AppConfig): Promise<CalendarBridgeTestResult> {
  const workdir = resolveCalendarWorkdir(config);
  const cliPath = resolveCalendarCliPath(config);
  const inputPath = writeCalendarInput(config, sampleCalendarInput(config));
  const engine = resolveCalendarEngine(config);

  if (engine === 'builtin') {
    const sample = sampleCalendarInput(config);
    const draft = runBuiltinCalendarDraft(sample, 'today', todayInTimezone(config));
    return {
      ok: true,
      workdir,
      cliPath,
      inputPath,
      engine,
      message: 'Built-in calendar draft engine OK. It can generate draft blocks without installing calendar-planning-os; writeback remains disabled.',
      stdoutPreview: JSON.stringify(draft, null, 2).slice(0, 1200),
    };
  }

  if (!fs.existsSync(workdir)) {
    return { ok: false, workdir, cliPath, inputPath, engine, message: `calendar.engine.workdir not found: ${workdir}` };
  }
  if (!fs.existsSync(cliPath)) {
    return { ok: false, workdir, cliPath, inputPath, engine, message: `calendar.engine.cli_path not found: ${cliPath}` };
  }

  const result = await runCommand(config.calendar.engine.command, [cliPath, 'draft-day', '--input', inputPath, '--format', 'json'], {
    cwd: workdir,
    timeoutMs: config.calendar.engine.timeout_ms,
    env: process.env,
  });
  if (!result.ok) {
    return {
      ok: false,
      workdir,
      cliPath,
      inputPath,
      engine,
      message: `calendar-planning-os smoke test failed: ${(result.stderr || result.stdout).slice(0, 1200)}`,
      stdoutPreview: result.stdout.slice(0, 1200),
    };
  }

  try {
    const draft = JSON.parse(result.stdout) as CalendarDraft;
    const eventCount = Array.isArray(draft.events) ? draft.events.length : 0;
    return {
      ok: true,
      workdir,
      cliPath,
      inputPath,
      engine,
      message: `Calendar engine OK. Generated ${eventCount} sample block(s). Save config, then run daily-os calendar week or daily-os calendar today.`,
      stdoutPreview: result.stdout.slice(0, 1200),
    };
  } catch {
    return {
      ok: false,
      workdir,
      cliPath,
      inputPath,
      engine,
      message: 'calendar-planning-os ran, but did not return valid JSON for the smoke draft.',
      stdoutPreview: result.stdout.slice(0, 1200),
    };
  }
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

function sampleCalendarInput(config: AppConfig): CalendarDraftInput {
  return {
    period: 'day',
    timezone: config.user.timezone,
    policy: defaultCalendarPolicy(),
    tasks: [
      {
        id: 'calendar-smoke-deep-work',
        title: 'Smoke test deep work block',
        type: 'deep_work',
        priority: 'P1',
        estimatedMinutes: 45,
        source: 'daily-os-smoke-test',
      },
    ],
    existingEvents: [],
    constraints: {
      startDate: todayInTimezone(config),
      days: 1,
    },
    evidence: {
      generatedAt: new Date().toISOString(),
      source: 'daily-os-calendar-bridge-smoke-test',
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

function resolveCalendarEngine(config: AppConfig): 'external' | 'builtin' {
  const mode = config.calendar.engine.mode;
  if (mode === 'builtin') return 'builtin';
  if (mode === 'external') return 'external';
  const workdir = resolveCalendarWorkdir(config);
  const cliPath = resolveCalendarCliPath(config);
  return fs.existsSync(workdir) && fs.existsSync(cliPath) ? 'external' : 'builtin';
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

function runBuiltinCalendarDraft(input: CalendarDraftInput, period: CalendarDraftPeriod, date: string): CalendarDraft {
  const policy = normalizeCalendarPolicy(input.policy);
  const events: CalendarDraftEvent[] = [];
  const warnings: string[] = ['Built-in draft-only engine used; no calendar writeback is available.'];
  const days = Math.max(1, input.constraints.days);
  const taskDays = Array.from({ length: days }, (_, index) => addDays(input.constraints.startDate || date, index));
  const counters = new Map<string, { deep_work: number; admin: number; review: number }>();

  for (const task of input.tasks) {
    const preferred = task.preferredDate && taskDays.includes(task.preferredDate) ? task.preferredDate : undefined;
    const targetDate = preferred || pickBuiltinTaskDate(task, taskDays, counters, policy);
    const slots = slotsForTaskType(task.type, policy);
    const slotIndex = nextSlotIndex(targetDate, task.type, counters, slots.length);
    const slot = slots[slotIndex] || slots[slots.length - 1] || '09:30-10:30';
    const [slotStart, slotEnd] = slot.split('-');
    const start = `${targetDate}T${slotStart}:00`;
    const proposedEnd = addMinutes(start, Math.min(task.estimatedMinutes || 45, minutesBetween(slotStart, slotEnd) || 60));
    const end = proposedEnd.slice(0, 10) === targetDate ? proposedEnd : `${targetDate}T${slotEnd}:00`;
    events.push({
      title: task.title,
      start,
      end,
      type: task.type,
      sourceTaskIds: [task.id],
      confidence: 'medium',
      warnings: overlapsExisting(start, end, input.existingEvents) ? ['Overlaps an existing calendar event; review before using.'] : [],
    });
  }

  if (events.some((event) => event.warnings.length > 0)) warnings.push('Some blocks overlap existing calendar events.');

  return {
    draftId: `builtin-${period}-${date}`,
    mode: 'draft-only',
    period: input.period,
    timezone: input.timezone,
    events,
    warnings,
    writeback: {
      supported: false,
      reason: 'Built-in Daily OS calendar draft engine only creates preview blocks.',
    },
  };
}

function normalizeCalendarPolicy(policy: Record<string, unknown>): {
  deepWorkWindows: string[];
  adminWindows: string[];
  reviewWindows: string[];
  maxDeepWorkBlocksPerDay: number;
  maxAdminBlocksPerDay: number;
  maxReviewBlocksPerDay: number;
} {
  const defaults = defaultCalendarPolicy();
  return {
    deepWorkWindows: arrayOfStrings(policy.deepWorkWindows) || (defaults.deepWorkWindows as string[]),
    adminWindows: arrayOfStrings(policy.adminWindows) || (defaults.adminWindows as string[]),
    reviewWindows: arrayOfStrings(policy.reviewWindows) || (defaults.reviewWindows as string[]),
    maxDeepWorkBlocksPerDay: positiveNumber(policy.maxDeepWorkBlocksPerDay) || Number(defaults.maxDeepWorkBlocksPerDay),
    maxAdminBlocksPerDay: positiveNumber(policy.maxAdminBlocksPerDay) || Number(defaults.maxAdminBlocksPerDay),
    maxReviewBlocksPerDay: positiveNumber(policy.maxReviewBlocksPerDay) || Number(defaults.maxReviewBlocksPerDay),
  };
}

function pickBuiltinTaskDate(
  task: CalendarTask,
  taskDays: string[],
  counters: Map<string, { deep_work: number; admin: number; review: number }>,
  policy: ReturnType<typeof normalizeCalendarPolicy>,
): string {
  const limit = task.type === 'deep_work' ? policy.maxDeepWorkBlocksPerDay : task.type === 'review' ? policy.maxReviewBlocksPerDay : policy.maxAdminBlocksPerDay;
  for (const day of taskDays) {
    const dayCounters = counters.get(day) || { deep_work: 0, admin: 0, review: 0 };
    if (dayCounters[task.type] < limit) return day;
  }
  return taskDays[(taskDays.length - 1) || 0];
}

function nextSlotIndex(
  date: string,
  type: CalendarTask['type'],
  counters: Map<string, { deep_work: number; admin: number; review: number }>,
  slotCount: number,
): number {
  const dayCounters = counters.get(date) || { deep_work: 0, admin: 0, review: 0 };
  const index = Math.min(dayCounters[type], Math.max(0, slotCount - 1));
  dayCounters[type] += 1;
  counters.set(date, dayCounters);
  return index;
}

function slotsForTaskType(type: CalendarTask['type'], policy: ReturnType<typeof normalizeCalendarPolicy>): string[] {
  if (type === 'deep_work') return policy.deepWorkWindows;
  if (type === 'review') return policy.reviewWindows;
  return policy.adminWindows;
}

function formatBuiltinDraftMarkdown(draft: CalendarDraft, period: CalendarDraftPeriod): string {
  const title = period === 'week' ? '本周日历草稿' : '今日日历草稿';
  return [
    `# ${title}`,
    '',
    'Built-in draft-only engine generated this preview. It has not written to any calendar.',
    '',
    ...draft.events.map((event) => `- ${formatEventTime(event)} ${event.title}`),
    '',
    '```json',
    JSON.stringify(draft, null, 2),
    '```',
  ].join('\n');
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

function arrayOfStrings(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : null;
}

function positiveNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function minutesBetween(start: string, end: string): number {
  const startParts = start.split(':').map(Number);
  const endParts = end.split(':').map(Number);
  if (startParts.length !== 2 || endParts.length !== 2 || startParts.some(Number.isNaN) || endParts.some(Number.isNaN)) return 0;
  return endParts[0] * 60 + endParts[1] - (startParts[0] * 60 + startParts[1]);
}

function addMinutes(start: string, minutes: number): string {
  const parsed = new Date(`${start}Z`);
  parsed.setUTCMinutes(parsed.getUTCMinutes() + Math.max(1, minutes));
  return parsed.toISOString().slice(0, 16);
}

function overlapsExisting(start: string, end: string, events: CalendarExistingEvent[]): boolean {
  const startMs = Date.parse(`${start}Z`);
  const endMs = Date.parse(`${end}Z`);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return false;
  return events.some((event) => {
    const existingStart = Date.parse(event.start);
    const existingEnd = Date.parse(event.end);
    return Number.isFinite(existingStart) && Number.isFinite(existingEnd) && startMs < existingEnd && endMs > existingStart;
  });
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
