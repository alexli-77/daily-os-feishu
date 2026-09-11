import { buildCycleId, type CycleDoc } from './file.js';
import { inferMode } from './migration.js';

/**
 * Where the cycle after the current one starts, and how long it runs.
 *
 * Until now every cycle file was born from a life-review-os run: the run knew
 * its own target week and `writeback.ts` turned that label into a file. A user
 * asking for "the next cycle" from the console has no run to borrow a label
 * from, so the dates have to come from somewhere else, and the only honest
 * source is the cycle that just ended.
 *
 * Hence the default policy — 沿用上一期. Length is copied from the previous
 * cycle and the start is the day after it ended. A constant 14 would be wrong
 * for anyone whose cadence changes, and this vault's own history alternates:
 * `6.22-6.28` (7 days) sits next to `6.29-7.12` (14).
 *
 * All arithmetic is on `YYYY-MM-DD` strings in UTC, the same way `migration.ts`
 * dates a label. A cycle is a span of whole days, and an hours-based local-time
 * calculation is how a cycle ends up starting a day early across a DST switch.
 */

/** Used only when the vault holds no cycle to copy: `DEFAULT_CYCLE_MODE`'s length. */
const DEFAULT_DAYS = 14;
const DAY_MS = 86_400_000;
const LABEL_PATTERN = /^(\d{1,2})\.(\d{1,2})-(\d{1,2})\.(\d{1,2})$/;

/**
 * The widest length that is still a cycle. Long enough for a monthly experiment,
 * short enough that a mistyped "140" is refused instead of creating a file that
 * swallows the rest of the year.
 */
export const MIN_CYCLE_DAYS = 1;
export const MAX_CYCLE_DAYS = 60;

export interface NextCycleOptions {
  /** Requested length. Absent means "copy the previous cycle". */
  days?: number;
  /** `YYYY-MM-DD` in the user's timezone. Only used when there is no previous cycle. */
  today: string;
}

export interface NextCyclePlan {
  /** `<YYYY-MM-DD>_<label>`, i.e. the file name without `.md`. */
  id: string;
  label: string;
  mode: string;
  startDate: string;
  endDate: string;
  days: number;
  /**
   * Which of the four rules decided the length. The caller repeats it back to
   * the user: "14 天" alone does not say whether the app copied their cadence or
   * fell back to a constant, and those two deserve different amounts of trust.
   */
  lengthFrom: 'request' | 'previous-label' | 'previous-mode' | 'default';
  /** The cycle this one follows, or '' when the vault was empty. */
  previousId: string;
}

export function planNextCycle(previous: CycleDoc | null, options: NextCycleOptions): NextCyclePlan {
  // A document whose id carried no start date cannot say when it ended, so it
  // cannot be followed. Falling back to "starts today" beats dating the new
  // cycle from a blank string.
  const base = previous && previous.startDate ? previous : null;
  const copied = base ? previousLength(base) : null;
  const days = options.days ?? copied?.days ?? DEFAULT_DAYS;
  const startDate = base && copied ? addDays(base.startDate, copied.days) : options.today;
  const endDate = addDays(startDate, days - 1);
  const label = cycleLabel(startDate, endDate);

  return {
    id: buildCycleId(startDate, label),
    label,
    // Derived from the label rather than chosen here, so the two can never
    // disagree — `inferMode` is what dates every migrated file's mode as well.
    mode: inferMode(label),
    startDate,
    endDate,
    days,
    lengthFrom: options.days !== undefined ? 'request' : copied ? copied.from : 'default',
    previousId: base?.id || '',
  };
}

/**
 * How long the previous cycle ran.
 *
 * The label is preferred over `mode` because it is the more specific statement:
 * a file marked `biweekly` and labelled `7.20-8.2` agrees, but a hand-edited
 * file can carry a label the mode never anticipated, and the label is the thing
 * the user reads. `mode` is the fallback for a label that does not parse, which
 * hand-edited files do have.
 */
function previousLength(doc: CycleDoc): { days: number; from: 'previous-label' | 'previous-mode' } {
  const fromLabel = labelSpanDays(doc.startDate, doc.cycle);
  if (fromLabel) return { days: fromLabel, from: 'previous-label' };
  return { days: doc.mode === 'weekly' ? 7 : 14, from: 'previous-mode' };
}

/**
 * `2026-07-20` + `7.20-8.2` -> 14. Null for a label that is not a date range, or
 * one so long it is more likely to be a typo than a cadence.
 *
 * Only the span is read, never the start: the file name is what dates a cycle,
 * and a file whose label disagrees with its name still has a usable length.
 */
function labelSpanDays(startDate: string, label: string): number | null {
  const match = LABEL_PATTERN.exec((label || '').replace(/\s+/g, ''));
  const year = Number((startDate || '').slice(0, 4));
  if (!match || !year) return null;
  const [startMonth, startDay, endMonth, endDay] = match.slice(1).map(Number);
  const start = Date.UTC(year, startMonth - 1, startDay);
  // A label that wraps the new year (`12.29-1.11`) ends in the following one.
  const end = Date.UTC(endMonth < startMonth ? year + 1 : year, endMonth - 1, endDay);
  const days = Math.round((end - start) / DAY_MS) + 1;
  return days >= MIN_CYCLE_DAYS && days <= MAX_CYCLE_DAYS ? days : null;
}

/** `2026-09-21` + `2026-10-04` -> `9.21-10.4`, the form the whole system uses. */
function cycleLabel(startDate: string, endDate: string): string {
  const start = utcDate(startDate);
  const end = utcDate(endDate);
  return `${start.getUTCMonth() + 1}.${start.getUTCDate()}-${end.getUTCMonth() + 1}.${end.getUTCDate()}`;
}

function addDays(date: string, days: number): string {
  return new Date(utcDate(date).getTime() + days * DAY_MS).toISOString().slice(0, 10);
}

function utcDate(date: string): Date {
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) throw new Error(`Invalid cycle date: ${date || '(empty)'}`);
  return parsed;
}
