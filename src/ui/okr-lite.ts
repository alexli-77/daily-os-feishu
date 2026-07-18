import fs from 'node:fs';
import path from 'node:path';

/**
 * Tiny, dependency-free OKR reader for the /today page. This intentionally does
 * NOT import src/okr/* — it is a tolerant "best effort" parser that reads the
 * three strategy files from memory-vault/default/10_OKR and never throws on a
 * missing or malformed file. It understands just enough of the structure
 * contract documented in current-okr.md:
 *
 *   - YAML-ish frontmatter (title, cycle, status, level, updated ...)
 *   - `## Objective <id>: <title>` headings, optional `Parent: <id>` line
 *   - a Markdown KR table with columns
 *     `KR ID | Description | Target | Current | Progress | Updated`
 */

export interface OkrKeyResult {
  id: string;
  description: string;
  target: string;
  current: string;
  progress: number | null;
  updated: string;
}

export interface OkrObjective {
  id: string;
  title: string;
  parent?: string;
  keyResults: OkrKeyResult[];
}

export interface OkrFile {
  file: string;
  exists: boolean;
  frontmatter: Record<string, string>;
  title: string;
  objectives: OkrObjective[];
}

export interface OkrSnapshot {
  dir: string;
  northStar: OkrFile;
  annual: OkrFile;
  current: OkrFile;
  /** Rough completion across the current cycle's KRs, 0-100 or null when empty. */
  currentProgress: number | null;
}

function okrDir(repositoryPath?: string): string {
  const trimmed = (repositoryPath || '').trim();
  if (trimmed) {
    const candidate = path.resolve(trimmed, '10_OKR');
    if (fs.existsSync(candidate)) return candidate;
  }
  return path.resolve('memory-vault', 'default', '10_OKR');
}

export function readOkrSnapshot(repositoryPath?: string): OkrSnapshot {
  const dir = okrDir(repositoryPath);
  const northStar = readOkrFile(path.join(dir, 'north-star-okr.md'));
  const annual = readOkrFile(path.join(dir, 'annual-okr.md'));
  const current = readOkrFile(path.join(dir, 'current-okr.md'));
  return { dir, northStar, annual, current, currentProgress: averageProgress(current) };
}

export function readOkrFile(filePath: string): OkrFile {
  const base: OkrFile = { file: filePath, exists: false, frontmatter: {}, title: path.basename(filePath), objectives: [] };
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return base;
  }
  const { frontmatter, body } = splitFrontmatter(raw);
  const objectives = parseObjectives(body);
  const title = frontmatter.title || firstHeading(body) || path.basename(filePath);
  return { file: filePath, exists: true, frontmatter, title, objectives };
}

function splitFrontmatter(raw: string): { frontmatter: Record<string, string>; body: string } {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: raw };
  const frontmatter: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key) frontmatter[key] = stripQuotes(value);
  }
  return { frontmatter, body: match[2] };
}

function parseObjectives(body: string): OkrObjective[] {
  const lines = body.split('\n');
  const objectives: OkrObjective[] = [];
  let current: OkrObjective | null = null;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const heading = line.match(/^##\s+Objective\s+([A-Za-z0-9_.-]+)\s*[:：]\s*(.*)$/);
    if (heading) {
      current = { id: heading[1].trim(), title: heading[2].trim(), keyResults: [] };
      objectives.push(current);
      continue;
    }
    if (!current) continue;
    const parent = line.match(/^Parent:\s*([A-Za-z0-9_.-]+)/i);
    if (parent) {
      current.parent = parent[1].trim();
      continue;
    }
    // A KR table row looks like: | O1-KR1 | desc | target | current | 40% | date |
    if (/^\|/.test(line) && line.includes('|')) {
      const cells = splitTableRow(line);
      if (cells.length >= 5 && /KR/i.test(cells[0]) && !/^KR\s*ID$/i.test(cells[0].trim())) {
        current.keyResults.push({
          id: cells[0],
          description: cells[1] || '',
          target: cells[2] || '',
          current: cells[3] || '',
          progress: parseProgress(cells[4] || ''),
          updated: cells[5] || '',
        });
      }
    }
  }
  return objectives;
}

function splitTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

function parseProgress(value: string): number | null {
  const match = value.match(/(-?\d+(?:\.\d+)?)\s*%?/);
  if (!match) return null;
  const num = Number(match[1]);
  if (!Number.isFinite(num)) return null;
  return Math.max(0, Math.min(100, Math.round(num)));
}

function averageProgress(file: OkrFile): number | null {
  const values = file.objectives.flatMap((obj) => obj.keyResults.map((kr) => kr.progress)).filter((n): n is number => n !== null);
  if (values.length === 0) return null;
  return Math.round(values.reduce((sum, n) => sum + n, 0) / values.length);
}

function firstHeading(body: string): string {
  const match = body.match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : '';
}

function stripQuotes(value: string): string {
  return value.replace(/^["']/, '').replace(/["']$/, '');
}
