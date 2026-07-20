import fs from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from '../utils/atomic-write.js';
import { okrDirName } from './loader.js';

/**
 * OKR KR-progress write-back (LEO-208 skeleton; the connect point for LEO-109
 * biweekly write-back). Locates a KR's table row across the three OKR files in a
 * vault `10_OKR/` directory and updates its Current / Progress / Updated cells
 * in place, preserving Description / Target. The write is atomic (temp file +
 * rename via writeFileAtomic).
 *
 * Fully implemented, but intentionally NOT wired into any workflow yet — LEO-109
 * calls this after each biweekly review.
 */

export interface UpdateKrProgressResult {
  ok: boolean;
  file?: string;
  krId: string;
  reason?: string;
}

const CANDIDATE_FILES = ['current-okr.md', 'annual-okr.md', 'north-star-okr.md'];

/**
 * Update a KR row's Current / Progress / Updated columns.
 * @param okrDir  directory that holds the three OKR files (…/10_OKR).
 * @param krId    KR id, e.g. "O1-KR1".
 * @param current new Current cell value.
 * @param progress new Progress cell value (e.g. "40%" or "40").
 * @param date    YYYY-MM-DD written into the Updated cell.
 */
export function updateKrProgress(
  okrDir: string,
  krId: string,
  current: string,
  progress: string,
  date: string,
): UpdateKrProgressResult {
  const normalizedProgress = /%\s*$/.test(progress.trim()) ? progress.trim() : `${progress.trim()}%`;
  for (const file of CANDIDATE_FILES) {
    const filePath = path.join(okrDir, file);
    let content: string;
    try {
      if (!fs.existsSync(filePath)) continue;
      content = fs.readFileSync(filePath, 'utf8');
    } catch (error) {
      return { ok: false, krId, reason: `read failed for ${file}: ${errText(error)}` };
    }
    const updated = replaceKrRow(content, krId, current, normalizedProgress, date);
    if (updated == null) continue;
    try {
      writeFileAtomic(filePath, updated);
    } catch (error) {
      return { ok: false, krId, file, reason: `write failed: ${errText(error)}` };
    }
    return { ok: true, krId, file };
  }
  return { ok: false, krId, reason: `KR ${krId} not found under ${okrDirName()}` };
}

/**
 * Return the file content with the matching KR row rewritten, or null if the
 * KR id is not present in this content.
 */
function replaceKrRow(content: string, krId: string, current: string, progress: string, date: string): string | null {
  const lines = content.split(/\r?\n/);
  const target = krId.trim().toLowerCase();
  let matched = false;
  const out = lines.map((line) => {
    if (!line.includes('|')) return line;
    const { cells, leading } = parseRow(line);
    if (cells.length < 6) return line;
    if (cells[0]!.trim().toLowerCase() !== target) return line;
    matched = true;
    cells[3] = ` ${current} `;
    cells[4] = ` ${progress} `;
    cells[5] = ` ${date} `;
    return `${leading}|${cells.join('|')}|`;
  });
  return matched ? out.join('\n') : null;
}

function parseRow(line: string): { cells: string[]; leading: string } {
  const leading = line.match(/^\s*/)?.[0] ?? '';
  let body = line.trim();
  if (body.startsWith('|')) body = body.slice(1);
  if (body.endsWith('|')) body = body.slice(0, -1);
  // Preserve inner spacing as its own cells; callers only rewrite cells 3-5.
  const cells = body.split('|').map((cell) => ` ${cell.trim()} `);
  return { cells, leading };
}

function errText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
