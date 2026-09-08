import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { writeFileAtomic } from '../utils/atomic-write.js';
import { randomAvatarSeed } from './avatar.js';
import { dbCountUsers, dbFindUser, dbInsertUser, dbLoadUsers, dbSetUserAvatarSeed, dbUpdateUserPassword, dbUsersMissingAvatarSeed } from '../storage/db.js';

/**
 * Local login + role store for the LEO-210 web admin console.
 *
 * - Users live in data/runtime/users.json. Passwords are salted + hashed with
 *   scrypt (node:crypto); the plaintext is never persisted.
 * - Sessions live in-memory and are mirrored to data/runtime/sessions.json so a
 *   server restart does not silently drop every logged-in browser.
 * - This module is intentionally free of any HTTP concerns; server.ts owns the
 *   cookie wiring and the runtime-token compatibility path.
 */

export type Role = 'admin' | 'member';

export interface UserRecord {
  username: string;
  role: Role;
  salt: string;
  hash: string;
  /** Collected at registration. Never verified — nothing here sends mail. */
  email: string;
  /** Fixed at registration; the avatar is drawn from it. */
  avatar_seed: string;
  created_at: string;
  updated_at: string;
}

export interface SessionRecord {
  token: string;
  username: string;
  role: Role;
  created_at: string;
  expires_at: string;
}

export interface AuthInitResult {
  createdAdmin: boolean;
  adminUsername: string;
  initialPassword?: string;
}

export const SESSION_COOKIE = 'daily_os_session';
const SESSIONS_PATH = './data/runtime/sessions.json';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SCRYPT_KEYLEN = 64;

let sessionCache: Map<string, SessionRecord> | null = null;

function sessionsPath(): string {
  return path.resolve(SESSIONS_PATH);
}

function nowIso(): string {
  return new Date().toISOString();
}

function isRole(value: unknown): value is Role {
  return value === 'admin' || value === 'member';
}

// --- password hashing -------------------------------------------------------

export function hashPassword(password: string, salt = crypto.randomBytes(16).toString('hex')): { salt: string; hash: string } {
  const derived = crypto.scryptSync(password, salt, SCRYPT_KEYLEN).toString('hex');
  return { salt, hash: derived };
}

export function verifyPassword(user: UserRecord, password: string): boolean {
  if (!user.salt || !user.hash) return false;
  let derived: Buffer;
  try {
    derived = crypto.scryptSync(password, user.salt, SCRYPT_KEYLEN);
  } catch {
    return false;
  }
  const expected = Buffer.from(user.hash, 'hex');
  if (expected.length !== derived.length) return false;
  return crypto.timingSafeEqual(expected, derived);
}

// --- user store (SQLite via storage/db) -------------------------------------

export function loadUsers(): UserRecord[] {
  return dbLoadUsers();
}

export function findUser(username: string): UserRecord | undefined {
  return dbFindUser(username);
}

/**
 * Look an account up by the address it registered with.
 *
 * Case-insensitive, because nobody types their own address the same way twice.
 * Accounts created before the email column carry '', which must never match an
 * empty or whitespace query.
 */
export function findUserByEmail(email: string): UserRecord | undefined {
  const wanted = (email || '').trim().toLowerCase();
  if (!wanted) return undefined;
  return dbLoadUsers().find((user) => (user.email || '').trim().toLowerCase() === wanted);
}

export function listUsers(): Array<{ username: string; role: Role; created_at: string }> {
  return dbLoadUsers().map((user) => ({ username: user.username, role: user.role, created_at: user.created_at }));
}

export function addUser(username: string, password: string, role: Role, extra: { email?: string; avatarSeed?: string } = {}): UserRecord {
  const name = username.trim();
  if (!name) throw new Error('Username is required.');
  if (!/^[A-Za-z0-9_.-]{2,64}$/.test(name)) throw new Error('Username must be 2-64 chars of letters, digits, _ . -');
  if (password.length < PASSWORD_MIN) throw new Error(`Password must be at least ${PASSWORD_MIN} characters.`);
  if (dbFindUser(name)) throw new Error(`User already exists: ${name}`);
  const { salt, hash } = hashPassword(password);
  const record: UserRecord = {
    username: name,
    role,
    salt,
    hash,
    email: (extra.email || '').trim(),
    // Every account gets one, including ones made by the admin form and the
    // first-run bootstrap: a missing seed would render as everyone sharing the
    // same avatar rather than as no avatar.
    avatar_seed: extra.avatarSeed || randomAvatarSeed(),
    created_at: nowIso(),
    updated_at: nowIso(),
  };
  dbInsertUser(record);
  return record;
}

export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 20;

export interface RegistrationInput {
  username: string;
  email: string;
  password: string;
}

/**
 * Per-field validation for the sign-up form, so the UI can put each message
 * under the input it belongs to instead of showing one combined error.
 *
 * The same function backs the endpoint. Client-side checks decide what the form
 * looks like; they decide nothing about what gets stored.
 */
export function validateRegistration(input: RegistrationInput): Record<string, string> {
  const errors: Record<string, string> = {};
  const username = (input.username || '').trim();
  const email = (input.email || '').trim();
  const password = input.password || '';

  if (!username) errors.username = '请填写用户名';
  else if (!/^[A-Za-z0-9_.-]{2,64}$/.test(username)) errors.username = '用户名只能用字母、数字、_ . -，2-64 个字符';

  if (!email) errors.email = '请填写邮箱';
  // Deliberately loose: this is a format sanity check, not an attempt to decide
  // which addresses exist. Nothing here sends mail, so a wrong-but-well-formed
  // address costs nothing.
  else if (!/^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(email)) errors.email = '邮箱格式不对';

  if (!password) errors.password = '请填写密码';
  else if (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) {
    errors.password = `密码需要 ${PASSWORD_MIN}-${PASSWORD_MAX} 个字符`;
  }

  return errors;
}

/**
 * Create an account from the sign-up form.
 *
 * New accounts are admins by design: this app is installed per machine and its
 * config is the machine's own (the Claude CLI it shells into, the Feishu account
 * in .env). Whoever registers on a given laptop is that laptop's owner, and it
 * only ever listens on 127.0.0.1.
 */
export function registerUser(input: RegistrationInput): { user: UserRecord } | { errors: Record<string, string> } {
  const errors = validateRegistration(input);
  if (Object.keys(errors).length > 0) return { errors };
  const username = input.username.trim();
  if (findUser(username)) return { errors: { username: '这个用户名已经被用了' } };
  return { user: addUser(username, input.password, 'admin', { email: input.email.trim() }) };
}

export function setPassword(username: string, password: string): UserRecord {
  if (password.length < 8) throw new Error('Password must be at least 8 characters.');
  const user = dbFindUser(username);
  if (!user) throw new Error(`User not found: ${username}`);
  const { salt, hash } = hashPassword(password);
  const updatedAt = nowIso();
  dbUpdateUserPassword(user.username, salt, hash, updatedAt);
  return { ...user, salt, hash, updated_at: updatedAt };
}

/**
 * On first ever start (no users) create an `admin` with a random password so the
 * console is never left wide open. The generated password is returned so the
 * caller can surface it once (console + ui.json).
 */
export function ensureAuthInitialized(): AuthInitResult {
  backfillAvatarSeeds();
  if (dbCountUsers() > 0) return { createdAdmin: false, adminUsername: 'admin' };
  const initialPassword = crypto.randomBytes(12).toString('base64url');
  const { salt, hash } = hashPassword(initialPassword);
  const admin: UserRecord = { username: 'admin', role: 'admin', salt, hash, email: '', avatar_seed: randomAvatarSeed(), created_at: nowIso(), updated_at: nowIso() };
  dbInsertUser(admin);
  return { createdAdmin: true, adminUsername: 'admin', initialPassword };
}

/**
 * Give an avatar to accounts that existed before the column did.
 *
 * The ADD COLUMN migration fills old rows with '', and the renderer falls back
 * to the username for those — which draws something, so nothing looks broken,
 * but it is the exact behaviour the stored seed exists to avoid: an avatar
 * derived from a name changes when the name does.
 */
function backfillAvatarSeeds(): void {
  for (const username of dbUsersMissingAvatarSeed()) dbSetUserAvatarSeed(username, randomAvatarSeed());
}

// --- sessions ---------------------------------------------------------------

function loadSessions(): Map<string, SessionRecord> {
  if (sessionCache) return sessionCache;
  const cache = new Map<string, SessionRecord>();
  const file = sessionsPath();
  if (fs.existsSync(file)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { sessions?: unknown };
      if (parsed && Array.isArray(parsed.sessions)) {
        for (const raw of parsed.sessions) {
          if (!raw || typeof raw !== 'object') continue;
          const record = raw as SessionRecord;
          if (typeof record.token === 'string' && typeof record.username === 'string' && isRole(record.role)) {
            cache.set(record.token, record);
          }
        }
      }
    } catch {
      // ignore corrupt session file; start with an empty set.
    }
  }
  sessionCache = cache;
  pruneExpiredSessions();
  return cache;
}

function persistSessions(): void {
  const cache = sessionCache;
  if (!cache) return;
  writeFileAtomic(sessionsPath(), JSON.stringify({ sessions: [...cache.values()] }, null, 2));
  try {
    fs.chmodSync(sessionsPath(), 0o600);
  } catch {
    // best-effort owner-only
  }
}

function pruneExpiredSessions(): void {
  const cache = sessionCache;
  if (!cache) return;
  const now = Date.now();
  let changed = false;
  for (const [token, session] of cache) {
    if (Date.parse(session.expires_at) <= now) {
      cache.delete(token);
      changed = true;
    }
  }
  if (changed) persistSessions();
}

export function createSession(username: string, role: Role): SessionRecord {
  const cache = loadSessions();
  const session: SessionRecord = {
    token: crypto.randomBytes(32).toString('hex'),
    username,
    role,
    created_at: nowIso(),
    expires_at: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
  };
  cache.set(session.token, session);
  persistSessions();
  return session;
}

export function getSession(token: string): SessionRecord | null {
  if (!token) return null;
  const cache = loadSessions();
  const session = cache.get(token);
  if (!session) return null;
  if (Date.parse(session.expires_at) <= Date.now()) {
    cache.delete(token);
    persistSessions();
    return null;
  }
  return session;
}

export function destroySession(token: string): void {
  if (!token) return;
  const cache = loadSessions();
  if (cache.delete(token)) persistSessions();
}

// --- cookie helper ----------------------------------------------------------

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) out[key] = decodeURIComponent(value);
  }
  return out;
}

/** Test-only helper so unit tests can start from a clean cache. */
export function resetSessionCacheForTests(): void {
  sessionCache = null;
}
