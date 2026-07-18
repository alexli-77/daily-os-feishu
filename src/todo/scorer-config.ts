import fs from 'node:fs';
import path from 'node:path';

/**
 * Weight constants for the programmatic todo scorer (LEO-209).
 *
 * These are intentionally kept out of `src/config/schema.ts` so the scorer can
 * evolve independently of the user-facing config surface. The defaults below are
 * the source of truth; an optional `data/runtime/scorer-weights.json` may
 * override any subset of them. That override file is a placeholder for the
 * feedback loop (adoption stats -> reweighting) and is not required to exist.
 */
export interface ScorerWeights {
  /** Item whose due date/next-review is already in the past. */
  overdue: number;
  /** Item due within the next 24h (but not yet overdue). */
  dueWithin24h: number;
  /** Linear priority = Urgent (1). */
  linearUrgent: number;
  /** Linear priority = High (2). */
  linearHigh: number;
  /** A calendar block within 2h is associated with the item. */
  calendarWithin2h: number;
  /** Per carry-over day bonus. */
  carryOverPerDay: number;
  /** Cap on the total carry-over bonus. */
  carryOverCap: number;
  /** Item linked to a real (non-placeholder) local OKR key result. */
  okrLinked: number;
  /**
   * Weaker OKR signal: item only matched a Feishu weekly-priority OKR tag.
   * This is a transitional fallback until the local OKR files are populated.
   */
  okrWeeklyHit: number;
  /** Item carries a customer / delivery facing signal. */
  customerFacing: number;
}

export const DEFAULT_SCORER_WEIGHTS: ScorerWeights = {
  overdue: 35,
  dueWithin24h: 25,
  linearUrgent: 20,
  linearHigh: 12,
  calendarWithin2h: 15,
  carryOverPerDay: 5,
  carryOverCap: 15,
  okrLinked: 12,
  okrWeeklyHit: 6,
  customerFacing: 10,
};

export const DEFAULT_TOP_N = 10;

export const SCORER_WEIGHTS_OVERRIDE_PATH = 'data/runtime/scorer-weights.json';

/**
 * Resolve the effective weights: defaults merged with an optional local
 * override file. Any malformed or missing file silently falls back to defaults
 * so a bad override never breaks the daily plan.
 */
export function loadScorerWeights(overridePath: string = SCORER_WEIGHTS_OVERRIDE_PATH): ScorerWeights {
  try {
    const resolved = path.resolve(overridePath);
    if (!fs.existsSync(resolved)) return { ...DEFAULT_SCORER_WEIGHTS };
    const raw = JSON.parse(fs.readFileSync(resolved, 'utf8')) as Partial<ScorerWeights>;
    const merged = { ...DEFAULT_SCORER_WEIGHTS };
    for (const key of Object.keys(DEFAULT_SCORER_WEIGHTS) as Array<keyof ScorerWeights>) {
      const value = raw[key];
      if (typeof value === 'number' && Number.isFinite(value)) merged[key] = value;
    }
    return merged;
  } catch {
    return { ...DEFAULT_SCORER_WEIGHTS };
  }
}
