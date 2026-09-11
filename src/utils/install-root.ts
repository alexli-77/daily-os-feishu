import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Where the *code* lives, as opposed to where the data lives.
 *
 * These were the same directory for as long as the service was only ever run
 * from a git checkout, so assets like `prompts/` were resolved against the cwd
 * and nobody noticed the conflation. Shipping the service inside the Mac app
 * separates them: the code sits read-only in
 * `Daily OS.app/Contents/Resources/service`, and the working directory is
 * `~/Library/Application Support/DailyOS`, which is where config, `.env` and
 * every data file belong — a bundle is replaced wholesale on update, so
 * anything written into it is lost the first time the app is upgraded.
 */
const INSTALL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export function installRoot(): string {
  return INSTALL_ROOT;
}

/**
 * A bundled asset, preferring a copy the user has placed in the working
 * directory.
 *
 * cwd first on purpose: prompts are the one bundled asset people legitimately
 * edit — the daily-plan prompt is tuned per person — and an override that the
 * next app update silently reverts would be worse than not allowing one. Put a
 * `prompts/` beside your data and it wins; otherwise the version that shipped
 * with the code is used.
 */
export function bundledAsset(...segments: string[]): string {
  const local = path.resolve(...segments);
  if (fs.existsSync(local)) return local;
  return path.join(INSTALL_ROOT, ...segments);
}
