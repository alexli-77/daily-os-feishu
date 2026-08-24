import assert from 'node:assert/strict';
import { applyCalendarAdjustments, parseCalendarAdjustments } from '../../src/calendar/adjust.js';
import type { CalendarDraft, CalendarDraftEvent } from '../../src/calendar/bridge.js';

// LEO-268 adjust feed-back loop — pure parse + apply (no DB needed).

function event(over: Partial<CalendarDraftEvent> & Pick<CalendarDraftEvent, 'title' | 'start' | 'end'>): CalendarDraftEvent {
  return {
    title: over.title,
    start: over.start,
    end: over.end,
    type: over.type ?? 'deep_work',
    sourceTaskIds: over.sourceTaskIds ?? [over.title],
    confidence: over.confidence ?? 'medium',
    warnings: over.warnings ?? [],
  };
}
function draft(events: CalendarDraftEvent[]): CalendarDraft {
  return { draftId: 'd', mode: 'draft-only', period: 'day', timezone: 'America/Toronto', events, warnings: [] };
}

testParseDrop();
testParseMoveVariants();
testParseResize();
testParseMultipleClauses();
testParseUnrecognized();
testApplyDropAndResize();
testApplyMoveDaypartTimeWeekday();
testApplyAccumulatesAndLeavesOthers();
console.log('calendar-adjust.test.ts: all tests passed');

function testParseDrop(): void {
  const r = parseCalendarAdjustments('删掉报销那块');
  assert.deepEqual(r.adjustments, [{ kind: 'drop', match: '报销' }]);
  assert.equal(r.unrecognized.length, 0);
}

function testParseMoveVariants(): void {
  assert.deepEqual(parseCalendarAdjustments('把深度工作挪到上午').adjustments, [
    { kind: 'move', match: '深度工作', to: { type: 'daypart', part: 'morning' } },
  ]);
  assert.deepEqual(parseCalendarAdjustments('把复盘挪到14:00').adjustments, [
    { kind: 'move', match: '复盘', to: { type: 'time', hhmm: '14:00' } },
  ]);
  assert.deepEqual(parseCalendarAdjustments('把复盘挪到周四').adjustments, [
    { kind: 'move', match: '复盘', to: { type: 'weekday', weekday: 4 } },
  ]);
}

function testParseResize(): void {
  assert.deepEqual(parseCalendarAdjustments('把深度工作缩到60分钟').adjustments, [
    { kind: 'resize', match: '深度工作', minutes: 60 },
  ]);
}

function testParseMultipleClauses(): void {
  const r = parseCalendarAdjustments('删掉报销，把深度工作挪到上午');
  assert.equal(r.adjustments.length, 2, 'two instructions parsed');
  assert.equal(r.adjustments[0]!.kind, 'drop');
  assert.equal(r.adjustments[1]!.kind, 'move');
}

function testParseUnrecognized(): void {
  const r = parseCalendarAdjustments('随便改改就行');
  assert.equal(r.adjustments.length, 0, 'nothing recognized');
  assert.deepEqual(r.unrecognized, ['随便改改就行'], 'surfaced, not silently dropped');
}

function testApplyDropAndResize(): void {
  const d = draft([
    event({ title: '深度工作', start: '2026-08-25T09:00:00', end: '2026-08-25T10:30:00' }),
    event({ title: '报销', start: '2026-08-25T14:00:00', end: '2026-08-25T14:30:00' }),
  ]);
  const dropped = applyCalendarAdjustments(d, [{ kind: 'drop', match: '报销' }]);
  assert.equal(dropped.events.length, 1, 'drop removes the matching block');
  assert.equal(dropped.events[0]!.title, '深度工作');

  const resized = applyCalendarAdjustments(d, [{ kind: 'resize', match: '深度工作', minutes: 60 }]);
  assert.equal(resized.events[0]!.start, '2026-08-25T09:00:00', 'resize keeps start');
  assert.equal(resized.events[0]!.end, '2026-08-25T10:00:00', 'resize sets end = start + 60min');
}

function testApplyMoveDaypartTimeWeekday(): void {
  const base = draft([event({ title: '深度工作', start: '2026-08-25T09:00:00', end: '2026-08-25T10:00:00' })]);

  const daypart = applyCalendarAdjustments(base, [{ kind: 'move', match: '深度工作', to: { type: 'daypart', part: 'afternoon' } }]);
  assert.equal(daypart.events[0]!.start, '2026-08-25T14:00:00', 'afternoon -> 14:00');
  assert.equal(daypart.events[0]!.end, '2026-08-25T15:00:00', 'duration (60m) preserved');

  const time = applyCalendarAdjustments(base, [{ kind: 'move', match: '深度工作', to: { type: 'time', hhmm: '11:30' } }]);
  assert.equal(time.events[0]!.start, '2026-08-25T11:30:00');
  assert.equal(time.events[0]!.end, '2026-08-25T12:30:00');

  const weekday = applyCalendarAdjustments(base, [{ kind: 'move', match: '深度工作', to: { type: 'weekday', weekday: 4 } }]);
  const movedDate = weekday.events[0]!.start.slice(0, 10);
  assert.equal(new Date(`${movedDate}T00:00:00Z`).getUTCDay(), 4, 'moved onto a Thursday');
  assert.equal(weekday.events[0]!.start.slice(11), '09:00:00', 'weekday move keeps time of day');
}

function testApplyAccumulatesAndLeavesOthers(): void {
  const d = draft([
    event({ title: '深度工作', start: '2026-08-25T09:00:00', end: '2026-08-25T10:30:00' }),
    event({ title: '报销', start: '2026-08-25T14:00:00', end: '2026-08-25T14:30:00' }),
    event({ title: '复盘', start: '2026-08-25T20:00:00', end: '2026-08-25T20:30:00' }),
  ]);
  const out = applyCalendarAdjustments(d, [
    { kind: 'drop', match: '报销' },
    { kind: 'move', match: '深度工作', to: { type: 'daypart', part: 'morning' } },
  ]);
  assert.equal(out.events.length, 2, 'one dropped, two remain');
  const deep = out.events.find((e) => e.title === '深度工作')!;
  assert.equal(deep.start, '2026-08-25T09:00:00', 'deep work moved to morning');
  const review = out.events.find((e) => e.title === '复盘')!;
  assert.equal(review.start, '2026-08-25T20:00:00', 'unrelated block left untouched');
}
