import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import type { AppConfig } from '../config/schema.js';
import { decisionPolicyFiles } from '../decision/policy.js';
import type { EvidenceSource } from '../workflows/types.js';
import { sourceFromResult } from '../workflows/types.js';

const MAX_MARKDOWN_FILES = 240;
const MAX_NOTE_CHARS = 60_000;
const MAX_SUMMARY_CHARS = 420;
const RECENT_DAYS = 14;
const SKIP_DIRS = new Set(['.git', '.obsidian', '.trash', 'node_modules', 'templates', 'template', 'logs', 'archive']);
const SKIP_PATH_PATTERNS = [/\/templates?\//i, /\/logs?\//i, /\/archive\//i, /\/done\//i, /\/abandoned\//i];
const DONE_STATUSES = new Set(['done', 'completed', 'complete', 'closed', 'abandoned', 'cancelled', 'canceled']);

interface VaultCandidate {
  path: string;
  title: string;
  status?: string;
  priority?: string;
  due?: string;
  next_review?: string;
  trigger_condition?: string;
  summary: string;
  score: number;
  reasons: string[];
  matched_policy_terms: string[];
  modified_at: string;
}

interface PolicyContext {
  terms: string[];
  preview: string;
}

export async function collectVault(config: AppConfig, date: string): Promise<Record<string, EvidenceSource>> {
  const source = config.sources.vault;
  if (!source.enabled) return { vault: { state: 'disabled' } };
  if (source.provider === 'remote') return collectRemoteVault(config);
  return collectLocalVault(config, date);
}

async function collectRemoteVault(config: AppConfig): Promise<Record<string, EvidenceSource>> {
  const cfg = config.sources.vault.remote;
  const baseUrl = process.env[cfg.base_url_env]?.replace(/\/+$/, '');
  const token = process.env[cfg.token_env];
  if (!baseUrl || !token) return { vault: { state: 'missing', detail: `${cfg.base_url_env} or ${cfg.token_env} is not configured` } };

  const headers = { Authorization: `Bearer ${token}` };
  const result: Record<string, EvidenceSource> = {};
  if (cfg.scan.enabled) {
    const endpoint = new URL('/scan', baseUrl);
    endpoint.searchParams.set('statuses', cfg.scan.statuses.join(','));
    endpoint.searchParams.set('due_within_days', String(cfg.scan.due_within_days));
    endpoint.searchParams.set('limit', String(cfg.scan.limit));
    result.vault_scan = await fetchJson(endpoint, headers);
  }

  for (const [name, relativePath] of Object.entries(cfg.read_paths)) {
    const endpoint = new URL('/read', baseUrl);
    endpoint.searchParams.set('path', relativePath);
    result[`vault_${name}`] = await fetchJson(endpoint, headers);
  }
  return result;
}

async function fetchJson(url: URL, headers: Record<string, string>): Promise<EvidenceSource> {
  try {
    const response = await fetch(url, { headers });
    if (!response.ok) return { state: response.status === 404 ? 'missing' : 'error', detail: `HTTP ${response.status}` };
    return sourceFromResult(await response.json());
  } catch (error) {
    return { state: 'error', detail: error instanceof Error ? error.message : String(error) };
  }
}

function collectLocalVault(config: AppConfig, date: string): Record<string, EvidenceSource> {
  const root = path.resolve(config.sources.vault.local_path);
  if (!fs.existsSync(root)) return { vault: { state: 'missing', detail: `vault path not found: ${root}` } };
  const readPaths = config.sources.vault.remote.read_paths;
  const out: Record<string, EvidenceSource> = {};
  for (const [name, relativePath] of Object.entries(readPaths)) {
    out[`vault_${name}`] = readLocalVaultFile(root, relativePath);
  }
  out.vault_scan = sourceFromResult(scanLocalVault(config, root, date));
  return out;
}

function readLocalVaultFile(root: string, relativePath: string): EvidenceSource {
  const filePath = safeVaultPath(root, relativePath);
  if (!filePath) return { state: 'error', detail: `unsafe vault path: ${relativePath}` };
  return fs.existsSync(filePath)
    ? sourceFromResult({ path: relativePath, content: fs.readFileSync(filePath, 'utf8') })
    : { state: 'missing', detail: `missing: ${relativePath}` };
}

function scanLocalVault(config: AppConfig, root: string, date: string): {
  root: string;
  date: string;
  scan_policy: {
    max_files: number;
    limit: number;
    due_within_days: number;
    statuses: string[];
    decision_policy_preview: string;
  };
  candidates: VaultCandidate[];
  skipped: { hidden_or_system_paths: boolean; done_or_abandoned_statuses: boolean };
} {
  const scanConfig = config.sources.vault.remote.scan;
  const policy = loadPolicyContext(config);
  const files = listVaultMarkdownFiles(root).slice(0, MAX_MARKDOWN_FILES);
  const candidates = files
    .map((filePath) => candidateFromMarkdown(root, filePath, date, scanConfig.due_within_days, scanConfig.statuses, policy))
    .filter((candidate): candidate is VaultCandidate => Boolean(candidate))
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, scanConfig.limit);

  return {
    root: 'configured-local-vault',
    date,
    scan_policy: {
      max_files: MAX_MARKDOWN_FILES,
      limit: scanConfig.limit,
      due_within_days: scanConfig.due_within_days,
      statuses: scanConfig.statuses,
      decision_policy_preview: policy.preview,
    },
    candidates,
    skipped: {
      hidden_or_system_paths: true,
      done_or_abandoned_statuses: true,
    },
  };
}

function candidateFromMarkdown(
  root: string,
  filePath: string,
  date: string,
  dueWithinDays: number,
  statuses: string[],
  policy: PolicyContext,
): VaultCandidate | null {
  const content = fs.readFileSync(filePath, 'utf8').slice(0, MAX_NOTE_CHARS);
  const relativePath = path.relative(root, filePath);
  const parsed = parseMarkdown(content);
  const title = firstString(parsed.frontmatter.title) || markdownTitle(parsed.body) || path.basename(filePath, '.md');
  const status = normalizeOptional(firstString(parsed.frontmatter.status));
  if (status && DONE_STATUSES.has(status.toLowerCase())) return null;
  const priority = normalizeOptional(firstString(parsed.frontmatter.priority));
  const due = normalizeOptional(firstString(parsed.frontmatter.due) || firstString(parsed.frontmatter.deadline));
  const nextReview = normalizeOptional(firstString(parsed.frontmatter.next_review) || firstString(parsed.frontmatter['next-review']));
  const triggerCondition = normalizeOptional(firstString(parsed.frontmatter.trigger_condition) || firstString(parsed.frontmatter.trigger));
  const summary = summarizeMarkdown(parsed.body);
  const text = `${relativePath}\n${title}\n${JSON.stringify(parsed.frontmatter)}\n${summary}`.toLowerCase();
  const matchedPolicyTerms = policy.terms.filter((term) => text.includes(term.toLowerCase())).slice(0, 8);
  const stat = fs.statSync(filePath);
  const scoreParts = scoreCandidate({
    relativePath,
    title,
    status,
    priority,
    due,
    nextReview,
    triggerCondition,
    summary,
    date,
    dueWithinDays,
    statuses,
    matchedPolicyTerms,
    modifiedAtMs: stat.mtimeMs,
  });
  if (scoreParts.score <= 0) return null;
  return {
    path: relativePath,
    title,
    ...(status ? { status } : {}),
    ...(priority ? { priority } : {}),
    ...(due ? { due } : {}),
    ...(nextReview ? { next_review: nextReview } : {}),
    ...(triggerCondition ? { trigger_condition: triggerCondition } : {}),
    summary,
    score: scoreParts.score,
    reasons: scoreParts.reasons,
    matched_policy_terms: matchedPolicyTerms,
    modified_at: new Date(stat.mtimeMs).toISOString(),
  };
}

function scoreCandidate(input: {
  relativePath: string;
  title: string;
  status?: string;
  priority?: string;
  due?: string;
  nextReview?: string;
  triggerCondition?: string;
  summary: string;
  date: string;
  dueWithinDays: number;
  statuses: string[];
  matchedPolicyTerms: string[];
  modifiedAtMs: number;
}): { score: number; reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];
  const status = input.status?.toLowerCase();
  if (status && input.statuses.map((value) => value.toLowerCase()).includes(status)) {
    score += 25;
    reasons.push(`status=${input.status}`);
  }
  if (input.priority && /^p[0-2]$/i.test(input.priority)) {
    const priorityScore = input.priority.toLowerCase() === 'p0' ? 35 : input.priority.toLowerCase() === 'p1' ? 25 : 12;
    score += priorityScore;
    reasons.push(`priority=${input.priority}`);
  }
  const dueDistance = daysUntil(input.due, input.date);
  if (dueDistance != null && dueDistance <= input.dueWithinDays) {
    score += dueDistance < 0 ? 35 : 30 - dueDistance;
    reasons.push(dueDistance < 0 ? `overdue=${input.due}` : `due_within_${input.dueWithinDays}_days=${input.due}`);
  }
  const reviewDistance = daysUntil(input.nextReview, input.date);
  if (reviewDistance != null && reviewDistance <= input.dueWithinDays) {
    score += reviewDistance < 0 ? 18 : 16 - reviewDistance;
    reasons.push(reviewDistance < 0 ? `next_review_overdue=${input.nextReview}` : `next_review_due=${input.nextReview}`);
  }
  if (input.matchedPolicyTerms.length > 0) {
    score += Math.min(24, input.matchedPolicyTerms.length * 6);
    reasons.push(`matches_decision_policy=${input.matchedPolicyTerms.slice(0, 4).join(', ')}`);
  }
  const todoCount = openTodoCount(input.summary);
  if (todoCount > 0) {
    score += Math.min(15, todoCount * 5);
    reasons.push(`open_todos=${todoCount}`);
  }
  if (Date.now() - input.modifiedAtMs <= RECENT_DAYS * 24 * 60 * 60 * 1000) {
    score += 6;
    reasons.push(`modified_within_${RECENT_DAYS}_days`);
  }
  if (/99_Meta|watch-list|todo|routing/i.test(input.relativePath)) {
    score += 8;
    reasons.push('meta_or_commitment_path');
  }
  if (!input.status && !input.priority && !input.due && !input.nextReview && input.matchedPolicyTerms.length === 0 && todoCount === 0) return { score: 0, reasons: [] };
  return { score, reasons };
}

function parseMarkdown(content: string): { frontmatter: Record<string, unknown>; body: string } {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
  if (!match) return { frontmatter: {}, body: content };
  try {
    const parsed = yaml.load(match[1] || '');
    return {
      frontmatter: parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {},
      body: content.slice(match[0].length),
    };
  } catch {
    return { frontmatter: {}, body: content.slice(match[0].length) };
  }
}

function listVaultMarkdownFiles(root: string): string[] {
  const out: string[] = [];
  walkVault(root, root, out);
  return out.sort();
}

function walkVault(root: string, dir: string, out: string[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name.toLowerCase())) continue;
    const fullPath = path.join(dir, entry.name);
    const relative = path.relative(root, fullPath);
    if (SKIP_PATH_PATTERNS.some((pattern) => pattern.test(`/${relative.replaceAll(path.sep, '/')}`))) continue;
    if (entry.isDirectory()) {
      walkVault(root, fullPath, out);
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      out.push(fullPath);
    }
  }
}

function safeVaultPath(root: string, relativePath: string): string | null {
  const resolvedRoot = path.resolve(root);
  const filePath = path.resolve(resolvedRoot, relativePath);
  return filePath === resolvedRoot || filePath.startsWith(`${resolvedRoot}${path.sep}`) ? filePath : null;
}

function loadPolicyContext(config: AppConfig): PolicyContext {
  const files = decisionPolicyFiles(config);
  const policy = fs.existsSync(files.policyPath) ? fs.readFileSync(files.policyPath, 'utf8') : '';
  const notes = fs.existsSync(files.notesPath) ? fs.readFileSync(files.notesPath, 'utf8') : '';
  const combined = `${policy}\n${notes}`.trim();
  return {
    terms: extractPolicyTerms(combined),
    preview: combined.slice(0, 1800),
  };
}

function extractPolicyTerms(text: string): string[] {
  const ignored = new Set(['version', 'status', 'rules', 'description', 'when', 'then', 'event', 'daily', 'policy', 'memory']);
  const matches = text.match(/[A-Za-z][A-Za-z0-9_-]{2,}|P[0-3]|[\u4e00-\u9fa5]{2,}/g) || [];
  return [...new Set(matches.map((term) => term.trim()).filter((term) => term.length >= 2 && !ignored.has(term.toLowerCase())))]
    .sort((a, b) => b.length - a.length)
    .slice(0, 80);
}

function markdownTitle(body: string): string {
  return body.match(/^#\s+(.+)$/m)?.[1]?.trim() || '';
}

function summarizeMarkdown(body: string): string {
  const usefulLines = body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('```') && !line.startsWith('%%'))
    .filter((line) => /^#{1,3}\s+|^[-*]\s+|^\d+\.\s+|^- \[[ xX]\]|due[:：]|next[_ -]?review[:：]|priority[:：]|status[:：]/i.test(line))
    .slice(0, 18);
  const summary = usefulLines.join('\n') || body.replace(/\s+/g, ' ').trim();
  return summary.slice(0, MAX_SUMMARY_CHARS);
}

function firstString(value: unknown): string {
  if (value == null) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (Array.isArray(value)) return firstString(value[0]);
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function normalizeOptional(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function daysUntil(value: string | undefined, date: string): number | null {
  if (!value) return null;
  const parsed = value.match(/\d{4}-\d{2}-\d{2}/)?.[0];
  if (!parsed) return null;
  const target = Date.parse(`${parsed}T00:00:00Z`);
  const base = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(target) || Number.isNaN(base)) return null;
  return Math.floor((target - base) / (24 * 60 * 60 * 1000));
}

function openTodoCount(text: string): number {
  return (text.match(/- \[ \]/g) || []).length;
}
