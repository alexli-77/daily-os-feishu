import assert from 'node:assert/strict';
import { parseDailyOsCommand } from '../../src/interaction/daily-os-command.js';

// LEO-247 — write-back text commands, so the confirm step is reachable outside
// Feishu cards (web chat could run a biweekly review but never write it back).

const PREFIX = 'daily-os';

try {
  testFeishuWritebackShapes();
  testOkrWritebackShapes();
  testConfirmIsExplicit();
  testDoesNotHijackFreeformText();
  testPrefixStillRequired();
  console.log('writeback-command.test.ts: all tests passed');
} catch (error) {
  console.error(error);
  process.exit(1);
}

function parse(text: string) {
  return parseDailyOsCommand(`${PREFIX} ${text}`, PREFIX);
}

function testFeishuWritebackShapes(): void {
  for (const text of ['writeback', 'writeback preview', '写回', '写回预览']) {
    assert.deepEqual(parse(text), { type: 'writeback', target: 'feishu', confirm: false }, `preview shape: ${text}`);
  }
  for (const text of ['writeback confirm', '确认写回']) {
    assert.deepEqual(parse(text), { type: 'writeback', target: 'feishu', confirm: true }, `confirm shape: ${text}`);
  }
}

function testOkrWritebackShapes(): void {
  for (const text of ['okr writeback', 'okr 写回']) {
    assert.deepEqual(parse(text), { type: 'writeback', target: 'okr', confirm: false }, `okr preview: ${text}`);
  }
  for (const text of ['okr writeback confirm', '确认写回 okr', '确认写回okr']) {
    assert.deepEqual(parse(text), { type: 'writeback', target: 'okr', confirm: true }, `okr confirm: ${text}`);
  }
}

function testConfirmIsExplicit(): void {
  // A bare write-back must never default to writing.
  const bare = parse('writeback');
  assert.equal(bare.type === 'writeback' && bare.confirm, false, 'bare writeback is preview-only');
  const zh = parse('写回');
  assert.equal(zh.type === 'writeback' && zh.confirm, false, 'bare 写回 is preview-only');
}

function testDoesNotHijackFreeformText(): void {
  // Sentences that merely mention write-back must fall through to the agent,
  // otherwise a chat message could silently mutate an external document.
  for (const text of ['帮我把这段写回到文档里好吗', 'should I writeback the draft or not', '写回的逻辑是怎么实现的']) {
    assert.equal(parse(text).type, 'ignore', `must not trigger: ${text}`);
  }
}

function testPrefixStillRequired(): void {
  // Without the daily-os prefix nothing is a command at all.
  assert.equal(parseDailyOsCommand('确认写回', PREFIX).type, 'ignore');
  assert.equal(parseDailyOsCommand('writeback confirm', PREFIX).type, 'ignore');
}
