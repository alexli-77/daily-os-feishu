import path from 'node:path';
import fs from 'node:fs';
import { writeFileAtomic } from '../utils/atomic-write.js';
import type { AppConfig } from '../config/schema.js';

/**
 * TokenMeter — records per-call LLM token usage + estimated cost to an append-only
 * JSONL ledger, and enforces a three-tier budget circuit breaker (per-task / daily
 * / monthly) before each LLM call.
 *
 * No new runtime dependencies: plain Node fs + the existing atomic-write helper.
 */

export interface ModelPrice {
  /** USD per 1M input tokens. */
  input: number;
  /** USD per 1M output tokens. */
  output: number;
}

export interface UsageLedgerEntry {
  ts: string;
  day: string; // YYYY-MM-DD (UTC)
  month: string; // YYYY-MM (UTC)
  runId: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  estCostUsd: number;
}

export interface UsageSummary {
  period: 'day' | 'month';
  key: string;
  inputTokens: number;
  outputTokens: number;
  estCostUsd: number;
  calls: number;
}

export type BudgetScope = 'per_task' | 'daily' | 'monthly';

export class BudgetExceededError extends Error {
  readonly scope: BudgetScope;
  readonly limitUsd: number;
  readonly spentUsd: number;

  constructor(scope: BudgetScope, limitUsd: number, spentUsd: number) {
    super(
      `Budget exceeded (${scope}): spent $${spentUsd.toFixed(4)} >= limit $${limitUsd.toFixed(2)}. ` +
        'Refusing further LLM calls until the window resets or the limit is raised.',
    );
    this.name = 'BudgetExceededError';
    this.scope = scope;
    this.limitUsd = limitUsd;
    this.spentUsd = spentUsd;
  }
}

/**
 * Built-in price table (USD per 1M tokens). Prefix matching is used so that
 * versioned model ids (e.g. `claude-sonnet-5-20260101`) resolve to the base row.
 * Values can be overridden per-model via config.billing.price_overrides.
 */
export const DEFAULT_PRICE_TABLE: Record<string, ModelPrice> = {
  // Anthropic
  'claude-sonnet-5': { input: 3, output: 15 },
  'claude-sonnet-4': { input: 3, output: 15 },
  'claude-opus-4': { input: 15, output: 75 },
  'claude-opus': { input: 15, output: 75 },
  'claude-haiku-4': { input: 0.8, output: 4 },
  'claude-haiku': { input: 0.8, output: 4 },
  'claude-3-5-sonnet': { input: 3, output: 15 },
  'claude-3-5-haiku': { input: 0.8, output: 4 },
  'claude-3-opus': { input: 15, output: 75 },
  // OpenAI
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'gpt-4o': { input: 2.5, output: 10 },
  'gpt-4.1-mini': { input: 0.4, output: 1.6 },
  'gpt-4.1': { input: 2, output: 8 },
  'o3-mini': { input: 1.1, output: 4.4 },
  'o3': { input: 2, output: 8 },
  'o1-mini': { input: 1.1, output: 4.4 },
  'o1': { input: 15, output: 60 },
};

/** Resolved lazily against the current cwd so callers/tests can redirect via chdir. */
function defaultLedgerPath(): string {
  return path.resolve('data/runtime/usage-ledger.jsonl');
}

function defaultAlertPath(): string {
  return path.resolve('data/runtime/budget-alerts.jsonl');
}

export interface MeterOptions {
  /** Override the ledger path (used by tests). */
  ledgerPath?: string;
  /** Override the alert-log path (used by tests). */
  alertPath?: string;
  /** Merge extra/override model prices (config.billing.price_overrides). */
  priceOverrides?: Record<string, ModelPrice>;
}

function utcDayMonth(date = new Date()): { day: string; month: string } {
  const iso = date.toISOString();
  return { day: iso.slice(0, 10), month: iso.slice(0, 7) };
}

/**
 * Resolve the price for a model: exact match first, then longest matching prefix,
 * checking config overrides before the built-in table.
 */
export function resolveModelPrice(
  model: string,
  priceOverrides?: Record<string, ModelPrice>,
): ModelPrice | undefined {
  const table: Record<string, ModelPrice> = { ...DEFAULT_PRICE_TABLE, ...(priceOverrides ?? {}) };
  if (table[model]) return table[model];
  const candidates = Object.keys(table)
    .filter((key) => model.startsWith(key))
    .sort((a, b) => b.length - a.length);
  return candidates.length > 0 ? table[candidates[0]] : undefined;
}

/** Estimate USD cost for a call. Returns 0 when the model price is unknown. */
export function estimateCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
  priceOverrides?: Record<string, ModelPrice>,
): number {
  const price = resolveModelPrice(model, priceOverrides);
  if (!price) return 0;
  return (inputTokens / 1_000_000) * price.input + (outputTokens / 1_000_000) * price.output;
}

/** Append a usage record to the JSONL ledger (atomic rewrite of the whole file). */
export function recordUsage(
  runId: string,
  provider: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
  estCostUsd: number,
  options: MeterOptions = {},
): UsageLedgerEntry {
  const ledgerPath = options.ledgerPath ?? defaultLedgerPath();
  const { day, month } = utcDayMonth();
  const entry: UsageLedgerEntry = {
    ts: new Date().toISOString(),
    day,
    month,
    runId,
    provider,
    model,
    inputTokens: Math.max(0, Math.round(inputTokens || 0)),
    outputTokens: Math.max(0, Math.round(outputTokens || 0)),
    estCostUsd: Number((estCostUsd || 0).toFixed(6)),
  };
  const existing = fs.existsSync(ledgerPath) ? fs.readFileSync(ledgerPath, 'utf8') : '';
  const next = existing.length > 0 && !existing.endsWith('\n') ? `${existing}\n` : existing;
  writeFileAtomic(ledgerPath, `${next}${JSON.stringify(entry)}\n`);
  return entry;
}

export function readLedger(ledgerPath = defaultLedgerPath()): UsageLedgerEntry[] {
  if (!fs.existsSync(ledgerPath)) return [];
  return fs
    .readFileSync(ledgerPath, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      try {
        return JSON.parse(line) as UsageLedgerEntry;
      } catch {
        return undefined;
      }
    })
    .filter((entry): entry is UsageLedgerEntry => Boolean(entry));
}

/** Aggregate usage for the current UTC day or month. */
export function getUsageSummary(
  period: 'day' | 'month',
  options: MeterOptions & { at?: Date } = {},
): UsageSummary {
  const ledgerPath = options.ledgerPath ?? defaultLedgerPath();
  const { day, month } = utcDayMonth(options.at ?? new Date());
  const key = period === 'day' ? day : month;
  const rows = readLedger(ledgerPath).filter((entry) => (period === 'day' ? entry.day : entry.month) === key);
  return rows.reduce<UsageSummary>(
    (acc, entry) => {
      acc.inputTokens += entry.inputTokens;
      acc.outputTokens += entry.outputTokens;
      acc.estCostUsd += entry.estCostUsd;
      acc.calls += 1;
      return acc;
    },
    { period, key, inputTokens: 0, outputTokens: 0, estCostUsd: 0, calls: 0 },
  );
}

function sumForRun(ledgerPath: string, runId: string): number {
  return readLedger(ledgerPath)
    .filter((entry) => entry.runId === runId)
    .reduce((total, entry) => total + entry.estCostUsd, 0);
}

function writeAlert(alertPath: string, payload: Record<string, unknown>): void {
  try {
    const existing = fs.existsSync(alertPath) ? fs.readFileSync(alertPath, 'utf8') : '';
    const next = existing.length > 0 && !existing.endsWith('\n') ? `${existing}\n` : existing;
    writeFileAtomic(alertPath, `${next}${JSON.stringify({ ts: new Date().toISOString(), ...payload })}\n`);
  } catch {
    // Alert logging is best-effort and must never mask the original budget error.
  }
}

export interface BillingLimits {
  per_task_usd: number;
  daily_usd: number;
  monthly_usd: number;
  price_overrides?: Record<string, ModelPrice>;
}

/**
 * Pre-flight budget check run before every LLM call. Inspects already-recorded
 * spend for the current run / UTC day / UTC month; if any tier is already at or
 * over its limit it logs an alert and throws BudgetExceededError (which aborts
 * the call).
 */
export function checkBudget(
  billing: BillingLimits,
  context: { runId: string } & MeterOptions,
): void {
  const ledgerPath = context.ledgerPath ?? defaultLedgerPath();
  const alertPath = context.alertPath ?? defaultAlertPath();

  const taskSpent = sumForRun(ledgerPath, context.runId);
  const daySpent = getUsageSummary('day', { ledgerPath }).estCostUsd;
  const monthSpent = getUsageSummary('month', { ledgerPath }).estCostUsd;

  const checks: Array<{ scope: BudgetScope; spent: number; limit: number }> = [
    { scope: 'per_task', spent: taskSpent, limit: billing.per_task_usd },
    { scope: 'daily', spent: daySpent, limit: billing.daily_usd },
    { scope: 'monthly', spent: monthSpent, limit: billing.monthly_usd },
  ];

  for (const check of checks) {
    if (check.limit > 0 && check.spent >= check.limit) {
      writeAlert(alertPath, {
        kind: 'budget_exceeded',
        scope: check.scope,
        runId: context.runId,
        spentUsd: Number(check.spent.toFixed(6)),
        limitUsd: check.limit,
      });
      throw new BudgetExceededError(check.scope, check.limit, check.spent);
    }
  }
}

/** Resolve billing limits from AppConfig, applying schema defaults defensively. */
export function billingFromConfig(config: AppConfig): BillingLimits {
  const billing = (config as AppConfig & { billing?: Partial<BillingLimits> }).billing;
  return {
    per_task_usd: billing?.per_task_usd ?? 2,
    daily_usd: billing?.daily_usd ?? 10,
    monthly_usd: billing?.monthly_usd ?? 100,
    price_overrides: billing?.price_overrides,
  };
}
