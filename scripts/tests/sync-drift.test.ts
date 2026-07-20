import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { AppConfigSchema, type AppConfig } from '../../src/config/schema.js';
import type { Evidence, EvidenceSource } from '../../src/workflows/types.js';
import {
  collectSyncDrift,
  filterUndecidedFindings,
  parseSyncDriftCardAction,
  recordSyncDriftDecision,
  renderSyncDriftCard,
  renderSyncDriftSection,
  syncDriftFindingKey,
} from '../../src/progress/sync-drift.js';

const DATE = '2026-07-18';
const OLD = '2026-07-10T09:00:00.000Z';
const TODAY_TS = `${DATE}T10:00:00.000Z`;

const tests: Array<{ name: string; fn: () => void }> = [];
const test = (name: string, fn: () => void): void => {
  tests.push({ name, fn });
};

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function makeConfig(overrides: (config: AppConfig) => void = () => {}): AppConfig {
  // The core schema sections are intentionally non-defaultable; parse the shipped
  // example config to get a fully-populated baseline, then override.
  const raw = yaml.load(fs.readFileSync(path.join(REPO_ROOT, 'config', 'config.example.yaml'), 'utf8'));
  const config = AppConfigSchema.parse(raw);
  config.progress_sync_check.enabled = true;
  config.sources.github.enabled = true;
  config.sources.linear.enabled = true;
  config.sources.github.repositories = [];
  overrides(config);
  return config;
}

function evidence(sources: Record<string, EvidenceSource>): Evidence {
  return { generated_at: new Date().toISOString(), date: DATE, sources };
}

function linearSource(updatedAt: string, extra: Record<string, unknown> = {}): EvidenceSource {
  return {
    state: 'available',
    data: {
      items: [
        {
          identifier: 'LEO-82',
          title: 'Ship the alpha release',
          url: 'https://linear.app/acme/issue/LEO-82',
          updatedAt,
          state: { name: 'In Progress' },
          ...extra,
        },
      ],
    },
  };
}

function ledgerSource(text: string): EvidenceSource {
  return { state: 'available', data: text };
}

function tmpDecisionsPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-os-sync-drift-'));
  return path.join(dir, 'sync-drift-decisions.jsonl');
}

// 1. enabled + 有 drift (LEO id in a Feishu message, Linear issue stale).
test('enabled + drift: stale Linear issue referenced by today Feishu message', () => {
  const ev = evidence({
    linear: linearSource(OLD),
    github: { state: 'disabled' },
    feishu_default_im_history: {
      state: 'available',
      data: { messages: [{ message_id: 'm1', body: '今天 LEO-82 发布完成', create_time: TODAY_TS }] },
    },
  });
  const { findings } = collectSyncDrift(ev, makeConfig());
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, 'linear-stale');
  assert.equal(findings[0].confidence, 'exact');
  assert.equal(findings[0].matchedId, 'LEO-82');
  assert.match(renderSyncDriftSection(findings).join('\n'), /🔄 可能需要同步的任务/);
});

// 2. enabled + 无 drift (Linear issue already updated today -> clean).
test('enabled + no drift: Linear issue updated today produces no findings', () => {
  const ev = evidence({
    linear: linearSource(TODAY_TS),
    github: { state: 'disabled' },
    progress_ledger: ledgerSource('## LEO-82 发布完成\n- Source: feishu'),
  });
  const { findings } = collectSyncDrift(ev, makeConfig());
  assert.equal(findings.length, 0);
  assert.deepEqual(renderSyncDriftSection(findings), []);
});

// 3. disabled -> zero trace even with drift evidence.
test('disabled: zero trace', () => {
  const ev = evidence({
    linear: linearSource(OLD),
    github: { state: 'disabled' },
    progress_ledger: ledgerSource('## LEO-82 发布完成'),
  });
  const config = makeConfig((c) => {
    c.progress_sync_check.enabled = false;
  });
  const { findings } = collectSyncDrift(ev, config);
  assert.equal(findings.length, 0);
});

// 4. source missing -> silent (debug only, no card findings).
test('source missing: stays silent', () => {
  const ev = evidence({
    linear: { state: 'error', detail: 'Linear HTTP 500' },
    github: { state: 'disabled' },
    progress_ledger: ledgerSource('## LEO-82 发布完成'),
  });
  const { findings } = collectSyncDrift(ev, makeConfig());
  assert.equal(findings.length, 0);
});

// 5. LEO-123 deterministic id matching from the progress ledger.
test('LEO-123 deterministic match: exact linear-stale from progress ledger', () => {
  const ev = evidence({
    linear: linearSource(OLD),
    github: { state: 'disabled' },
    progress_ledger: ledgerSource('## LEO-82 发布完成\n- Evidence: shipped today'),
  });
  const { findings } = collectSyncDrift(ev, makeConfig());
  assert.equal(findings.length, 1);
  assert.equal(findings[0].confidence, 'exact');
  assert.equal(findings[0].matchedId, 'LEO-82');
  assert.equal(findings[0].matchedUrl, 'https://linear.app/acme/issue/LEO-82');
});

// 6. #123 requires repository context.
test('#123 requires repo context', () => {
  const githubSource: EvidenceSource = {
    state: 'available',
    data: [{ repo: 'acme/app', state: 'available', issues: [{ number: 103, title: 'Release', html_url: 'https://github.com/acme/app/pull/103', updated_at: OLD }] }],
  };

  // No repo context in the text and no configured repos -> no match.
  const noContext = collectSyncDrift(
    evidence({ github: githubSource, linear: { state: 'disabled' }, progress_ledger: ledgerSource('今天 #103 发布完成') }),
    makeConfig(),
  );
  assert.equal(noContext.findings.length, 0);

  // Configured repository provides context -> matches, github-stale.
  const withContext = collectSyncDrift(
    evidence({ github: githubSource, linear: { state: 'disabled' }, progress_ledger: ledgerSource('今天 #103 发布完成') }),
    makeConfig((c) => {
      c.sources.github.repositories = ['acme/app'];
    }),
  );
  assert.equal(withContext.findings.length, 1);
  assert.equal(withContext.findings[0].kind, 'github-stale');
  assert.equal(withContext.findings[0].confidence, 'exact');
  assert.equal(withContext.findings[0].matchedId, 'acme/app#103');
});

// 7. Fuzzy title match is annotated only ("可能相关"), never exact.
test('fuzzy: low-confidence title match is annotate-only', () => {
  const ev = evidence({
    linear: {
      state: 'available',
      data: { items: [{ identifier: 'LEO-90', title: 'Refactor billing meter', url: 'https://linear.app/acme/issue/LEO-90', updatedAt: OLD }] },
    },
    github: { state: 'disabled' },
    progress_ledger: ledgerSource('今天把 billing meter 重构推进了不少'),
  });
  const { findings } = collectSyncDrift(ev, makeConfig());
  assert.equal(findings.length, 1);
  assert.equal(findings[0].confidence, 'fuzzy');
  assert.equal(findings[0].matchedId, 'LEO-90');
  assert.match(findings[0].suggestion, /可能与 LEO-90 相关|低置信/);
});

// 8. Ignored findings are not re-prompted for the same date.
test('ignored findings are not re-prompted for the same date', () => {
  const decisionsPath = tmpDecisionsPath();
  const ev = evidence({
    linear: linearSource(OLD),
    github: { state: 'disabled' },
    progress_ledger: ledgerSource('## LEO-82 发布完成'),
  });
  const { findings } = collectSyncDrift(ev, makeConfig());
  assert.equal(findings.length, 1);

  const key = syncDriftFindingKey(findings[0]);
  recordSyncDriftDecision({ key, date: DATE, decision: 'ignore' }, decisionsPath);

  assert.equal(filterUndecidedFindings(findings, DATE, decisionsPath).length, 0);
  // A different date is unaffected.
  assert.equal(filterUndecidedFindings(findings, '2026-07-19', decisionsPath).length, 1);
});

// Card action round-trip (button minimal wiring): sign + parse.
test('sync-drift card action signs and parses round-trip', () => {
  const config = makeConfig();
  const ev = evidence({ linear: linearSource(OLD), github: { state: 'disabled' }, progress_ledger: ledgerSource('## LEO-82 发布完成') });
  const { findings } = collectSyncDrift(ev, config);
  const card = renderSyncDriftCard(config, DATE, findings) as { elements: Array<{ tag: string; actions?: Array<{ value: unknown }> }> };
  const actionElement = card.elements.find((element) => element.tag === 'action');
  assert.ok(actionElement?.actions && actionElement.actions.length === 3);
  const ignoreValue = actionElement.actions[2].value;
  const parsed = parseSyncDriftCardAction(ignoreValue, config);
  assert.ok(parsed);
  assert.equal(parsed?.action, 'ignore');
  assert.equal(parsed?.date, DATE);
  // Tampered token is rejected.
  const tampered = { ...(ignoreValue as Record<string, unknown>), daily_os_sync_drift_token: 'bad' };
  assert.equal(parseSyncDriftCardAction(tampered, config), null);
});

// Adversarial: a corrupted / partial line in the decisions ledger must not throw
// or drop the valid decisions around it.
test('decisions ledger tolerates corrupted lines', () => {
  const decisionsPath = tmpDecisionsPath();
  const ev = evidence({
    linear: linearSource(OLD),
    github: { state: 'disabled' },
    progress_ledger: ledgerSource('## LEO-82 发布完成'),
  });
  const { findings } = collectSyncDrift(ev, makeConfig());
  assert.equal(findings.length, 1);
  const key = syncDriftFindingKey(findings[0]);

  // Hand-write a ledger with garbage, a half-written record, and a valid ignore.
  fs.mkdirSync(path.dirname(decisionsPath), { recursive: true });
  fs.writeFileSync(
    decisionsPath,
    [
      'not json at all {{{',
      '{"key":"sd_partial","date":', // truncated JSON
      '',
      JSON.stringify({ key, date: DATE, decision: 'ignore', at: new Date().toISOString() }),
    ].join('\n'),
    'utf8',
  );

  // The valid ignore still filters its finding; the corrupt lines are skipped.
  assert.equal(filterUndecidedFindings(findings, DATE, decisionsPath).length, 0);
  // A subsequent append after the corruption still works and is honored.
  recordSyncDriftDecision({ key, date: '2026-07-19', decision: 'handled' }, decisionsPath);
  assert.equal(filterUndecidedFindings(findings, '2026-07-19', decisionsPath).length, 0);
});

// Adversarial: tampering any signed field (action / date / keys), not just the
// token, must be rejected because the HMAC is recomputed over those fields.
test('sync-drift card action rejects a tampered signed payload', () => {
  const config = makeConfig();
  const ev = evidence({ linear: linearSource(OLD), github: { state: 'disabled' }, progress_ledger: ledgerSource('## LEO-82 发布完成') });
  const { findings } = collectSyncDrift(ev, config);
  const card = renderSyncDriftCard(config, DATE, findings) as { elements: Array<{ tag: string; actions?: Array<{ value: unknown }> }> };
  const ignoreValue = card.elements.find((element) => element.tag === 'action')!.actions![2].value as Record<string, unknown>;

  // Baseline: the untouched value parses.
  assert.ok(parseSyncDriftCardAction(ignoreValue, config));

  // Escalate the action from ignore -> handled while keeping the ignore token.
  assert.equal(parseSyncDriftCardAction({ ...ignoreValue, daily_os_sync_drift_action: 'handled' }, config), null);
  // Change the date (would suppress a different day) — signature no longer matches.
  assert.equal(parseSyncDriftCardAction({ ...ignoreValue, daily_os_sync_drift_date: '2026-07-19' }, config), null);
  // Swap in an attacker-chosen finding key.
  assert.equal(parseSyncDriftCardAction({ ...ignoreValue, daily_os_sync_drift_keys: ['sd_evil'] }, config), null);
  // A signature minted under a different secret is rejected. The signing secret
  // falls back to config.assistant.name only when no env secret is present, so
  // this sub-check runs only in that (test/sandbox) configuration.
  if (!process.env.LARK_APP_SECRET && !process.env.DAILY_OS_CALLBACK_SECRET) {
    const otherSecretConfig = makeConfig((c) => {
      c.assistant.name = 'a-different-signing-secret';
    });
    assert.equal(parseSyncDriftCardAction(ignoreValue, otherSecretConfig), null);
  }
});

let passed = 0;
let failed = 0;
for (const { name, fn } of tests) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  ✗ ${name}`);
    console.error(`    ${error instanceof Error ? error.stack || error.message : String(error)}`);
  }
}
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
