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
  email          TEXT NOT NULL DEFAULT '',
  avatar_seed    TEXT NOT NULL DEFAULT '',
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
CREATE TABLE IF NOT EXISTS chat_messages (
  id         TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  channel    TEXT NOT NULL,
  role       TEXT NOT NULL,   -- user | assistant | system
  content    TEXT NOT NULL,
  run_id     TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS chat_messages_session ON chat_messages (session_id, created_at);
-- LEO-266 calendar write-back state (dedup / batch / undo). See src/calendar/writeback.ts.
CREATE TABLE IF NOT EXISTS calendar_draft_snapshots (
  draft_id   TEXT PRIMARY KEY,
  period     TEXT NOT NULL,
  payload    TEXT NOT NULL,   -- JSON-encoded CalendarDraft, retrieved on confirm
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS calendar_batches (
  batch_id    TEXT PRIMARY KEY,
  draft_id    TEXT NOT NULL,
  period      TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  event_count INTEGER NOT NULL,
  undone_at   TEXT
);
CREATE TABLE IF NOT EXISTS calendar_writebacks (
  dedup_key       TEXT PRIMARY KEY,   -- sha1(source_task_ids + '|' + start day)
  event_id        TEXT NOT NULL,
  calendar_id     TEXT NOT NULL,
  batch_id        TEXT NOT NULL,
  title           TEXT NOT NULL,
  start           TEXT NOT NULL,
  end             TEXT NOT NULL,
  source_task_ids TEXT NOT NULL,      -- JSON array
  created_at      TEXT NOT NULL,
  deleted_at      TEXT                 -- non-null once undone
);
CREATE INDEX IF NOT EXISTS calendar_writebacks_batch ON calendar_writebacks (batch_id);
-- LEO-268 adjust feed-back: stored per-period adjustment instructions.
CREATE TABLE IF NOT EXISTS calendar_adjustments (
  scope      TEXT PRIMARY KEY,   -- 'week' | 'today'
  payload    TEXT NOT NULL,      -- JSON array of CalendarAdjustment
  updated_at TEXT NOT NULL
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
  addMissingUserColumns(db);
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

/**
 * SCHEMA only ever runs as CREATE TABLE IF NOT EXISTS, so a column added later
 * never reaches a database that already exists. Anyone upgrading has a users
 * table from before email and avatar_seed, and losing their login over a schema
 * bump would be a bad way to find that out.
 */
function addMissingUserColumns(db: Db): void {
  const present = new Set((db.prepare('PRAGMA table_info(users)').all() as Array<{ name: string }>).map((row) => row.name));
  for (const [column, ddl] of [
    ['email', "ALTER TABLE users ADD COLUMN email TEXT NOT NULL DEFAULT ''"],
    ['avatar_seed', "ALTER TABLE users ADD COLUMN avatar_seed TEXT NOT NULL DEFAULT ''"],
  ] as const) {
    if (!present.has(column)) db.exec(ddl);
  }
}

// --- users ------------------------------------------------------------------

const USER_COLS = 'username, role, salt, hash, email, avatar_seed, created_at, updated_at';

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
    .prepare('INSERT INTO users (username, username_lower, role, salt, hash, email, avatar_seed, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(user.username, user.username.toLowerCase(), user.role, user.salt, user.hash, user.email || '', user.avatar_seed || '', user.created_at, user.updated_at);
}

/** Rows that predate the avatar_seed column carry ''. */
export function dbUsersMissingAvatarSeed(): string[] {
  return (getDb().prepare("SELECT username FROM users WHERE avatar_seed = '' OR avatar_seed IS NULL").all() as Array<{ username: string }>)
    .map((row) => row.username);
}

export function dbSetUserAvatarSeed(username: string, seed: string): void {
  getDb().prepare('UPDATE users SET avatar_seed = ? WHERE username_lower = ?').run(seed, username.toLowerCase());
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

// --- web chat messages (LEO-236) --------------------------------------------

export interface ChatMessageRow {
  id: string;
  session_id: string;
  channel: string;
  role: string;
  content: string;
  run_id: string | null;
  created_at: string;
}

export interface ChatSessionSummaryRow {
  session_id: string;
  channel: string;
  messages: number;
  last_at: string;
  first_user_content: string | null;
}

export function dbInsertChatMessage(row: ChatMessageRow): void {
  getDb()
    .prepare(
      'INSERT INTO chat_messages (id, session_id, channel, role, content, run_id, created_at) VALUES (@id, @session_id, @channel, @role, @content, @run_id, @created_at)',
    )
    .run(row);
}

export function dbListChatMessages(sessionId: string, limit = 500): ChatMessageRow[] {
  return getDb()
    .prepare(
      'SELECT id, session_id, channel, role, content, run_id, created_at FROM chat_messages WHERE session_id = ? ORDER BY created_at ASC, rowid ASC LIMIT ?',
    )
    .all(sessionId, limit) as ChatMessageRow[];
}

/** One row per session for the channel, with message count and a title seed. */
export function dbListChatSessions(channel: string, limit = 100): ChatSessionSummaryRow[] {
  return getDb()
    .prepare(
      `SELECT m.session_id AS session_id,
              m.channel AS channel,
              COUNT(*) AS messages,
              MAX(m.created_at) AS last_at,
              (SELECT content FROM chat_messages u
                 WHERE u.session_id = m.session_id AND u.role = 'user'
                 ORDER BY u.created_at ASC, u.rowid ASC LIMIT 1) AS first_user_content
         FROM chat_messages m
        WHERE m.channel = ?
        GROUP BY m.session_id
        ORDER BY last_at DESC
        LIMIT ?`,
    )
    .all(channel, limit) as ChatSessionSummaryRow[];
}

// --- calendar write-back state (LEO-266) ------------------------------------

export interface CalendarWritebackRow {
  dedup_key: string;
  event_id: string;
  calendar_id: string;
  batch_id: string;
  title: string;
  start: string;
  end: string;
  source_task_ids: string; // JSON array
  created_at: string;
  deleted_at: string | null;
}

export interface CalendarBatchRow {
  batch_id: string;
  draft_id: string;
  period: string;
  created_at: string;
  event_count: number;
  undone_at: string | null;
}

/** Persist a draft so the confirm card action can retrieve exactly what was shown. */
export function dbSaveCalendarDraftSnapshot(draftId: string, period: string, payload: string, createdAt: string): void {
  getDb()
    .prepare(
      `INSERT INTO calendar_draft_snapshots (draft_id, period, payload, created_at)
       VALUES (?,?,?,?)
       ON CONFLICT(draft_id) DO UPDATE SET period = excluded.period, payload = excluded.payload, created_at = excluded.created_at`,
    )
    .run(draftId, period, payload, createdAt);
}

export function dbLoadCalendarDraftSnapshot(draftId: string): string | undefined {
  const row = getDb().prepare('SELECT payload FROM calendar_draft_snapshots WHERE draft_id = ?').get(draftId) as
    | { payload: string }
    | undefined;
  return row?.payload;
}

/** Active (not undone) write-back for a dedup key, or undefined. */
export function dbFindCalendarWriteback(dedupKey: string): CalendarWritebackRow | undefined {
  const row = getDb()
    .prepare('SELECT * FROM calendar_writebacks WHERE dedup_key = ? AND deleted_at IS NULL')
    .get(dedupKey) as CalendarWritebackRow | undefined;
  return row;
}

export function dbInsertCalendarBatch(row: CalendarBatchRow): void {
  getDb()
    .prepare(
      'INSERT INTO calendar_batches (batch_id, draft_id, period, created_at, event_count, undone_at) VALUES (@batch_id, @draft_id, @period, @created_at, @event_count, @undone_at)',
    )
    .run(row);
}

/** Insert or resurrect a write-back row (a previously undone key can be reused). */
export function dbUpsertCalendarWriteback(row: CalendarWritebackRow): void {
  getDb()
    .prepare(
      `INSERT INTO calendar_writebacks (dedup_key, event_id, calendar_id, batch_id, title, start, end, source_task_ids, created_at, deleted_at)
       VALUES (@dedup_key, @event_id, @calendar_id, @batch_id, @title, @start, @end, @source_task_ids, @created_at, @deleted_at)
       ON CONFLICT(dedup_key) DO UPDATE SET
         event_id = excluded.event_id, calendar_id = excluded.calendar_id, batch_id = excluded.batch_id,
         title = excluded.title, start = excluded.start, end = excluded.end,
         source_task_ids = excluded.source_task_ids, created_at = excluded.created_at, deleted_at = NULL`,
    )
    .run(row);
}

/** Update the time of an existing (active) write-back after a lark-cli +update. */
export function dbUpdateCalendarWritebackTime(dedupKey: string, start: string, end: string, batchId: string): void {
  getDb()
    .prepare('UPDATE calendar_writebacks SET start = ?, end = ?, batch_id = ? WHERE dedup_key = ?')
    .run(start, end, batchId, dedupKey);
}

export function dbListCalendarBatchWritebacks(batchId: string): CalendarWritebackRow[] {
  return getDb()
    .prepare('SELECT * FROM calendar_writebacks WHERE batch_id = ? AND deleted_at IS NULL')
    .all(batchId) as CalendarWritebackRow[];
}

export function dbMarkCalendarWritebackDeleted(dedupKey: string, deletedAt: string): void {
  getDb().prepare('UPDATE calendar_writebacks SET deleted_at = ? WHERE dedup_key = ?').run(deletedAt, dedupKey);
}

export function dbMarkCalendarBatchUndone(batchId: string, undoneAt: string): void {
  getDb().prepare('UPDATE calendar_batches SET undone_at = ? WHERE batch_id = ?').run(undoneAt, batchId);
}

/** Most recent batch that has not been undone (for `calendar undo` with no id). */
export function dbLatestCalendarBatchId(): string | undefined {
  const row = getDb()
    .prepare('SELECT batch_id FROM calendar_batches WHERE undone_at IS NULL ORDER BY created_at DESC LIMIT 1')
    .get() as { batch_id: string } | undefined;
  return row?.batch_id;
}

// --- calendar adjustments (LEO-268) -----------------------------------------

export function dbLoadCalendarAdjustments(scope: string): string | undefined {
  const row = getDb().prepare('SELECT payload FROM calendar_adjustments WHERE scope = ?').get(scope) as
    | { payload: string }
    | undefined;
  return row?.payload;
}

export function dbSaveCalendarAdjustments(scope: string, payload: string, updatedAt: string): void {
  getDb()
    .prepare(
      `INSERT INTO calendar_adjustments (scope, payload, updated_at) VALUES (?,?,?)
       ON CONFLICT(scope) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`,
    )
    .run(scope, payload, updatedAt);
}

export function dbClearCalendarAdjustments(scope: string): void {
  getDb().prepare('DELETE FROM calendar_adjustments WHERE scope = ?').run(scope);
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
