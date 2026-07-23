import assert from 'node:assert/strict';
import {
  apiKeyEnvVar,
  buildFeishuEnvPatch,
  defaultModelFor,
  parseEnv,
  updateLlmInYaml,
  upsertEnv,
} from '../../src/cli/setup-wizard.js';

// LEO-235 — pure logic behind the first-run onboarding wizard. The interactive
// readline layer is intentionally not exercised here; these cover the file
// edits and provider mapping the wizard applies.

try {
  testProviderMapping();
  testUpdateLlmScopedToBlock();
  testUpdateLlmPreservesCommentsAndOtherKeys();
  testUpdateLlmThrowsWhenBlockMissing();
  testEnvUpsertIsInPlaceAndIdempotent();
  testFeishuPatchDropsBlanks();
  console.log('setup-wizard.test.ts: all tests passed');
} catch (error) {
  console.error(error);
  process.exit(1);
}

function testProviderMapping(): void {
  assert.equal(apiKeyEnvVar('anthropic'), 'ANTHROPIC_API_KEY');
  assert.equal(apiKeyEnvVar('openai'), 'OPENAI_API_KEY');
  // anthropic keeps the symbolic 'default' (agent maps it to claude-sonnet-5);
  // openai needs a concrete id because the string is sent to the API verbatim.
  assert.equal(defaultModelFor('anthropic'), 'default');
  assert.notEqual(defaultModelFor('openai'), 'default');
  assert.ok(defaultModelFor('openai').length > 0);
}

function testUpdateLlmScopedToBlock(): void {
  const yamlText = [
    'llm:',
    '  provider: "codex" # codex | openai | claude | anthropic',
    '  model: "default" # comment',
    '',
    'output:',
    '  feishu:',
    '    provider: "auto"',
    '',
  ].join('\n');
  const next = updateLlmInYaml(yamlText, 'anthropic', 'default');
  assert.match(next, /^  provider: "anthropic" # codex \| openai \| claude \| anthropic$/m);
  assert.match(next, /^  model: "default" # comment$/m);
  // The unrelated output.feishu.provider must be untouched.
  assert.match(next, /^    provider: "auto"$/m);
}

function testUpdateLlmPreservesCommentsAndOtherKeys(): void {
  const yamlText = [
    'assistant:',
    '  name: "daily-os-feishu"',
    'llm:',
    '  # 程序化调度请使用 API-key provider。',
    '  provider: "codex" # codex | openai | claude | anthropic',
    '  model: "default"',
    'billing:',
    '  per_task_usd: 2',
    '',
  ].join('\n');
  const next = updateLlmInYaml(yamlText, 'openai', 'gpt-4o');
  assert.match(next, /# 程序化调度请使用 API-key provider。/);
  assert.match(next, /^  provider: "openai"/m);
  assert.match(next, /^  model: "gpt-4o"$/m);
  assert.match(next, /^  per_task_usd: 2$/m, 'billing block untouched');
  assert.match(next, /^  name: "daily-os-feishu"$/m, 'assistant block untouched');
}

function testUpdateLlmThrowsWhenBlockMissing(): void {
  assert.throws(() => updateLlmInYaml('output:\n  feishu:\n    enabled: true\n', 'openai', 'gpt-4o'), /llm:/);
}

function testEnvUpsertIsInPlaceAndIdempotent(): void {
  const original = ['# comment', 'OPENAI_API_KEY=', 'LARK_APP_ID=old', ''].join('\n');
  const once = upsertEnv(original, { OPENAI_API_KEY: 'sk-123', ANTHROPIC_API_KEY: 'sk-ant' });
  const parsed = parseEnv(once);
  assert.equal(parsed.OPENAI_API_KEY, 'sk-123', 'existing key rewritten in place');
  assert.equal(parsed.LARK_APP_ID, 'old', 'untouched key preserved');
  assert.equal(parsed.ANTHROPIC_API_KEY, 'sk-ant', 'new key appended');
  assert.match(once, /^# comment$/m, 'comment preserved');
  // Rewriting the OPENAI key again must not duplicate the line.
  const twice = upsertEnv(once, { OPENAI_API_KEY: 'sk-999' });
  assert.equal((twice.match(/^OPENAI_API_KEY=/gm) || []).length, 1, 'no duplicate lines');
  assert.equal(parseEnv(twice).OPENAI_API_KEY, 'sk-999');
}

function testFeishuPatchDropsBlanks(): void {
  const patch = buildFeishuEnvPatch({ larkAppId: '  cli_abc ', larkAppSecret: '', feishuChatId: 'oc_1' });
  assert.deepEqual(patch, { LARK_APP_ID: 'cli_abc', FEISHU_CHAT_ID: 'oc_1' });
  assert.equal('LARK_APP_SECRET' in patch, false, 'blank secret is not written');
}
