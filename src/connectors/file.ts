import fs from 'node:fs';
import path from 'node:path';

export function readTextIfExists(filePath: string): { ok: true; content: string } | { ok: false; reason: string } {
  const absolute = path.resolve(filePath);
  if (!fs.existsSync(absolute)) return { ok: false, reason: `missing: ${filePath}` };
  return { ok: true, content: fs.readFileSync(absolute, 'utf8') };
}

export function readJsonIfExists(filePath: string): { ok: true; content: unknown } | { ok: false; reason: string } {
  const text = readTextIfExists(filePath);
  if (!text.ok) return text;
  try {
    return { ok: true, content: JSON.parse(text.content) };
  } catch (error) {
    return { ok: false, reason: `invalid json: ${error instanceof Error ? error.message : String(error)}` };
  }
}

