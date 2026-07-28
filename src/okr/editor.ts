import fs from 'node:fs';
import path from 'node:path';
import type { AppConfig } from '../config/schema.js';

/**
 * Raw-markdown read/write for the three OKR files, backing the console's OKR
 * editor (LEO-205). Directory resolution mirrors the Today page (okr-lite.ts)
 * exactly so the editor always writes the same files the dashboard reads:
 * `<memory repo>/10_OKR` when it exists, else the bundled default.
 */

const OKR_FILES = [
  { level: 'north-star', label: '5年 North Star', fileName: 'north-star-okr.md' },
  { level: 'annual', label: '年度 Annual', fileName: 'annual-okr.md' },
  { level: 'current', label: '本季 Current', fileName: 'current-okr.md' },
] as const;

export type OkrLevel = (typeof OKR_FILES)[number]['level'];

function okrDir(repositoryPath?: string): string {
  const trimmed = (repositoryPath || '').trim();
  if (trimmed) {
    const candidate = path.resolve(trimmed, '10_OKR');
    if (fs.existsSync(candidate)) return candidate;
  }
  return path.resolve('memory-vault', 'default', '10_OKR');
}

export function readOkrEditorState(config: AppConfig): Record<string, unknown> {
  const dir = okrDir(config.memory.repository_path);
  const files = OKR_FILES.map((entry) => {
    const filePath = path.join(dir, entry.fileName);
    let markdown = '';
    try {
      markdown = fs.readFileSync(filePath, 'utf8');
    } catch {
      markdown = '';
    }
    return { level: entry.level, label: entry.label, fileName: entry.fileName, path: filePath, markdown };
  });
  return { dir, files };
}

export function writeOkrFile(config: AppConfig, level: string, markdown: string): { path: string } {
  const entry = OKR_FILES.find((file) => file.level === level);
  if (!entry) throw new Error(`Unknown OKR level: ${level}`);
  const dir = okrDir(config.memory.repository_path);
  const filePath = path.join(dir, entry.fileName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, markdown.replace(/\r\n/g, '\n'), 'utf8');
  return { path: filePath };
}
