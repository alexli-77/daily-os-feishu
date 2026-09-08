/**
 * Supabase session for the team read-only mirror (LEO-282).
 *
 * Local markdown is the source of truth. Everything here is a transport
 * concern, so every function in this file is written to fail *soft*: a missing
 * config, a missing session, an expired token or an unreachable Supabase must
 * never take the local app down with it. `readTeamSession()` in particular is
 * called from the console state builder on every page load and is documented as
 * never throwing.
 *
 * The session lives on disk (refresh token included) so restarting the service
 * does not force a re-login. The file is written 0600 and is inside data/,
 * which .gitignore already excludes.
 */
import fs from 'node:fs';
import path from 'node:path';

import type { AppConfig } from '../config/schema.js';

export interface TeamSession {
  userId: string;
  email: string;
  accessToken: string;
  teamId: string | null; // null until the member joins or creates a team
  memberId: string;
}

export interface TeamMember {
  userId: string;
  memberId: string;
  displayName: string;
}

/**
 * What is actually persisted. A superset of TeamSession: the refresh token, and
 * the team facts the console renders.
 *
 * The cached facts (team name, invite code, member list) exist so that building
 * the console state is a pure disk read. If /api/state did a round trip to
 * Supabase, an unreachable Supabase would stall or break the Cycles page — the
 * exact coupling this feature is not allowed to introduce.
 */
export interface StoredTeamSession {
  userId: string;
  email: string;
  accessToken: string;
  refreshToken: string;
  /** Epoch ms. Refreshed slightly early; see EXPIRY_SKEW_MS. */
  expiresAt: number;
  teamId: string | null;
  memberId: string;
  displayName: string;
  teamName: string;
  inviteCode: string;
  members: TeamMember[];
  updatedAt: string;
}

/** Thrown when the remote said this session is over. The UI degrades to signed-out. */
export class TeamSessionError extends Error {
  readonly code: 'not_configured' | 'signed_out' | 'session_expired' | 'remote_error';

  constructor(code: TeamSessionError['code'], message: string) {
    super(message);
    this.name = 'TeamSessionError';
    this.code = code;
  }
}

const DEFAULT_SESSION_PATH = './data/runtime/team-session.json';
const EXPIRY_SKEW_MS = 60_000;

/** Resolved per call: tests (and the console) chdir, and the path is relative. */
export function teamSessionPath(): string {
  return path.resolve(process.env.DAILY_OS_TEAM_SESSION_PATH || DEFAULT_SESSION_PATH);
}

function trimmed(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** No trailing slash, so path joining never produces `//rest/v1`. */
export function supabaseBaseUrl(config: AppConfig): string {
  return trimmed(config.team?.supabase_url).replace(/\/+$/, '');
}

export function supabaseAnonKey(config: AppConfig): string {
  return trimmed(config.team?.supabase_anon_key);
}

/**
 * A service_role key must never reach a laptop: it carries BYPASSRLS, which
 * turns every policy in supabase/migrations into a no-op. Supabase keys are
 * JWTs whose payload names the role, so the obvious mistake — pasting the key
 * sitting next to the anon key in the dashboard — is cheap to catch here rather
 * than discovering it after someone has read another team's data.
 *
 * This is a guard against a slip, not a security boundary: anyone determined to
 * use service_role can edit the file. The boundary is that we never ask for it.
 */
export function looksLikeServiceRoleKey(key: string): boolean {
  const parts = key.split('.');
  if (parts.length !== 3) return false;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as Record<string, unknown>;
    return String(payload.role || '') === 'service_role';
  } catch {
    return false;
  }
}

/** Supabase is configured (url + anon key both present, and the key is not service_role). */
export function isSupabaseConfigured(config: AppConfig): boolean {
  const url = supabaseBaseUrl(config);
  const key = supabaseAnonKey(config);
  if (!url || !key) return false;
  if (!/^https?:\/\//i.test(url)) return false;
  return !looksLikeServiceRoleKey(key);
}

function isTeamMember(value: unknown): value is TeamMember {
  const record = value as Record<string, unknown> | null;
  return Boolean(record) && typeof record?.userId === 'string' && typeof record?.memberId === 'string';
}

/** Never throws: a corrupt or absent file is simply "not signed in". */
export function readStoredTeamSession(): StoredTeamSession | null {
  try {
    const filePath = teamSessionPath();
    if (!fs.existsSync(filePath)) return null;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>;
    const userId = trimmed(parsed.userId);
    const accessToken = trimmed(parsed.accessToken);
    const refreshToken = trimmed(parsed.refreshToken);
    if (!userId || !accessToken || !refreshToken) return null;
    const rawMembers = Array.isArray(parsed.members) ? parsed.members : [];
    return {
      userId,
      email: trimmed(parsed.email),
      accessToken,
      refreshToken,
      expiresAt: Number(parsed.expiresAt) || 0,
      teamId: trimmed(parsed.teamId) || null,
      memberId: trimmed(parsed.memberId),
      displayName: trimmed(parsed.displayName),
      teamName: trimmed(parsed.teamName),
      inviteCode: trimmed(parsed.inviteCode),
      members: rawMembers.filter(isTeamMember).map((member) => ({
        userId: member.userId,
        memberId: member.memberId,
        displayName: trimmed(member.displayName) || member.memberId,
      })),
      updatedAt: trimmed(parsed.updatedAt),
    };
  } catch {
    return null;
  }
}

/** 0600 and written through a temp file, like data/runtime/ui.json. */
export function writeStoredTeamSession(session: StoredTeamSession): void {
  const filePath = teamSessionPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const payload = JSON.stringify({ ...session, updatedAt: new Date().toISOString() }, null, 2);
  const tempPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, payload, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tempPath, filePath);
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // best-effort: the token file should stay owner-only, but do not fail on chmod
  }
}

export function clearStoredTeamSession(): void {
  try {
    fs.rmSync(teamSessionPath(), { force: true });
  } catch {
    // nothing to clear
  }
}

/**
 * The current session, or null when there is nothing usable.
 *
 * Returns the session even when the access token has expired — refreshing is
 * `supabaseFetch`'s job, and reporting "signed out" for a token that is one
 * minute stale would log the user out every time the laptop wakes up.
 */
export function readTeamSession(config: AppConfig): TeamSession | null {
  try {
    if (!isSupabaseConfigured(config)) return null;
    const stored = readStoredTeamSession();
    if (!stored) return null;
    return {
      userId: stored.userId,
      email: stored.email,
      accessToken: stored.accessToken,
      teamId: stored.teamId,
      memberId: stored.memberId,
    };
  } catch {
    return null;
  }
}

function joinUrl(base: string, target: string): string {
  if (/^https?:\/\//i.test(target)) return target;
  return `${base}${target.startsWith('/') ? '' : '/'}${target}`;
}

function mergeHeaders(init: RequestInit | undefined, extra: Record<string, string>): Headers {
  const headers = new Headers(init?.headers as HeadersInit | undefined);
  for (const [key, value] of Object.entries(extra)) {
    if (!headers.has(key)) headers.set(key, value);
  }
  return headers;
}

/** Unauthenticated call (sign-up / sign-in). Carries the anon key only. */
export async function supabaseAnonFetch(config: AppConfig, target: string, init: RequestInit = {}): Promise<Response> {
  if (!isSupabaseConfigured(config)) {
    throw new TeamSessionError('not_configured', 'Supabase 未配置（需要 supabase_url + anon key）。');
  }
  const headers = mergeHeaders(init, {
    apikey: supabaseAnonKey(config),
    'content-type': 'application/json',
  });
  return fetch(joinUrl(supabaseBaseUrl(config), target), { ...init, headers });
}

/** GoTrue token payload. Only the fields we persist are read. */
export function applyTokenResponse(base: StoredTeamSession | null, payload: unknown): StoredTeamSession {
  const body = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;
  const user = (body.user && typeof body.user === 'object' ? body.user : {}) as Record<string, unknown>;
  const accessToken = trimmed(body.access_token);
  const refreshToken = trimmed(body.refresh_token);
  if (!accessToken || !refreshToken) throw new TeamSessionError('remote_error', 'Supabase 未返回完整的会话令牌。');
  const expiresIn = Number(body.expires_in) || 3600;
  return {
    userId: trimmed(user.id) || base?.userId || '',
    email: trimmed(user.email) || base?.email || '',
    accessToken,
    refreshToken,
    expiresAt: Date.now() + expiresIn * 1000,
    teamId: base?.teamId ?? null,
    memberId: base?.memberId || '',
    displayName: base?.displayName || '',
    teamName: base?.teamName || '',
    inviteCode: base?.inviteCode || '',
    members: base?.members || [],
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Exchange the refresh token for a new access token.
 *
 * The two failure modes are deliberately not treated the same:
 *   * the remote rejecting the refresh token (4xx) means the session is over —
 *     the stored file is deleted so the console shows a login form;
 *   * an unreachable host or a 5xx is transient — the file is kept, so coming
 *     back online resumes the same session instead of demanding a password.
 * Conflating them would log the user out every time the wifi drops.
 */
async function refreshStoredSession(config: AppConfig, stored: StoredTeamSession): Promise<StoredTeamSession> {
  let response: Response;
  try {
    response = await supabaseAnonFetch(config, '/auth/v1/token?grant_type=refresh_token', {
      method: 'POST',
      body: JSON.stringify({ refresh_token: stored.refreshToken }),
    });
  } catch (error) {
    throw new TeamSessionError('remote_error', `无法连接 Supabase：${error instanceof Error ? error.message : String(error)}`);
  }
  if (response.status >= 400 && response.status < 500) {
    clearStoredTeamSession();
    throw new TeamSessionError('session_expired', 'Supabase 会话已失效，请重新登录。本地功能不受影响。');
  }
  if (!response.ok) {
    throw new TeamSessionError('remote_error', `Supabase 刷新令牌失败（HTTP ${response.status}）。`);
  }
  const next = applyTokenResponse(stored, await response.json());
  writeStoredTeamSession(next);
  return next;
}

/**
 * Authenticated Supabase REST/RPC call.
 *
 * Throws when there is no usable session — callers that must not fail (the
 * console state, the sync loop) check `readTeamSession()` first. Refresh is
 * handled here, both proactively (token about to expire) and reactively (the
 * remote answered 401 anyway, e.g. after a clock jump).
 */
export async function supabaseFetch(config: AppConfig, target: string, init: RequestInit = {}): Promise<Response> {
  if (!isSupabaseConfigured(config)) {
    throw new TeamSessionError('not_configured', 'Supabase 未配置（需要 supabase_url + anon key）。');
  }
  let stored = readStoredTeamSession();
  if (!stored) throw new TeamSessionError('signed_out', '尚未登录 Supabase。');

  if (!stored.expiresAt || stored.expiresAt - Date.now() < EXPIRY_SKEW_MS) {
    stored = await refreshStoredSession(config, stored);
  }

  const call = async (token: string): Promise<Response> => {
    const headers = mergeHeaders(init, {
      apikey: supabaseAnonKey(config),
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    });
    return fetch(joinUrl(supabaseBaseUrl(config), target), { ...init, headers });
  };

  const response = await call(stored.accessToken);
  if (response.status !== 401) return response;
  const refreshed = await refreshStoredSession(config, stored);
  return call(refreshed.accessToken);
}

/** Body of a failed PostgREST/GoTrue response, as a single readable line. */
export async function supabaseErrorText(response: Response): Promise<string> {
  let raw = '';
  try {
    raw = await response.text();
  } catch {
    raw = '';
  }
  if (!raw) return `HTTP ${response.status}`;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const message = trimmed(parsed.message) || trimmed(parsed.error_description) || trimmed(parsed.msg) || trimmed(parsed.error) || trimmed(parsed.hint);
    if (message) return message;
  } catch {
    // not JSON; fall through to the raw body
  }
  return raw.slice(0, 400);
}

interface MemberRow {
  user_id?: unknown;
  member_id?: unknown;
  display_name?: unknown;
}

/**
 * Everyone in the caller's team, including the caller.
 *
 * Empty array when Supabase is unconfigured, nobody is signed in, or the signed
 * in user has not joined a team yet — all three are ordinary states, not errors.
 * A remote failure does throw: the caller (console, sync) decides whether that
 * is worth surfacing, and silently returning [] would render an empty team as
 * if the teammate had left.
 */
export async function listTeamMembers(config: AppConfig): Promise<TeamMember[]> {
  const session = readTeamSession(config);
  if (!session || !session.teamId) return [];
  const query = `/rest/v1/members?select=user_id,member_id,display_name&team_id=eq.${encodeURIComponent(session.teamId)}`;
  const response = await supabaseFetch(config, query, { method: 'GET' });
  if (!response.ok) {
    throw new TeamSessionError('remote_error', `读取团队成员失败：${await supabaseErrorText(response)}`);
  }
  const rows = (await response.json()) as MemberRow[];
  return (Array.isArray(rows) ? rows : [])
    .map((row) => ({
      userId: trimmed(row.user_id),
      memberId: trimmed(row.member_id),
      displayName: trimmed(row.display_name) || trimmed(row.member_id),
    }))
    .filter((member) => member.userId);
}
