import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildChainSummary,
  buildOkrSummary,
  loadOkrFromDir,
  parseOkrContents,
  resolveChain,
} from '../../src/okr/loader.js';
import { updateKrProgress } from '../../src/okr/writeback.js';

const NORTH_STAR = `---
title: North Star OKR
level: north-star
cycle: 2026-2031
---

## Objective N1: Become financially independent

Parent: none

| KR ID | Description | Target | Current | Progress | Updated |
| --- | --- | --- | --- | --- | --- |
| N1-KR1 | Net worth milestone | 1,000,000 | 200,000 | 20% | 2026-07-16 |
`;

const ANNUAL = `---
title: Annual OKR
level: annual
cycle: 2026
parent: north-star-okr
---

## Objective A1: Grow the product to profitability

Parent: N1

| KR ID | Description | Target | Current | Progress | Updated |
| --- | --- | --- | --- | --- | --- |
| A1-KR1 | Monthly revenue | 50,000 | 10,000 | 20% | 2026-07-16 |
`;

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

function makeVault(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-os-okr-'));
  const okrDir = path.join(dir, '10_OKR');
  fs.mkdirSync(okrDir, { recursive: true });
  fs.writeFileSync(path.join(okrDir, 'north-star-okr.md'), NORTH_STAR);
  fs.writeFileSync(path.join(okrDir, 'annual-okr.md'), ANNUAL);
  fs.writeFileSync(path.join(okrDir, 'current-okr.md'), QUARTERLY);
  return okrDir;
}

const cleanups: string[] = [];
function trackDir(okrDir: string): string {
  cleanups.push(path.dirname(okrDir));
  return okrDir;
}

try {
  testLoadParsesThreeLayers();
  testResolveChainWalksFullStack();
  testResolveChainForHigherLayerKr();
  testBuildOkrSummaryIncludesProgress();
  testWritebackUpdatesRowAtomically();
  testWritebackReturnsNotFound();
  testMissingFilesDegradeWithWarnings();
  testParseContentsToleratesGarbage();
  console.log('okr.test.ts: all tests passed');
} finally {
  for (const dir of cleanups) fs.rmSync(dir, { recursive: true, force: true });
}

function testLoadParsesThreeLayers(): void {
  const okrDir = trackDir(makeVault());
  const model = loadOkrFromDir(okrDir);
  assert.equal(model.warnings.length, 0, 'no warnings for complete vault');
  assert.equal(model.northStar.length, 1);
  assert.equal(model.annual.length, 1);
  assert.equal(model.quarterly.length, 1);
  const o1 = model.quarterly[0]!;
  assert.equal(o1.id, 'O1');
  assert.equal(o1.parent, 'A1');
  assert.equal(o1.keyResults.length, 2);
  assert.equal(o1.keyResults[0]!.id, 'O1-KR1');
  assert.equal(o1.keyResults[0]!.progressPct, 25);
  assert.equal(model.northStar[0]!.parent, null, 'Parent: none becomes null');
}

function testResolveChainWalksFullStack(): void {
  const model = parseOkrContents({ northStar: NORTH_STAR, annual: ANNUAL, quarterly: QUARTERLY });
  const chain = resolveChain(model, 'O1-KR1');
  assert.equal(chain.kr?.id, 'O1-KR1');
  assert.equal(chain.quarterly?.id, 'O1');
  assert.equal(chain.annual?.id, 'A1');
  assert.equal(chain.northStar?.id, 'N1');
  assert.equal(chain.warnings.length, 0);
  const summary = buildChainSummary(chain);
  assert.ok(summary.includes('N1') && summary.includes('A1') && summary.includes('O1') && summary.includes('O1-KR1'));
}

function testResolveChainForHigherLayerKr(): void {
  const model = parseOkrContents({ northStar: NORTH_STAR, annual: ANNUAL, quarterly: QUARTERLY });
  const chain = resolveChain(model, 'A1-KR1');
  assert.equal(chain.quarterly, null, 'annual KR has no quarterly layer');
  assert.equal(chain.annual?.id, 'A1');
  assert.equal(chain.northStar?.id, 'N1');
}

function testBuildOkrSummaryIncludesProgress(): void {
  const model = parseOkrContents({ northStar: NORTH_STAR, annual: ANNUAL, quarterly: QUARTERLY });
  const summary = buildOkrSummary(model);
  assert.ok(summary.includes('O1-KR1 [25%]'), 'summary shows per-KR progress');
  assert.ok(summary.indexOf('North Star') < summary.indexOf('Quarterly'), 'north star rendered first');
}

function testWritebackUpdatesRowAtomically(): void {
  const okrDir = trackDir(makeVault());
  const result = updateKrProgress(okrDir, 'O1-KR1', '12', '60', '2026-07-30');
  assert.equal(result.ok, true);
  assert.equal(result.file, 'current-okr.md');
  const reloaded = loadOkrFromDir(okrDir);
  const kr = reloaded.quarterly[0]!.keyResults.find((entry) => entry.id === 'O1-KR1')!;
  assert.equal(kr.current, '12');
  assert.equal(kr.progress, '60%');
  assert.equal(kr.progressPct, 60);
  assert.equal(kr.updated, '2026-07-30');
  // Untouched row keeps its values and description column is preserved.
  assert.equal(reloaded.quarterly[0]!.keyResults.find((e) => e.id === 'O1-KR2')!.progressPct, 25);
  assert.equal(kr.description, 'Onboard pilot users');
}

function testWritebackReturnsNotFound(): void {
  const okrDir = trackDir(makeVault());
  const result = updateKrProgress(okrDir, 'O9-KR9', '1', '10', '2026-07-30');
  assert.equal(result.ok, false);
  assert.ok(result.reason?.includes('not found'));
}

function testMissingFilesDegradeWithWarnings(): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-os-okr-empty-'));
  cleanups.push(dir);
  const okrDir = path.join(dir, '10_OKR');
  fs.mkdirSync(okrDir, { recursive: true });
  fs.writeFileSync(path.join(okrDir, 'current-okr.md'), QUARTERLY); // only one file present
  const model = loadOkrFromDir(okrDir);
  assert.equal(model.quarterly.length, 1);
  assert.equal(model.northStar.length, 0);
  assert.equal(model.annual.length, 0);
  assert.ok(model.warnings.some((w) => w.includes('north-star-okr.md')));
  assert.ok(model.warnings.some((w) => w.includes('annual-okr.md')));
  // Chain still resolves what it can, records a missing-parent warning.
  const chain = resolveChain(model, 'O1-KR1');
  assert.equal(chain.quarterly?.id, 'O1');
  assert.equal(chain.annual, null);
  assert.ok(chain.warnings.some((w) => w.includes('parent')));
}

function testParseContentsToleratesGarbage(): void {
  const model = parseOkrContents({ quarterly: 'not markdown, no frontmatter, no tables' });
  assert.equal(model.quarterly.length, 0);
  assert.equal(model.warnings.length, 0, 'empty parse is not an error');
  const chain = resolveChain(model, 'X1-KR1');
  assert.equal(chain.kr, null);
  assert.ok(chain.warnings.some((w) => w.includes('not found')));
}
