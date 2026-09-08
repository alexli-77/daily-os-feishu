/**
 * Team membership operations (LEO-283), on top of the session in session.ts.
 *
 * Creating and joining a team are `security definer` RPCs, not table writes.
 * The reason is in supabase/migrations/20260907000000_init.sql: `members.team_id`
 * is pinned by RLS (it is the input to every read policy, so a user who can set
 * it can read any team), and `teams` has no write policy at all. So there is no
 * "insert a team then update my row" path from a client — both halves have to
 * happen inside one privileged transaction, or the person who created the team
 * could not join it.
 *
 * Everything here degrades: a failure returns a message, never a thrown stack
 * into the console request handler, and never touches local markdown.
 */
import type { AppConfig } from '../config/schema.js';
import {
  type StoredTeamSession,
  type TeamMember,
  TeamSessionError,
  applyTokenResponse,
  clearStoredTeamSession,
  isSupabaseConfigured,
  readStoredTeamSession,
  readTeamSession,
  supabaseAnonFetch,
  supabaseBaseUrl,
  supabaseErrorText,
  supabaseFetch,
  writeStoredTeamSession,
} from './session.js';

export interface TeamUiState {
  configured: boolean;
  supabaseUrl: string;
  signedIn: boolean;
  userId: string;
  email: string;
  memberId: string;
  displayName: string;
  teamId: string;
  teamName: string;
  inviteCode: string;
  members: TeamMember[];
  updatedAt: string;
}

export interface TeamActionResult {
  ok: boolean;
  text?: string;
  error?: string;
}

function fail(error: unknown): TeamActionResult {
  return { ok: false, error: error instanceof Error ? error.message : String(error) };
}

/**
 * Purely local: reads the cached session file, never the network.
 *
 * /api/state is built on every console load, so a round trip here would make an
 * unreachable Supabase stall the Cycles page. The team panel refreshes its
 * remote facts through an explicit action instead.
 */
export function readTeamUiState(config: AppConfig): TeamUiState {
  const configured = isSupabaseConfigured(config);
  const stored = configured ? readStoredTeamSession() : null;
  return {
    configured,
    supabaseUrl: supabaseBaseUrl(config),
    signedIn: Boolean(stored),
    userId: stored?.userId || '',
    email: stored?.email || '',
    memberId: stored?.memberId || '',
    displayName: stored?.displayName || '',
    teamId: stored?.teamId || '',
    teamName: stored?.teamName || '',
    inviteCode: stored?.inviteCode || '',
    members: stored?.members || [],
    updatedAt: stored?.updatedAt || '',
  };
}

interface MemberRow {
  team_id?: unknown;
  member_id?: unknown;
  display_name?: unknown;
}

interface TeamRow {
  id?: unknown;
  name?: unknown;
  invite_code?: unknown;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

async function readJsonRows<T>(config: AppConfig, query: string): Promise<T[]> {
  const response = await supabaseFetch(config, query, { method: 'GET' });
  if (!response.ok) throw new TeamSessionError('remote_error', await supabaseErrorText(response));
  const rows = (await response.json()) as T[];
  return Array.isArray(rows) ? rows : [];
}

/**
 * Re-read the caller's own member row, their team, and the team roster, and
 * cache all of it in the session file. Called after every membership change and
 * from the panel's Refresh button.
 */
export async function refreshTeamFacts(config: AppConfig): Promise<StoredTeamSession> {
  const stored = readStoredTeamSession();
  if (!stored) throw new TeamSessionError('signed_out', '尚未登录 Supabase。');

  const [self] = await readJsonRows<MemberRow>(
    config,
    `/rest/v1/members?select=team_id,member_id,display_name&user_id=eq.${encodeURIComponent(stored.userId)}`,
  );
  const teamId = text(self?.team_id) || null;
  const next: StoredTeamSession = {
    ...stored,
    teamId,
    memberId: text(self?.member_id) || stored.memberId,
    displayName: text(self?.display_name) || stored.displayName,
    teamName: '',
    inviteCode: '',
    members: [],
  };

  if (teamId) {
    const [team] = await readJsonRows<TeamRow>(
      config,
      `/rest/v1/teams?select=id,name,invite_code&id=eq.${encodeURIComponent(teamId)}`,
    );
    next.teamName = text(team?.name);
    next.inviteCode = text(team?.invite_code);
    const rows = await readJsonRows<MemberRow & { user_id?: unknown }>(
      config,
      `/rest/v1/members?select=user_id,member_id,display_name&team_id=eq.${encodeURIComponent(teamId)}`,
    );
    next.members = rows
      .map((row) => ({
        userId: text(row.user_id),
        memberId: text(row.member_id),
        displayName: text(row.display_name) || text(row.member_id),
      }))
      .filter((member) => member.userId);
  }

  writeStoredTeamSession(next);
  return next;
}

/** Best-effort refresh: a membership change already succeeded, so a failed
 * re-read is a stale panel, not a failed operation. */
async function refreshQuietly(config: AppConfig): Promise<string> {
  try {
    await refreshTeamFacts(config);
    return '';
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export async function signUp(
  config: AppConfig,
  input: { email: string; password: string; displayName?: string; memberId?: string },
): Promise<TeamActionResult> {
  const email = text(input.email);
  const password = typeof input.password === 'string' ? input.password : '';
  if (!email) return { ok: false, error: '请填写邮箱。' };
  if (password.length < 6) return { ok: false, error: '密码至少 6 位。' };
  const displayName = text(input.displayName);
  // member_id is a display label, not identity (see supabase/README.md). Falling
  // back to the email local part matches what the signup trigger does anyway.
  const memberId = (text(input.memberId) || displayName || email.split('@')[0]).slice(0, 40);

  try {
    const response = await supabaseAnonFetch(config, '/auth/v1/signup', {
      method: 'POST',
      body: JSON.stringify({
        email,
        password,
        data: { member_id: memberId, display_name: displayName || memberId },
      }),
    });
    if (!response.ok) return { ok: false, error: `注册失败：${await supabaseErrorText(response)}` };
    const body = (await response.json()) as Record<string, unknown>;
    if (!text(body.access_token)) {
      // Email confirmation is on: the account exists but there is no session yet.
      return { ok: true, text: '注册成功，但 Supabase 要求先确认邮箱。确认后回到这里登录。' };
    }
    const stored = applyTokenResponse(null, body);
    stored.memberId = memberId;
    stored.displayName = displayName || memberId;
    writeStoredTeamSession(stored);
    const warning = await refreshQuietly(config);
    return { ok: true, text: warning ? `注册并登录成功（团队信息读取失败：${warning}）` : '注册并登录成功。' };
  } catch (error) {
    return fail(error);
  }
}

export async function signIn(config: AppConfig, input: { email: string; password: string }): Promise<TeamActionResult> {
  const email = text(input.email);
  const password = typeof input.password === 'string' ? input.password : '';
  if (!email || !password) return { ok: false, error: '请填写邮箱和密码。' };
  try {
    const response = await supabaseAnonFetch(config, '/auth/v1/token?grant_type=password', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
    if (!response.ok) return { ok: false, error: `登录失败：${await supabaseErrorText(response)}` };
    const stored = applyTokenResponse(readStoredTeamSession(), await response.json());
    // A different account must not inherit the previous one's cached team.
    const previous = readStoredTeamSession();
    if (previous && previous.userId !== stored.userId) {
      stored.teamId = null;
      stored.memberId = '';
      stored.displayName = '';
      stored.teamName = '';
      stored.inviteCode = '';
      stored.members = [];
    }
    writeStoredTeamSession(stored);
    const warning = await refreshQuietly(config);
    return { ok: true, text: warning ? `已登录（团队信息读取失败：${warning}）` : '已登录。' };
  } catch (error) {
    return fail(error);
  }
}

/** Local sign-out always wins: the remote call is best effort. */
export async function signOut(config: AppConfig): Promise<TeamActionResult> {
  try {
    if (readTeamSession(config)) {
      await supabaseFetch(config, '/auth/v1/logout', { method: 'POST', body: '{}' }).catch(() => undefined);
    }
  } catch {
    // ignore: clearing the local session is what actually signs this machine out
  }
  clearStoredTeamSession();
  return { ok: true, text: '已退出登录。本地功能不受影响。' };
}

/** POST an RPC and return its scalar result, or a readable error. */
async function callRpc(config: AppConfig, name: string, args: Record<string, unknown>): Promise<unknown> {
  const response = await supabaseFetch(config, `/rest/v1/rpc/${name}`, {
    method: 'POST',
    body: JSON.stringify(args),
  });
  if (!response.ok) throw new TeamSessionError('remote_error', await supabaseErrorText(response));
  const raw = await response.text();
  if (!raw) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

export async function createTeam(config: AppConfig, name: string): Promise<TeamActionResult> {
  const teamName = text(name);
  if (!teamName) return { ok: false, error: '请填写团队名称。' };
  const session = readTeamSession(config);
  if (!session) return { ok: false, error: '请先登录 Supabase。' };
  // Mirrors the RPC's own check. The database is the enforcement point; this is
  // only here so the common case reports something better than a SQL error.
  if (session.teamId) return { ok: false, error: '你已经在一个团队里了，先退出才能新建。' };
  try {
    await callRpc(config, 'create_team', { team_name: teamName });
    const warning = await refreshQuietly(config);
    return { ok: true, text: warning ? `团队已创建（信息读取失败：${warning}）` : `团队「${teamName}」已创建。` };
  } catch (error) {
    return fail(error);
  }
}

export async function joinTeam(config: AppConfig, code: string): Promise<TeamActionResult> {
  const inviteCode = text(code);
  if (!inviteCode) return { ok: false, error: '请填写邀请码。' };
  const session = readTeamSession(config);
  if (!session) return { ok: false, error: '请先登录 Supabase。' };
  if (session.teamId) return { ok: false, error: '你已经在一个团队里了，不能直接加入另一个团队。' };
  try {
    await callRpc(config, 'join_team', { code: inviteCode });
    const warning = await refreshQuietly(config);
    return { ok: true, text: warning ? `已加入团队（信息读取失败：${warning}）` : '已加入团队。' };
  } catch (error) {
    return fail(error);
  }
}

export async function leaveTeam(config: AppConfig): Promise<TeamActionResult> {
  const session = readTeamSession(config);
  if (!session) return { ok: false, error: '请先登录 Supabase。' };
  if (!session.teamId) return { ok: false, error: '你还没有加入任何团队。' };
  try {
    await callRpc(config, 'leave_team', {});
    const warning = await refreshQuietly(config);
    return { ok: true, text: warning ? `已退出团队（信息读取失败：${warning}）` : '已退出团队。已同步过的周期仍留在原团队。' };
  } catch (error) {
    return fail(error);
  }
}

export async function rotateInviteCode(config: AppConfig): Promise<TeamActionResult> {
  const session = readTeamSession(config);
  if (!session) return { ok: false, error: '请先登录 Supabase。' };
  if (!session.teamId) return { ok: false, error: '你还没有加入任何团队。' };
  try {
    // The new code is not put in the returned message: it is rendered (and
    // copyable) in the panel, and the message ends up in the UI log.
    await callRpc(config, 'rotate_invite_code', {});
    const warning = await refreshQuietly(config);
    return { ok: true, text: warning ? `邀请码已更换（信息读取失败：${warning}）` : '邀请码已更换，旧邀请码立即失效。' };
  } catch (error) {
    return fail(error);
  }
}

export async function refreshTeam(config: AppConfig): Promise<TeamActionResult> {
  if (!isSupabaseConfigured(config)) return { ok: false, error: 'Supabase 未配置。' };
  if (!readTeamSession(config)) return { ok: false, error: '尚未登录 Supabase。' };
  try {
    await refreshTeamFacts(config);
    return { ok: true, text: '团队信息已刷新。' };
  } catch (error) {
    return fail(error);
  }
}
