import path from 'node:path';
import fs from 'node:fs';
import { writeFileAtomic } from '../utils/atomic-write.js';
import { okrDirName, type OkrModel, type KeyResult } from './loader.js';
import { updateKrProgress } from './writeback.js';

/**
 * Biweekly OKR progress contract + write-back pipeline (LEO-109).
 *
 * The biweekly review LLM is asked to emit a structured JSON block alongside its
 * narrative (see prompts/weekly_review.md). This module turns that block into
 * measurable, per-KR progress increments, matches every krId back to the local
 * OKR chain (skipping ids the model never proposed), renders human-facing
 * "O1-KR2: 40%→55% (+15)" lines for the confirmation card, and — only after the
 * user confirms — writes each KR back to the local OKR files via
 * `updateKrProgress` while appending an audit line to the rolling history.
 *
 * Everything degrades gracefully: an unparseable block yields `{ ok: false }` so
 * the caller keeps the narrative and skips write-back entirely.
 */

/** One KR progress entry as emitted by the biweekly LLM. */
export interface BiweeklyKrProgressInput {
  krId: string;
  current: string;
  /** progress percent; accepts "55" or "55%". */
  progress: string;
  evidence?: string;
  /** optional LLM self-rating, kept verbatim for the card. */
  confidence?: string | number;
}

/** The full structured block the biweekly LLM must emit. */
export interface BiweeklyProgressContract {
  kr_progress: BiweeklyKrProgressInput[];
  obstacles: string[];
  next_priorities: string[];
}

export interface BiweeklyProgressParse {
  ok: boolean;
  reason?: string;
  contract?: BiweeklyProgressContract;
}

/** A KR entry successfully matched to the loaded OKR model. */
export interface MatchedKr {
  krId: string;
  description: string;
  fromCurrent: string;
  fromProgress: string;
  fromPct: number | null;
  toCurrent: string;
  toProgress: string;
  toPct: number | null;
  deltaPct: number | null;
  evidence: string;
  confidence?: string;
}

export interface MatchResult {
  matched: MatchedKr[];
  skipped: Array<{ krId: string; reason: string }>;
}

export interface OkrProgressHistoryRecord {
  krId: string;
  date: string;
  from: string;
  to: string;
}

export interface WritebackOutcome {
  succeeded: number;
  failed: number;
  historyAppended: number;
  results: Array<{ krId: string; ok: boolean; file?: string; reason?: string }>;
}

/**
 * Extract and parse the biweekly progress JSON from raw LLM output. Tolerant of
 * ```json fences, surrounding narrative, and trailing prose. Never throws:
 * returns `{ ok: false, reason }` when no valid contract is found so the caller
 * can fall back to a narrative-only run.
 */
export function parseBiweeklyProgress(raw: string): BiweeklyProgressParse {
  if (!raw || !raw.trim()) return { ok: false, reason: 'empty output' };
  for (const candidate of extractJsonObjects(raw)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== 'object') continue;
    const obj = parsed as Record<string, unknown>;
    if (!Array.isArray(obj.kr_progress)) continue;
    const contract: BiweeklyProgressContract = {
      kr_progress: obj.kr_progress
        .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object')
        .map((entry) => ({
          krId: str(entry.krId ?? entry.kr_id),
          current: str(entry.current),
          progress: str(entry.progress),
          evidence: str(entry.evidence) || undefined,
          confidence: normalizeConfidence(entry.confidence),
        }))
        .filter((entry) => Boolean(entry.krId)),
      obstacles: toStringList(obj.obstacles),
      next_priorities: toStringList(obj.next_priorities),
    };
    return { ok: true, contract };
  }
  return { ok: false, reason: 'no kr_progress JSON block found' };
}

/**
 * Match each contract KR back to the loaded OKR model. Unknown ids are skipped
 * (never invented), so a hallucinated krId can never reach write-back.
 */
export function matchBiweeklyProgress(model: OkrModel, contract: BiweeklyProgressContract): MatchResult {
  const index = buildKrIndex(model);
  const matched: MatchedKr[] = [];
  const skipped: Array<{ krId: string; reason: string }> = [];
  const seen = new Set<string>();
  for (const entry of contract.kr_progress) {
    const key = entry.krId.trim().toLowerCase();
    if (!key) continue;
    if (seen.has(key)) {
      skipped.push({ krId: entry.krId, reason: 'duplicate krId in output' });
      continue;
    }
    const kr = index.get(key);
    if (!kr) {
      skipped.push({ krId: entry.krId, reason: 'krId not found in local OKR chain' });
      continue;
    }
    const toProgress = normalizePct(entry.progress);
    const fromPct = kr.progressPct;
    const toPct = parsePct(toProgress);
    // Reject nonsense progress before it can reach write-back: a non-numeric
    // percent, or one outside 0–100, is treated as a bad row and skipped (never
    // written to the local OKR file). The krId is still marked seen so a later
    // duplicate is reported as a duplicate rather than re-validated.
    seen.add(key);
    if (toPct == null) {
      skipped.push({ krId: kr.id, reason: `progress "${entry.progress}" is not a numeric percent` });
      continue;
    }
    if (toPct < 0 || toPct > 100) {
      skipped.push({ krId: kr.id, reason: `progress ${toPct}% is out of range (expected 0–100)` });
      continue;
    }
    matched.push({
      krId: kr.id,
      description: kr.description,
      fromCurrent: kr.current,
      fromProgress: kr.progress || (fromPct != null ? `${fromPct}%` : ''),
      fromPct,
      toCurrent: entry.current,
      toProgress,
      toPct,
      deltaPct: fromPct != null && toPct != null ? round1(toPct - fromPct) : null,
      evidence: entry.evidence || '',
      ...(entry.confidence != null && entry.confidence !== '' ? { confidence: String(entry.confidence) } : {}),
    });
  }
  return { matched, skipped };
}

/** Render "O1-KR2: 40%→55% (+15)" lines (falls back to current values when % is absent). */
export function renderKrIncrements(matched: MatchedKr[]): string[] {
  return matched.map((entry) => {
    if (entry.fromPct != null && entry.toPct != null) {
      const delta = entry.deltaPct ?? entry.toPct - entry.fromPct;
      const sign = delta >= 0 ? '+' : '';
      return `${entry.krId}: ${entry.fromPct}%→${entry.toPct}% (${sign}${round1(delta)})`;
    }
    const from = entry.fromProgress || entry.fromCurrent || 'n/a';
    const to = entry.toProgress || entry.toCurrent || 'n/a';
    return `${entry.krId}: ${from}→${to}`;
  });
}

/**
 * Apply confirmed KR write-backs to the local OKR files and append an audit line
 * per successful write to the rolling history JSONL. Failures are collected, not
 * thrown, so a single bad row cannot abort the batch.
 */
export function applyBiweeklyWriteback(input: {
  okrDir: string;
  historyPath: string;
  matched: MatchedKr[];
  date: string;
}): WritebackOutcome {
  const results: WritebackOutcome['results'] = [];
  const historyRecords: OkrProgressHistoryRecord[] = [];
  let succeeded = 0;
  let failed = 0;
  for (const entry of input.matched) {
    const result = updateKrProgress(input.okrDir, entry.krId, entry.toCurrent, entry.toProgress, input.date);
    if (result.ok) {
      succeeded += 1;
      historyRecords.push({
        krId: entry.krId,
        date: input.date,
        from: entry.fromProgress || (entry.fromPct != null ? `${entry.fromPct}%` : entry.fromCurrent),
        to: entry.toProgress || entry.toCurrent,
      });
      results.push({ krId: entry.krId, ok: true, ...(result.file ? { file: result.file } : {}) });
    } else {
      failed += 1;
      results.push({ krId: entry.krId, ok: false, ...(result.reason ? { reason: result.reason } : {}) });
    }
  }
  const historyAppended = historyRecords.length ? appendOkrProgressHistory(input.historyPath, historyRecords) : 0;
  return { succeeded, failed, historyAppended, results };
}

/** Append records to the rolling history JSONL atomically. Returns the count appended. */
export function appendOkrProgressHistory(historyPath: string, records: OkrProgressHistoryRecord[]): number {
  if (records.length === 0) return 0;
  let existing = '';
  try {
    if (fs.existsSync(historyPath)) existing = fs.readFileSync(historyPath, 'utf8');
  } catch {
    existing = '';
  }
  const base = existing && !existing.endsWith('\n') ? `${existing}\n` : existing;
  const appended = records.map((record) => JSON.stringify(record)).join('\n');
  writeFileAtomic(historyPath, `${base}${appended}\n`);
  return records.length;
}

/** Resolve the 10_OKR directory from a vault repository path (mirrors ui/okr-lite). */
export function resolveOkrDir(repositoryPath?: string): string {
  const trimmed = (repositoryPath || '').trim();
  if (trimmed) {
    const candidate = path.resolve(trimmed, okrDirName());
    if (fs.existsSync(candidate)) return candidate;
  }
  return path.resolve('memory-vault', 'default', okrDirName());
}

/** Default rolling-history path under data/runtime. */
export function defaultOkrHistoryPath(): string {
  return path.resolve('data', 'runtime', 'okr-progress-history.jsonl');
}

// --- internals ---------------------------------------------------------------

function buildKrIndex(model: OkrModel): Map<string, KeyResult> {
  const index = new Map<string, KeyResult>();
  for (const level of ['quarterly', 'annual', 'northStar'] as const) {
    for (const objective of model[level]) {
      for (const kr of objective.keyResults) {
        const key = kr.id.trim().toLowerCase();
        if (!index.has(key)) index.set(key, kr);
      }
    }
  }
  return index;
}

/**
 * Return candidate balanced-brace JSON substrings from arbitrary text, ordered
 * by appearance. String contents (including escaped quotes) are respected so
 * braces inside values do not confuse the matcher.
 */
function extractJsonObjects(text: string): string[] {
  const objects: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escape = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (inString) {
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === '}') {
      if (depth > 0) {
        depth -= 1;
        if (depth === 0 && start >= 0) {
          objects.push(text.slice(start, i + 1));
          start = -1;
        }
      }
    }
  }
  // Prefer objects that mention kr_progress so we skip unrelated JSON snippets.
  return objects.sort((a, b) => Number(b.includes('kr_progress')) - Number(a.includes('kr_progress')));
}

function normalizePct(value: string): string {
  const trimmed = (value || '').trim();
  if (!trimmed) return '';
  return /%\s*$/.test(trimmed) ? trimmed : `${trimmed}%`;
}

function parsePct(value: string): number | null {
  const match = (value || '').match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const num = Number(match[0]);
  return Number.isFinite(num) ? num : null;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function normalizeConfidence(value: unknown): string | undefined {
  if (value == null || value === '') return undefined;
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return value.trim() || undefined;
  return undefined;
}

function toStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => str(item)).filter(Boolean);
}

function str(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}
