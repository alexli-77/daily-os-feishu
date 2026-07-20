import fs from 'node:fs';
import path from 'node:path';

/**
 * Write a file atomically by staging the content in a sibling temp file and
 * renaming it into place. `fs.renameSync` is atomic on the same filesystem, so
 * readers never observe a half-written state and a crash mid-write cannot
 * corrupt the previous version of the file.
 */
export function writeFileAtomic(filePath: string, data: string | Uint8Array): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tempPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(tempPath, data);
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    fs.rmSync(tempPath, { force: true });
    throw error;
  }
}
