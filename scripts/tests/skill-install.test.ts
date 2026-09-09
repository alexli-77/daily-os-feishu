import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installSkillRepo, type SkillCommandRunner } from '../../src/skills/update.js';

// LEO-287: install (git clone) flow, driven by an injected runner so no real
// network/git is touched. Covers the four actionable outcomes the issue lists.

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-install-'));

try {
  await testGitMissing();
  await testTargetNonEmpty();
  await testCloneFailure();
  await testSuccessSeedsConfigAndRegisters();
  console.log('skill-install.test.ts: all tests passed');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

async function testGitMissing(): Promise<void> {
  const run: SkillCommandRunner = async (_cmd, args) =>
    args[0] === '--version' ? { ok: false, stdout: '', stderr: 'command not found' } : { ok: true, stdout: '', stderr: '' };
  const r = await installSkillRepo(path.join(tmp, 'gitmissing'), { run });
  assert.equal(r.ok, false, 'git missing fails');
  assert.match(r.message, /git 不可用/);
}

async function testTargetNonEmpty(): Promise<void> {
  const dir = path.join(tmp, 'nonempty');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'keep.txt'), 'existing');
  const run: SkillCommandRunner = async () => ({ ok: true, stdout: '', stderr: '' });
  const r = await installSkillRepo(dir, { run });
  assert.equal(r.ok, false, 'non-empty target refused');
  assert.match(r.message, /已存在且非空/);
  assert.ok(fs.existsSync(path.join(dir, 'keep.txt')), 'existing content untouched');
}

async function testCloneFailure(): Promise<void> {
  const dir = path.join(tmp, 'clonefail');
  const run: SkillCommandRunner = async (_cmd, args) => {
    if (args[0] === '--version') return { ok: true, stdout: 'git version 2.x', stderr: '' };
    if (args[0] === 'clone') return { ok: false, stdout: '', stderr: 'fatal: repository not found' };
    return { ok: true, stdout: '', stderr: '' };
  };
  const r = await installSkillRepo(dir, { run });
  assert.equal(r.ok, false, 'clone failure surfaces');
  assert.match(r.message, /git clone 失败/);
}

async function testSuccessSeedsConfigAndRegisters(): Promise<void> {
  const dir = path.join(tmp, 'ok');
  const run: SkillCommandRunner = async (_cmd, args) => {
    if (args[0] === '--version') return { ok: true, stdout: 'git version 2.x', stderr: '' };
    if (args[0] === 'clone') {
      const target = args[args.length - 1]!;
      fs.mkdirSync(target, { recursive: true });
      fs.writeFileSync(path.join(target, 'config.example.yaml'), 'user:\n  name: you\n');
      fs.writeFileSync(path.join(target, 'SKILL.md'), '# weekly-review');
      return { ok: true, stdout: '', stderr: '' };
    }
    return { ok: true, stdout: '', stderr: '' };
  };
  const r = await installSkillRepo(dir, { run });
  assert.equal(r.ok, true, r.message);
  assert.ok(fs.existsSync(path.join(dir, 'config.yaml')), 'config.yaml seeded from example');
  assert.equal(fs.readFileSync(path.join(dir, 'config.yaml'), 'utf8'), 'user:\n  name: you\n', 'seed copied verbatim');
  assert.ok(r.registered, 'returns a registry entry');
  assert.equal(r.registered!.path, path.join(dir, 'SKILL.md'), 'registry path points at SKILL.md');
  assert.equal(r.registered!.workdir, dir, 'registry workdir is the checkout');
  assert.match(r.message, /填入飞书文档 token/);
}
