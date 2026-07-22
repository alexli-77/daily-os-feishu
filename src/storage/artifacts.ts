import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { dbFindArtifact, dbReadArtifacts, dbSearchArtifacts, dbUpsertArtifact, dbUpsertArtifacts } from './db.js';

/**
 * Artifact index for the LEO-210 web console /artifacts page.
 *
 * registerArtifact() records a single produced file; scanAndIndex() walks the
 * conventional output directories (data/outputs and logs) and back-fills any
 * files that were never explicitly registered. The index is a single JSON file
 * written atomically via writeFileAtomic so the page never reads a torn file.
 */

export type ArtifactType = 'markdown' | 'text' | 'json' | 'log' | 'image' | 'pdf' | 'binary';

export interface ArtifactRecord {
  id: string;
  path: string; // absolute path on disk
  rel_path: string; // path relative to repo root when possible
  name: string;
  type: ArtifactType;
  tags: string[];
  source: string;
  size: number;
  mtime: string;
  registered_at: string;
}

const DEFAULT_SCAN_DIRS = ['./data/outputs', './logs'];
const MAX_SCAN_FILES = 2000;
const PREVIEWABLE: ReadonlySet<ArtifactType> = new Set<ArtifactType>(['markdown', 'text', 'json', 'log']);

function repoRoot(): string {
  return process.cwd();
}

export function isPreviewableType(type: ArtifactType): boolean {
  return PREVIEWABLE.has(type);
}

export function inferArtifactType(filePath: string): ArtifactType {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.md' || ext === '.markdown') return 'markdown';
  if (ext === '.json' || ext === '.jsonl') return 'json';
  if (ext === '.log') return 'log';
  if (ext === '.txt' || ext === '.csv' || ext === '.yaml' || ext === '.yml') return 'text';
  if (ext === '.png' || ext === '.jpg' || ext === '.jpeg' || ext === '.gif' || ext === '.webp' || ext === '.svg') return 'image';
  if (ext === '.pdf') return 'pdf';
  return 'binary';
}

function artifactId(absolutePath: string): string {
  return `art_${crypto.createHash('sha1').update(absolutePath).digest('hex').slice(0, 16)}`;
}

export function readArtifactsIndex(): ArtifactRecord[] {
  return dbReadArtifacts();
}

/**
 * Full-text search over the artifact index (name / rel_path / tags) via FTS5.
 * Empty / blank query returns []. Powers the /artifacts console search box.
 */
export function searchArtifacts(query: string, limit = 50): ArtifactRecord[] {
  return dbSearchArtifacts(query, limit);
}

export interface RegisterArtifactInput {
  path: string;
  type?: ArtifactType;
  tags?: string[];
  source?: string;
}

export function registerArtifact(input: RegisterArtifactInput): ArtifactRecord | null {
  const absolute = path.resolve(input.path);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(absolute);
  } catch {
    return null; // do not index files that no longer exist
  }
  if (!stat.isFile()) return null;

  const id = artifactId(absolute);
  const existing = dbFindArtifact(id);
  const record: ArtifactRecord = {
    id,
    path: absolute,
    rel_path: toRelPath(absolute),
    name: path.basename(absolute),
    type: input.type ?? inferArtifactType(absolute),
    tags: dedupeTags([...(existing?.tags ?? []), ...(input.tags ?? [])]),
    source: input.source ?? existing?.source ?? 'manual',
    size: stat.size,
    mtime: stat.mtime.toISOString(),
    registered_at: existing?.registered_at ?? new Date().toISOString(),
  };
  dbUpsertArtifact(record);
  return record;
}

export interface ScanResult {
  added: number;
  updated: number;
  total: number;
}

export function scanAndIndex(scanDirs: string[] = DEFAULT_SCAN_DIRS): ScanResult {
  const records = dbReadArtifacts();
  const byId = new Map(records.map((record) => [record.id, record]));
  let added = 0;
  let updated = 0;
  let scanned = 0;

  for (const dir of scanDirs) {
    const absoluteDir = path.resolve(dir);
    if (!fs.existsSync(absoluteDir)) continue;
    const source = path.basename(absoluteDir);
    for (const filePath of walkFiles(absoluteDir)) {
      if (scanned >= MAX_SCAN_FILES) break;
      scanned += 1;
      let stat: fs.Stats;
      try {
        stat = fs.statSync(filePath);
      } catch {
        continue;
      }
      const id = artifactId(filePath);
      const existing = byId.get(id);
      const record: ArtifactRecord = {
        id,
        path: filePath,
        rel_path: toRelPath(filePath),
        name: path.basename(filePath),
        type: existing?.type ?? inferArtifactType(filePath),
        tags: existing?.tags ?? [],
        source: existing?.source ?? source,
        size: stat.size,
        mtime: stat.mtime.toISOString(),
        registered_at: existing?.registered_at ?? new Date().toISOString(),
      };
      if (existing) updated += 1;
      else added += 1;
      byId.set(id, record);
    }
  }

  const next = [...byId.values()];
  dbUpsertArtifacts(next);
  return { added, updated, total: next.length };
}

/**
 * Guard for the /artifacts preview endpoint: only files that are present in the
 * index may be read back, which prevents path-traversal reads via a crafted id.
 */
export function findArtifactById(id: string): ArtifactRecord | undefined {
  return dbFindArtifact(id);
}

function walkFiles(root: string, out: string[] = []): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) walkFiles(full, out);
    else if (entry.isFile()) out.push(full);
    if (out.length >= MAX_SCAN_FILES) break;
  }
  return out;
}

function toRelPath(absolute: string): string {
  const rel = path.relative(repoRoot(), absolute);
  return rel.startsWith('..') ? absolute : rel;
}

function dedupeTags(tags: string[]): string[] {
  return [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))];
}
