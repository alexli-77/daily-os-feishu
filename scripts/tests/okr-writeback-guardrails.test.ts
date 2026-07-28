import assert from 'node:assert/strict';
import { assessKrProposals, locateEvidence, renderFlaggedLines } from '../../src/okr/writeback-guardrails.js';
import type { MatchedKr } from '../../src/okr/biweekly-progress.js';

// LEO-248 — deterministic guardrails between the biweekly LLM draft and the
// local OKR write-back: evidence back-check + big-jump gating.

// A pack modeled on the real 2026-07-28 incident: "三条路径" exists (as an
// unfinished KR row) and ✅ marks exist — but only on *other* items.
const PACK = [
  '# Daily OS Skill Input Pack',
  '## Local OKR Chain',
  '- O1-KR1 [0%] 三条路径 yes/no 决策文档（PhD / AI 工程求职 / 过渡现金流） — target: 1 / current: 0',
  '- O2-KR2 [0%] 可重复销售产品：≥1 次真实付费或 3 个明确付费意向',
  '## Recent Daily Memory',
  '已连续 4 周以上每天计划 MIT 但无可核实文件产出。',
  '完成 storyboard 优化并交付 MIT ✅',
  'Feishu 🐶 7.13-7.26 要务 ✅ 确定被动收入最小可行产品方向',
].join('\n');

function kr(overrides: Partial<MatchedKr>): MatchedKr {
  return {
    krId: 'O1-KR1',
    description: '三条路径 yes/no 决策文档',
    fromCurrent: '0',
    fromProgress: '0%',
    fromPct: 0,
    toCurrent: '1',
    toProgress: '100%',
    toPct: 100,
    deltaPct: 100,
    evidence: '',
    ...overrides,
  };
}

try {
  testFabricatedCheckmarkIsFlagged();
  testGenuineEvidenceIsAccepted();
  testVerifiedBigJumpPasses();
  testNoPackConservativeRules();
  testEmptyEvidenceFlagged();
  testFlaggedLineRendering();
  console.log('okr-writeback-guardrails.test.ts: all tests passed');
} catch (error) {
  console.error(error);
  process.exit(1);
}

function testFabricatedCheckmarkIsFlagged(): void {
  // The exact hallucination shape: borrows a ✅ that exists elsewhere in the
  // pack and attributes it to this KR. Fragments match line 3, but the claimed
  // ✅ never co-occurs with 三条路径 — must be flagged, and the 0→100 jump adds
  // a second reason.
  const fake = kr({ evidence: 'Feishu 🐶 7.13-7.26 要务 ✅ 三条路径 yes/no 决策文档' });
  const { accepted, flagged } = assessKrProposals([fake], PACK);
  assert.equal(accepted.length, 0, 'fabricated evidence must not be accepted');
  assert.equal(flagged.length, 1);
  assert.match(flagged[0].reasons.join(' '), /无法在 input pack 中核实/);
  assert.match(flagged[0].reasons.join(' '), /跳变 100 个百分点/);
}

function testGenuineEvidenceIsAccepted(): void {
  // Small delta whose evidence quotes a real pack line verbatim.
  const real = kr({
    krId: 'O2-KR2',
    evidence: 'Feishu 🐶 7.13-7.26 要务 ✅ 确定被动收入最小可行产品方向',
    toProgress: '10%',
    toPct: 10,
    deltaPct: 10,
  });
  const { accepted, flagged } = assessKrProposals([real], PACK);
  assert.equal(flagged.length, 0, `unexpected flags: ${JSON.stringify(flagged.map((f) => f.reasons))}`);
  assert.equal(accepted.length, 1);
}

function testVerifiedBigJumpPasses(): void {
  // A big jump is fine when its completion evidence really exists in the pack.
  const pack = PACK + '\n三条路径 yes/no 决策文档 终稿已提交 ✅';
  const done = kr({ evidence: '三条路径 yes/no 决策文档 终稿已提交 ✅' });
  const { accepted, flagged } = assessKrProposals([done], pack);
  assert.equal(flagged.length, 0, `unexpected flags: ${JSON.stringify(flagged.map((f) => f.reasons))}`);
  assert.equal(accepted.length, 1);
}

function testNoPackConservativeRules(): void {
  // Pack missing: evidence cannot be located, so big jumps are flagged while
  // small deltas still pass (backwards compatible with pack-less callers).
  const small = kr({ krId: 'O2-KR2', toPct: 10, toProgress: '10%', deltaPct: 10, evidence: '任意' });
  const big = kr({ evidence: '任意' });
  const { accepted, flagged } = assessKrProposals([small, big], null);
  assert.deepEqual(accepted.map((entry) => entry.krId), ['O2-KR2']);
  assert.equal(flagged.length, 1);
  assert.match(flagged[0].reasons.join(' '), /input pack 缺失/);
}

function testEmptyEvidenceFlagged(): void {
  const { accepted, flagged } = assessKrProposals([kr({ evidence: '', toPct: 10, deltaPct: 10 })], PACK);
  assert.equal(accepted.length, 0);
  assert.match(flagged[0].reasons.join(' '), /证据缺失/);
  // Direct helper check too.
  assert.equal(locateEvidence('', PACK).located, false);
}

function testFlaggedLineRendering(): void {
  const { flagged } = assessKrProposals([kr({ evidence: '不存在的证据内容啊' })], PACK);
  const lines = renderFlaggedLines(flagged);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^O1-KR1: 0%→100% — /);
}
