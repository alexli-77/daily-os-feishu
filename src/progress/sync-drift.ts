import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { AppConfig } from '../config/schema.js';
import type { Evidence, EvidenceSource } from '../workflows/types.js';
import { collectFeishuUserMessageRecords } from '../utils/feishu-message-records.js';

// LEO-120: detect "progress made today but not yet synced to GitHub/Linear".
//
// The matching is deterministic-first and never writes anything: it produces
// suggestion-only findings. A finding is only marked `exact` when it comes from
// a deterministic reference (LEO-123 style id, owner/repo#123 with an explicit
// repository context, or an issue/PR URL). Low-confidence fuzzy title matches are
// flagged `fuzzy` and marked "可能相关" — they never drive writes and are advisory.

export type SyncDriftKind = 'linear-stale' | 'github-stale' | 'no-tracker';
export type SyncDriftConfidence = 'exact' | 'fuzzy';

export interface SyncDriftFinding {
  kind: SyncDriftKind;
  /** The today-signal text that triggered this finding (evidence for the user). */
  evidence: string;
  matchedId?: string;
  matchedUrl?: string;
  suggestion: string;
  confidence: SyncDriftConfidence;
}

export interface SyncDriftResult {
  findings: SyncDriftFinding[];
}

export interface SyncDriftDecision {
  key: string;
  date: string;
  decision: 'ignore' | 'handled';
  at: string;
}

interface Signal {
  text: string;
  origin: string;
}

interface LinearItem {
  identifier: string;
  title: string;
  url: string;
  updatedAt: string;
}

interface GithubItem {
  repo: string;
  number: number;
  title: string;
  url: string;
  updatedAt: string;
  body: string;
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

const LINEAR_ID_RE = /\b([A-Z]{2,}-\d+)\b/g;
const LINEAR_URL_RE = /https?:\/\/linear\.app\/[^\s)]+?\/([A-Z]{2,}-\d+)/g;
const GH_URL_RE = /https?:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/(?:issues|pull)\/(\d+)/g;
const GH_REPO_HASH_RE = /\b([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#(\d+)\b/g;
const GH_BARE_HASH_RE = /(?<![\w/])#(\d+)\b/g;

const STOPWORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'that',
  'this',
  'from',
  'have',
  'https',
  'http',
  'github',
  'linear',
  'issue',
  'pull',
  'today',
]);

/**
 * Deterministic-first drift detection. Pure over the already-collected evidence
 * so it is trivially testable and never performs network IO.
 */
export function collectSyncDrift(evidence: Evidence, config: AppConfig): SyncDriftResult {
  if (!config.progress_sync_check.enabled) return { findings: [] };

  const date = evidence.date;
  const linearSource = evidence.sources.linear;
  const githubSource = evidence.sources.github;
  const linearAvailable = isSourceAvailable(linearSource);
  const githubAvailable = isSourceAvailable(githubSource);

  // Enabled but the tracker source is unavailable -> debug only, never a card
  // finding. This keeps the review clean when GitHub/Linear are not configured.
  if (!linearAvailable && !githubAvailable) {
    debug(`[sync-drift] enabled but neither GitHub nor Linear source is available; no findings.`);
    return { findings: [] };
  }

  const linearItems = linearAvailable ? readLinearItems(linearSource?.data) : [];
  const githubItems = githubAvailable ? readGithubItems(githubSource?.data) : [];
  const configRepos = config.sources.github.repositories.map(normalizeRepo).filter(Boolean);

  const signals = gatherSignals(evidence, date);
  const findings: SyncDriftFinding[] = [];

  for (const signal of signals) {
    const matchedAnyId = evaluateExactMatches({
      signal,
      date,
      linearAvailable,
      githubAvailable,
      linearItems,
      githubItems,
      configRepos,
      findings,
    });
    // Fuzzy title match only when nothing deterministic matched this signal.
    // Fuzzy findings are advisory ("可能相关") and never drive writes.
    if (!matchedAnyId) evaluateFuzzyMatch({ signal, linearItems, githubItems, date, findings });
  }

  return { findings: dedupeFindings(findings) };
}

interface ExactInput {
  signal: Signal;
  date: string;
  linearAvailable: boolean;
  githubAvailable: boolean;
  linearItems: LinearItem[];
  githubItems: GithubItem[];
  configRepos: string[];
  findings: SyncDriftFinding[];
}

function evaluateExactMatches(input: ExactInput): boolean {
  const { signal, date, findings } = input;
  let matched = false;

  // Linear ids (LEO-123) and Linear issue URLs.
  const linearIds = new Set<string>([...matchAll(signal.text, LINEAR_ID_RE), ...matchAll(signal.text, LINEAR_URL_RE)]);
  for (const id of linearIds) {
    matched = true;
    if (!input.linearAvailable) {
      debug(`[sync-drift] ${id} referenced but Linear source unavailable; skipping.`);
      continue;
    }
    const item = input.linearItems.find((entry) => entry.identifier === id);
    if (!item) {
      findings.push({
        kind: 'no-tracker',
        evidence: snippet(signal.text),
        matchedId: id,
        confidence: 'exact',
        suggestion: `在 Linear 进行中的任务里没找到 ${id}，确认它是否已经建好或已归档，避免今天的进展无处对账。`,
      });
      continue;
    }
    if (!isSameDate(item.updatedAt, date)) {
      findings.push({
        kind: 'linear-stale',
        evidence: snippet(signal.text),
        matchedId: id,
        ...(item.url ? { matchedUrl: item.url } : {}),
        confidence: 'exact',
        suggestion: `我看到今天 ${id} 有进展，但 Linear 里它最近更新时间不是今天，你可能可以更新一下状态/进度。`,
      });
    }
  }

  // GitHub references: explicit repo#num, github URLs, and bare #num when a
  // repository context is explicit (from the text or configured repositories).
  const githubRefs = collectGithubRefs(signal.text, input.configRepos);
  for (const ref of githubRefs) {
    matched = true;
    if (!input.githubAvailable) {
      debug(`[sync-drift] #${ref.number} referenced but GitHub source unavailable; skipping.`);
      continue;
    }
    const item = input.githubItems.find(
      (entry) => entry.number === ref.number && (ref.repos.length === 0 || ref.repos.includes(entry.repo)),
    );
    const label = ref.repos.length === 1 ? `${ref.repos[0]}#${ref.number}` : `#${ref.number}`;
    if (!item) {
      findings.push({
        kind: 'no-tracker',
        evidence: snippet(signal.text),
        matchedId: label,
        confidence: 'exact',
        suggestion: `GitHub 里没找到 ${label}（进行中列表），确认它是否已经建好或已关闭。`,
      });
      continue;
    }
    if (!isSameDate(item.updatedAt, date)) {
      findings.push({
        kind: 'github-stale',
        evidence: snippet(signal.text),
        matchedId: `${item.repo}#${item.number}`,
        ...(item.url ? { matchedUrl: item.url } : {}),
        confidence: 'exact',
        suggestion: `我看到今天 ${item.repo}#${item.number} 有进展，但 GitHub 里它最近更新时间不是今天，你可能可以同步一下状态或补个评论。`,
      });
    }
  }

  return matched;
}

interface FuzzyInput {
  signal: Signal;
  linearItems: LinearItem[];
  githubItems: GithubItem[];
  date: string;
  findings: SyncDriftFinding[];
}

function evaluateFuzzyMatch(input: FuzzyInput): void {
  const signalTokens = tokenize(input.signal.text);
  if (signalTokens.size === 0) return;

  let best: { kind: SyncDriftKind; id: string; url: string; overlap: number } | null = null;
  const consider = (kind: SyncDriftKind, id: string, url: string, title: string): void => {
    const overlap = overlapCount(signalTokens, tokenize(title));
    if (overlap >= 2 && (!best || overlap > best.overlap)) best = { kind, id, url, overlap };
  };
  for (const item of input.linearItems) consider('linear-stale', item.identifier, item.url, item.title);
  for (const item of input.githubItems) consider('github-stale', `${item.repo}#${item.number}`, item.url, item.title);

  if (!best) return;
  const match = best as { kind: SyncDriftKind; id: string; url: string; overlap: number };
  input.findings.push({
    kind: match.kind,
    evidence: snippet(input.signal.text),
    matchedId: match.id,
    ...(match.url ? { matchedUrl: match.url } : {}),
    confidence: 'fuzzy',
    suggestion: `今天这条进展可能与 ${match.id} 相关（低置信标题匹配，仅供参考，请你确认是否需要同步）。`,
  });
}

// --- signal gathering ------------------------------------------------------

function gatherSignals(evidence: Evidence, date: string): Signal[] {
  const signals: Signal[] = [];

  const ledger = evidence.sources.progress_ledger;
  if (ledger && ledger.state === 'available' && typeof ledger.data === 'string') {
    for (const line of ledger.data.split('\n')) {
      const text = line.replace(/^#+\s*/, '').replace(/^[-*]\s*/, '').trim();
      if (!text || text.startsWith('<!--')) continue;
      signals.push({ text, origin: 'progress-ledger' });
    }
  }

  for (const [name, source] of Object.entries(evidence.sources)) {
    if (!name.includes('im_history') || source.state !== 'available') continue;
    for (const message of collectFeishuUserMessageRecords(source.data)) {
      const text = message.text.replace(/\s+/g, ' ').trim();
      if (!looksLikeProgress(text)) continue;
      if (message.createdAt && !isSameDate(message.createdAt.toISOString(), date)) continue;
      signals.push({ text, origin: name });
    }
  }

  const github = evidence.sources.github;
  if (github && isSourceAvailable(github)) {
    for (const item of readGithubItems(github.data)) {
      if (!isSameDate(item.updatedAt, date)) continue;
      const text = [item.title, item.body, item.url].filter(Boolean).join(' ');
      if (!text.trim()) continue;
      signals.push({ text, origin: 'github' });
    }
  }

  return signals;
}

// --- tracker readers -------------------------------------------------------

function readLinearItems(data: unknown): LinearItem[] {
  const rows = linearRows(data);
  return rows
    .map((row) => ({
      identifier: readString(row, 'identifier'),
      title: readString(row, 'title'),
      url: readString(row, 'url'),
      updatedAt: readString(row, 'updatedAt') || readString(row, 'updated_at'),
    }))
    .filter((item) => item.identifier);
}

function linearRows(data: unknown): Record<string, unknown>[] {
  if (!isRecord(data)) return [];
  for (const keys of [['items'], ['issues', 'nodes'], ['data', 'issues', 'nodes']]) {
    const value = getAtPath(data, keys);
    if (Array.isArray(value)) return value.filter(isRecord);
  }
  return [];
}

function readGithubItems(data: unknown): GithubItem[] {
  const out: GithubItem[] = [];
  const pushIssue = (issue: unknown, repoHint: string): void => {
    if (!isRecord(issue)) return;
    const number = typeof issue.number === 'number' ? issue.number : Number(readString(issue, 'number'));
    if (!Number.isFinite(number)) return;
    const repo = repoHint || repoFromIssue(issue);
    out.push({
      repo,
      number,
      title: readString(issue, 'title'),
      url: readString(issue, 'html_url') || readString(issue, 'url'),
      updatedAt: readString(issue, 'updated_at') || readString(issue, 'updatedAt'),
      body: readString(issue, 'body'),
    });
  };

  if (Array.isArray(data)) {
    for (const entry of data) {
      if (isRecord(entry) && Array.isArray(entry.issues)) {
        const repo = normalizeRepo(readString(entry, 'repo'));
        for (const issue of entry.issues) pushIssue(issue, repo);
      } else {
        pushIssue(entry, '');
      }
    }
  }
  return out;
}

function repoFromIssue(issue: Record<string, unknown>): string {
  const repositoryUrl = readString(issue, 'repository_url');
  const match = repositoryUrl.match(/repos\/([^/]+\/[^/]+)$/);
  if (match) return normalizeRepo(match[1]);
  const htmlUrl = readString(issue, 'html_url');
  const htmlMatch = htmlUrl.match(/github\.com\/([^/]+\/[^/]+)\//);
  return htmlMatch ? normalizeRepo(htmlMatch[1]) : '';
}

interface GithubRef {
  number: number;
  repos: string[];
}

function collectGithubRefs(text: string, configRepos: string[]): GithubRef[] {
  const refs = new Map<string, GithubRef>();
  const add = (number: number, repo: string): void => {
    const key = `${repo}#${number}`;
    if (!refs.has(key)) refs.set(key, { number, repos: repo ? [repo] : [] });
  };

  for (const [, repo, num] of text.matchAll(GH_URL_RE)) add(Number(num), normalizeRepo(repo));
  for (const [, repo, num] of text.matchAll(GH_REPO_HASH_RE)) add(Number(num), normalizeRepo(repo));

  // Bare #num only counts when a repository context is explicit: either the
  // configured repositories, or a repo already referenced in this signal.
  const contextRepos = new Set<string>([
    ...configRepos,
    ...[...refs.values()].flatMap((ref) => ref.repos),
  ]);
  if (contextRepos.size > 0) {
    for (const [, num] of text.matchAll(GH_BARE_HASH_RE)) {
      const number = Number(num);
      if ([...refs.values()].some((ref) => ref.number === number)) continue;
      refs.set(`bare#${number}`, { number, repos: [...contextRepos] });
    }
  }

  return [...refs.values()];
}

// --- decisions ledger (dedup) ---------------------------------------------

export function syncDriftDecisionsPath(): string {
  return path.resolve('data/runtime/sync-drift-decisions.jsonl');
}

export function syncDriftFindingKey(finding: SyncDriftFinding): string {
  const seed = `${finding.kind}:${finding.matchedId || finding.matchedUrl || finding.evidence}`;
  return `sd_${crypto.createHash('sha256').update(seed).digest('hex').slice(0, 16)}`;
}

export function loadSyncDriftDecisions(filePath = syncDriftDecisionsPath()): SyncDriftDecision[] {
  if (!fs.existsSync(filePath)) return [];
  return fs
    .readFileSync(filePath, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as SyncDriftDecision;
      } catch {
        return null;
      }
    })
    .filter((entry): entry is SyncDriftDecision => Boolean(entry && entry.key && entry.date));
}

export function recordSyncDriftDecision(
  input: { key: string; date: string; decision: 'ignore' | 'handled' },
  filePath = syncDriftDecisionsPath(),
): void {
  const record: SyncDriftDecision = { ...input, at: new Date().toISOString() };
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  // If a previous write crashed and left a partial line with no trailing
  // newline, prepend one so this append starts on its own line instead of
  // gluing onto (and corrupting) the prior record.
  let prefix = '';
  try {
    if (fs.existsSync(filePath)) {
      const existing = fs.readFileSync(filePath, 'utf8');
      if (existing.length > 0 && !existing.endsWith('\n')) prefix = '\n';
    }
  } catch {
    prefix = '';
  }
  fs.appendFileSync(filePath, `${prefix}${JSON.stringify(record)}\n`, 'utf8');
}

/**
 * Drop findings that were already decided (ignored / marked handled) for the
 * same date, so later reviews on the same day never re-prompt the same finding.
 */
export function filterUndecidedFindings(
  findings: SyncDriftFinding[],
  date: string,
  filePath = syncDriftDecisionsPath(),
): SyncDriftFinding[] {
  const decisions = loadSyncDriftDecisions(filePath);
  const decided = new Set(decisions.filter((entry) => entry.date === date).map((entry) => entry.key));
  return findings.filter((finding) => !decided.has(syncDriftFindingKey(finding)));
}

// --- review-card section + companion card ---------------------------------

export function renderSyncDriftSection(findings: SyncDriftFinding[]): string[] {
  if (findings.length === 0) return [];
  const lines = ['**🔄 可能需要同步的任务**', '这些只是建议，不会自动修改 GitHub / Linear；你确认后再手动更新。'];
  for (const finding of findings) {
    const tag = finding.confidence === 'fuzzy' ? '（可能相关）' : '';
    const match = finding.matchedId ? ` [${finding.matchedId}]${tag}` : '';
    lines.push('', `- ${finding.suggestion}${match}`, `  > 依据：${finding.evidence}`);
  }
  return lines;
}

export function renderSyncDriftCard(config: AppConfig, date: string, findings: SyncDriftFinding[]): object {
  const keys = findings.map(syncDriftFindingKey);
  return {
    config: { wide_screen_mode: true },
    header: {
      template: 'orange',
      title: { tag: 'plain_text', content: '🔄 可能需要同步的任务' },
    },
    elements: [
      { tag: 'markdown', content: renderSyncDriftSection(findings).join('\n') },
      { tag: 'hr' },
      {
        tag: 'action',
        actions: [
          syncDriftButton('起草更新', syncDriftActionValue(config, 'draft', date, keys), 'primary'),
          syncDriftButton('标记已处理', syncDriftActionValue(config, 'handled', date, keys), 'default'),
          syncDriftButton('忽略', syncDriftActionValue(config, 'ignore', date, keys), 'default'),
        ],
      },
      {
        tag: 'note',
        elements: [{ tag: 'plain_text', content: '「起草更新」只生成建议文案，不会写 GitHub / Linear；忽略或标记已处理后当天不再重复提示。' }],
      },
    ],
  };
}

export function renderSyncDriftDraft(findings: SyncDriftFinding[]): string {
  if (findings.length === 0) return '当前没有需要同步的进展。';
  return [
    '这是给你参考的更新草稿（不会自动写入 GitHub / Linear）：',
    '',
    ...findings.map((finding, index) => {
      const target = finding.matchedId ? `${finding.matchedId}：` : '';
      return `${index + 1}. ${target}把今天的进展补充到对应任务，依据「${finding.evidence}」。`;
    }),
  ].join('\n');
}

// --- card action parsing / signing ----------------------------------------

export type SyncDriftCardActionKind = 'ignore' | 'handled' | 'draft';

export interface ParsedSyncDriftCardAction {
  action: SyncDriftCardActionKind;
  date: string;
  keys: string[];
}

export function parseSyncDriftCardAction(value: unknown, config: AppConfig): ParsedSyncDriftCardAction | null {
  if (!isRecord(value)) return null;
  const action = value.daily_os_sync_drift_action;
  const date = value.daily_os_sync_drift_date;
  const token = value.daily_os_sync_drift_token;
  const keys = Array.isArray(value.daily_os_sync_drift_keys)
    ? value.daily_os_sync_drift_keys.filter((key): key is string => typeof key === 'string')
    : [];
  if (!isSyncDriftAction(action) || typeof date !== 'string' || typeof token !== 'string') return null;
  const expected = signSyncDriftAction(config, action, date, keys);
  if (!timingSafeEqual(token, expected)) return null;
  return { action, date, keys };
}

function syncDriftActionValue(
  config: AppConfig,
  action: SyncDriftCardActionKind,
  date: string,
  keys: string[],
): Record<string, unknown> {
  return {
    daily_os_sync_drift_action: action,
    daily_os_sync_drift_date: date,
    daily_os_sync_drift_keys: keys,
    daily_os_sync_drift_token: signSyncDriftAction(config, action, date, keys),
  };
}

function signSyncDriftAction(config: AppConfig, action: SyncDriftCardActionKind, date: string, keys: string[]): string {
  const secret = process.env.LARK_APP_SECRET || process.env.DAILY_OS_CALLBACK_SECRET || config.assistant.name;
  return crypto.createHmac('sha256', secret).update(`${action}:${date}:${keys.join(',')}`).digest('hex');
}

function syncDriftButton(label: string, value: Record<string, unknown>, type: 'primary' | 'default'): object {
  return { tag: 'button', text: { tag: 'plain_text', content: label }, type, value };
}

function isSyncDriftAction(value: unknown): value is SyncDriftCardActionKind {
  return value === 'ignore' || value === 'handled' || value === 'draft';
}

function timingSafeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// --- helpers ---------------------------------------------------------------

function dedupeFindings(findings: SyncDriftFinding[]): SyncDriftFinding[] {
  const order = { exact: 0, fuzzy: 1 } as const;
  const sorted = [...findings].sort((a, b) => order[a.confidence] - order[b.confidence]);
  const seen = new Set<string>();
  const out: SyncDriftFinding[] = [];
  for (const finding of sorted) {
    const key = syncDriftFindingKey(finding);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(finding);
  }
  return out;
}

function isSourceAvailable(source: EvidenceSource | undefined): boolean {
  return Boolean(source && (source.state === 'available' || source.state === 'empty'));
}

function looksLikeProgress(text: string): boolean {
  const lower = text.toLowerCase();
  return text.length >= 4 && PROGRESS_WORDS.some((word) => lower.includes(word.toLowerCase()));
}

function tokenize(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length < 2) continue;
    if (STOPWORDS.has(raw)) continue;
    if (PROGRESS_WORDS.includes(raw)) continue;
    tokens.add(raw);
  }
  return tokens;
}

function overlapCount(a: Set<string>, b: Set<string>): number {
  let count = 0;
  for (const token of a) if (b.has(token)) count += 1;
  return count;
}

function matchAll(text: string, regex: RegExp): string[] {
  return [...text.matchAll(regex)].map((match) => match[1]).filter(Boolean);
}

function normalizeRepo(value: string): string {
  return value
    .trim()
    .replace(/^https:\/\/github\.com\//, '')
    .replace(/\.git$/, '')
    .replace(/\/$/, '');
}

function snippet(text: string, max = 160): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length > max ? `${normalized.slice(0, max)}...` : normalized;
}

function isSameDate(value: string, date: string): boolean {
  if (!value) return false;
  return value.startsWith(date) || value.slice(0, 10) === date;
}

function readString(value: unknown, key: string): string {
  if (!isRecord(value)) return '';
  const raw = value[key];
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'number') return String(raw);
  return '';
}

function getAtPath(value: unknown, keys: string[]): unknown {
  let current = value;
  for (const key of keys) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function debug(message: string): void {
  if (process.env.DAILY_OS_DEBUG) console.debug(message);
}
