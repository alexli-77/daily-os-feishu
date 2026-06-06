import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { AppConfig } from '../config/schema.js';
import { loadMemory } from '../storage/memory.js';
import { collectEvidence } from '../workflows/evidence.js';
import type { Evidence, EvidenceSource } from '../workflows/types.js';

export interface ProgressCandidate {
  id: string;
  title: string;
  source: string;
  evidence: string;
  confidence: 'high' | 'medium' | 'low';
  reason: string;
}

export interface ProgressCaptureResult {
  date: string;
  generated_at: string;
  candidates: ProgressCandidate[];
  missing_sources: string[];
}

export interface ProgressLedgerEntry {
  id: string;
  title: string;
  source: string;
  evidence: string;
  confirmed_at: string;
}

const PROGRESS_WORDS = [
  '完成',
  '已完成',
  '推进',
  '进展',
  '合并',
  '发布',
  '上线',
  '修复',
  'done',
  'merged',
  'shipped',
  'released',
  'fixed',
  'progress',
];

export async function collectProgressCandidates(config: AppConfig, date: string): Promise<ProgressCaptureResult> {
  const [evidence, memory] = await Promise.all([collectEvidence(config, date), Promise.resolve(loadMemory(config))]);
  const candidates = dedupeCandidates([
    ...extractLinearCandidates(evidence, date),
    ...extractGitHubCandidates(evidence, date),
    ...extractFeishuCandidates(evidence),
    ...extractDailyMemoryCandidates(memory.recentDaily, date),
    ...extractLocalFileCandidates(evidence),
  ]).slice(0, config.progress.max_candidates);

  return {
    date,
    generated_at: new Date().toISOString(),
    candidates,
    missing_sources: missingSources(evidence),
  };
}

export function progressLedgerPath(config: AppConfig, date: string): string {
  return path.join(path.resolve(config.progress.ledger_dir), `${date}.md`);
}

export function appendConfirmedProgress(config: AppConfig, date: string, entries: ProgressLedgerEntry[]): string {
  const ledgerPath = progressLedgerPath(config, date);
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  const existing = fs.existsSync(ledgerPath) ? fs.readFileSync(ledgerPath, 'utf8') : '';
  const existingIds = new Set([...existing.matchAll(/<!-- progress-id:([^ ]+) -->/g)].map((match) => match[1]));
  const fresh = entries.filter((entry) => !existingIds.has(entry.id));
  if (fresh.length === 0) return ledgerPath;
  const header = existing.trim() ? '' : `# Daily Progress Ledger - ${date}\n\n`;
  const body = fresh
    .map((entry) =>
      [
        `<!-- progress-id:${entry.id} -->`,
        `## ${entry.title}`,
        '',
        `- Source: ${entry.source}`,
        `- Evidence: ${entry.evidence}`,
        `- Confirmed at: ${entry.confirmed_at}`,
      ].join('\n'),
    )
    .join('\n\n');
  fs.appendFileSync(ledgerPath, `${header}${body}\n\n`, 'utf8');
  return ledgerPath;
}

export function readProgressLedger(config: AppConfig, date: string): string {
  const ledgerPath = progressLedgerPath(config, date);
  return fs.existsSync(ledgerPath) ? fs.readFileSync(ledgerPath, 'utf8') : '';
}

export function formatProgressCandidates(result: ProgressCaptureResult): string {
  if (result.candidates.length === 0) {
    return [
      `# 今日进展候选 - ${result.date}`,
      '',
      '暂时没有看到可靠的进展候选。',
      result.missing_sources.length ? `缺失/不可用来源：${result.missing_sources.join(', ')}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  }
  return [
    `# 今日进展候选 - ${result.date}`,
    '',
    ...result.candidates.map((candidate, index) =>
      [
        `${index + 1}. ${candidate.title}`,
        `   - ID: ${candidate.id}`,
        `   - Source: ${candidate.source}`,
        `   - Confidence: ${candidate.confidence}`,
        `   - Evidence: ${candidate.evidence}`,
        `   - Why: ${candidate.reason}`,
      ].join('\n'),
    ),
    result.missing_sources.length ? `\n缺失/不可用来源：${result.missing_sources.join(', ')}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export function confirmedEntriesFromCandidates(candidates: ProgressCandidate[]): ProgressLedgerEntry[] {
  const confirmedAt = new Date().toISOString();
  return candidates.map((candidate) => ({
    id: candidate.id,
    title: candidate.title,
    source: candidate.source,
    evidence: candidate.evidence,
    confirmed_at: confirmedAt,
  }));
}

function extractLinearCandidates(evidence: Evidence, date: string): ProgressCandidate[] {
  const source = evidence.sources.linear;
  const items = linearItems(source?.data);
  return items
    .filter((item) => isSameDate(readString(item, 'updatedAt'), date))
    .map((item) => {
      const identifier = readString(item, 'identifier');
      const title = readString(item, 'title') || identifier;
      const state = nestedString(item, ['state', 'name']);
      const project = nestedString(item, ['project', 'name']);
      return candidate({
        title: `${identifier ? `${identifier} ` : ''}${title}`,
        source: 'linear',
        evidence: [state ? `state=${state}` : '', project ? `project=${project}` : '', readString(item, 'url')].filter(Boolean).join('; '),
        confidence: state.toLowerCase() === 'done' || state.toLowerCase() === 'completed' ? 'high' : 'medium',
        reason: 'Linear issue updated today.',
      });
    });
}

function extractGitHubCandidates(evidence: Evidence, date: string): ProgressCandidate[] {
  const source = evidence.sources.github;
  const items = Array.isArray(source?.data) ? source.data : [];
  return items
    .filter((item) => isRecord(item) && isSameDate(readString(item, 'updated_at') || readString(item, 'updatedAt'), date))
    .map((item) =>
      candidate({
        title: readString(item, 'title') || readString(item, 'html_url') || 'GitHub item updated',
        source: 'github',
        evidence: readString(item, 'html_url') || readString(item, 'url') || 'GitHub assigned issue updated today.',
        confidence: 'medium',
        reason: 'GitHub assigned issue had activity today.',
      }),
    );
}

function extractFeishuCandidates(evidence: Evidence): ProgressCandidate[] {
  const out: ProgressCandidate[] = [];
  for (const [sourceName, source] of Object.entries(evidence.sources)) {
    if (!sourceName.includes('im_history') || source.state !== 'available') continue;
    for (const text of collectTexts(source.data)) {
      const normalized = text.replace(/\s+/g, ' ').trim();
      if (!looksLikeProgress(normalized)) continue;
      out.push(
        candidate({
          title: truncate(normalized, 90),
          source: sourceName,
          evidence: truncate(normalized, 160),
          confidence: 'low',
          reason: 'Feishu message looks like a progress update. Needs user confirmation.',
        }),
      );
    }
  }
  return out;
}

function extractDailyMemoryCandidates(recentDaily: Array<{ path: string; content: string }>, date: string): ProgressCandidate[] {
  const today = recentDaily.find((entry) => path.basename(entry.path) === `${date}.md`);
  if (!today?.content.trim()) return [];
  const sections = today.content
    .split(/\n##\s+/)
    .map((section) => section.trim())
    .filter(Boolean);
  return sections.slice(-3).map((section) =>
    candidate({
      title: `Daily OS workflow output: ${truncate(section.split('\n')[0] || 'today', 80)}`,
      source: 'daily_memory',
      evidence: `memory daily file: ${path.basename(today.path)}`,
      confidence: 'medium',
      reason: 'Daily OS generated workflow output today.',
    }),
  );
}

function extractLocalFileCandidates(evidence: Evidence): ProgressCandidate[] {
  const source = evidence.sources.local_files;
  if (source?.state !== 'available') return [];
  return collectTexts(source.data)
    .filter(looksLikeProgress)
    .slice(0, 3)
    .map((text) =>
      candidate({
        title: truncate(text.replace(/\s+/g, ' ').trim(), 90),
        source: 'local_files',
        evidence: truncate(text, 160),
        confidence: 'low',
        reason: 'Configured local file contains progress-like text.',
      }),
    );
}

function missingSources(evidence: Evidence): string[] {
  return Object.entries(evidence.sources)
    .filter(([, source]) => ['missing', 'error'].includes(source.state))
    .map(([name, source]) => `${name}${source.detail ? ` (${source.detail})` : ''}`);
}

function candidate(input: Omit<ProgressCandidate, 'id'>): ProgressCandidate {
  const id = `pc_${hashValue(`${input.source}:${input.title}:${input.evidence}`).slice(0, 12)}`;
  return { id, ...input };
}

function dedupeCandidates(candidates: ProgressCandidate[]): ProgressCandidate[] {
  const seen = new Set<string>();
  const out: ProgressCandidate[] = [];
  for (const candidate of candidates) {
    if (seen.has(candidate.id)) continue;
    seen.add(candidate.id);
    out.push(candidate);
  }
  return out;
}

function linearItems(data: unknown): Record<string, unknown>[] {
  if (!isRecord(data)) return [];
  for (const path of [
    ['items'],
    ['issues', 'nodes'],
    ['data', 'issues', 'nodes'],
  ]) {
    const value = getAtPath(data, path);
    if (Array.isArray(value)) return value.filter(isRecord);
  }
  return [];
}

function collectTexts(value: unknown): string[] {
  if (typeof value === 'string') return [textFromMaybeJson(value)];
  if (Array.isArray(value)) return value.flatMap(collectTexts);
  if (!isRecord(value)) return [];
  return Object.values(value).flatMap(collectTexts);
}

function textFromMaybeJson(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return value;
  try {
    return collectTexts(JSON.parse(trimmed) as unknown).join(' ');
  } catch {
    return value;
  }
}

function looksLikeProgress(text: string): boolean {
  const lower = text.toLowerCase();
  return text.length >= 4 && PROGRESS_WORDS.some((word) => lower.includes(word.toLowerCase()));
}

function isSameDate(value: string, date: string): boolean {
  return value.startsWith(date) || value.slice(0, 10) === date;
}

function readString(value: unknown, key: string): string {
  return isRecord(value) && typeof value[key] === 'string' ? value[key] : '';
}

function nestedString(value: unknown, keys: string[]): string {
  const nested = getAtPath(value, keys);
  return typeof nested === 'string' ? nested : '';
}

function getAtPath(value: unknown, keys: string[]): unknown {
  let current = value;
  for (const key of keys) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

function truncate(value: string, max: number): string {
  const normalized = value.trim();
  return normalized.length > max ? `${normalized.slice(0, max)}...` : normalized;
}

function hashValue(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
