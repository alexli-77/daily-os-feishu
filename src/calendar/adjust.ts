import { addDays } from '../utils/date.js';
import type { CalendarDraft, CalendarDraftEvent } from './bridge.js';

/**
 * LEO-268 — adjust feed-back loop.
 *
 * The old "我要调整" button was a dead end: the user's request was never stored
 * and re-running the command just recomputed the same draft. Here we parse the
 * request into structured instructions, persist them per period, and apply them
 * when the draft is regenerated — so the draft actually moves the way the user
 * asked. Pure functions (parse + apply) keep the loop fully testable; storage
 * lives in storage/db.ts and the wiring in bridge.ts / daily-os-command.ts.
 */

export type MoveTarget =
  | { type: 'time'; hhmm: string }
  | { type: 'daypart'; part: 'morning' | 'noon' | 'afternoon' | 'evening' }
  | { type: 'weekday'; weekday: number }; // 1 = Monday .. 7 = Sunday

export type CalendarAdjustment =
  | { kind: 'drop'; match: string }
  | { kind: 'resize'; match: string; minutes: number }
  | { kind: 'move'; match: string; to: MoveTarget };

export interface ParseResult {
  adjustments: CalendarAdjustment[];
  unrecognized: string[];
}

const DAYPART_START: Record<'morning' | 'noon' | 'afternoon' | 'evening', string> = {
  morning: '09:00',
  noon: '12:00',
  afternoon: '14:00',
  evening: '20:00',
};

const WEEKDAYS: Array<[RegExp, number]> = [
  [/周一|星期一|礼拜一|周1/, 1],
  [/周二|星期二|礼拜二|周2/, 2],
  [/周三|星期三|礼拜三|周3/, 3],
  [/周四|星期四|礼拜四|周4/, 4],
  [/周五|星期五|礼拜五|周5/, 5],
  [/周六|星期六|礼拜六|周6/, 6],
  [/周日|周天|星期日|星期天|礼拜天/, 7],
];

/** Split free text into clauses and parse each; unparseable clauses are surfaced. */
export function parseCalendarAdjustments(text: string): ParseResult {
  const clauses = (text || '')
    .split(/[、，,；;。\n]+/)
    .map((clause) => clause.trim())
    .filter(Boolean);
  const adjustments: CalendarAdjustment[] = [];
  const unrecognized: string[] = [];
  for (const clause of clauses) {
    const parsed = parseClause(clause);
    if (parsed) adjustments.push(parsed);
    else unrecognized.push(clause);
  }
  return { adjustments, unrecognized };
}

function parseClause(clause: string): CalendarAdjustment | null {
  const resize = clause.match(/^(?:把)?\s*(.+?)\s*(?:缩到|缩短到|改成|改为|设为|调整为)\s*(\d+)\s*分钟$/);
  if (resize) {
    const match = cleanTarget(resize[1]!);
    const minutes = Number(resize[2]);
    if (match && minutes > 0) return { kind: 'resize', match, minutes };
  }

  const move = clause.match(/^(?:把)?\s*(.+?)\s*(?:挪到|移到|改到|放到|安排到|调到)\s*(.+)$/);
  if (move) {
    const match = cleanTarget(move[1]!);
    const to = parseMoveTarget(move[2]!);
    if (match && to) return { kind: 'move', match, to };
  }

  const drop = clause.match(/^(?:删掉|删除|去掉|移除|不要|去除)\s*(.+)$/);
  if (drop) {
    const match = cleanTarget(drop[1]!);
    if (match) return { kind: 'drop', match };
  }
  return null;
}

function parseMoveTarget(text: string): MoveTarget | null {
  const time = text.match(/(\d{1,2})\s*[:：点]\s*(\d{2})?/);
  if (time) {
    const hh = String(Math.min(23, Number(time[1]))).padStart(2, '0');
    const mm = (time[2] ?? '00').padStart(2, '0');
    return { type: 'time', hhmm: `${hh}:${mm}` };
  }
  for (const [pattern, weekday] of WEEKDAYS) {
    if (pattern.test(text)) return { type: 'weekday', weekday };
  }
  if (/上午|早上|早晨/.test(text)) return { type: 'daypart', part: 'morning' };
  if (/中午/.test(text)) return { type: 'daypart', part: 'noon' };
  if (/下午/.test(text)) return { type: 'daypart', part: 'afternoon' };
  if (/晚上|傍晚|夜里/.test(text)) return { type: 'daypart', part: 'evening' };
  return null;
}

/** Strip verbs / fillers so the remainder is a keyword to match against titles. */
function cleanTarget(raw: string): string {
  return raw
    .replace(/^(?:那个|这个|那|这)\s*/, '')
    .replace(/(?:那块|这块|那个块|这个块|的块|时间块|块|的安排|安排|任务|事项)$/, '')
    .trim();
}

/** Apply stored adjustments to a freshly generated draft, in order. */
export function applyCalendarAdjustments(draft: CalendarDraft, adjustments: CalendarAdjustment[]): CalendarDraft {
  let events = [...draft.events];
  for (const adjustment of adjustments) {
    if (adjustment.kind === 'drop') {
      events = events.filter((event) => !matches(event, adjustment.match));
    } else if (adjustment.kind === 'resize') {
      events = events.map((event) => (matches(event, adjustment.match) ? resizeEvent(event, adjustment.minutes) : event));
    } else {
      events = events.map((event) => (matches(event, adjustment.match) ? moveEvent(event, adjustment.to) : event));
    }
  }
  return { ...draft, events };
}

function matches(event: CalendarDraftEvent, keyword: string): boolean {
  if (!keyword) return false;
  return event.title.includes(keyword);
}

function resizeEvent(event: CalendarDraftEvent, minutes: number): CalendarDraftEvent {
  return { ...event, end: addMinutesToWall(event.start, minutes) };
}

function moveEvent(event: CalendarDraftEvent, to: MoveTarget): CalendarDraftEvent {
  const durationMin = wallDiffMinutes(event.start, event.end);
  let start = event.start;
  if (to.type === 'time') {
    start = `${event.start.slice(0, 10)}T${to.hhmm}:00`;
  } else if (to.type === 'daypart') {
    start = `${event.start.slice(0, 10)}T${DAYPART_START[to.part]}:00`;
  } else {
    const date = event.start.slice(0, 10);
    const delta = to.weekday - isoWeekday(date);
    start = `${addDays(date, delta)}T${event.start.slice(11)}`;
  }
  return { ...event, start, end: addMinutesToWall(start, durationMin || 60) };
}

// --- wall-clock helpers (draft times are naive `YYYY-MM-DDTHH:mm:ss`) --------

function wallDiffMinutes(start: string, end: string): number {
  const a = Date.parse(`${start.slice(0, 19)}Z`);
  const b = Date.parse(`${end.slice(0, 19)}Z`);
  return Number.isNaN(a) || Number.isNaN(b) ? 0 : Math.round((b - a) / 60000);
}

function addMinutesToWall(start: string, minutes: number): string {
  const base = Date.parse(`${start.slice(0, 19)}Z`);
  if (Number.isNaN(base)) return start;
  return `${new Date(base + Math.max(1, minutes) * 60000).toISOString().slice(0, 19)}`;
}

function isoWeekday(date: string): number {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  return day === 0 ? 7 : day;
}

// --- user-facing help -------------------------------------------------------

export function supportedAdjustmentForms(): string {
  return [
    '支持的调整表达（可用「，」「、」分隔多条）：',
    '- 删除：删掉 报销、去掉 邮件',
    '- 改时段：把 深度工作 挪到 上午 / 挪到 14:00',
    '- 改日期：把 复盘 挪到 周四',
    '- 改时长：把 深度工作 缩到 60 分钟',
  ].join('\n');
}
