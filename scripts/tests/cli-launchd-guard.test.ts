import assert from 'node:assert/strict';
import { loadConfig } from '../../src/config/load-config.js';
import { runDoctor } from '../../src/cli/doctor.js';
import { runAgent } from '../../src/agent/index.js';
import {
  cliUnderLaunchdMessage,
  cliUnderLaunchdOverridden,
  describeAgentTimeout,
  isCliProvider,
  isHeadlessLaunchd,
} from '../../src/agent/runtime-env.js';

// daily-os #199: a subscription CLI (claude/codex) under launchd connects but
// never returns. The fix must (a) refuse that combination up front with a clear
// reminder instead of hanging, and (b) name the provider/model/prompt in the
// timeout message rather than emitting a bare "[timeout] killed after 180000ms".

// --- pure helpers (platform-independent) ------------------------------------
assert.equal(isCliProvider('claude'), true);
assert.equal(isCliProvider('codex'), true);
assert.equal(isCliProvider('anthropic'), false);
assert.equal(isCliProvider('openai'), false);

const reminder = cliUnderLaunchdMessage('claude');
assert.match(reminder, /#199/, 'reminder cites the issue');
assert.match(reminder, /anthropic|openai/, 'reminder points at an API-key provider');
assert.match(reminder, /DAILY_OS_ALLOW_CLI_UNDER_LAUNCHD/, 'reminder documents the escape hatch');

const timeoutMsg = describeAgentTimeout('anthropic', 'claude-sonnet-5', 12345, 6000, 600000);
assert.match(timeoutMsg, /anthropic/, 'timeout names the provider');
assert.match(timeoutMsg, /claude-sonnet-5/, 'timeout names the model');
assert.match(timeoutMsg, /12345/, 'timeout names the prompt size');
assert.match(timeoutMsg, /llm\.timeout_ms/, 'timeout tells the user which knob to raise');

// --- the guard (macOS launchd only) -----------------------------------------
const savedLaunchd = process.env.DAILY_OS_LAUNCHD;
const savedOverride = process.env.DAILY_OS_ALLOW_CLI_UNDER_LAUNCHD;
try {
  process.env.DAILY_OS_LAUNCHD = '1';
  delete process.env.DAILY_OS_ALLOW_CLI_UNDER_LAUNCHD;

  if (process.platform === 'darwin') {
    assert.equal(isHeadlessLaunchd(), true, 'DAILY_OS_LAUNCHD=1 is detected as headless launchd');

    // provider=claude under launchd must throw the reminder — and must not hang.
    await assert.rejects(
      () => runAgent({ config: { llm: { provider: 'claude' } } } as never),
      /#199/,
      'claude under launchd fails fast with the reminder',
    );

    // The escape hatch is honoured (deterministic — spawning the real CLI here
    // would be flaky, and its timeout message also cites #199).
    assert.equal(cliUnderLaunchdOverridden(), false, 'override defaults off');
    process.env.DAILY_OS_ALLOW_CLI_UNDER_LAUNCHD = '1';
    assert.equal(cliUnderLaunchdOverridden(), true, 'override is read from the env var');
    delete process.env.DAILY_OS_ALLOW_CLI_UNDER_LAUNCHD;

    // doctor surfaces the launchd+CLI combo as a warning, not a login failure.
    const config = loadConfig('config/config.example.yaml');
    config.llm.provider = 'claude';
    const checks = await runDoctor(config);
    const warn = checks.find((c) => /under launchd/.test(c.name));
    assert.ok(warn, 'doctor adds a launchd warning check');
    assert.equal(warn!.level, 'warning');
    assert.match(String(warn!.detail), /#199|API-key|Keychain/);
  } else {
    // Off macOS the guard is a no-op by design; just prove detection is disabled.
    assert.equal(isHeadlessLaunchd(), false, 'launchd detection is macOS-only');
  }

  console.log('cli-launchd-guard.test.ts: all tests passed');
} finally {
  if (savedLaunchd === undefined) delete process.env.DAILY_OS_LAUNCHD;
  else process.env.DAILY_OS_LAUNCHD = savedLaunchd;
  if (savedOverride === undefined) delete process.env.DAILY_OS_ALLOW_CLI_UNDER_LAUNCHD;
  else process.env.DAILY_OS_ALLOW_CLI_UNDER_LAUNCHD = savedOverride;
}
