import crypto from 'node:crypto';
import type { AppConfig } from '../config/schema.js';
import { runCommand } from '../utils/command.js';
import type { CalendarDraft, CalendarDraftEvent } from './bridge.js';
import {
  dbFindCalendarWriteback,
  dbInsertCalendarBatch,
  dbListCalendarBatchWritebacks,
  dbLatestCalendarBatchId,
  dbMarkCalendarBatchUndone,
  dbMarkCalendarWritebackDeleted,
  dbUpdateCalendarWritebackTime,
  dbUpsertCalendarWriteback,
} from '../storage/db.js';

/**
 * LEO-266 — Feishu/Lark calendar write-back.
 *
 * Turns a confirmed CalendarDraft into real Feishu calendar events via lark-cli,
 * with the three safety guarantees from the design:
 *  - idempotency: a per-(task, day) dedup key means confirming the same draft
 *    twice never double-books; a moved block updates in place.
 *  - undo: every write is tagged with a batch id and its event id is recorded,
 *    so `undoCalendarBatch` can delete exactly what this run created.
 * Free/busy conflict detection is layered on in LEO-267.
 *
 * The lark-cli calls go through an injectable {@link LarkCalendarClient} so tests
 * exercise the full dedup/undo logic with a fake client and zero side effects.
 */

export type WritebackAction =
  | 'created'
  | 'updated'
  | 'skipped'
  | 'blocked'
  | 'would-create'
  | 'would-update'
  | 'would-skip'
  | 'would-block'
  | 'failed';

export interface WritebackEventResult {
  title: string;
  dedupKey: string;
  action: WritebackAction;
  eventId?: string;
  error?: string;
  /** LEO-267: the target slot overlapped an existing calendar event. */
  conflict?: boolean;
}

export interface WritebackSummary {
  enabled: boolean;
  dryRun: boolean;
  batchId?: string;
  created: number;
  updated: number;
  skipped: number;
  failed: number;
  /** LEO-267: events whose slot overlapped an existing event (warned or blocked). */
  conflicts: number;
  /** LEO-267: events not written because conflict_policy=block. */
  blocked: number;
  events: WritebackEventResult[];
}

export interface UndoSummary {
  batchId?: string;
  deleted: number;
  failed: number;
  errors: string[];
}

export interface CreateEventInput {
  summary: string;
  start: string; // RFC3339 with offset
  end: string;
  description: string;
  calendarId: string;
  identity: string;
}

export interface DeleteEventInput {
  eventId: string;
  calendarId: string;
  identity: string;
}

export interface UpdateEventInput extends CreateEventInput {
  eventId: string;
}

export interface FreeBusyQuery {
  start: string;
  end: string;
  identity: string;
}

export interface FreeBusyInterval {
  start: string;
  end: string;
}

export interface LarkCalendarClient {
  createEvent(input: CreateEventInput): Promise<{ eventId: string; calendarId: string }>;
  updateEvent(input: UpdateEventInput): Promise<void>;
  deleteEvent(input: DeleteEventInput): Promise<void>;
  /** LEO-267: busy intervals overlapping the window; absent => conflict check skipped. */
  queryFreeBusy?(query: FreeBusyQuery): Promise<FreeBusyInterval[]>;
}

export interface WritebackOptions {
  dryRun?: boolean;
  client?: LarkCalendarClient;
  now?: string;
  batchId?: string;
}

/**
 * Stable idempotency key at day granularity: same task(s) on the same calendar
 * day map to the same key, so a re-confirmed draft updates in place instead of
 * creating a duplicate. Source ids are sorted so ordering never changes the key.
 */
export function calendarDedupKey(event: CalendarDraftEvent): string {
  const ids = [...event.sourceTaskIds].sort().join(',');
  const day = event.start.slice(0, 10);
  return crypto.createHash('sha1').update(`${ids}|${day}`).digest('hex');
}

/** `[daily-os#<key8>]` marker embedded in the event description for traceability. */
function dedupMarker(dedupKey: string): string {
  return `[daily-os#${dedupKey.slice(0, 8)}]`;
}

export async function writebackCalendarDraft(
  config: AppConfig,
  draft: CalendarDraft,
  options: WritebackOptions = {},
): Promise<WritebackSummary> {
  const wb = config.calendar.writeback;
  const dryRun = options.dryRun ?? wb.dry_run;
  const client = options.client ?? createLarkCalendarClient(config);
  const now = options.now ?? new Date().toISOString();
  const batchId = options.batchId ?? `cal_${draft.draftId}_${crypto.randomBytes(4).toString('hex')}`;

  const results: WritebackEventResult[] = [];
  let created = 0;
  let updated = 0;
  let skipped = 0;
  let failed = 0;
  let conflicts = 0;
  let blocked = 0;

  for (const event of draft.events) {
    const dedupKey = calendarDedupKey(event);
    const start = localWallTimeToRfc3339(event.start, config.user.timezone);
    const end = localWallTimeToRfc3339(event.end, config.user.timezone);
    const existing = dbFindCalendarWriteback(dedupKey);
    const unchanged = existing && existing.start === start && existing.end === end;

    // LEO-267: only a slot we are about to (re)write is worth a free/busy check;
    // an unchanged block already lives on the calendar. A failed check never
    // blocks the write.
    let conflict = false;
    if (!unchanged && wb.conflict_policy !== 'ignore' && client.queryFreeBusy) {
      try {
        const busy = await client.queryFreeBusy({ start, end, identity: wb.identity });
        conflict = busy.some((interval) => overlaps(start, end, interval.start, interval.end));
      } catch {
        conflict = false;
      }
    }
    const blockedByConflict = conflict && wb.conflict_policy === 'block';
    if (conflict) conflicts += 1;

    if (dryRun) {
      let action: WritebackAction;
      if (unchanged) action = 'would-skip';
      else if (blockedByConflict) action = 'would-block';
      else if (existing) action = 'would-update';
      else action = 'would-create';
      if (blockedByConflict) blocked += 1;
      results.push({ title: event.title, dedupKey, action, eventId: existing?.event_id, conflict });
      continue;
    }

    try {
      if (unchanged) {
        skipped += 1;
        results.push({ title: event.title, dedupKey, action: 'skipped', eventId: existing!.event_id });
        continue;
      }
      if (blockedByConflict) {
        blocked += 1;
        results.push({ title: event.title, dedupKey, action: 'blocked', eventId: existing?.event_id, conflict: true });
        continue;
      }
      const createInput: CreateEventInput = {
        summary: event.title,
        start,
        end,
        description: buildDescription(event, dedupKey),
        calendarId: existing?.calendar_id ?? wb.calendar_id,
        identity: wb.identity,
      };
      if (existing) {
        await client.updateEvent({ ...createInput, eventId: existing.event_id });
        dbUpdateCalendarWritebackTime(dedupKey, start, end, batchId);
        updated += 1;
        results.push({ title: event.title, dedupKey, action: 'updated', eventId: existing.event_id, conflict });
      } else {
        const { eventId, calendarId } = await client.createEvent(createInput);
        dbUpsertCalendarWriteback({
          dedup_key: dedupKey,
          event_id: eventId,
          calendar_id: calendarId,
          batch_id: batchId,
          title: event.title,
          start,
          end,
          source_task_ids: JSON.stringify(event.sourceTaskIds),
          created_at: now,
          deleted_at: null,
        });
        created += 1;
        results.push({ title: event.title, dedupKey, action: 'created', eventId, conflict });
      }
    } catch (error) {
      failed += 1;
      results.push({ title: event.title, dedupKey, action: 'failed', error: errorText(error) });
    }
  }

  // Record the batch even on partial failure, so undo can reach whatever got written.
  if (!dryRun && created + updated > 0) {
    dbInsertCalendarBatch({
      batch_id: batchId,
      draft_id: draft.draftId,
      period: draft.period,
      created_at: now,
      event_count: created + updated,
      undone_at: null,
    });
  }

  return {
    enabled: wb.enabled,
    dryRun,
    batchId: !dryRun && created + updated > 0 ? batchId : undefined,
    created,
    updated,
    skipped,
    failed,
    conflicts,
    blocked,
    events: results,
  };
}

export async function undoCalendarBatch(
  config: AppConfig,
  batchId?: string,
  options: { client?: LarkCalendarClient; now?: string } = {},
): Promise<UndoSummary> {
  const target = batchId ?? dbLatestCalendarBatchId();
  if (!target) return { deleted: 0, failed: 0, errors: [] };
  const client = options.client ?? createLarkCalendarClient(config);
  const now = options.now ?? new Date().toISOString();
  const rows = dbListCalendarBatchWritebacks(target);

  let deleted = 0;
  let failed = 0;
  const errors: string[] = [];
  for (const row of rows) {
    try {
      await client.deleteEvent({ eventId: row.event_id, calendarId: row.calendar_id, identity: config.calendar.writeback.identity });
      dbMarkCalendarWritebackDeleted(row.dedup_key, now);
      deleted += 1;
    } catch (error) {
      failed += 1;
      errors.push(`${row.title}: ${errorText(error)}`);
    }
  }
  if (failed === 0) dbMarkCalendarBatchUndone(target, now);
  return { batchId: target, deleted, failed, errors };
}

function buildDescription(event: CalendarDraftEvent, dedupKey: string): string {
  const parts = [`来源：daily-os 日历草稿（${event.type}）`, dedupMarker(dedupKey)];
  return parts.join('\n');
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// --- lark-cli backed client -------------------------------------------------

function createLarkCalendarClient(config: AppConfig): LarkCalendarClient {
  const timeoutMs = 30000;
  return {
    async createEvent(input) {
      const args = [
        'calendar',
        '+create',
        '--summary',
        input.summary,
        '--start',
        input.start,
        '--end',
        input.end,
        '--description',
        input.description,
        '--calendar-id',
        input.calendarId,
        '--format',
        'json',
        '--as',
        input.identity,
      ];
      if (config.calendar.writeback.dry_run) args.push('--dry-run');
      const result = await runCommand('lark-cli', args, { timeoutMs });
      if (!result.ok) throw new Error((result.stderr || result.stdout).slice(0, 500));
      const parsed = safeJson(result.stdout);
      return {
        eventId: findString(parsed, ['event_id', 'eventId']) || `unknown-${Date.now()}`,
        calendarId: findString(parsed, ['calendar_id', 'calendarId']) || input.calendarId,
      };
    },
    async updateEvent(input) {
      const args = [
        'calendar',
        '+update',
        '--calendar-id',
        input.calendarId,
        '--event-id',
        input.eventId,
        '--summary',
        input.summary,
        '--start',
        input.start,
        '--end',
        input.end,
        '--format',
        'json',
        '--as',
        input.identity,
      ];
      const result = await runCommand('lark-cli', args, { timeoutMs });
      if (!result.ok) throw new Error((result.stderr || result.stdout).slice(0, 500));
    },
    async deleteEvent(input) {
      const args = [
        'calendar',
        'events',
        'delete',
        '--calendar-id',
        input.calendarId,
        '--event-id',
        input.eventId,
        '--as',
        input.identity,
      ];
      const result = await runCommand('lark-cli', args, { timeoutMs });
      if (!result.ok) throw new Error((result.stderr || result.stdout).slice(0, 500));
    },
    async queryFreeBusy(query) {
      const args = ['calendar', '+freebusy', '--start', query.start, '--end', query.end, '--format', 'json', '--as', query.identity];
      const result = await runCommand('lark-cli', args, { timeoutMs });
      if (!result.ok) throw new Error((result.stderr || result.stdout).slice(0, 500));
      return parseBusyIntervals(safeJson(result.stdout));
    },
  };
}

/** Pull {start,end} busy intervals out of a lark-cli +freebusy JSON response. */
function parseBusyIntervals(value: unknown): FreeBusyInterval[] {
  const out: FreeBusyInterval[] = [];
  const stack: unknown[] = [value];
  while (stack.length) {
    const current = stack.pop();
    if (Array.isArray(current)) {
      stack.push(...current);
      continue;
    }
    if (!current || typeof current !== 'object') continue;
    const record = current as Record<string, unknown>;
    const start = firstString(record, ['start_time', 'startTime', 'start']);
    const end = firstString(record, ['end_time', 'endTime', 'end']);
    if (start && end) out.push({ start, end });
    for (const child of Object.values(record)) if (child && typeof child === 'object') stack.push(child);
  }
  return out;
}

function firstString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) if (typeof record[key] === 'string' && record[key]) return record[key] as string;
  return undefined;
}

/** Half-open interval overlap on RFC3339 timestamps. */
function overlaps(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  const as = Date.parse(aStart);
  const ae = Date.parse(aEnd);
  const bs = Date.parse(bStart);
  const be = Date.parse(bEnd);
  if ([as, ae, bs, be].some((n) => Number.isNaN(n))) return false;
  return as < be && ae > bs;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Depth-first search for the first string value under any of the given keys. */
function findString(value: unknown, keys: string[]): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const stack: unknown[] = [value];
  while (stack.length) {
    const current = stack.pop();
    if (!current || typeof current !== 'object') continue;
    const record = current as Record<string, unknown>;
    for (const key of keys) {
      if (typeof record[key] === 'string' && record[key]) return record[key] as string;
    }
    for (const child of Object.values(record)) if (child && typeof child === 'object') stack.push(child);
  }
  return undefined;
}

// --- timezone -----------------------------------------------------------------

/**
 * Turn a naive wall-clock time (`YYYY-MM-DDTHH:mm:ss`, meaning local time in
 * `timeZone`) into an RFC3339 string with the correct UTC offset, e.g.
 * `2026-08-25T09:30:00-04:00`. Resolves the offset at the actual instant so DST
 * boundaries get the right value.
 */
export function localWallTimeToRfc3339(wall: string, timeZone: string): string {
  const base = `${wall}`.slice(0, 19);
  const naive = new Date(`${base}Z`);
  if (Number.isNaN(naive.getTime())) return wall;
  let offset = offsetMinutesAt(naive, timeZone);
  // Re-resolve at the corrected instant to handle DST edges.
  offset = offsetMinutesAt(new Date(naive.getTime() - offset * 60000), timeZone);
  const sign = offset >= 0 ? '+' : '-';
  const abs = Math.abs(offset);
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  return `${base}${sign}${hh}:${mm}`;
}

function offsetMinutesAt(instant: Date, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = Object.fromEntries(dtf.formatToParts(instant).filter((p) => p.type !== 'literal').map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour === '24' ? '00' : parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return Math.round((asUtc - instant.getTime()) / 60000);
}
