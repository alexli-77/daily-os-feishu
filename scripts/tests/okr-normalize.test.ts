import assert from 'node:assert/strict';
import { normalizeOkrMarkdown } from '../../src/okr/normalize.js';

// LEO-205 — deterministic free-form -> loader-format normalizer behind the
// "整理格式" button in the OKR editor.

try {
  testFreeformToStructure();
  testBracketPriority();
  testLevelPrefix();
  testUnlabeledAndLabeledKrsRenumber();
  testAlreadyStructuredIsUnchanged();
  testFrontmatterPreserved();
  console.log('okr-normalize.test.ts: all tests passed');
} catch (error) {
  console.error(error);
  process.exit(1);
}

function testFreeformToStructure(): void {
  const input = [
    '`P0` O1 工作：寻求稳定工作',
    '* KR1: 确定主路径',
    '* KR2: 拿到 offer',
    '`P1`O2 家庭：多联系父母',
    '* 每周视频一次',
  ].join('\n');
  const out = normalizeOkrMarkdown(input, 'annual');
  assert.match(out, /^## Objective A1: 工作：寻求稳定工作$/m, 'objective heading with A prefix + title');
  assert.match(out, /^Parent: none$/m);
  assert.match(out, /^Priority: P0$/m, 'priority preserved');
  assert.match(out, /^\| KR ID \| Description \| Target \| Current \| Progress \| Updated \|$/m, 'table header');
  assert.match(out, /^\| A1-KR1 \| 确定主路径 \|.*0% \|.*\|$/m, 'first KR row');
  assert.match(out, /^\| A1-KR2 \| 拿到 offer \|/m, 'second KR row');
  assert.match(out, /^## Objective A2: 家庭：多联系父母$/m, 'second objective');
  assert.match(out, /^\| A2-KR1 \| 每周视频一次 \|/m, 'unlabeled bullet becomes KR1');
}

function testBracketPriority(): void {
  // 5-year OKR was written with square-bracket priority: "[P0] O1 工作：…".
  // Both the bracket and the O-enumerator must be stripped from the title.
  const input = ['[P0] O1 工作：技术专家', '- 建立职业主路径', '【P1】O2 金钱：理财', '- 建立理财系统'].join('\n');
  const out = normalizeOkrMarkdown(input, 'north-star');
  assert.match(out, /^## Objective N1: 工作：技术专家$/m, 'no stray "] O1" left in title');
  assert.match(out, /^Priority: P0$/m);
  assert.match(out, /^## Objective N2: 金钱：理财$/m, 'full-width brackets handled too');
  assert.doesNotMatch(out, /\]/, 'no stray bracket anywhere');
}

function testLevelPrefix(): void {
  const input = '工作\n- 做点事';
  assert.match(normalizeOkrMarkdown(input, 'north-star'), /^## Objective N1:/m);
  assert.match(normalizeOkrMarkdown(input, 'annual'), /^## Objective A1:/m);
  assert.match(normalizeOkrMarkdown(input, 'current'), /^## Objective O1:/m);
}

function testUnlabeledAndLabeledKrsRenumber(): void {
  const input = ['名利：打造 IP', '* KR1: 粉丝过万', '* 每月输出 2-4 次', '* KR2: 收尾旧业务'].join('\n');
  const out = normalizeOkrMarkdown(input, 'annual');
  // All three bullets become sequential A1-KR1..3 regardless of their own labels.
  assert.match(out, /^\| A1-KR1 \| 粉丝过万 \|/m);
  assert.match(out, /^\| A1-KR2 \| 每月输出 2-4 次 \|/m);
  assert.match(out, /^\| A1-KR3 \| 收尾旧业务 \|/m);
}

function testAlreadyStructuredIsUnchanged(): void {
  const structured = [
    '## Objective A1: 已经是标准格式',
    'Parent: none',
    '',
    '| KR ID | Description | Target | Current | Progress | Updated |',
    '| --- | --- | --- | --- | --- | --- |',
    '| A1-KR1 | x | y | z | 40% | 2026-07-27 |',
    '',
  ].join('\n');
  assert.equal(normalizeOkrMarkdown(structured, 'annual'), structured, 'idempotent on structured input');
}

function testFrontmatterPreserved(): void {
  const input = ['---', 'title: Annual OKR', 'level: annual', '---', '工作', '- 做事'].join('\n');
  const out = normalizeOkrMarkdown(input, 'annual');
  assert.match(out, /^---\ntitle: Annual OKR\nlevel: annual\n---/, 'frontmatter kept verbatim');
  assert.match(out, /^## Objective A1: 工作$/m);
}
