import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Isolate the SQLite DB before anything opens it (same pattern as sqlite-store).
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-os-calwb-'));
process.env.DAILY_OS_DB_PATH = path.join(dir, 'daily-os.db');

const db = await import('../../src/storage/db.js');
const wb = await import('../../src/calendar/writeback.js');
import type { AppConfig } from '../../src/config/schema.js';
import type { CalendarDraft, CalendarDraftEvent } from '../../src/calendar/bridge.js';

type Client = wb.LarkCalendarClient & { calls: { create: number; update: number; delete: number } };

function fakeClient(): Client {
  const calls = { create: 0, update: 0, delete: 0 };
  let seq = 0;
  return {
    calls,
    async createEvent() {
      calls.create += 1;
      seq += 1;
      return { eventId: `ev_${seq}`, calendarId: 'primary' };
    },
    async updateEvent() {
      calls.update += 1;
    },
    async deleteEvent() {
      calls.delete += 1;
    },
  };
}

function makeConfig(conflictPolicy: 'warn' | 'block' | 'ignore'): AppConfig {
  return {
    user: { timezone: 'America/Toronto' },
    calendar: { writeback: { enabled: true, identity: 'user', calendar_id: 'primary', conflict_policy: conflictPolicy, dry_run: false } },
  } as unknown as AppConfig;
}
const config = makeConfig('warn');

// LEO-267: a busy interval that overlaps the 09:00-10:00 slots used by conflict tests.
const OVERLAP: wb.FreeBusyInterval[] = [{ start: '2026-09-01T09:30:00-04:00', end: '2026-09-01T10:30:00-04:00' }];

type ConflictClient = wb.LarkCalendarClient & { calls: { create: number; update: number; delete: number; freebusy: number } };

/** Client whose free/busy always reports the given busy intervals. */
function conflictClient(busy: wb.FreeBusyInterval[]): ConflictClient {
  const calls = { create: 0, update: 0, delete: 0, freebusy: 0 };
  let seq = 0;
  return {
    calls,
    async createEvent() {
      calls.create += 1;
      seq += 1;
      return { eventId: `cev_${seq}`, calendarId: 'primary' };
    },
    async updateEvent() {
      calls.update += 1;
    },
    async deleteEvent() {
      calls.delete += 1;
    },
    async queryFreeBusy() {
      calls.freebusy += 1;
      return busy;
    },
  };
}

let draftSeq = 0;
function event(over: Partial<CalendarDraftEvent> & Pick<CalendarDraftEvent, 'sourceTaskIds' | 'start' | 'end'>): CalendarDraftEvent {
  return {
    title: over.title ?? 'Block',
    start: over.start,
    end: over.end,
    type: over.type ?? 'deep_work',
    sourceTaskIds: over.sourceTaskIds,
    confidence: over.confidence ?? 'medium',
    warnings: over.warnings ?? [],
  };
}
function draft(events: CalendarDraftEvent[]): CalendarDraft {
  draftSeq += 1;
  return { draftId: `d${draftSeq}`, mode: 'draft-only', period: 'day', timezone: config.user.timezone, events, warnings: [] };
}

try {
  await testIdempotentByDay();
  await testMovedBlockUpdatesInPlace();
  await testUndoDeletesOnlyBatchThenResurrects();
  await testDryRunPersistsNothing();
  testTimezoneOffsets();
  await testPartialFailureStillRecordsBatch();
  await testConflictWarnWritesButFlags();
  await testConflictBlockSkipsWrite();
  await testConflictIgnoreSkipsCheck();
  await testNoOverlapWritesClean();
  console.log('calendar-writeback.test.ts: all tests passed');
} finally {
  db.resetDbForTests();
  fs.rmSync(dir, { recursive: true, force: true });
}

async function testIdempotentByDay(): Promise<void> {
  const d = draft([event({ sourceTaskIds: ['t1'], start: '2026-08-25T09:30:00', end: '2026-08-25T11:00:00', title: 'Deep work' })]);
  const client = fakeClient();
  const r1 = await wb.writebackCalendarDraft(config, d, { client, batchId: 'b1' });
  assert.equal(r1.created, 1, 'first confirm creates');
  assert.equal(client.calls.create, 1);

  const r2 = await wb.writebackCalendarDraft(config, d, { client, batchId: 'b2' });
  assert.equal(r2.created, 0, 'second confirm creates nothing');
  assert.equal(r2.skipped, 1, 'second confirm skips (unchanged)');
  assert.equal(client.calls.create, 1, 'no duplicate create call');

  const row = db.dbFindCalendarWriteback(wb.calendarDedupKey(d.events[0]!));
  assert.ok(row, 'exactly one active row for the key');
}

async function testMovedBlockUpdatesInPlace(): Promise<void> {
  const client = fakeClient();
  const first = draft([event({ sourceTaskIds: ['t2'], start: '2026-08-25T09:30:00', end: '2026-08-25T10:30:00', title: 'Move me' })]);
  await wb.writebackCalendarDraft(config, first, { client, batchId: 'm1' });
  // Same task + same day, different time -> same dedup key -> update, not create.
  const moved = draft([event({ sourceTaskIds: ['t2'], start: '2026-08-25T14:00:00', end: '2026-08-25T15:00:00', title: 'Move me' })]);
  const r = await wb.writebackCalendarDraft(config, moved, { client, batchId: 'm2' });
  assert.equal(r.updated, 1, 'moved block updates');
  assert.equal(r.created, 0, 'moved block does not create a new event');
  assert.equal(client.calls.update, 1);
  const row = db.dbFindCalendarWriteback(wb.calendarDedupKey(moved.events[0]!));
  assert.ok(row && row.start.startsWith('2026-08-25T14:00:00'), 'row time updated to new slot');
}

async function testUndoDeletesOnlyBatchThenResurrects(): Promise<void> {
  const client = fakeClient();
  const d = draft([event({ sourceTaskIds: ['u1'], start: '2026-08-26T09:00:00', end: '2026-08-26T10:00:00', title: 'Undo me' })]);
  const key = wb.calendarDedupKey(d.events[0]!);
  await wb.writebackCalendarDraft(config, d, { client, batchId: 'bu' });
  assert.ok(db.dbFindCalendarWriteback(key), 'active before undo');

  const undo = await wb.undoCalendarBatch(config, 'bu', { client });
  assert.equal(undo.deleted, 1, 'undo deletes the one event');
  assert.equal(client.calls.delete, 1);
  assert.ok(!db.dbFindCalendarWriteback(key), 'key inactive after undo');

  const r = await wb.writebackCalendarDraft(config, d, { client, batchId: 'bu2' });
  assert.equal(r.created, 1, 'an undone key can be recreated');
}

async function testDryRunPersistsNothing(): Promise<void> {
  const client = fakeClient();
  const d = draft([event({ sourceTaskIds: ['dr1'], start: '2026-08-27T09:00:00', end: '2026-08-27T10:00:00', title: 'Dry' })]);
  const r = await wb.writebackCalendarDraft(config, d, { client, dryRun: true });
  assert.equal(r.dryRun, true);
  assert.equal(r.events[0]!.action, 'would-create', 'dry-run reports planned action');
  assert.equal(client.calls.create, 0, 'dry-run never calls the client');
  assert.ok(!db.dbFindCalendarWriteback(wb.calendarDedupKey(d.events[0]!)), 'dry-run persists nothing');
  assert.equal(r.batchId, undefined, 'dry-run records no batch');
}

function testTimezoneOffsets(): void {
  assert.ok(wb.localWallTimeToRfc3339('2026-07-15T09:30:00', 'America/Toronto').endsWith('-04:00'), 'summer EDT offset');
  assert.ok(wb.localWallTimeToRfc3339('2026-01-15T09:30:00', 'America/Toronto').endsWith('-05:00'), 'winter EST offset');
  assert.equal(wb.localWallTimeToRfc3339('2026-07-15T09:30:00', 'UTC'), '2026-07-15T09:30:00+00:00', 'UTC offset');
}

async function testConflictWarnWritesButFlags(): Promise<void> {
  const client = conflictClient(OVERLAP);
  const d = draft([event({ sourceTaskIds: ['cw1'], start: '2026-09-01T09:00:00', end: '2026-09-01T10:00:00', title: 'Warn' })]);
  const r = await wb.writebackCalendarDraft(makeConfig('warn'), d, { client });
  assert.equal(client.calls.freebusy, 1, 'free/busy queried before write');
  assert.equal(r.created, 1, 'warn policy still writes');
  assert.equal(r.conflicts, 1, 'conflict counted');
  assert.equal(r.events[0]!.conflict, true, 'event flagged as conflicting');
  assert.ok(db.dbFindCalendarWriteback(wb.calendarDedupKey(d.events[0]!)), 'row persisted under warn');
}

async function testConflictBlockSkipsWrite(): Promise<void> {
  const client = conflictClient(OVERLAP);
  const d = draft([event({ sourceTaskIds: ['cb1'], start: '2026-09-01T09:00:00', end: '2026-09-01T10:00:00', title: 'Block' })]);
  const r = await wb.writebackCalendarDraft(makeConfig('block'), d, { client });
  assert.equal(r.blocked, 1, 'block policy blocks the conflicting slot');
  assert.equal(r.created, 0, 'nothing written under block');
  assert.equal(client.calls.create, 0, 'create never called under block');
  assert.equal(r.events[0]!.action, 'blocked');
  assert.ok(!db.dbFindCalendarWriteback(wb.calendarDedupKey(d.events[0]!)), 'no row under block');
}

async function testConflictIgnoreSkipsCheck(): Promise<void> {
  const client = conflictClient(OVERLAP);
  const d = draft([event({ sourceTaskIds: ['ci1'], start: '2026-09-01T09:00:00', end: '2026-09-01T10:00:00', title: 'Ignore' })]);
  const r = await wb.writebackCalendarDraft(makeConfig('ignore'), d, { client });
  assert.equal(client.calls.freebusy, 0, 'ignore policy never queries free/busy');
  assert.equal(r.created, 1, 'ignore writes directly');
  assert.equal(r.conflicts, 0, 'no conflict recorded under ignore');
}

async function testNoOverlapWritesClean(): Promise<void> {
  const client = conflictClient([]);
  const d = draft([event({ sourceTaskIds: ['no1'], start: '2026-09-01T09:00:00', end: '2026-09-01T10:00:00', title: 'Clean' })]);
  const r = await wb.writebackCalendarDraft(makeConfig('warn'), d, { client });
  assert.equal(client.calls.freebusy, 1, 'free/busy queried');
  assert.equal(r.created, 1);
  assert.equal(r.conflicts, 0, 'no conflict when free/busy is empty');
  assert.equal(r.events[0]!.conflict, false);
}

async function testPartialFailureStillRecordsBatch(): Promise<void> {
  let n = 0;
  const client: wb.LarkCalendarClient = {
    async createEvent() {
      n += 1;
      if (n === 2) throw new Error('boom');
      return { eventId: `e${n}`, calendarId: 'primary' };
    },
    async updateEvent() {},
    async deleteEvent() {},
  };
  const d = draft([
    event({ sourceTaskIds: ['pf1'], start: '2026-08-28T09:00:00', end: '2026-08-28T10:00:00', title: 'ok' }),
    event({ sourceTaskIds: ['pf2'], start: '2026-08-28T11:00:00', end: '2026-08-28T12:00:00', title: 'boom' }),
  ]);
  const r = await wb.writebackCalendarDraft(config, d, { client, batchId: 'bp' });
  assert.equal(r.created, 1, 'the good event is written');
  assert.equal(r.failed, 1, 'the failing event is reported, not thrown');
  assert.equal(r.batchId, 'bp', 'batch recorded despite partial failure so undo can reach it');
  assert.ok(db.dbFindCalendarWriteback(wb.calendarDedupKey(d.events[0]!)), 'successful event persisted');
  assert.ok(!db.dbFindCalendarWriteback(wb.calendarDedupKey(d.events[1]!)), 'failed event not persisted');
}
