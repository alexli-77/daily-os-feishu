import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

let cached: string | undefined;

/** Reads the `version` field from the project's package.json (cached). */
export function appVersion(): string {
  if (cached) return cached;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8')) as { version?: string };
    cached = pkg.version ?? 'unknown';
  } catch {
    cached = 'unknown';
  }
  return cached;
}
