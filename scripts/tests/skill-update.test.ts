/**
 * Updating the weekly-review skill from the console.
 *
 * Independent, tsx-runnable:  npx tsx scripts/tests/skill-update.test.ts
 *
 * The skill is not a copied bundle: `~/.claude/skills/weekly-review` is a
 * symlink to the life-review-os checkout, which is also the workdir this app
 * shells into. So the update is a `git pull` on one directory, and the risks
 * are git's, not packaging's — a diverged branch, a dirty working tree, a
 * directory that is not a repo at all.
 *
 * Everything runs against throwaway repos with a local bare "origin"; no
 * network, no real config, and the real skill checkout is never touched.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

import { AppConfigSchema, type AppConfig } from '../../src/config/schema.js';
import { readSkillRepoState, updateSkillRepo } from '../../src/skills/update.js';
import { runCommand } from '../../src/utils/command.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

type TestFn = () => void | Promise<void>;
const tests: Array<{ name: string; fn: TestFn }> = [];
function test(name: string, fn: TestFn): void {
  tests.push({ name, fn });
}

const CREATED: string[] = [];

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await runCommand('git', ['-C', cwd, ...args], {
    timeoutMs: 30000,
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
  });
  if (!result.ok) throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  return (result.stdout || '').trim();
}

function configFor(workdir: string): AppConfig {
  const parsed = yaml.load(fs.readFileSync(path.join(REPO_ROOT, 'config', 'config.example.yaml'), 'utf8')) as Record<string, any>;
  parsed.skills = parsed.skills || {};
  parsed.skills.enabled = true;
  parsed.skills.registry = [
    { id: 'weekly-review', provider: 'claude', path: path.join(workdir, 'SKILL.md'), workdir, effects: [], require_confirmation_for: [] },
  ];
  return AppConfigSchema.parse(parsed);
}

/** A clone with a real upstream, plus a helper to add commits to that upstream. */
async function repoWithOrigin(): Promise<{ workdir: string; pushCommit: (message: string) => Promise<void> }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-os-skillrepo-'));
  CREATED.push(root);
  const upstream = path.join(root, 'upstream');
  const seed = path.join(root, 'seed');
  const workdir = path.join(root, 'clone');

  fs.mkdirSync(upstream, { recursive: true });
  await git(upstream, ['init', '--bare', '--initial-branch=main', '.']);

  fs.mkdirSync(seed, { recursive: true });
  await git(seed, ['init', '--initial-branch=main', '.']);
  fs.writeFileSync(path.join(seed, 'SKILL.md'), '# skill v1\n', 'utf8');
  fs.writeFileSync(path.join(seed, '.gitignore'), 'config.yaml\n', 'utf8');
  await git(seed, ['add', '-A']);
  await git(seed, ['commit', '-m', 'seed']);
  await git(seed, ['remote', 'add', 'origin', upstream]);
  await git(seed, ['push', '-u', 'origin', 'main']);

  await git(root, ['clone', upstream, workdir]);

  return {
    workdir,
    pushCommit: async (message: string) => {
      fs.appendFileSync(path.join(seed, 'SKILL.md'), `${message}\n`, 'utf8');
      await git(seed, ['add', '-A']);
      await git(seed, ['commit', '-m', message]);
      await git(seed, ['push', 'origin', 'main']);
    },
  };
}

// --- reading state ------------------------------------------------------------

test('a healthy clone reports its branch, commit and subject', async () => {
  const { workdir } = await repoWithOrigin();
  const state = await readSkillRepoState(configFor(workdir));
  assert.equal(state.isGitRepo, true);
  assert.equal(state.branch, 'main');
  assert.equal(state.subject, 'seed');
  assert.match(state.commit, /^[0-9a-f]{7,}$/);
  assert.equal(state.blocked, '', 'a clean clone is updatable');
});

test('reading state never fetches, so "behind" reflects the last fetch only', async () => {
  const { workdir, pushCommit } = await repoWithOrigin();
  await pushCommit('v2');
  const state = await readSkillRepoState(configFor(workdir));
  assert.equal(state.behind, 0, 'an un-fetched remote commit must not appear as "behind"');
});

test('after a fetch the pending commits are counted', async () => {
  const { workdir, pushCommit } = await repoWithOrigin();
  await pushCommit('v2');
  await pushCommit('v3');
  await git(workdir, ['fetch', 'origin']);
  assert.equal((await readSkillRepoState(configFor(workdir))).behind, 2);
});

test('an untracked file does not block the update', async () => {
  const { workdir } = await repoWithOrigin();
  // life-review-os keeps a real, gitignored config.yaml in its root.
  fs.writeFileSync(path.join(workdir, 'config.yaml'), 'doc: xxx\n', 'utf8');
  fs.writeFileSync(path.join(workdir, 'scratch.txt'), 'notes\n', 'utf8');
  const state = await readSkillRepoState(configFor(workdir));
  assert.deepEqual(state.dirty, []);
  assert.equal(state.blocked, '');
});

test('a modified tracked file blocks the update and is named', async () => {
  const { workdir } = await repoWithOrigin();
  fs.writeFileSync(path.join(workdir, 'SKILL.md'), '# locally edited\n', 'utf8');
  const state = await readSkillRepoState(configFor(workdir));
  assert.deepEqual(state.dirty, ['SKILL.md']);
  assert.match(state.blocked, /未提交的改动/);
  assert.match(state.blocked, /SKILL\.md/);
});

test('a workdir that is not a git repo says so instead of failing later', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-os-nongit-'));
  CREATED.push(dir);
  const state = await readSkillRepoState(configFor(dir));
  assert.equal(state.isGitRepo, false);
  assert.match(state.blocked, /不是一个 git 仓库/);
});

test('a missing workdir is reported, not thrown', async () => {
  const state = await readSkillRepoState(configFor(path.join(os.tmpdir(), 'daily-os-does-not-exist-xyz')));
  assert.equal(state.available, false);
  assert.match(state.blocked, /不存在/);
});

// --- updating -----------------------------------------------------------------

test('an update fast-forwards and lists what came in', async () => {
  const { workdir, pushCommit } = await repoWithOrigin();
  await pushCommit('v2');
  await pushCommit('v3');

  const result = await updateSkillRepo(configFor(workdir));
  assert.equal(result.ok, true, result.message);
  assert.equal(result.changed, true);
  assert.equal(result.commits.length, 2, result.commits.join(' | '));
  assert.match(result.commits.join('\n'), /v3/);
  assert.equal(fs.readFileSync(path.join(workdir, 'SKILL.md'), 'utf8').includes('v3'), true, 'the file on disk actually moved');
});

test('an already-current repo succeeds and says nothing changed', async () => {
  const { workdir } = await repoWithOrigin();
  const result = await updateSkillRepo(configFor(workdir));
  assert.equal(result.ok, true, result.message);
  assert.equal(result.changed, false);
  assert.equal(result.before, result.after);
  assert.match(result.message, /已经是最新/);
});

test('a diverged branch is refused rather than merged', async () => {
  const { workdir, pushCommit } = await repoWithOrigin();
  await pushCommit('remote-side');
  fs.writeFileSync(path.join(workdir, 'SKILL.md'), '# local divergence\n', 'utf8');
  await git(workdir, ['commit', '-am', 'local-side']);

  const result = await updateSkillRepo(configFor(workdir));
  assert.equal(result.ok, false, 'a button must not resolve a divergence on its own');
  assert.match(result.message, /ff-only/);
  assert.equal((await git(workdir, ['log', '-1', '--format=%s'])), 'local-side', 'local history is untouched');
});

test('a dirty tracked file is refused before anything is fetched', async () => {
  const { workdir, pushCommit } = await repoWithOrigin();
  await pushCommit('v2');
  fs.writeFileSync(path.join(workdir, 'SKILL.md'), '# uncommitted work\n', 'utf8');

  const result = await updateSkillRepo(configFor(workdir));
  assert.equal(result.ok, false);
  assert.match(result.message, /未提交的改动/);
  assert.equal(fs.readFileSync(path.join(workdir, 'SKILL.md'), 'utf8'), '# uncommitted work\n', 'the edit survives');
});

test('updating a non-repo fails cleanly', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-os-nongit2-'));
  CREATED.push(dir);
  const result = await updateSkillRepo(configFor(dir));
  assert.equal(result.ok, false);
  assert.equal(result.commits.length, 0);
});

// --- where the CLI looks for the skill ----------------------------------------

/** Run `fn` with `$HOME` pointed at a throwaway directory. */
async function withHome(fn: (home: string) => Promise<void>): Promise<void> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-os-skillhome-'));
  CREATED.push(home);
  const previous = process.env.HOME;
  process.env.HOME = home;
  try {
    await fn(home);
  } finally {
    if (previous === undefined) delete process.env.HOME;
    else process.env.HOME = previous;
  }
}

function linkSkill(home: string, cliHome: string, workdir: string): void {
  const dir = path.join(home, cliHome, 'skills');
  fs.mkdirSync(dir, { recursive: true });
  fs.symlinkSync(workdir, path.join(dir, 'weekly-review'));
}

test('both Claude and Codex skill directories are reported, not just Claude', async () => {
  await withHome(async (home) => {
    const { workdir } = await repoWithOrigin();
    const state = await readSkillRepoState(configFor(workdir));
    assert.deepEqual(state.installs.map((link) => link.cli), ['claude', 'codex']);
    assert.equal(state.installs[0].path, path.join(home, '.claude', 'skills', 'weekly-review'));
    assert.equal(state.installs[1].path, path.join(home, '.codex', 'skills', 'weekly-review'));
  });
});

test('a Codex-only install is recognised as linked', async () => {
  // Regression: the install path was hardcoded to ~/.claude, so a Codex user's
  // skill directory was never looked at and always reported as absent.
  await withHome(async (home) => {
    const { workdir } = await repoWithOrigin();
    linkSkill(home, '.codex', workdir);
    const state = await readSkillRepoState(configFor(workdir));
    const codex = state.installs.find((link) => link.cli === 'codex')!;
    const claude = state.installs.find((link) => link.cli === 'claude')!;
    assert.equal(codex.linked, true, 'the Codex entry resolves to the workdir');
    assert.equal(claude.linked, false, 'nothing is installed for Claude');
    assert.equal(claude.target, '', 'a missing directory reports no target');
    assert.equal(state.installPath, codex.path, 'the linked entry is the one surfaced');
    assert.equal(state.installTarget, fs.realpathSync(workdir));
  });
});

test('an entry that is a copy rather than a symlink is reported as not linked', async () => {
  // The case that motivated this: a copied skill directory means Update changes
  // nothing the CLI loads, and that has to be visible rather than silently fine.
  await withHome(async (home) => {
    const { workdir } = await repoWithOrigin();
    const copy = path.join(home, '.codex', 'skills', 'weekly-review');
    fs.mkdirSync(copy, { recursive: true });
    fs.writeFileSync(path.join(copy, 'SKILL.md'), '# a copy\n', 'utf8');
    const state = await readSkillRepoState(configFor(workdir));
    const codex = state.installs.find((link) => link.cli === 'codex')!;
    assert.equal(codex.target, fs.realpathSync(copy), 'the directory exists');
    assert.equal(codex.linked, false, 'but it is not the checkout being updated');
    assert.equal(state.blocked, '', 'an unlinked copy does not block the git update itself');
  });
});

test('with nothing installed anywhere, state still reports a usable default path', async () => {
  await withHome(async (home) => {
    const { workdir } = await repoWithOrigin();
    const state = await readSkillRepoState(configFor(workdir));
    assert.ok(state.installs.every((link) => !link.linked && link.target === ''));
    assert.equal(state.installPath, path.join(home, '.claude', 'skills', 'weekly-review'));
    assert.equal(state.installTarget, '');
  });
});

async function run(): Promise<void> {
  let passed = 0;
  let failed = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      passed += 1;
      console.log(`  ✓ ${name}`);
    } catch (error) {
      failed += 1;
      console.error(`  ✗ ${name}`);
      console.error(`    ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  for (const dir of CREATED) fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

void run();
