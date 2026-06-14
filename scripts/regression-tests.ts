import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config/load-config.js';
import { parseDailyOsCommand } from '../src/interaction/daily-os-command.js';
import { handlePendingBackgroundSuggestionReply } from '../src/service/background-suggestions.js';
import { renderFeishuWorkflowCard } from '../src/connectors/feishu-sdk.js';
import { collectFeishuUserMessageRecords, isFeishuAppMessageRecord } from '../src/utils/feishu-message-records.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-os-regression-'));

try {
  testFeishuUserMessageFiltering();
  testDailyOsCommandParsing();
  testBackgroundSuggestionDismissAllFromAmbiguousDismiss();
  testWorkflowCardRendering();
  console.log('Regression tests passed.');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

function testFeishuUserMessageFiltering(): void {
  const appMessage = {
    message_id: 'app-1',
    content: '<card title="Daily OS"># 后台工作建议\n请确认</card>',
    create_time: '2026-06-14 10:00',
    sender: { sender_type: 'app' },
  };
  const userMessage = {
    message_id: 'user-1',
    content: 'LEO-7 邮件已经完成，待周一发布',
    create_time: '2026-06-14 10:01',
    sender: { sender_type: 'user' },
  };

  assert.equal(isFeishuAppMessageRecord(appMessage), true);
  assert.equal(isFeishuAppMessageRecord(userMessage), false);

  const records = collectFeishuUserMessageRecords({ data: { items: [appMessage, userMessage] } });
  assert.equal(records.length, 1);
  assert.equal(records[0]?.id, 'user-1');
  assert.equal(records[0]?.text, 'LEO-7 邮件已经完成，待周一发布');
  assert.ok(records[0]?.createdAt instanceof Date);
}

function testDailyOsCommandParsing(): void {
  assert.deepEqual(parseDailyOsCommand('daily-os plan', 'daily-os'), { type: 'workflow', workflow: 'daily_plan' });
  assert.deepEqual(parseDailyOsCommand('daily-os review', 'daily-os'), { type: 'workflow', workflow: 'daily_review' });
  assert.deepEqual(parseDailyOsCommand('daily-os weekly', 'daily-os'), { type: 'workflow', workflow: 'weekly_review' });

  const revision = parseDailyOsCommand('daily-os 修改今日安排：把 LEO-12 降级，今天先处理导师邮件', 'daily-os');
  assert.equal(revision.type, 'revision_request');
  if (revision.type === 'revision_request') {
    assert.equal(revision.workflow, 'daily_plan');
    assert.match(revision.text, /LEO-12/);
  }
}

function testBackgroundSuggestionDismissAllFromAmbiguousDismiss(): void {
  const config = testConfig();
  const pendingPath = config.background_suggestions.pending_path;
  fs.mkdirSync(path.dirname(pendingPath), { recursive: true });
  fs.writeFileSync(
    pendingPath,
    JSON.stringify(
      {
        created_at: '2026-06-14T10:00:00.000Z',
        expires_at: '2099-01-01T00:00:00.000Z',
        date: '2026-06-14',
        mode: 'review',
        window_label: 'test',
        suggestions: [
          {
            index: 1,
            id: 's1',
            kind: 'new_task',
            title: '第一条建议',
            summary: 'summary',
            targets: ['todo'],
            confidence: 'medium',
          },
          {
            index: 2,
            id: 's2',
            kind: 'reschedule',
            title: '第二条建议',
            summary: 'summary',
            targets: ['daily_plan'],
            confidence: 'medium',
          },
        ],
      },
      null,
      2,
    ),
    'utf8',
  );

  const result = handlePendingBackgroundSuggestionReply(config, '不采纳这个建议。', {
    messageId: 'msg-1',
    source: 'regression-test',
    now: new Date('2026-06-14T10:02:00.000Z'),
  });

  assert.equal(result.handled, true);
  assert.match(result.reply || '', /已忽略第 1、2 条建议/);
  assert.equal(fs.existsSync(pendingPath), false);
  assert.match(fs.readFileSync(config.feedback.feishu.log_path, 'utf8'), /dismiss_background_suggestion/);
}

function testWorkflowCardRendering(): void {
  const card = renderFeishuWorkflowCard('老板，今天先这样安排。', {
    workflow: 'daily_plan',
    date: '2026-06-14',
    detailId: 'detail-1',
  }) as { elements?: unknown[] };
  const serialized = JSON.stringify(card);
  assert.match(serialized, /今日安排/);
  assert.match(serialized, /重排一次/);
  assert.match(serialized, /daily_plan/);
}

function testConfig(): ReturnType<typeof loadConfig> {
  const config = loadConfig();
  config.background_suggestions.pending_path = path.join(tmp, 'pending.json');
  config.background_suggestions.state_path = path.join(tmp, 'background-state.json');
  config.feedback.feishu.log_path = path.join(tmp, 'feedback.md');
  config.feedback.feishu.state_path = path.join(tmp, 'feedback-state.json');
  config.memory.daily_dir = path.join(tmp, 'daily');
  config.memory.long_term_path = path.join(tmp, 'long-term.md');
  return config;
}
