import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { Role, UserRecord } from '../ui/auth.js';
import type { ArtifactRecord } from './artifacts.js';

/**
 * LEO-212 — embedded SQLite store (better-sqlite3) that replaces the JSON files
 * for the account store (users.json) and the artifact index (artifacts-index.json).
 *
 * - Single file at data/runtime/daily-os.db, opened in WAL mode.
 * - On first open, any legacy JSON is imported once and the file renamed to
 *   `*.migrated` as a backup, so an existing install upgrades transparently.
 * - Artifacts get an FTS5 index (name/rel_path/tags) kept in sync via triggers,
 *   powering full-text search on the /artifacts console page.
 * - auth.ts and artifacts.ts keep their public signatures and call in here; no
 *   other caller changes. Sessions stay JSON (out of scope for this migration).
 */

type Db = InstanceType<typeof Database>;

const DEFAULT_DB_PATH = './data/runtime/daily-os.db';

/** Absolute DB path; `DAILY_OS_DB_PATH` overrides it (used to isolate tests). */
function dbFile(): string {
  return path.resolve(process.env.DAILY_OS_DB_PATH || DEFAULT_DB_PATH);
}

/** Legacy JSON stores live next to the DB file, so a custom path migrates too. */
function legacyUsersJson(): string {
  return path.join(path.dirname(dbFile()), 'users.json');
}
function legacyArtifactsJson(): string {
  return path.join(path.dirname(dbFile()), 'artifacts-index.json');
}

let handle: Db | null = null;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  username       TEXT PRIMARY KEY,
  username_lower TEXT NOT NULL UNIQUE,
  role           TEXT NOT NULL,
  salt           TEXT NOT NULL,
  hash           TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS artifacts (
  id            TEXT PRIMARY KEY,
  path          TEXT NOT NULL,
  rel_path      TEXT NOT NULL,
  name          TEXT NOT NULL,
  type          TEXT NOT NULL,
  tags          TEXT NOT NULL,   -- JSON array of strings
  source        TEXT NOT NULL,
  size          INTEGER NOT NULL,
  mtime         TEXT NOT NULL,
  registered_at TEXT NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS artifacts_fts USING fts5(
  id UNINDEXED, name, rel_path, tags, tokenize = 'unicode61'
);
CREATE TRIGGER IF NOT EXISTS artifacts_fts_ai AFTER INSERT ON artifacts BEGIN
  INSERT INTO artifacts_fts(id, name, rel_path, tags) VALUES (new.id, new.name, new.rel_path, new.tags);
END;
CREATE TRIGGER IF NOT EXISTS artifacts_fts_ad AFTER DELETE ON artifacts BEGIN
  DELETE FROM artifacts_fts WHERE id = old.id;
END;
CREATE TRIGGER IF NOT EXISTS artifacts_fts_au AFTER UPDATE ON artifacts BEGIN
  DELETE FROM artifacts_fts WHERE id = old.id;
  INSERT INTO artifacts_fts(id, name, rel_path, tags) VALUES (new.id, new.name, new.rel_path, new.tags);
END;
`;

export function getDb(): Db {
  if (handle) return handle;
  const file = dbFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);
  handle = db;
  migrateLegacyJson(db);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // owner-only is best-effort; never fail startup on chmod.
  }
  return db;
}

/** Test-only: close and forget the handle so a fresh DB path can be opened. */
export function resetDbForTests(): void {
  if (handle) {
    handle.close();
    handle = null;
  }
}

// --- users ------------------------------------------------------------------

const USER_COLS = 'username, role, salt, hash, created_at, updated_at';

export function dbLoadUsers(): UserRecord[] {
  return getDb().prepare(`SELECT ${USER_COLS} FROM users ORDER BY created_at`).all() as UserRecord[];
}

export function dbFindUser(username: string): UserRecord | undefined {
  const row = getDb()
    .prepare(`SELECT ${USER_COLS} FROM users WHERE username_lower = ?`)
    .get(username.trim().toLowerCase());
  return row ? (row as UserRecord) : undefined;
}

export function dbCountUsers(): number {
  return (getDb().prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
}

export function dbInsertUser(user: UserRecord): void {
  getDb()
    .prepare('INSERT INTO users (username, username_lower, role, salt, hash, created_at, updated_at) VALUES (?,?,?,?,?,?,?)')
    .run(user.username, user.username.toLowerCase(), user.role, user.salt, user.hash, user.created_at, user.updated_at);
}

export function dbUpdateUserPassword(username: string, salt: string, hash: string, updatedAt: string): number {
  return getDb()
    .prepare('UPDATE users SET salt = ?, hash = ?, updated_at = ? WHERE username_lower = ?')
    .run(salt, hash, updatedAt, username.trim().toLowerCase()).changes;
}

// --- artifacts --------------------------------------------------------------

const ARTIFACT_COLS = 'id, path, rel_path, name, type, tags, source, size, mtime, registered_at';

interface ArtifactRow {
  id: string;
  path: string;
  rel_path: string;
  name: string;
  type: string;
  tags: string;
  source: string;
  size: number;
  mtime: string;
  registered_at: string;
}

function rowToArtifact(row: ArtifactRow): ArtifactRecord {
  return {
    id: row.id,
    path: row.path,
    rel_path: row.rel_path,
    name: row.name,
    type: row.type as ArtifactRecord['type'],
    tags: parseTags(row.tags),
    source: row.source,
    size: row.size,
    mtime: row.mtime,
    registered_at: row.registered_at,
  };
}

function parseTags(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((tag): tag is string => typeof tag === 'string') : [];
  } catch {
    return [];
  }
}

const UPSERT_ARTIFACT_SQL = `
INSERT INTO artifacts (${ARTIFACT_COLS})
VALUES (@id, @path, @rel_path, @name, @type, @tags, @source, @size, @mtime, @registered_at)
ON CONFLICT(id) DO UPDATE SET
  path = @path, rel_path = @rel_path, name = @name, type = @type,
  tags = @tags, source = @source, size = @size, mtime = @mtime
`;

function artifactParams(record: ArtifactRecord): ArtifactRow {
  return { ...record, tags: JSON.stringify(record.tags) };
}

export function dbReadArtifacts(): ArtifactRecord[] {
  const rows = getDb().prepare(`SELECT ${ARTIFACT_COLS} FROM artifacts ORDER BY mtime DESC`).all() as ArtifactRow[];
  return rows.map(rowToArtifact);
}

export function dbFindArtifact(id: string): ArtifactRecord | undefined {
  const row = getDb().prepare(`SELECT ${ARTIFACT_COLS} FROM artifacts WHERE id = ?`).get(id) as ArtifactRow | undefined;
  return row ? rowToArtifact(row) : undefined;
}

export function dbUpsertArtifact(record: ArtifactRecord): void {
  getDb().prepare(UPSERT_ARTIFACT_SQL).run(artifactParams(record));
}

export function dbUpsertArtifacts(records: ArtifactRecord[]): void {
  const db = getDb();
  const stmt = db.prepare(UPSERT_ARTIFACT_SQL);
  const tx = db.transaction((rows: ArtifactRecord[]) => {
    for (const record of rows) stmt.run(artifactParams(record));
  });
  tx(records);
}

/**
 * Full-text search over artifact name / rel_path / tags. The raw query is turned
 * into a set of quoted prefix terms so arbitrary user input can never inject FTS5
 * operators. Returns [] on an empty/blank query.
 */
export function dbSearchArtifacts(query: string, limit = 50): ArtifactRecord[] {
  const match = toFtsQuery(query);
  if (!match) return [];
  const rows = getDb()
    .prepare(
      `SELECT ${ARTIFACT_COLS.split(', ').map((col) => `a.${col}`).join(', ')}
       FROM artifacts_fts f JOIN artifacts a ON a.id = f.id
       WHERE artifacts_fts MATCH ? ORDER BY rank LIMIT ?`,
    )
    .all(match, limit) as ArtifactRow[];
  return rows.map(rowToArtifact);
}

function toFtsQuery(input: string): string {
  const terms = (input || '')
    .trim()
    .split(/\s+/)
    .map((term) => term.replace(/["*]/g, ''))
    .filter(Boolean);
  if (terms.length === 0) return '';
  return terms.map((term) => `"${term}"*`).join(' ');
}

// --- one-time migration from the legacy JSON files --------------------------

function migrateLegacyJson(db: Db): void {
  if ((db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n === 0) {
    const users = readLegacyUsers();
    if (users.length > 0) {
      const insert = db.prepare(
        'INSERT OR IGNORE INTO users (username, username_lower, role, salt, hash, created_at, updated_at) VALUES (?,?,?,?,?,?,?)',
      );
      db.transaction((rows: UserRecord[]) => {
        for (const u of rows) insert.run(u.username, u.username.toLowerCase(), u.role, u.salt, u.hash, u.created_at, u.updated_at);
      })(users);
      archiveLegacy(legacyUsersJson());
    }
  }
  if ((db.prepare('SELECT COUNT(*) AS n FROM artifacts').get() as { n: number }).n === 0) {
    const artifacts = readLegacyArtifacts();
    if (artifacts.length > 0) {
      const stmt = db.prepare(UPSERT_ARTIFACT_SQL);
      db.transaction((rows: ArtifactRecord[]) => {
        for (const record of rows) stmt.run(artifactParams(record));
      })(artifacts);
      archiveLegacy(legacyArtifactsJson());
    }
  }
}

function readLegacyUsers(): UserRecord[] {
  const file = legacyUsersJson();
  if (!fs.existsSync(file)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { users?: unknown };
    if (!parsed || !Array.isArray(parsed.users)) return [];
    return parsed.users.filter(
      (value): value is UserRecord =>
        Boolean(value) &&
        typeof value === 'object' &&
        typeof (value as UserRecord).username === 'string' &&
        isRole((value as UserRecord).role) &&
        typeof (value as UserRecord).salt === 'string' &&
        typeof (value as UserRecord).hash === 'string',
    );
  } catch {
    return [];
  }
}

function readLegacyArtifacts(): ArtifactRecord[] {
  const file = legacyArtifactsJson();
  if (!fs.existsSync(file)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { artifacts?: unknown };
    if (!parsed || !Array.isArray(parsed.artifacts)) return [];
    return parsed.artifacts.filter(
      (value): value is ArtifactRecord =>
        Boolean(value) &&
        typeof value === 'object' &&
        typeof (value as ArtifactRecord).id === 'string' &&
        typeof (value as ArtifactRecord).path === 'string' &&
        typeof (value as ArtifactRecord).type === 'string',
    );
  } catch {
    return [];
  }
}

function isRole(value: unknown): value is Role {
  return value === 'admin' || value === 'member';
}

function archiveLegacy(relPath: string): void {
  const file = path.resolve(relPath);
  try {
    if (fs.existsSync(file)) fs.renameSync(file, `${file}.migrated`);
  } catch {
    // keeping the original file is harmless; it just won't be re-imported
    // because the tables are now non-empty.
  }
}
