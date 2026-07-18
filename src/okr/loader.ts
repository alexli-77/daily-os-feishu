import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

/**
 * OKR strategy-layer loader (LEO-208).
 *
 * Parses the three source-of-truth files under a vault's `10_OKR/` directory
 * into a structured model:
 *   - north-star-okr.md  -> 5-year objectives (ids N1, N2, ...)
 *   - annual-okr.md      -> yearly objectives (ids A1, A2, ...)
 *   - current-okr.md     -> quarterly objectives (ids O1, O2, ...)
 *
 * Each objective carries a `parent` id (from a per-objective `Parent: <id>`
 * line, falling back to the file frontmatter `parent`) so the layers form a
 * stack: quarterly O -> annual A -> 5-year N. `resolveChain(krId)` walks that
 * stack for any KR.
 *
 * The loader is defensive: a missing or unparseable file yields an empty layer
 * plus a warning, never a throw.
 */

export type OkrLevel = 'northStar' | 'annual' | 'quarterly';

export interface KeyResult {
  id: string;
  description: string;
  target: string;
  current: string;
  progress: string;
  progressPct: number | null;
  updated: string;
}

export interface Objective {
  id: string;
  title: string;
  level: OkrLevel;
  parent: string | null;
  cycle: string | null;
  sourceFile: string;
  keyResults: KeyResult[];
}

export interface OkrModel {
  northStar: Objective[];
  annual: Objective[];
  quarterly: Objective[];
  warnings: string[];
}

export interface OkrChain {
  krId: string;
  kr: KeyResult | null;
  quarterly: Objective | null;
  annual: Objective | null;
  northStar: Objective | null;
  warnings: string[];
}

const OKR_DIR_NAME = '10_OKR';

const LEVEL_FILES: Array<{ level: OkrLevel; file: string }> = [
  { level: 'northStar', file: 'north-star-okr.md' },
  { level: 'annual', file: 'annual-okr.md' },
  { level: 'quarterly', file: 'current-okr.md' },
];

/**
 * Load the three OKR files from a vault `10_OKR/` directory on disk.
 * `okrDir` should point at the directory that contains the three files.
 */
export function loadOkrFromDir(okrDir: string): OkrModel {
  const warnings: string[] = [];
  const contents: Partial<Record<OkrLevel, string>> = {};
  for (const { level, file } of LEVEL_FILES) {
    const filePath = path.join(okrDir, file);
    try {
      if (fs.existsSync(filePath)) {
        contents[level] = fs.readFileSync(filePath, 'utf8');
      } else {
        warnings.push(`okr: missing ${file} in ${OKR_DIR_NAME}`);
      }
    } catch (error) {
      warnings.push(`okr: failed to read ${file}: ${errText(error)}`);
    }
  }
  const model = parseOkrContents(contents);
  return { ...model, warnings: [...warnings, ...model.warnings] };
}

/**
 * Parse OKR files from already-loaded content strings. Used by the remote vault
 * path (content fetched over the gate) and by tests. Any level may be omitted.
 */
export function parseOkrContents(contents: Partial<Record<OkrLevel, string>>): OkrModel {
  const warnings: string[] = [];
  const model: OkrModel = { northStar: [], annual: [], quarterly: [], warnings };
  for (const { level } of LEVEL_FILES) {
    const raw = contents[level];
    if (raw == null) continue;
    try {
      model[level] = parseOkrFile(raw, level);
    } catch (error) {
      warnings.push(`okr: failed to parse ${level}: ${errText(error)}`);
    }
  }
  return model;
}

function parseOkrFile(content: string, level: OkrLevel): Objective[] {
  const { frontmatter, body } = splitFrontmatter(content);
  const fileParent = optionalString(frontmatter.parent);
  const fileCycle = optionalString(frontmatter.cycle);
  const sourceFile = LEVEL_FILES.find((entry) => entry.level === level)?.file ?? '';

  const objectives: Objective[] = [];
  // Split the body on Objective headings, keeping each objective's block.
  const headingRe = /^##\s+Objective\s+([A-Za-z0-9_-]+)\s*:\s*(.+?)\s*$/gm;
  const matches = [...body.matchAll(headingRe)];
  for (let i = 0; i < matches.length; i += 1) {
    const match = matches[i]!;
    const id = match[1]!.trim();
    const title = match[2]!.trim();
    const blockStart = match.index! + match[0].length;
    const blockEnd = i + 1 < matches.length ? matches[i + 1]!.index! : body.length;
    const block = body.slice(blockStart, blockEnd);
    const parent = parseParent(block) ?? fileParent;
    objectives.push({
      id,
      title,
      level,
      parent: parent && parent.toLowerCase() !== 'none' ? parent : null,
      cycle: fileCycle,
      sourceFile,
      keyResults: parseKeyResults(block),
    });
  }
  return objectives;
}

function parseParent(block: string): string | null {
  const match = block.match(/^\s*Parent\s*:\s*([A-Za-z0-9_-]+)\s*$/im);
  return match ? match[1]!.trim() : null;
}

function parseKeyResults(block: string): KeyResult[] {
  const results: KeyResult[] = [];
  const lines = block.split(/\r?\n/);
  for (const line of lines) {
    if (!line.includes('|')) continue;
    const cells = splitTableRow(line);
    if (cells.length < 6) continue;
    const [id, description, target, current, progress, updated] = cells;
    // Skip the header row and the `--- | ---` separator row.
    if (/^KR\s*ID$/i.test(id!) || /^-{2,}$/.test(id!.replace(/\s/g, ''))) continue;
    if (!/-KR\d+/i.test(id!)) continue;
    results.push({
      id: id!.trim(),
      description: (description ?? '').trim(),
      target: (target ?? '').trim(),
      current: (current ?? '').trim(),
      progress: (progress ?? '').trim(),
      progressPct: parsePercent(progress ?? ''),
      updated: (updated ?? '').trim(),
    });
  }
  return results;
}

function splitTableRow(line: string): string[] {
  let trimmed = line.trim();
  if (trimmed.startsWith('|')) trimmed = trimmed.slice(1);
  if (trimmed.endsWith('|')) trimmed = trimmed.slice(0, -1);
  return trimmed.split('|').map((cell) => cell.trim());
}

function parsePercent(value: string): number | null {
  const match = value.match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const num = Number(match[0]);
  return Number.isFinite(num) ? num : null;
}

/**
 * Walk the strategy stack for a KR id and return
 * KR -> quarterly O -> annual A -> 5-year N.
 * If the KR belongs to a higher layer (annual/north-star), lower layers are
 * left null and the walk still climbs upward.
 */
export function resolveChain(model: OkrModel, krId: string): OkrChain {
  const warnings: string[] = [];
  const chain: OkrChain = { krId, kr: null, quarterly: null, annual: null, northStar: null, warnings };

  const found = findKeyResult(model, krId);
  if (!found) {
    warnings.push(`okr: KR ${krId} not found`);
    return chain;
  }
  chain.kr = found.kr;

  let current: Objective | null = found.objective;
  if (current.level === 'quarterly') chain.quarterly = current;
  if (current.level === 'annual') chain.annual = current;
  if (current.level === 'northStar') chain.northStar = current;

  const seen = new Set<string>();
  while (current && current.parent && !seen.has(current.id)) {
    seen.add(current.id);
    const parentLevel: OkrLevel | null = current.level === 'quarterly' ? 'annual' : current.level === 'annual' ? 'northStar' : null;
    if (!parentLevel) break;
    const parent: Objective | null = model[parentLevel].find((obj) => obj.id === current!.parent) ?? null;
    if (!parent) {
      warnings.push(`okr: parent ${current.parent} of ${current.id} not found in ${parentLevel}`);
      break;
    }
    if (parentLevel === 'annual') chain.annual = parent;
    if (parentLevel === 'northStar') chain.northStar = parent;
    current = parent;
  }
  return chain;
}

function findKeyResult(model: OkrModel, krId: string): { kr: KeyResult; objective: Objective } | null {
  const target = krId.trim().toLowerCase();
  for (const level of ['quarterly', 'annual', 'northStar'] as OkrLevel[]) {
    for (const objective of model[level]) {
      const kr = objective.keyResults.find((entry) => entry.id.toLowerCase() === target);
      if (kr) return { kr, objective };
    }
  }
  return null;
}

/**
 * Render the model as an indented strategy-stack summary, north star at the top,
 * each KR line showing its progress %. Used as the daily-plan OKR evidence.
 */
export function buildOkrSummary(model: OkrModel): string {
  const lines: string[] = [];
  const layers: Array<{ level: OkrLevel; label: string }> = [
    { level: 'northStar', label: '5年 North Star' },
    { level: 'annual', label: '年度 Annual' },
    { level: 'quarterly', label: '季度 Quarterly' },
  ];
  for (const { level, label } of layers) {
    const objectives = model[level];
    if (objectives.length === 0) continue;
    lines.push(`# ${label}`);
    for (const obj of objectives) {
      const parentSuffix = obj.parent ? ` (→ ${obj.parent})` : '';
      lines.push(`- ${obj.id}: ${obj.title}${parentSuffix}`);
      for (const kr of obj.keyResults) {
        const pct = kr.progressPct != null ? `${kr.progressPct}%` : (kr.progress || 'n/a');
        lines.push(`    - ${kr.id} [${pct}] ${kr.description} — target: ${kr.target || 'n/a'} / current: ${kr.current || 'n/a'}`);
      }
    }
  }
  return lines.join('\n');
}

/** Render a single resolved chain as an indented KR→O→A→N summary. */
export function buildChainSummary(chain: OkrChain): string {
  const lines: string[] = [];
  if (chain.northStar) lines.push(`5年 ${chain.northStar.id}: ${chain.northStar.title}`);
  if (chain.annual) lines.push(`${indent(1)}年度 ${chain.annual.id}: ${chain.annual.title}`);
  if (chain.quarterly) lines.push(`${indent(2)}季度 ${chain.quarterly.id}: ${chain.quarterly.title}`);
  if (chain.kr) {
    const pct = chain.kr.progressPct != null ? `${chain.kr.progressPct}%` : (chain.kr.progress || 'n/a');
    lines.push(`${indent(3)}KR ${chain.kr.id} [${pct}] ${chain.kr.description}`);
  }
  return lines.join('\n');
}

function indent(level: number): string {
  return '  '.repeat(level);
}

/** Directory name convention for OKR files inside a vault (hardcoded per LEO-208). */
export function okrDirName(): string {
  return OKR_DIR_NAME;
}

function splitFrontmatter(content: string): { frontmatter: Record<string, unknown>; body: string } {
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

function optionalString(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === 'string') return value.trim() || null;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null;
}

function errText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
