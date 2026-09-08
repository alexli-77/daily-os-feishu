import type { AppConfig } from '../config/schema.js';

/**
 * The seam between cycle sync (LEO-284/285) and team auth (LEO-282/283).
 *
 * Auth owns `src/team/session.ts`: signing in, holding the access token, and
 * knowing which team the account belongs to. Sync owns everything downstream of
 * that. The two are built in parallel, so this file exists to let the sync half
 * compile, run and be tested before the auth half lands.
 *
 * Three properties matter here, in this order:
 *
 *   1. **It must typecheck when `session.ts` does not exist yet.** A static
 *      `import { readTeamSession } from './session.js'` is a hard build error
 *      until the other branch merges, which would mean this branch could not be
 *      verified on its own. So the module is loaded through a *computed*
 *      specifier: TypeScript only resolves `import()` when the specifier is a
 *      syntactic string literal, and gives `any` otherwise. The interfaces below
 *      are copied verbatim from the agreed contract and are what the rest of the
 *      code is typed against — the runtime object is validated against them in
 *      `adapt()` rather than trusted.
 *
 *   2. **A missing or broken auth module degrades, it never throws.** Sync is a
 *      transport for markdown files that are perfectly usable without it. If
 *      `session.ts` is absent, half-written, or throws on import, every caller
 *      here sees "not configured" and local reads and writes carry on untouched.
 *
 *   3. **It is injectable.** Tests drive the whole sync path through a stub
 *      provider instead of a live Supabase project, so the assertions are about
 *      what we send and what we do with what comes back, not about the network.
 *
 * Once `session.ts` is on main this file stays: point 2 and 3 are still worth
 * having, and deleting it would put a network dependency back into the tests.
 */

/** Signed-in account. `teamId` is null until the account joins a team. */
export interface TeamSession {
  userId: string;
  email: string;
  accessToken: string;
  teamId: string | null;
  memberId: string;
}

/** A row of `public.members`, resolved for display. Identity is `userId`. */
export interface TeamMember {
  userId: string;
  memberId: string;
  displayName: string;
}

/**
 * The slice of `src/team/session.ts` sync depends on. Signatures are the locked
 * contract; do not widen them here without changing it there too.
 */
export interface TeamSessionProvider {
  isSupabaseConfigured(config: AppConfig): boolean;
  readTeamSession(config: AppConfig): TeamSession | null;
  supabaseFetch(config: AppConfig, path: string, init?: RequestInit): Promise<Response>;
  listTeamMembers(config: AppConfig): Promise<TeamMember[]>;
}

/** Why no provider is available. Rendered in the console as-is. */
export type ProviderAbsence = 'missing' | 'incomplete' | 'failed';

export interface ProviderLookup {
  provider: TeamSessionProvider | null;
  /** Set only when `provider` is null. */
  absence?: ProviderAbsence;
  detail?: string;
}

// Split so TypeScript sees `string`, not a string literal it would try to
// resolve at build time. Node resolves it relative to this module either way.
const SESSION_MODULE_SPECIFIER = ['.', 'session.js'].join('/');

let cached: ProviderLookup | null = null;
let override: TeamSessionProvider | null = null;

/**
 * Inject a provider, for tests. Pass null to go back to the real module.
 * Also clears the negative cache, so a suite can move between the two.
 */
export function setTeamSessionProviderForTests(provider: TeamSessionProvider | null): void {
  override = provider;
  cached = null;
}

/**
 * The provider to use, or a reason there is none. Resolved once per process:
 * the answer only changes when a file appears on disk, which does not happen
 * while the app is running.
 */
export async function resolveTeamSessionProvider(): Promise<ProviderLookup> {
  if (override) return { provider: override };
  if (cached) return cached;
  cached = await loadTeamSessionProvider();
  return cached;
}

async function loadTeamSessionProvider(): Promise<ProviderLookup> {
  let loaded: unknown;
  try {
    loaded = await import(SESSION_MODULE_SPECIFIER);
  } catch (error) {
    // Not-found is the expected state before the auth branch merges. Anything
    // else (a syntax error, a throwing top-level side effect) is a real defect,
    // but it is still not a reason to take local editing down with it, so it is
    // reported through the same channel with a different label.
    const code = (error as { code?: unknown })?.code;
    if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') {
      return { provider: null, absence: 'missing', detail: '团队登录模块尚未安装（src/team/session.ts）。' };
    }
    return { provider: null, absence: 'failed', detail: error instanceof Error ? error.message : String(error) };
  }
  return adapt(loaded);
}

/**
 * Bind the four functions we need off the loaded module.
 *
 * Checked rather than cast: this is a cross-branch contract, and a module that
 * silently renamed one of these would otherwise fail at the first call, inside
 * a background poll, as an unexplained TypeError.
 */
function adapt(loaded: unknown): ProviderLookup {
  const module = (loaded || {}) as Record<string, unknown>;
  const required = ['isSupabaseConfigured', 'readTeamSession', 'supabaseFetch', 'listTeamMembers'] as const;
  const missing = required.filter((name) => typeof module[name] !== 'function');
  if (missing.length > 0) {
    return {
      provider: null,
      absence: 'incomplete',
      detail: `src/team/session.ts 缺少导出：${missing.join(', ')}。`,
    };
  }
  const provider: TeamSessionProvider = {
    isSupabaseConfigured: module.isSupabaseConfigured as TeamSessionProvider['isSupabaseConfigured'],
    readTeamSession: module.readTeamSession as TeamSessionProvider['readTeamSession'],
    supabaseFetch: module.supabaseFetch as TeamSessionProvider['supabaseFetch'],
    listTeamMembers: module.listTeamMembers as TeamSessionProvider['listTeamMembers'],
  };
  return { provider };
}

/**
 * `readTeamSession` is contractually total, but it is written on another branch
 * and read on every poll tick and every page render. Wrapping it costs nothing
 * and keeps a regression there from becoming a crash here.
 */
export function safeReadTeamSession(provider: TeamSessionProvider, config: AppConfig): TeamSession | null {
  try {
    return provider.readTeamSession(config);
  } catch {
    return null;
  }
}

export function safeIsSupabaseConfigured(provider: TeamSessionProvider, config: AppConfig): boolean {
  try {
    return provider.isSupabaseConfigured(config);
  } catch {
    return false;
  }
}
