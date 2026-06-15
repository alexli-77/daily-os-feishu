import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config/load-config.js';
import { coalesceChatSuggestions } from '../src/chat/context-analysis.js';
import type { ChatContextSuggestion } from '../src/chat/context-analysis.js';
import { parseDailyOsCommand, runParsedDailyOsCommand } from '../src/interaction/daily-os-command.js';
import { handlePendingBackgroundSuggestionReply } from '../src/service/background-suggestions.js';
import { renderFeishuWorkflowCard } from '../src/connectors/feishu-sdk.js';
import { handleFeishuFeedbackCommand } from '../src/feedback/feishu-feedback.js';
import { formatWorkflowSummaryForFeishu } from '../src/workflows/summary.js';
import { extractWeeklyPrioritiesFromXml } from '../src/workflows/weekly-priorities.js';
import { createPolicyCandidate, listPolicyCandidates } from '../src/decision/candidates.js';
import { decisionPolicyFiles } from '../src/decision/policy.js';
import { collectFeishuUserMessageRecords, isFeishuAppMessageRecord } from '../src/utils/feishu-message-records.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-os-regression-'));

try {
  testFeishuUserMessageFiltering();
  testChatSuggestionCoalescing();
  testDailyOsCommandParsing();
  testEveryFeishuInteractionWorkflowCommandHasCardSender();
  await testWorkflowCommandUsesCardCallback();
  await testWeeklyWorkflowCommandPassesEvidenceToCardSummary();
  await testFeedbackPollWorkflowCommandUsesCardSender();
  testDailyPlanSummaryShowsOpenLoopEvidence();
  testWorkflowSummaryQuotesLinearMetadata();
  testWeeklyReviewSummaryPrioritizesReviewEvidence();
  testWeeklyReviewSummaryShowsStructuredPriorityItems();
  testWeeklyPrioritiesExtractPortfolioReviewItem();
  await testConfirmLatestPolicyCandidateWithoutId();
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

function testChatSuggestionCoalescing(): void {
  const suggestions: ChatContextSuggestion[] = [
    {
      id: 'weekly-1',
      kind: 'new_task',
      title: '今天是周日，需要对本周的 weekly 进行复盘。',
      summary: '建议新增为待办。',
      targets: ['todo', 'memory'],
      confidence: 'medium',
      due: '今天',
      evidence: '今天是周日，需要对本周的 weekly 进行复盘。',
      why: '聊天里出现待办、请求或下一步信号。',
    },
    {
      id: 'weekly-2',
      kind: 'document_update',
      title: '根据 feishu weekly 文档里的本周要务核对任务进度。',
      summary: '建议检查是否需要更新飞书文档。',
      targets: ['document', 'linear', 'memory'],
      confidence: 'medium',
      due: '今天',
      evidence: '你要根据我的 feishu weekly 文档里的本周要务，对今天的任务做安排。',
      why: '聊天里出现文档、方案或记录更新信号。',
    },
    {
      id: 'leo-7',
      kind: 'completion',
      title: 'LEO-7 邮件已经完成，待周一发布',
      summary: '建议确认是否标记完成。',
      targets: ['daily_plan', 'review'],
      confidence: 'high',
      due: '周一',
      evidence: 'LEO-7 邮件已经完成，待周一发布',
      why: '聊天里出现完成、合并、发布或搞定信号。',
    },
  ];

  const coalesced = coalesceChatSuggestions(suggestions);
  assert.equal(coalesced.length, 2);
  const weekly = coalesced.find((suggestion) => suggestion.id === 'weekly-2' || suggestion.id === 'weekly-1');
  assert.ok(weekly);
  assert.deepEqual(new Set(weekly.targets), new Set(['todo', 'document', 'linear', 'memory']));
}

function testEveryFeishuInteractionWorkflowCommandHasCardSender(): void {
  const source = fs.readFileSync(path.resolve('src/interaction/feishu-interaction.ts'), 'utf8');
  const commandHandlerCount = source.match(/handleDailyOsCommand\(\{/g)?.length || 0;
  const workflowCardSenderCount = source.match(/sendWorkflowCard:/g)?.length || 0;
  assert.ok(commandHandlerCount >= 3, 'expected Feishu interaction command handlers to be discoverable');
  assert.equal(workflowCardSenderCount, commandHandlerCount, 'every Feishu command handler must pass sendWorkflowCard');
}

function testDailyOsCommandParsing(): void {
  assert.deepEqual(parseDailyOsCommand('daily-os plan', 'daily-os'), { type: 'workflow', workflow: 'daily_plan' });
  assert.deepEqual(parseDailyOsCommand('daily-os review', 'daily-os'), { type: 'workflow', workflow: 'daily_review' });
  assert.deepEqual(parseDailyOsCommand('daily-os weekly', 'daily-os'), { type: 'workflow', workflow: 'weekly_review' });
  assert.deepEqual(parseDailyOsCommand('daily-os 保存规则', 'daily-os'), { type: 'confirm_policy_candidate' });
  assert.deepEqual(parseDailyOsCommand('daily-os 确认保存', 'daily-os'), { type: 'confirm_policy_candidate' });
  assert.deepEqual(parseDailyOsCommand('daily-os 确认保存：daily-os 保存规则 pol-20260605202553-801f4cf6', 'daily-os'), {
    type: 'confirm_policy_candidate',
    id: 'pol-20260605202553-801f4cf6',
  });

  const revision = parseDailyOsCommand('daily-os 修改今日安排：把 LEO-12 降级，今天先处理导师邮件', 'daily-os');
  assert.equal(revision.type, 'revision_request');
  if (revision.type === 'revision_request') {
    assert.equal(revision.workflow, 'daily_plan');
    assert.match(revision.text, /LEO-12/);
  }
}

async function testWorkflowCommandUsesCardCallback(): Promise<void> {
  const replies: string[] = [];
  const cards: Array<{ workflow: string; summary: string }> = [];
  await runParsedDailyOsCommand(
    {
      config: testConfig(),
      messageId: 'message-1',
      text: 'daily-os plan',
      source: 'regression-test',
      prefix: 'daily-os',
      sendWorkflowOutput: false,
      reply: async (text) => {
        replies.push(text);
      },
      sendWorkflowCard: async ({ workflow, summary }) => {
        cards.push({ workflow, summary });
      },
      runWorkflowForCommand: async (_config, workflow, options) => {
        assert.equal(workflow, 'daily_plan');
        assert.deepEqual(options, { send: false });
        return '老板，今天先看这几件事。\n\n## 今日重点\n- LEO-7 邮件复核';
      },
    },
    { type: 'workflow', workflow: 'daily_plan' },
  );

  assert.deepEqual(replies, ['Running daily plan...']);
  assert.equal(cards.length, 1);
  assert.equal(cards[0]?.workflow, 'daily_plan');
  assert.match(cards[0]?.summary || '', /LEO-7/);
}

async function testWeeklyWorkflowCommandPassesEvidenceToCardSummary(): Promise<void> {
  const replies: string[] = [];
  const cards: Array<{ workflow: string; summary: string }> = [];
  await runParsedDailyOsCommand(
    {
      config: testConfig(),
      messageId: 'message-1',
      text: 'daily-os weekly',
      source: 'regression-test',
      prefix: 'daily-os',
      sendWorkflowOutput: false,
      reply: async (text) => {
        replies.push(text);
      },
      sendWorkflowCard: async ({ workflow, summary }) => {
        cards.push({ workflow, summary });
      },
      runWorkflowForCommand: async (_config, workflow, options) => {
        assert.equal(workflow, 'weekly_review');
        assert.deepEqual(options, { send: false });
        return [
          '老板，我帮您整理了本周总结和下周安排。',
          '',
          '**1. 本周已经完成 / 已推进**',
          '确认的：`LEO-7 Heng Li 意向邮件` 已推进到发送前审核。',
          '',
          '**2. 本周没做完 / 需要继续盯**',
          '逐条核对 🐶 本周要务：导师联系被 Weekly 标为 `MIT ✅`，但 Linear 仍显示待周一发送。',
        ].join('\n');
      },
      collectEvidenceForSummary: async () => ({
        generated_at: '2026-06-14T00:00:00.000Z',
        date: '2026-06-14',
        sources: {
          weekly_priorities: {
            state: 'available',
            data: {
              week: '6.8-6.14',
              items: [{ scope: '🐶', item: '个人 portfolio：把首版页面发给小企鹅 review，并按反馈改 1 轮（延续上周⭕️）' }],
            },
          },
        },
      }),
    },
    { type: 'workflow', workflow: 'weekly_review' },
  );

  assert.deepEqual(replies, ['Running weekly review...']);
  assert.equal(cards.length, 1);
  assert.equal(cards[0]?.workflow, 'weekly_review');
  assert.match(cards[0]?.summary || '', /个人 portfolio/);
}

async function testFeedbackPollWorkflowCommandUsesCardSender(): Promise<void> {
  const replies: string[] = [];
  const cards: Array<{ workflow: string; summary: string }> = [];
  const config = testConfig();
  await handleFeishuFeedbackCommand(
    config,
    { id: 'message-1', text: 'daily-os plan', raw: { sender: { sender_type: 'user' } } },
    true,
    async ({ workflow, summary }) => {
      cards.push({ workflow, summary });
    },
    async (_config, workflow, options) => {
      assert.equal(workflow, 'daily_plan');
      assert.deepEqual(options, { send: false });
      return '老板，今天先看这几件事。\n\n## 今日重点\n- LEO-7 邮件复核';
    },
    async (text) => {
      replies.push(text);
    },
  );

  assert.deepEqual(replies, ['Running daily plan...']);
  assert.equal(cards.length, 1);
  assert.equal(cards[0]?.workflow, 'daily_plan');
  assert.match(cards[0]?.summary || '', /LEO-7/);
}

async function testConfirmLatestPolicyCandidateWithoutId(): Promise<void> {
  const config = testConfig();
  createPolicyCandidate(config, {
    chatId: 'chat-1',
    messageId: 'message-1',
    senderOpenId: 'sender-1',
    rawUserText: '每周日按 weekly 复盘。',
    assistantReply: '已记录候选规则。',
    rule: {
      id: 'sunday-weekly-review',
      description: '每周日必须参考 weekly 文档复盘本周要务。',
      applies_to: ['daily_plan', 'weekly_review'],
    },
  });

  const replies: string[] = [];
  await runParsedDailyOsCommand(
    {
      config,
      messageId: 'message-2',
      text: 'daily-os 保存规则',
      source: 'regression-test',
      prefix: 'daily-os',
      reply: async (text) => {
        replies.push(text);
      },
    },
    { type: 'confirm_policy_candidate' },
  );

  assert.equal(listPolicyCandidates(config, 'pending').length, 0);
  assert.match(replies.join('\n'), /已保存长期决策规则：sunday-weekly-review/);
  assert.match(fs.readFileSync(decisionPolicyFiles(config).policyPath, 'utf8'), /每周日必须参考 weekly 文档复盘本周要务/);
}

function testDailyPlanSummaryShowsOpenLoopEvidence(): void {
  const content = [
    '老板您好，我帮您整理了今天的安排。',
    '',
    '**1. 今日重点**',
    'MIT：',
    '- `Weekly2026 🐶 本周要务复盘` 今天最重要的是核对 6.8-6.14 本周要务还有哪些没有真实闭环，完成标准是四栏表。',
    '',
    '**2. 为什么是这些**',
    '最高校准源是 Feishu Docs `Weekly2026`。',
    '今日需要补进 todo 的未闭环项是：`LEO-7` 邮件还没看到真实发送记录和 follow-up 日期；`未来 4 周唯一主线` 需要周日确认是否最终闭环；飞书文档、方案、会议记录需要检查是否和真实进展一致。',
    '',
    '**4. Codex 可以做**',
    '- `Weekly2026 🐶 对账` Codex 可以整理本周要务核对表，预期产物是四栏表。',
  ].join('\n');
  const summary = formatWorkflowSummaryForFeishu('daily_plan', '2026-06-14', content, undefined, testConfig());
  assert.match(summary, /未闭环依据/);
  assert.match(summary, /LEO-7/);
  assert.match(summary, /未来 4 周唯一主线/);
  assert.match(summary, /飞书文档/);
}

function testWorkflowSummaryQuotesLinearMetadata(): void {
  const content = [
    '老板您好，我帮您整理了今天的安排。',
    '',
    '**1. 今日重点**',
    '- `LEO-7 Heng Li 意向邮件` 今天先做最终发送审核。',
  ].join('\n');
  const summary = formatWorkflowSummaryForFeishu(
    'daily_plan',
    '2026-06-14',
    content,
    {
      generated_at: '2026-06-14T00:00:00.000Z',
      date: '2026-06-14',
      sources: {
        linear: {
          state: 'available',
          data: {
            items: [
              {
                identifier: 'LEO-7',
                title: '[P0][6/15][Draft ready] Heng Li 意向邮件',
                project: { name: 'Job or PhD?' },
                dueDate: '2026-06-15',
              },
            ],
          },
        },
      },
    },
    testConfig(),
  );
  assert.match(summary, /> Linear：Job or PhD\? · Due 2026-06-15 · P0/);
  assert.doesNotMatch(summary, /\n\s+Linear：Project/);
}

function testWeeklyReviewSummaryPrioritizesReviewEvidence(): void {
  const content = [
    '老板，我帮您整理了本周总结和下周安排。',
    '',
    '**1. 本周已经完成 / 已推进**',
    '',
    '确认的：本周主线已经从泛泛的 PhD / Job 选择，收口到 Poly / MOOSE / Heng Li 申请链路。证据来源是 Feishu Weekly2026 🐶 6.8-6.14 本周要务。',
    '确认的：`LEO-7 Heng Li 意向邮件` 已推进到发送前审核状态。证据来源是 Linear：`LEO-7 [P0][6/15][Draft ready][待周一发送]`。',
    '',
    '**2. 本周没做完 / 需要继续盯**',
    '',
    '未闭环：`LEO-7` 邮件是否真实发出。原因是 Weekly2026 把导师联系标成 `MIT ✅`，但 Linear 到 2026-06-14 仍显示 `In Review / Draft ready / 待周一发送`。',
    '未闭环：follow-up 日期没有证据。Weekly 要务明确要求记录 follow-up 日期，但当前证据里没有看到 follow-up 记录。',
    '',
    '**3. OKR / 优先级对齐**',
    '',
    '已确认决策规则影响排序：周日必须 review Feishu Weekly 🐶；博士 / 工作重大选择优先保护；Codex 可以先做草稿、检查表和方案拆解，最终判断、验收、对外发送由您本人完成。',
    '',
    '**4. 下周 MIT**',
    '',
    '下周唯一 MIT：`2026-06-15 发送 LEO-7 Heng Li 意向邮件，并记录收件人、附件、发送时间、follow-up 日期`。',
  ].join('\n');
  const summary = formatWorkflowSummaryForFeishu('weekly_review', '2026-06-14', content, undefined, testConfig());
  assert.match(summary, /先复盘本周/);
  assert.match(summary, /本周未闭环/);
  assert.match(summary, /LEO-7/);
  assert.match(summary, /follow-up/);
  assert.match(summary, /决策依据/);
  assert.doesNotMatch(summary, /\*\*下周先这样安排\*\*/);
}

function testWeeklyReviewSummaryShowsStructuredPriorityItems(): void {
  const content = [
    '老板，我帮您整理了本周总结和下周安排。',
    '',
    '**1. 本周已经完成 / 已推进**',
    '确认的：`LEO-7 Heng Li 意向邮件` 已推进到发送前审核状态。',
    '',
    '**2. 本周没做完 / 需要继续盯**',
    '逐条核对 🐶 本周要务：导师联系被 Weekly 标为 `MIT ✅`，但 Linear 仍显示待周一发送。',
    '',
    '**3. OKR / 优先级对齐**',
    '已确认决策规则影响排序：周日必须 review Feishu Weekly 🐶。',
  ].join('\n');
  const summary = formatWorkflowSummaryForFeishu(
    'weekly_review',
    '2026-06-14',
    content,
    {
      generated_at: '2026-06-14T00:00:00.000Z',
      date: '2026-06-14',
      sources: {
        weekly_priorities: {
          state: 'available',
          data: {
            week: '6.8-6.14',
            items: [
              { scope: '🐶', item: '完成 2026 年度 OKR 方向 review 收尾：明确未来 4 周唯一主线（延续上周⭕️）' },
              { scope: '🐶', item: 'Leon 学长强制令工具：完成 1 个付费文档上架（延续上周⭕️）' },
              { scope: '🐶', item: '个人 portfolio：把首版页面发给小企鹅 review，并按反馈改 1 轮（延续上周⭕️）' },
            ],
          },
        },
      },
    },
    testConfig(),
  );
  assert.match(summary, /Weekly 🐶 未完成/);
  assert.match(summary, /个人 portfolio/);
  assert.match(summary, /小企鹅 review/);
}

function testWeeklyPrioritiesExtractPortfolioReviewItem(): void {
  const xml = [
    '<title>Weekly2026</title>',
    '<table>',
    '<tbody>',
    '<tr><td><p>🐶 重点OKR</p></td><td><p>6.8-6.14 要务</p></td><td><p>retro</p></td></tr>',
    '<tr>',
    '<td><p>名利-Leon学长</p></td>',
    '<td><ol>',
    '<li>Leon 学长强制令工具：完成 1 个付费文档上架（延续上周⭕️）</li>',
    '<li>个人 portfolio：把首版页面发给小企鹅 review，并按反馈改 1 轮（延续上周⭕️）</li>',
    '<li>发布 2 条 build in public 内容：换导师 / AI 研究方向 / 读博选择</li>',
    '</ol></td>',
    '<td><p></p></td>',
    '</tr>',
    '</tbody>',
    '</table>',
  ].join('');
  const items = extractWeeklyPrioritiesFromXml(xml, '6.8-6.14', 'Weekly2026');
  assert.ok(
    items.some((item) => item.scope === '🐶' && /个人 portfolio/.test(item.item) && /小企鹅 review/.test(item.item)),
    'weekly priorities must preserve the portfolio review item as its own row',
  );
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
  config.memory.repository_path = path.join(tmp, 'repository');
  config.decision.candidates_path = path.join(tmp, 'decision-policy-candidates.md');
  return config;
}
