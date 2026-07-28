import type { OkrLevel } from './editor.js';

/**
 * Deterministic free-form -> loader-format normalizer for the OKR editor (LEO-205).
 * Users write objectives as plain lines with KRs as bullet points; this converts
 * that into the strict structure the loader (okr-lite.ts) parses:
 *   ## Objective <PREFIX><n>: <title>
 *   Parent: none
 *   | KR ID | Description | Target | Current | Progress | Updated |
 * Level decides the id prefix (north-star->N, annual->A, current->O). Frontmatter
 * is preserved verbatim. Already-structured input (has `## Objective`) is returned
 * unchanged, so the button is idempotent.
 */

function levelPrefix(level: OkrLevel): string {
  if (level === 'north-star') return 'N';
  if (level === 'annual') return 'A';
  return 'O';
}

function splitFrontmatter(raw: string): { frontmatter: string | null; body: string } {
  const match = raw.match(/^(---\n[\s\S]*?\n---\n?)([\s\S]*)$/);
  if (!match) return { frontmatter: null, body: raw };
  return { frontmatter: match[1].replace(/\n*$/, '\n'), body: match[2] };
}

interface FreeObjective {
  priority?: string;
  title: string;
  krs: string[];
}

function parseFreeform(body: string): FreeObjective[] {
  const objectives: FreeObjective[] = [];
  let current: FreeObjective | null = null;
  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    // Skip quotes / headings / existing table or separator rows / HTML comments.
    if (/^(>|#|\||<!--)/.test(line)) continue;
    const bullet = line.match(/^[-*•]\s+(.*)$/);
    if (bullet) {
      if (!current) continue;
      const kr = bullet[1].trim().replace(/^KR\s*\d+\s*[:：]\s*/i, '').trim();
      if (kr) current.krs.push(kr);
      continue;
    }
    // Otherwise: a new objective line. Tolerate "P0", "`P0`" and "P0O3"
    // (priority stuck to an O-enumerator with no space).
    let title = line.replace(/`/g, ' ').trim();
    const priorityMatch = title.match(/(?:^|[^A-Za-z0-9])(P[0-4])(?![0-9])/i);
    const priority = priorityMatch ? priorityMatch[1].toUpperCase() : undefined;
    title = title.replace(/(?:^|[^A-Za-z0-9])P[0-4](?![0-9])/gi, ' ');
    // Strip a leading "Objective <id>" or bare "O<n>" enumerator.
    title = title.replace(/^\s*Objective\s+[A-Za-z0-9_.-]+\s*[:：]?\s*/i, ' ');
    title = title.replace(/^\s*O\s*\d+\s*[.、:：]?\s*/i, ' ');
    title = title.trim();
    if (!title) continue;
    current = { priority, title, krs: [] };
    objectives.push(current);
  }
  return objectives;
}

function cell(value: string): string {
  return value.replace(/\|/g, '/').replace(/\n/g, ' ').trim();
}

function renderObjective(objective: FreeObjective, prefix: string, index: number): string {
  const id = `${prefix}${index}`;
  const lines = [`## Objective ${id}: ${cell(objective.title)}`, 'Parent: none'];
  if (objective.priority) lines.push(`Priority: ${objective.priority}`);
  lines.push('');
  lines.push('| KR ID | Description | Target | Current | Progress | Updated |');
  lines.push('| --- | --- | --- | --- | --- | --- |');
  if (objective.krs.length === 0) {
    lines.push(`| ${id}-KR1 |  |  | — | 0% |  |`);
  } else {
    objective.krs.forEach((kr, i) => {
      lines.push(`| ${id}-KR${i + 1} | ${cell(kr)} |  | — | 0% |  |`);
    });
  }
  return lines.join('\n');
}

export function normalizeOkrMarkdown(raw: string, level: OkrLevel): string {
  const { frontmatter, body } = splitFrontmatter(raw);
  // Already structured -> leave it (idempotent).
  if (/^##\s+Objective\s+/m.test(body)) return raw;
  const objectives = parseFreeform(body);
  if (objectives.length === 0) return raw;
  const prefix = levelPrefix(level);
  const rendered = objectives.map((objective, i) => renderObjective(objective, prefix, i + 1)).join('\n\n');
  return `${frontmatter ?? ''}${rendered}\n`;
}
