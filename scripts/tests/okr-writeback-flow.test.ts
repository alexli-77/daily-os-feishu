import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { loadOkrFromDir } from '../../src/okr/loader.js';
import { AppConfigSchema, type AppConfig } from '../../src/config/schema.js';
import { decideFeishuControl, type FeishuAccessDecision } from '../../src/interaction/access-policy.js';
import {
  appendOkrProgressHistory,
  applyBiweeklyWriteback,
  matchBiweeklyProgress,
  parseBiweeklyProgress,
  renderKrIncrements,
} from '../../src/okr/biweekly-progress.js';
import { stripWritebackJsonBlock } from '../../src/skills/life-review-os.js';
import { buildOkrWritebackPreview } from '../../src/interaction/okr-writeback-card.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function exampleConfig(): AppConfig {
  const raw = yaml.load(fs.readFileSync(path.join(REPO_ROOT, 'config', 'config.example.yaml'), 'utf8'));
  return AppConfigSchema.parse(raw);
}

const QUARTERLY = `---
title: Current OKR
level: quarterly
cycle: 2026-Q3
parent: annual-okr
---

## Objective O1: Ship the alpha

Parent: A1

| KR ID | Description | Target | Current | Progress | Updated |
| --- | --- | --- | --- | --- | --- |
| O1-KR1 | Onboard pilot users | 20 | 5 | 25% | 2026-07-16 |
| O1-KR2 | Ship weekly release | 12 | 3 | 25% | 2026-07-16 |
`;

const cleanups: string[] = [];

function makeVault(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-os-okr-flow-'));
  cleanups.push(dir);
  const okrDir = path.join(dir, '10_OKR');
  fs.mkdirSync(okrDir, { recursive: true });
  fs.writeFileSync(path.join(okrDir, 'current-okr.md'), QUARTERLY);
  return okrDir;
}

try {
  testParseExtractsFencedContract();
  testParseDegradesOnGarbage();
  testMatchSkipsUnknownKr();
  testRenderIncrementsFormat();
  testWritebackUpdatesFileRowAndHistory();
  testHistoryAppendsAtomically();
  testRejectsOutOfBoundsAndNonNumericProgress();
  testDoubleConfirmIsIdempotentOnFile();
  testWritebackRequiresMemoryWritePermission();
  testLifeReviewOsCoexistingBlocksSurviveStrip();
  testLifeReviewOsKrProgressBeforeWritebackSurvives();
  testOldLifeReviewOsDraftDegradesSilently();
  console.log('okr-writeback-flow.test.ts: all tests passed');
} finally {
  for (const dir of cleanups) fs.rmSync(dir, { recursive: true, force: true });
}

function testParseExtractsFencedContract(): void {
  const draft = [
    '这是双周复盘叙述……',
    '',
    '```json',
    '{',
    '  "kr_progress": [',
    '    { "krId": "O1-KR2", "current": "6", "progress": "55", "evidence": "Linear 关闭 3 个", "confidence": "high" }',
    '  ],',
    '  "obstacles": ["招聘卡住"],',
    '  "next_priorities": ["先做 onboarding"]',
    '}',
    '```',
  ].join('\n');
  const parse = parseBiweeklyProgress(draft);
  assert.equal(parse.ok, true);
  assert.equal(parse.contract?.kr_progress.length, 1);
  assert.equal(parse.contract?.kr_progress[0]!.krId, 'O1-KR2');
  assert.equal(parse.contract?.kr_progress[0]!.confidence, 'high');
  assert.deepEqual(parse.contract?.obstacles, ['招聘卡住']);
  assert.deepEqual(parse.contract?.next_priorities, ['先做 onboarding']);
}

function testParseDegradesOnGarbage(): void {
  assert.equal(parseBiweeklyProgress('纯叙述，没有任何 JSON。').ok, false);
  assert.equal(parseBiweeklyProgress('').ok, false);
  // A JSON object without kr_progress must not be accepted.
  assert.equal(parseBiweeklyProgress('{"summary": "done"}').ok, false);
  // Broken JSON (trailing comma) degrades instead of throwing.
  assert.equal(parseBiweeklyProgress('{ "kr_progress": [ {krId:"O1-KR1"}, ] }').ok, false);
}

function testMatchSkipsUnknownKr(): void {
  const model = loadOkrFromDir(makeVault());
  const parse = parseBiweeklyProgress(
    '{ "kr_progress": [ { "krId": "O1-KR2", "current": "6", "progress": "55%" }, { "krId": "Z9-KR9", "current": "1", "progress": "80%" } ], "obstacles": [], "next_priorities": [] }',
  );
  assert.ok(parse.contract);
  const { matched, skipped } = matchBiweeklyProgress(model, parse.contract!);
  assert.equal(matched.length, 1);
  assert.equal(matched[0]!.krId, 'O1-KR2');
  assert.equal(matched[0]!.fromPct, 25);
  assert.equal(matched[0]!.toPct, 55);
  assert.equal(matched[0]!.deltaPct, 30);
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0]!.krId, 'Z9-KR9');
  assert.ok(skipped[0]!.reason.includes('not found'));
}

function testRenderIncrementsFormat(): void {
  const model = loadOkrFromDir(makeVault());
  const parse = parseBiweeklyProgress('{ "kr_progress": [ { "krId": "O1-KR2", "current": "6", "progress": "55" } ] }');
  const { matched } = matchBiweeklyProgress(model, parse.contract!);
  assert.deepEqual(renderKrIncrements(matched), ['O1-KR2: 25%→55% (+30)']);
}

function testWritebackUpdatesFileRowAndHistory(): void {
  const okrDir = makeVault();
  const historyPath = path.join(path.dirname(okrDir), 'history.jsonl');
  const parse = parseBiweeklyProgress(
    '{ "kr_progress": [ { "krId": "O1-KR2", "current": "6", "progress": "55" }, { "krId": "Z9-KR9", "current": "1", "progress": "80" } ] }',
  );
  const model = loadOkrFromDir(okrDir);
  const { matched } = matchBiweeklyProgress(model, parse.contract!);
  const outcome = applyBiweeklyWriteback({ okrDir, historyPath, matched, date: '2026-07-30' });
  assert.equal(outcome.succeeded, 1);
  assert.equal(outcome.failed, 0);
  assert.equal(outcome.historyAppended, 1);

  // The OKR file row is rewritten; the untouched row keeps its values.
  const reloaded = loadOkrFromDir(okrDir);
  const kr2 = reloaded.quarterly[0]!.keyResults.find((entry) => entry.id === 'O1-KR2')!;
  assert.equal(kr2.current, '6');
  assert.equal(kr2.progress, '55%');
  assert.equal(kr2.updated, '2026-07-30');
  assert.equal(kr2.description, 'Ship weekly release');
  const kr1 = reloaded.quarterly[0]!.keyResults.find((entry) => entry.id === 'O1-KR1')!;
  assert.equal(kr1.progressPct, 25, 'untouched KR unchanged');

  // History line records from -> to for the confirmed KR only.
  const lines = fs.readFileSync(historyPath, 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  const record = JSON.parse(lines[0]!);
  assert.equal(record.krId, 'O1-KR2');
  assert.equal(record.date, '2026-07-30');
  assert.equal(record.from, '25%');
  assert.equal(record.to, '55%');
}

function testHistoryAppendsAtomically(): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-os-okr-hist-'));
  cleanups.push(dir);
  const historyPath = path.join(dir, 'nested', 'okr-progress-history.jsonl');
  const first = appendOkrProgressHistory(historyPath, [{ krId: 'O1-KR1', date: '2026-07-30', from: '25%', to: '40%' }]);
  const second = appendOkrProgressHistory(historyPath, [{ krId: 'O1-KR2', date: '2026-08-13', from: '40%', to: '60%' }]);
  assert.equal(first, 1);
  assert.equal(second, 1);
  const lines = fs.readFileSync(historyPath, 'utf8').trim().split('\n');
  assert.equal(lines.length, 2, 'append does not overwrite prior lines');
  assert.equal(JSON.parse(lines[0]!).krId, 'O1-KR1');
  assert.equal(JSON.parse(lines[1]!).krId, 'O1-KR2');
  // No-op append returns 0 and leaves the file intact.
  assert.equal(appendOkrProgressHistory(historyPath, []), 0);
  assert.equal(fs.readFileSync(historyPath, 'utf8').trim().split('\n').length, 2);
}

// Adversarial: a hallucinated / out-of-range / non-numeric progress percent must
// never reach write-back. Each bad row is skipped with a reason; the OKR file is
// left untouched.
function testRejectsOutOfBoundsAndNonNumericProgress(): void {
  const okrDir = makeVault();
  const model = loadOkrFromDir(okrDir);
  const parse = parseBiweeklyProgress(
    '{ "kr_progress": [ { "krId": "O1-KR1", "current": "30", "progress": "150" }, { "krId": "O1-KR2", "current": "-1", "progress": "-5" } ] }',
  );
  const { matched, skipped } = matchBiweeklyProgress(model, parse.contract!);
  assert.equal(matched.length, 0, 'no out-of-range KR is ever matched');
  assert.equal(skipped.length, 2);
  assert.ok(skipped.every((entry) => /out of range/.test(entry.reason)), 'both rows skipped for range');

  const nonNumeric = parseBiweeklyProgress('{ "kr_progress": [ { "krId": "O1-KR1", "current": "x", "progress": "abc" } ] }');
  const result = matchBiweeklyProgress(model, nonNumeric.contract!);
  assert.equal(result.matched.length, 0);
  assert.equal(result.skipped.length, 1);
  assert.match(result.skipped[0]!.reason, /not a numeric percent/);

  // Boundary values 0 and 100 remain valid.
  const boundary = parseBiweeklyProgress('{ "kr_progress": [ { "krId": "O1-KR1", "current": "0", "progress": "0" }, { "krId": "O1-KR2", "current": "12", "progress": "100" } ] }');
  assert.equal(matchBiweeklyProgress(model, boundary.contract!).matched.length, 2, '0% and 100% are in range');

  // Nothing was written: the file still reads the original 25% for both rows.
  const reloaded = loadOkrFromDir(okrDir);
  for (const id of ['O1-KR1', 'O1-KR2']) {
    const kr = reloaded.quarterly[0]!.keyResults.find((entry) => entry.id === id)!;
    assert.equal(kr.progressPct, 25, `${id} untouched by rejected write-back`);
  }
}

// Adversarial: confirming the same draft twice (double-click / re-delivered
// callback) must not corrupt the OKR file. The second apply re-reads the now-55%
// row, computes a 0-delta, and writes the same value back — the file stays 55%.
function testDoubleConfirmIsIdempotentOnFile(): void {
  const okrDir = makeVault();
  const historyPath = path.join(path.dirname(okrDir), 'idempotent-history.jsonl');
  const draft = '{ "kr_progress": [ { "krId": "O1-KR2", "current": "6", "progress": "55" } ] }';

  const first = applyBiweeklyWriteback({
    okrDir,
    historyPath,
    matched: matchBiweeklyProgress(loadOkrFromDir(okrDir), parseBiweeklyProgress(draft).contract!).matched,
    date: '2026-07-30',
  });
  assert.equal(first.succeeded, 1);

  // Re-derive from the *current* file state (mirrors executeConfirmedOkrWriteback)
  // and apply again — the file value must be identical, never doubled/garbled.
  const second = applyBiweeklyWriteback({
    okrDir,
    historyPath,
    matched: matchBiweeklyProgress(loadOkrFromDir(okrDir), parseBiweeklyProgress(draft).contract!).matched,
    date: '2026-07-31',
  });
  assert.equal(second.succeeded, 1);

  const reloaded = loadOkrFromDir(okrDir);
  const kr2 = reloaded.quarterly[0]!.keyResults.find((entry) => entry.id === 'O1-KR2')!;
  assert.equal(kr2.current, '6', 'current not doubled by a second confirm');
  assert.equal(kr2.progress, '55%', 'progress stays 55% after a repeat confirm');
  const kr1 = reloaded.quarterly[0]!.keyResults.find((entry) => entry.id === 'O1-KR1')!;
  assert.equal(kr1.progressPct, 25, 'unrelated KR remains untouched across repeats');
}

// Adversarial: the OKR write-back button is gated by memory_write. A group
// member (allowed_chat) or a non-allowlisted sender must be rejected; only
// owner/admin/allowed_user may write.
function testWritebackRequiresMemoryWritePermission(): void {
  const config = exampleConfig();
  const control = (role: FeishuAccessDecision['role'], ok: boolean) =>
    decideFeishuControl(config, { ok, role }, { effect: 'memory_write' });

  assert.equal(control('denied', false).ok, false, 'a non-allowlisted member cannot write OKR');
  assert.equal(control('allowed_chat', true).ok, false, 'a group member (allowed_chat) cannot durably write');
  for (const role of ['owner', 'admin', 'allowed_user'] as const) {
    const decision = control(role, true);
    assert.equal(decision.ok, true, `${role} may write OKR progress`);
    assert.equal(decision.requiresConfirmation, true, `${role} write still requires confirmation`);
  }
}

// Wiring guard (LEO-109 close-out, re-verified 2026-07-20): the Feishu biweekly
// path runs through the life-review-os skill, whose draft now carries TWO fenced
// JSON blocks — the Feishu `writeback_plan`/`retro_review` block AND the new
// local-OKR `kr_progress` block. The bridge's `stripWritebackJsonBlock` must
// remove only the writeback_plan block and leave `kr_progress` intact so the OKR
// write-back card can fire. This exercises the real bridge cleaner + parser.
function testLifeReviewOsCoexistingBlocksSurviveStrip(): void {
  const okrDir = makeVault();
  const model = loadOkrFromDir(okrDir);
  const draft = [
    '## 📊 上周执行对比（6.29-7.5）',
    '本双周关闭了 3 个 release ticket……',
    '',
    '## 📋 下周计划（7.6-7.19）',
    '继续推进 onboarding……',
    '',
    '```json',
    '{"retro_review":"两段式复盘：做得好……；待改进……","writeback_plan":[{"row_index":1,"row_label":"O1","text":"更新简历","is_mit":true}]}',
    '```',
    '',
    '```json',
    '{ "kr_progress": [ { "krId": "O1-KR2", "current": "6", "progress": "55%", "evidence": "Linear 关闭 3 个", "confidence": "high" } ], "obstacles": ["招聘卡住"], "next_priorities": ["先做 onboarding"] }',
    '```',
  ].join('\n');

  // The bridge strips the writeback_plan block before the draft reaches the card.
  const stripped = stripWritebackJsonBlock(draft);
  assert.ok(!/writeback_plan/.test(stripped), 'writeback_plan block is removed from the user-facing draft');
  assert.ok(/kr_progress/.test(stripped), 'kr_progress block survives the strip');
  assert.ok(/retro_review/.test(stripped) === false, 'retro_review block (writeback_plan) is gone');

  // The stripped draft still parses into a usable contract.
  const parse = parseBiweeklyProgress(stripped);
  assert.equal(parse.ok, true, 'stripped life-review-os draft still yields a kr_progress contract');
  assert.equal(parse.contract?.kr_progress[0]!.krId, 'O1-KR2');
  assert.deepEqual(parse.contract?.obstacles, ['招聘卡住']);

  // End-to-end: buildOkrWritebackPreview would surface the increment / card.
  const { matched } = matchBiweeklyProgress(model, parse.contract!);
  assert.equal(matched.length, 1);
  assert.deepEqual(renderKrIncrements(matched), ['O1-KR2: 25%→55% (+30)']);
}

// Regression guard for the over-match bug: when the kr_progress block appears
// BEFORE the writeback_plan block, a naive single spanning regex would eat both.
// The per-fence cleaner must keep kr_progress and drop only writeback_plan.
function testLifeReviewOsKrProgressBeforeWritebackSurvives(): void {
  const draft = [
    '正文……',
    '```json',
    '{ "kr_progress": [ { "krId": "O1-KR1", "current": "8", "progress": "40%" } ], "obstacles": [], "next_priorities": [] }',
    '```',
    '```json',
    '{"retro_review":"复盘……","writeback_plan":[{"row_index":1,"row_label":"O1","text":"要务","is_mit":false}]}',
    '```',
  ].join('\n');
  const stripped = stripWritebackJsonBlock(draft);
  assert.ok(/kr_progress/.test(stripped), 'kr_progress before writeback_plan is not swallowed');
  assert.ok(!/writeback_plan/.test(stripped), 'writeback_plan is still removed');
  assert.equal(parseBiweeklyProgress(stripped).contract?.kr_progress[0]!.krId, 'O1-KR1');
}

// Old-version life-review-os draft: only a writeback_plan block, no kr_progress.
// After strip nothing parseable remains, so buildOkrWritebackPreview reports
// hasProgress=false and the card degrades silently (never pops).
function testOldLifeReviewOsDraftDegradesSilently(): void {
  const config = exampleConfig();
  const draft = [
    '## 📊 上周执行对比（6.29-7.5）',
    '……',
    '```json',
    '{"retro_review":"两段式复盘……","writeback_plan":[{"row_index":1,"row_label":"O1","text":"更新简历","is_mit":true}]}',
    '```',
  ].join('\n');
  const stripped = stripWritebackJsonBlock(draft);
  assert.equal(parseBiweeklyProgress(stripped).ok, false, 'old draft carries no kr_progress after strip');
  const preview = buildOkrWritebackPreview({ config, draft: stripped });
  assert.equal(preview.hasProgress, false, 'no card fires for a kr_progress-less draft');
}
