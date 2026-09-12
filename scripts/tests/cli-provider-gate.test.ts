/**
 * P0 regression — the CLI provider gate must test, not assume.
 *
 * Independent, tsx-runnable:  npx tsx scripts/tests/cli-provider-gate.test.ts
 *
 * ## The incident (P0, 2026-09-11)
 *
 * daily-os #199 reported `provider=claude` burning the full 180s timeout on
 * every scheduled run in the launchd background service. The investigation
 * concluded that *subscription CLIs* cannot work under launchd — a Keychain
 * prompt with no GUI to answer it — and the fix refused `claude` and `codex`
 * alike whenever `isHeadlessLaunchd()` was true.
 *
 * Both halves were wrong, and the second half was the damaging one.
 *
 * Measured on the reporting machine, in the service's own environment, minutes
 * apart:
 *
 *     codex exec "Reply with exactly: OK"   → OK in 10s
 *     claude -p   "Reply with exactly: OK"  → still running at 120s
 *
 * That machine's ledger held **77 successful launchd-scheduled runs, every one
 * on `provider=codex`**, and *zero* successful runs on `provider=claude` — it had
 * never worked there, not once. The blanket gate would have taken away the only
 * provider the user had, to protect them from a limitation it does not have.
 *
 * The named cause did not survive either: `--bare` documents that it skips
 * keychain reads and hangs identically, and so does a run with
 * `CLAUDE_CODE_OAUTH_TOKEN` set. Whatever blocks `claude -p` there is still
 * unidentified.
 *
 * ## What these tests hold down
 *
 * The lesson is not "codex is fine". It is that **a gate may not encode a theory
 * about why something is broken when it can just check.** Every case below is
 * one step of that: probe the CLI that is actually configured, believe the
 * result, cache it, and never generalise from one provider to the other.
 *
 * Everything runs against a stub `runCommand`; no CLI is spawned, no network.
 */
import assert from 'node:assert/strict';

import {
  assertCliProviderUsable,
  cliUnavailableMessage,
  isCliProvider,
  isHeadlessLaunchd,
  probeCliProvider,
  resetCliProbeCache,
} from '../../src/agent/runtime-env.js';
import type { CommandResult } from '../../src/utils/command.js';

type TestFn = () => void | Promise<void>;
const tests: Array<{ name: string; fn: TestFn }> = [];
function test(name: string, fn: TestFn): void {
  tests.push({ name, fn });
}

interface Call {
  command: string;
  args: string[];
  input?: string;
}

/** A stub `runCommand` that records what it was asked to run. */
function stub(result: Partial<CommandResult>): { run: typeof import('../../src/utils/command.js').runCommand; calls: Call[] } {
  const calls: Call[] = [];
  const run = (command: string, args: string[], options: { input?: string } = {}): Promise<CommandResult> => {
    calls.push({ command, args, input: options.input });
    return Promise.resolve({ ok: true, code: 0, stdout: 'OK', stderr: '', ...result });
  };
  return { run: run as never, calls };
}

const answers = () => stub({ ok: true, code: 0, stdout: 'OK' });
const hangs = () => stub({ ok: false, code: null, stdout: '', stderr: '', timedOut: true });

function withLaunchd(fn: () => Promise<void> | void): () => Promise<void> {
  return async () => {
    const previous = process.env.DAILY_OS_LAUNCHD;
    const skip = process.env.DAILY_OS_SKIP_CLI_PROBE;
    const override = process.env.DAILY_OS_ALLOW_CLI_UNDER_LAUNCHD;
    process.env.DAILY_OS_LAUNCHD = '1';
    delete process.env.DAILY_OS_SKIP_CLI_PROBE;
    delete process.env.DAILY_OS_ALLOW_CLI_UNDER_LAUNCHD;
    resetCliProbeCache();
    try {
      await fn();
    } finally {
      if (previous === undefined) delete process.env.DAILY_OS_LAUNCHD;
      else process.env.DAILY_OS_LAUNCHD = previous;
      if (skip !== undefined) process.env.DAILY_OS_SKIP_CLI_PROBE = skip;
      if (override !== undefined) process.env.DAILY_OS_ALLOW_CLI_UNDER_LAUNCHD = override;
      resetCliProbeCache();
    }
  };
}

const darwin = process.platform === 'darwin';

// --- the P0 case itself ------------------------------------------------------

test(
  'P0: a CLI that answers is NOT blocked under launchd — this is the codex regression',
  withLaunchd(async () => {
    if (!darwin) return;
    const codex = answers();
    await assertCliProviderUsable('codex', 'codex', codex.run);
    assert.equal(codex.calls.length, 1, 'the gate should have asked the CLI exactly once');
  }),
);

test(
  'P0: one provider hanging says nothing about the other',
  withLaunchd(async () => {
    if (!darwin) return;
    const claude = hangs();
    await assert.rejects(() => assertCliProviderUsable('claude', 'claude', claude.run));

    // Same process, same launchd environment, immediately after: codex must still
    // be allowed to run. Generalising from claude to codex is the whole incident.
    const codex = answers();
    await assertCliProviderUsable('codex', 'codex', codex.run);
  }),
);

test(
  'P0: the refusal must not claim every subscription CLI is unusable',
  withLaunchd(async () => {
    if (!darwin) return;
    const claude = hangs();
    const error = await assertCliProviderUsable('claude', 'claude', claude.run).then(
      () => null,
      (e: unknown) => (e instanceof Error ? e.message : String(e)),
    );
    assert.ok(error, 'a hanging CLI must be refused');
    // The old wording asserted the environment itself was unusable for every
    // subscription CLI. Denying that claim is fine and expected; making it is not.
    assert.ok(!/结构性地不支持/.test(error!), `message still calls the environment unusable: ${error}`);
    assert.ok(!/订阅版 CLI 会因为?无法弹出 Keychain/.test(error!), `message still asserts the unproven Keychain cause: ${error}`);
    assert.ok(/分别验证|另一个 CLI/.test(error!), 'the message should point at verifying the other provider');
    assert.ok(!/codex/.test(error!), 'a claude failure must not name codex as also broken');
  }),
);

// --- the gate's shape --------------------------------------------------------

test(
  'a hanging CLI is refused before the workflow runs, not after the full timeout',
  withLaunchd(async () => {
    if (!darwin) return;
    const claude = hangs();
    await assert.rejects(() => assertCliProviderUsable('claude', 'claude', claude.run), /没有响应/);
  }),
);

test(
  'API-key providers are never probed — there is no CLI to ask',
  withLaunchd(async () => {
    if (!darwin) return;
    for (const provider of ['anthropic', 'openai']) {
      const s = answers();
      await assertCliProviderUsable(provider, provider, s.run);
      assert.equal(s.calls.length, 0, `${provider} should not spawn anything`);
    }
  }),
);

test('outside launchd nothing is probed: the CLIs work in a terminal', async () => {
  const previous = process.env.DAILY_OS_LAUNCHD;
  const xpc = process.env.XPC_SERVICE_NAME;
  delete process.env.DAILY_OS_LAUNCHD;
  delete process.env.XPC_SERVICE_NAME;
  resetCliProbeCache();
  try {
    const s = answers();
    await assertCliProviderUsable('claude', 'claude', s.run);
    assert.equal(s.calls.length, 0, 'a terminal run should not pay for a probe');
  } finally {
    if (previous !== undefined) process.env.DAILY_OS_LAUNCHD = previous;
    if (xpc !== undefined) process.env.XPC_SERVICE_NAME = xpc;
    resetCliProbeCache();
  }
});

test(
  'the probe runs once per provider and the verdict is reused',
  withLaunchd(async () => {
    if (!darwin) return;
    const s = answers();
    await assertCliProviderUsable('codex', 'codex', s.run);
    await assertCliProviderUsable('codex', 'codex', s.run);
    await assertCliProviderUsable('codex', 'codex', s.run);
    assert.equal(s.calls.length, 1, 'the CLI should be asked once, not once per workflow');
  }),
);

test(
  'the probe judges the binary the agent will actually run',
  withLaunchd(async () => {
    if (!darwin) return;
    const s = answers();
    await assertCliProviderUsable('claude', '/custom/path/claude', s.run);
    assert.equal(s.calls[0]?.command, '/custom/path/claude');
  }),
);

test(
  'each CLI is probed with its own invocation shape',
  withLaunchd(async () => {
    if (!darwin) return;
    const c = answers();
    await probeCliProvider('claude', 'claude', c.run);
    assert.ok(c.calls[0]?.args.includes('-p'), 'claude is prompted with -p');

    const x = answers();
    await probeCliProvider('codex', 'codex', x.run);
    assert.ok(x.calls[0]?.args.includes('exec'), 'codex is prompted with exec');
  }),
);

test(
  'a CLI that answers with an error still counts as answering',
  withLaunchd(async () => {
    if (!darwin) return;
    // A bad model name or an expired login is the real run's error to report, in
    // its own words. The probe only gets to decide "does this thing come back".
    const s = stub({ ok: false, code: 1, stdout: '', stderr: 'unknown model' });
    await assertCliProviderUsable('codex', 'codex', s.run);
  }),
);

test(
  'DAILY_OS_SKIP_CLI_PROBE=1 skips the probe entirely',
  withLaunchd(async () => {
    if (!darwin) return;
    process.env.DAILY_OS_SKIP_CLI_PROBE = '1';
    const s = hangs();
    await assertCliProviderUsable('claude', 'claude', s.run);
    assert.equal(s.calls.length, 0);
  }),
);

test(
  'the pre-#201 override keeps working for anyone who already set it',
  withLaunchd(async () => {
    if (!darwin) return;
    process.env.DAILY_OS_ALLOW_CLI_UNDER_LAUNCHD = '1';
    const s = hangs();
    await assertCliProviderUsable('claude', 'claude', s.run);
    assert.equal(s.calls.length, 0);
  }),
);

// --- helpers -----------------------------------------------------------------

test('isCliProvider covers the two subscription CLIs and nothing else', () => {
  assert.equal(isCliProvider('claude'), true);
  assert.equal(isCliProvider('codex'), true);
  assert.equal(isCliProvider('anthropic'), false);
  assert.equal(isCliProvider('openai'), false);
});

test('launchd detection stays macOS-only', () => {
  if (darwin) return;
  assert.equal(isHeadlessLaunchd(), false);
});

test('the unavailable message names the provider, the binary and a repro', () => {
  const message = cliUnavailableMessage('claude', '/opt/homebrew/bin/claude', {
    ok: false,
    hung: true,
    elapsedMs: 25_000,
    reason: '没有任何返回',
  });
  assert.ok(message.includes('claude'));
  assert.ok(message.includes('/opt/homebrew/bin/claude'));
  assert.ok(message.includes('手动复现'), 'an operator should be able to reproduce it by hand');
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
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

void run();
