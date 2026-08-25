/**
 * Console-editable review strategy files.
 *
 * Independent, tsx-runnable:  npx tsx scripts/tests/review-strategy.test.ts
 *
 * The biweekly plan rules live in three files across two repos. This locks down
 * that the console lists all three, writes to the right place (including the
 * life-review-os repo outside this checkout), refuses ids outside the allowlist,
 * and that an emptied strategy file degrades to the built-in rules rather than
 * shipping an input pack with no plan rules at all.
 *
 * Runs entirely inside a temp workspace: no real config, prompt, or skill file
 * is read or written.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

let passed = 0;
let failed = 0;
function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function cookieFrom(setCookie: string | null): string {
  return setCookie ? setCookie.split(';')[0] : '';
}

/** A stand-in for the life-review-os checkout the console reaches across into. */
function seedSkillRepo(root: string): string {
  const repo = path.join(root, 'life-review-os');
  fs.mkdirSync(path.join(repo, 'engine'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'modes'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'engine', '03-plan.md'), '# Engine 03\n规则 3.5：默认逐字照搬。\n');
  fs.writeFileSync(path.join(repo, 'modes', 'biweekly.md'), '# 模式：biweekly\n');
  return repo;
}

function writeConfig(root: string, skillWorkdir: string): void {
  const parsed = yaml.load(fs.readFileSync(path.join(REPO_ROOT, 'config', 'config.example.yaml'), 'utf8')) as Record<string, any>;
  parsed.skills.enabled = true;
  parsed.skills.registry[0].workdir = skillWorkdir;
  parsed.skills.registry[0].path = path.join(skillWorkdir, 'SKILL.md');
  fs.mkdirSync(path.join(root, 'config'), { recursive: true });
  fs.writeFileSync(path.join(root, 'config', 'config.yaml'), yaml.dump(parsed), 'utf8');
}

async function main(): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-os-strategy-test-'));
  const skillRepo = seedSkillRepo(tmp);
  writeConfig(tmp, skillRepo);
  fs.writeFileSync(path.join(tmp, '.env'), '');

  const originalCwd = process.cwd();
  process.chdir(tmp);

  const auth = await import('../../src/ui/auth.js');
  const { startUiServer } = await import('../../src/ui/server.js');
  const { readBiweeklyStrategy, defaultBiweeklyStrategy } = await import('../../src/skills/runner.js');

  auth.resetSessionCacheForTests();
  auth.addUser('admin', 'admin-password-1', 'admin');
  auth.addUser('member', 'member-password-1', 'member');

  const controls = await startUiServer({ configPath: 'config/config.yaml', envPath: '.env', host: '127.0.0.1', port: 0, open: false });
  const base = controls.url;

  try {
    const login = await fetch(`${base}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin-password-1' }),
    });
    const cookie = cookieFrom(login.headers.get('set-cookie'));
    const authed = { cookie, 'content-type': 'application/json' };

    const stateResponse = await fetch(`${base}/api/state`, { headers: { cookie } });
    const state = (await stateResponse.json()) as any;
    const files = state?.strategy?.files || [];
    const ids = files.map((file: any) => file.id).join(',');
    check('state lists all three strategy files', ids === 'biweekly_strategy,plan_rules,biweekly_mode', ids);
    check('built-in default rules are exposed for reset', String(state?.strategy?.defaultStrategy || '').includes('计划条目规则'));

    const planRules = files.find((file: any) => file.id === 'plan_rules');
    check('plan_rules resolves into the life-review-os repo', planRules?.path === path.join(skillRepo, 'engine', '03-plan.md'), planRules?.path);
    check('plan_rules content is read from disk', String(planRules?.markdown || '').includes('默认逐字照搬'));

    const strategyFile = files.find((file: any) => file.id === 'biweekly_strategy');
    check('missing prompt file is reported, not fabricated', strategyFile?.exists === false && strategyFile?.markdown === '');

    // --- Write across the repo boundary -------------------------------------
    const edited = '# Engine 03\n规则 3.5：备注比条目新时必须改写。\n';
    const saved = await fetch(`${base}/api/strategy`, {
      method: 'POST',
      headers: authed,
      body: JSON.stringify({ id: 'plan_rules', markdown: edited }),
    });
    check('saving plan_rules -> 200', saved.status === 200, String(saved.status));
    check('plan_rules written to the skill repo', fs.readFileSync(path.join(skillRepo, 'engine', '03-plan.md'), 'utf8') === edited);

    const createdPath = path.join(tmp, 'prompts', 'biweekly_strategy.md');
    const created = await fetch(`${base}/api/strategy`, {
      method: 'POST',
      headers: authed,
      body: JSON.stringify({ id: 'biweekly_strategy', markdown: '计划条目规则（下双周要务）：\n- 自定义\n' }),
    });
    check('saving a not-yet-existing file creates it', created.status === 200 && fs.existsSync(createdPath));
    check('edited strategy is what the input pack reads', readBiweeklyStrategy().includes('自定义'));

    // --- Allowlist + auth ---------------------------------------------------
    const escape = await fetch(`${base}/api/strategy`, {
      method: 'POST',
      headers: authed,
      body: JSON.stringify({ id: '../../../etc/hosts', markdown: 'pwned' }),
    });
    const escapeBody = (await escape.json()) as any;
    check('unknown id is rejected by the allowlist', escape.status >= 400 || escapeBody?.ok === false, JSON.stringify(escapeBody).slice(0, 120));

    const memberLogin = await fetch(`${base}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'member', password: 'member-password-1' }),
    });
    const memberWrite = await fetch(`${base}/api/strategy`, {
      method: 'POST',
      headers: { cookie: cookieFrom(memberLogin.headers.get('set-cookie')), 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'biweekly_strategy', markdown: 'member edit' }),
    });
    check('member role cannot edit strategy -> 403', memberWrite.status === 403, String(memberWrite.status));

    // --- Fallback -----------------------------------------------------------
    fs.writeFileSync(createdPath, '   \n');
    check('blank strategy file falls back to built-in rules', readBiweeklyStrategy() === defaultBiweeklyStrategy());
    fs.rmSync(createdPath);
    check('deleted strategy file falls back to built-in rules', readBiweeklyStrategy() === defaultBiweeklyStrategy());

    // --- Degraded config ----------------------------------------------------
    writeConfig(tmp, path.join(tmp, 'does-not-exist'));
    const degraded = (await (await fetch(`${base}/api/state`, { headers: { cookie } })).json()) as any;
    const degradedIds = (degraded?.strategy?.files || []).map((file: any) => file.id).join(',');
    check('unreachable skill repo degrades to the local file only', degradedIds === 'biweekly_strategy', degradedIds);
  } finally {
    await controls.stop();
    process.chdir(originalCwd);
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

void main();
