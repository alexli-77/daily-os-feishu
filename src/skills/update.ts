import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AppConfig } from '../config/schema.js';
import { runCommand } from '../utils/command.js';

/**
 * Updating the weekly-review skill from the console.
 *
 * The skill is not a copied bundle. The CLI's skill entry is a symlink to the
 * life-review-os checkout, and that checkout is also the `workdir` this app
 * shells into. So "update the skill" is one operation on one directory —
 * `git pull --ff-only` — and both the CLI and Daily OS see the result
 * immediately. There is nothing to copy and nothing to keep in sync.
 *
 * Which CLI is a per-install question: Claude Code reads `~/.claude/skills`,
 * Codex reads `~/.codex/skills`, and both are supported skill providers. So the
 * install location is discovered rather than assumed — see `skillInstallLinks()`.
 *
 * Two rules make the button safe to press without reading the code first:
 *
 *   - `--ff-only`, so a pull can never create a merge commit or rewrite local
 *     history. If the branch has diverged the pull fails and says so.
 *   - a dirty *tracked* file blocks the update before anything is fetched.
 *     life-review-os keeps a real `config.yaml` in its root; that one is
 *     gitignored, so untracked files are deliberately not counted.
 */

/** One CLI's skill directory entry for this skill. */
export interface SkillInstallLink {
  /** Which CLI's skill directory this is, e.g. `claude` or `codex`. */
  cli: string;
  path: string;
  /** Where `path` resolves to, or '' when it does not exist. */
  target: string;
  /** True when this CLI's entry resolves to the workdir Daily OS updates. */
  linked: boolean;
}

export interface SkillRepoState {
  skillId: string;
  workdir: string;
  /**
   * Every known CLI skill directory for this skill, so the console can say which
   * CLI actually sees the checkout being updated.
   */
  installs: SkillInstallLink[];
  /**
   * The CLI entry pointing at `workdir`; falls back to the first that exists,
   * then to the first known location. Kept for callers that predate `installs`.
   */
  installPath: string;
  installTarget: string;
  available: boolean;
  isGitRepo: boolean;
  branch: string;
  commit: string;
  subject: string;
  committedAt: string;
  /** Tracked files with local modifications. Non-empty means an update is refused. */
  dirty: string[];
  /** Commits behind the upstream as of the last fetch; -1 when unknown. */
  behind: number;
  /** Why this repo cannot be updated, if it cannot. */
  blocked: string;
}

export interface SkillUpdateResult {
  ok: boolean;
  changed: boolean;
  before: string;
  after: string;
  /** One line per commit pulled in, newest first. */
  commits: string[];
  message: string;
}

const SKILL_ID = 'weekly-review';
const GIT_TIMEOUT_MS = 120000;

/**
 * CLI skill directories this app knows about. Both Claude Code and Codex are
 * supported skill providers (`skills.registry[].provider`), and each reads its
 * own directory, so neither can be assumed.
 */
const CLI_SKILL_HOMES: ReadonlyArray<{ cli: string; home: string }> = [
  { cli: 'claude', home: '.claude' },
  { cli: 'codex', home: '.codex' },
];

function realpathOrEmpty(target: string): string {
  try {
    return fs.realpathSync(target);
  } catch {
    return '';
  }
}

/**
 * Where each supported CLI would look for this skill, and whether that entry
 * resolves to `workdir` — the checkout Daily OS actually updates. An entry that
 * is a copy rather than a symlink comes back `linked: false`, which is the
 * signal that pressing Update will not change what the CLI loads.
 */
export function skillInstallLinks(workdir = '', skillId = SKILL_ID): SkillInstallLink[] {
  const resolvedWorkdir = workdir ? realpathOrEmpty(workdir) : '';
  return CLI_SKILL_HOMES.map(({ cli, home }) => {
    const installPath = path.join(os.homedir(), home, 'skills', skillId);
    const target = realpathOrEmpty(installPath);
    return {
      cli,
      path: installPath,
      target,
      linked: Boolean(target) && Boolean(resolvedWorkdir) && target === resolvedWorkdir,
    };
  });
}

/**
 * The single install path worth showing: the one linked to `workdir`, else the
 * first that exists at all, else the first known location.
 */
export function skillInstallPath(skillId = SKILL_ID, workdir = ''): string {
  const links = skillInstallLinks(workdir, skillId);
  return (links.find((link) => link.linked) || links.find((link) => link.target) || links[0]).path;
}

function workdirFor(config: AppConfig): string {
  const entry = config.skills.registry.find((candidate) => candidate.id === SKILL_ID);
  if (!entry) return '';
  const raw = (entry.workdir || '').trim() || path.dirname(entry.path || '');
  if (!raw) return '';
  const expanded = raw === '~' ? os.homedir() : raw.startsWith('~/') ? path.join(os.homedir(), raw.slice(2)) : path.resolve(raw);
  return expanded;
}

async function git(cwd: string, args: string[]): Promise<{ ok: boolean; out: string; err: string }> {
  const result = await runCommand('git', ['-C', cwd, ...args], { timeoutMs: GIT_TIMEOUT_MS });
  return { ok: result.ok, out: (result.stdout || '').trim(), err: (result.stderr || '').trim() };
}

/** Local-only: never touches the network, so the console can render it on every load. */
export async function readSkillRepoState(config: AppConfig): Promise<SkillRepoState> {
  const workdir = workdirFor(config);
  const installs = skillInstallLinks(workdir);
  const primary = installs.find((link) => link.linked) || installs.find((link) => link.target) || installs[0];
  const state: SkillRepoState = {
    skillId: SKILL_ID,
    workdir,
    installs,
    installPath: primary.path,
    installTarget: primary.target,
    available: Boolean(workdir) && fs.existsSync(workdir),
    isGitRepo: false,
    branch: '',
    commit: '',
    subject: '',
    committedAt: '',
    dirty: [],
    behind: -1,
    blocked: '',
  };
  if (!workdir) {
    state.blocked = '没有配置 weekly-review skill（config.yaml 的 skills.registry 里没有这一项）。';
    return state;
  }
  if (!state.available) {
    state.blocked = `skill workdir 不存在：${workdir}`;
    return state;
  }
  if (!(await git(workdir, ['rev-parse', '--git-dir'])).ok) {
    state.blocked = `${workdir} 不是一个 git 仓库，没法用 git pull 更新。`;
    return state;
  }
  state.isGitRepo = true;
  state.branch = (await git(workdir, ['rev-parse', '--abbrev-ref', 'HEAD'])).out;
  state.commit = (await git(workdir, ['rev-parse', '--short', 'HEAD'])).out;
  state.subject = (await git(workdir, ['log', '-1', '--format=%s'])).out;
  state.committedAt = (await git(workdir, ['log', '-1', '--format=%cI'])).out;

  // `diff --name-only HEAD` rather than `status --porcelain`: it lists tracked
  // files that differ from HEAD, staged or not, as bare paths. Porcelain's
  // fixed-width `XY ` prefix has to be sliced off, and the leading space of an
  // unstaged change does not survive trimming the command's output — which ate
  // the first character of every such path.
  //
  // Untracked files are excluded either way, and that is deliberate:
  // life-review-os keeps a real, gitignored config.yaml in its working tree,
  // and counting it would block updates forever.
  const status = await git(workdir, ['diff', '--name-only', 'HEAD']);
  state.dirty = status.out ? status.out.split('\n').map((line) => line.trim()).filter(Boolean) : [];

  const behind = await git(workdir, ['rev-list', '--count', 'HEAD..@{upstream}']);
  state.behind = behind.ok && /^\d+$/.test(behind.out) ? Number(behind.out) : -1;

  if (state.dirty.length > 0) {
    state.blocked = `工作区有未提交的改动（${state.dirty.slice(0, 3).join('、')}${state.dirty.length > 3 ? ' 等' : ''}），先处理掉再更新。`;
  }
  return state;
}

/** Fetch and fast-forward. Never throws: every failure comes back as `ok: false`. */
export async function updateSkillRepo(config: AppConfig): Promise<SkillUpdateResult> {
  const fail = (message: string, before = ''): SkillUpdateResult => ({
    ok: false,
    changed: false,
    before,
    after: before,
    commits: [],
    message,
  });

  const state = await readSkillRepoState(config);
  if (!state.isGitRepo || state.blocked) return fail(state.blocked || '这个 skill 无法用 git 更新。');

  const workdir = state.workdir;
  const before = (await git(workdir, ['rev-parse', 'HEAD'])).out;

  const fetched = await git(workdir, ['fetch', '--prune', 'origin']);
  if (!fetched.ok) return fail(`git fetch 失败：${fetched.err || fetched.out || '未知错误'}`, before);

  const pulled = await git(workdir, ['pull', '--ff-only']);
  if (!pulled.ok) {
    // --ff-only refusing is the interesting case: it means the local branch has
    // commits the remote does not, which a button must not silently resolve.
    return fail(`git pull --ff-only 失败：${pulled.err || pulled.out || '未知错误'}`, before);
  }

  const after = (await git(workdir, ['rev-parse', 'HEAD'])).out;
  if (after === before) {
    return { ok: true, changed: false, before, after, commits: [], message: `已经是最新的（${state.branch} @ ${before.slice(0, 7)}）。` };
  }
  const log = await git(workdir, ['log', '--oneline', `${before}..${after}`]);
  const commits = log.out ? log.out.split('\n').filter(Boolean) : [];
  return {
    ok: true,
    changed: true,
    before,
    after,
    commits,
    message: `已更新 ${before.slice(0, 7)} → ${after.slice(0, 7)}，${commits.length} 个新提交。`,
  };
}
