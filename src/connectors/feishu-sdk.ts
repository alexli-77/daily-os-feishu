import { AppType, Client, Domain, LoggerLevel } from '@larksuiteoapi/node-sdk';
import type { WorkflowName } from '../config/schema.js';
import type { CalendarDraftPeriod } from '../calendar/bridge.js';
import type { DailyPlanTableModel, DailyPlanTodo } from '../workflows/summary.js';

export type FeishuSdkSendMode = 'markdown' | 'text';

export interface FeishuSdkMessageOptions {
  workflow?: WorkflowName;
  date?: string;
  detailId?: string;
  /** Ranked daily todos (LEO-209) rendered as per-item completion buttons. */
  todos?: DailyPlanTodo[];
  /** When present, daily_plan renders as a card 2.0 table instead of markdown. */
  planTable?: DailyPlanTableModel;
}

/** Cap on per-todo completion buttons so the card stays compact. */
const MAX_TODO_BUTTONS = 5;

export interface FeishuSkillCardOptions {
  skillId: string;
  mode: string;
  provider: string;
  inputPackPath: string;
  draftOnly: boolean;
  runId?: string;
}

export interface FeishuSkillWritebackPreviewCardOptions {
  token: string;
  skillId: string;
  mode: string;
  docLabel: string;
  weekLabel: string;
  taskHeader: string;
  action: 'append_to_existing_empty_column' | 'insert_columns';
  items: Array<{ text: string; targetRowLabel: string; isMit: boolean }>;
}

export interface FeishuCalendarDraftCardOptions {
  period: CalendarDraftPeriod;
  date: string;
  eventCount: number;
  taskCount: number;
  engine?: 'external' | 'builtin';
  writebackSupported: boolean;
}

export interface FeishuSdkStatus {
  ok: boolean;
  missing: string[];
  detail?: string;
}

export function feishuSdkStatus(): FeishuSdkStatus {
  const missing = ['LARK_APP_ID', 'LARK_APP_SECRET'].filter((key) => !process.env[key]);
  return {
    ok: missing.length === 0,
    missing,
    detail:
      missing.length === 0
        ? 'SDK credentials are configured'
        : `Missing ${missing.join(', ')} for Feishu SDK output`,
  };
}

export async function sendFeishuSdkMessage(input: {
  chatId: string;
  text: string;
  mode: FeishuSdkSendMode;
  options?: FeishuSdkMessageOptions;
}): Promise<void> {
  const client = createFeishuClient();
  const message = sdkMessagePayload(input.text, input.mode, input.options);
  const result = await client.im.v1.message.create({
    params: { receive_id_type: 'chat_id' },
    data: {
      receive_id: input.chatId,
      msg_type: message.msgType,
      content: message.content,
    },
  });
  if (result.code && result.code !== 0) {
    throw new Error(`Feishu SDK send failed: ${result.code} ${result.msg || ''}`.trim());
  }
}

export async function sendFeishuSdkCard(input: { chatId: string; card: object }): Promise<void> {
  const client = createFeishuClient();
  const result = await client.im.v1.message.create({
    params: { receive_id_type: 'chat_id' },
    data: {
      receive_id: input.chatId,
      msg_type: 'interactive',
      content: JSON.stringify(input.card),
    },
  });
  if (result.code && result.code !== 0) {
    throw new Error(`Feishu SDK card send failed: ${result.code} ${result.msg || ''}`.trim());
  }
}

export async function createFeishuSdkPrivateChat(input: {
  name: string;
  description: string;
  ownerOpenId: string;
}): Promise<string> {
  const client = createFeishuClient();
  const result = await client.im.v1.chat.create({
    data: {
      name: input.name,
      description: input.description,
      chat_mode: 'group',
      chat_type: 'private',
      user_id_list: [input.ownerOpenId],
    },
    params: {
      user_id_type: 'open_id',
      set_bot_manager: true,
    },
  });
  if (result.code && result.code !== 0) {
    throw new Error(`Feishu SDK chat.create failed: ${result.code} ${result.msg || ''}`.trim());
  }
  const chatId = result.data?.chat_id;
  if (!chatId) throw new Error(`Feishu SDK chat.create returned no chat_id: ${JSON.stringify(result).slice(0, 300)}`);
  return chatId;
}

function createFeishuClient(): Client {
  const appId = process.env.LARK_APP_ID;
  const appSecret = process.env.LARK_APP_SECRET;
  if (!appId || !appSecret) {
    throw new Error('LARK_APP_ID and LARK_APP_SECRET are required for Feishu SDK output');
  }
  return new Client({
    appId,
    appSecret,
    appType: AppType.SelfBuild,
    domain: Domain.Feishu,
    loggerLevel: LoggerLevel.warn,
  });
}

function sdkMessagePayload(text: string, mode: FeishuSdkSendMode, options?: FeishuSdkMessageOptions): { msgType: string; content: string } {
  if (mode === 'text') return textPayload(text);
  const card =
    options?.workflow === 'daily_plan' && options.planTable?.rows.length
      ? renderFeishuPlanTableCard(options.planTable, options)
      : renderFeishuWorkflowCard(text, options);
  const content = JSON.stringify(card);
  // Feishu card bodies are stricter than text messages. When a workflow is
  // unexpectedly large, prefer delivering the message over failing the run.
  if (Buffer.byteLength(content, 'utf8') > 25_000) return textPayload(text);
  return { msgType: 'interactive', content };
}

/**
 * Card 2.0 daily-plan briefing: 🔴 follow-up markdown + a real table
 * (priority/status as colored tags, task cell with a clickable Linear link) +
 * the same action buttons as the classic card. Schema 2.0 buttons carry the
 * identical `value` payload inside `behaviors`, so the existing card-action
 * handler keeps working unchanged.
 */
export function renderFeishuPlanTableCard(table: DailyPlanTableModel, options?: FeishuSdkMessageOptions): object {
  const buttons = workflowActions('daily_plan', options).map((action) => {
    const legacy = action as { text?: object; type?: string; value?: Record<string, string> };
    return {
      tag: 'button',
      text: legacy.text,
      type: legacy.type,
      behaviors: [{ type: 'callback', value: legacy.value || {} }],
    };
  });
  return {
    schema: '2.0',
    header: {
      template: 'blue',
      title: { tag: 'plain_text', content: cardTitle('daily_plan') },
    },
    body: {
      elements: [
        ...(table.followupMd ? [{ tag: 'markdown', content: table.followupMd }, { tag: 'hr' }] : []),
        { tag: 'markdown', content: '🟡 **今日待办**' },
        {
          tag: 'table',
          page_size: Math.min(Math.max(table.rows.length, 1), 10),
          row_height: 'low',
          header_style: { bold: true, background_style: 'grey' },
          // Note: Feishu rejects arbitrary pixel widths (76px/104px failed with
          // ErrCode 200912); stick to these validated values.
          columns: [
            { name: 'priority', display_name: '优先级', data_type: 'options', width: '80px' },
            { name: 'task', display_name: '任务', data_type: 'lark_md', width: 'auto' },
            { name: 'due', display_name: '截止', data_type: 'text', width: '110px' },
            { name: 'status', display_name: '状态', data_type: 'options', width: '90px' },
          ],
          rows: table.rows.map((row) => ({
            priority: [{ text: row.priority, color: row.priorityColor }],
            task: row.taskMd,
            due: row.due,
            status: [{ text: row.status, color: row.statusColor }],
          })),
        },
        { tag: 'hr' },
        ...buttons,
        { tag: 'markdown', content: '<font color="grey">完成一条点「✅ 完成」；想调整点「我要调整」。</font>' },
      ],
    },
  };
}

export function renderFeishuWorkflowCard(text: string, options?: FeishuSdkMessageOptions): object {
  const workflow = options?.workflow;
  const actions = workflow ? workflowActions(workflow, options) : [];
  return {
    config: { wide_screen_mode: true },
    header: {
      template: headerTemplate(workflow),
      title: { tag: 'plain_text', content: cardTitle(workflow) },
    },
    elements: [
      {
        tag: 'markdown',
        content: stripTextOnlyInstructions(text),
      },
      ...(actions.length > 0
        ? [
            { tag: 'hr' },
            { tag: 'action', actions },
            { tag: 'note', elements: [{ tag: 'plain_text', content: '想看原因点详情；想改安排点调整；按钮不可用时直接回复 daily-os details。' }] },
          ]
        : []),
    ],
  };
}

export function renderFeishuSkillCard(text: string, options: FeishuSkillCardOptions): object {
  return {
    config: { wide_screen_mode: true },
    header: {
      template: 'purple',
      title: { tag: 'plain_text', content: `Skill: ${options.skillId}` },
    },
    elements: [
      {
        tag: 'markdown',
        content: [
          stripTextOnlyInstructions(text),
          '',
          '> 本次是草稿预览：不会自动修改 Feishu 文档。',
        ].join('\n'),
      },
      { tag: 'hr' },
      {
        tag: 'markdown',
        content: [`Provider：${options.provider}`, `Mode：${options.mode}`, `Input pack：${options.inputPackPath}`].join('\n'),
      },
      {
        tag: 'action',
        actions: [
          cardButton('重新生成', { daily_os_skill_action: 'rerun', skill_id: options.skillId, mode: options.mode }, 'primary'),
          cardButton(
            '准备写回',
            {
              daily_os_skill_action: 'prepare_writeback',
              skill_id: options.skillId,
              mode: options.mode,
              ...(options.runId ? { run_id: options.runId } : {}),
            },
            'default',
          ),
          cardButton('先不写回', { daily_os_skill_action: 'dismiss', skill_id: options.skillId, mode: options.mode }, 'default'),
        ],
      },
      {
        tag: 'note',
        elements: [
          {
            tag: 'plain_text',
            content: '点「准备写回」只会生成二次确认卡；确认目标周列和内容后才会修改 Feishu Doc。',
          },
        ],
      },
    ],
  };
}

export function renderFeishuSkillWritebackPreviewCard(options: FeishuSkillWritebackPreviewCardOptions): object {
  const itemLines = options.items
    .map((item, index) => `${index + 1}. ${item.isMit ? '**MIT** ' : ''}${item.text}\n   > ${item.targetRowLabel}`)
    .join('\n');
  return {
    config: { wide_screen_mode: true },
    header: {
      template: 'orange',
      title: { tag: 'plain_text', content: '确认写回 Feishu' },
    },
    elements: [
      {
        tag: 'markdown',
        content: [
          '我准备把这次 weekly-review 草稿写回 Feishu Weekly。',
          '',
          `> 目标：${options.docLabel} · ${options.weekLabel} · ${options.taskHeader}`,
          `> 操作：${options.action === 'insert_columns' ? '插入新周列并写入' : '写入已有空周列'}`,
          '',
          '**将写入这些要务**',
          itemLines || '（没有可写入要务）',
        ].join('\n'),
      },
      { tag: 'hr' },
      {
        tag: 'action',
        actions: [
          cardButton('确认写回', { daily_os_skill_action: 'execute_writeback', skill_id: options.skillId, mode: options.mode, token: options.token }, 'primary'),
          cardButton('取消', { daily_os_skill_action: 'dismiss', skill_id: options.skillId, mode: options.mode }, 'default'),
        ],
      },
      {
        tag: 'note',
        elements: [{ tag: 'plain_text', content: '如果目标列已有内容，执行会自动停止，不会覆盖。确认 token 30 分钟内有效。' }],
      },
    ],
  };
}

export function renderFeishuCalendarDraftCard(text: string, options: FeishuCalendarDraftCardOptions): object {
  return {
    config: { wide_screen_mode: true },
    header: {
      template: 'turquoise',
      title: { tag: 'plain_text', content: options.period === 'week' ? '本周日历草稿' : '今日日历草稿' },
    },
    elements: [
      {
        tag: 'markdown',
        content: [
          stripTextOnlyInstructions(text),
          '',
          `> ${options.date} · ${options.taskCount} 个任务 · ${options.eventCount} 个时间块 · ${options.engine || 'external'} engine`,
          options.writebackSupported ? '> Calendar writeback: engine reports supported.' : '> Calendar writeback: 当前关闭；这张卡不会修改任何日历。',
        ].join('\n'),
      },
      { tag: 'hr' },
      {
        tag: 'action',
        actions: [
          cardButton('确认草稿', { daily_os_calendar_action: 'confirm', period: options.period }, 'primary'),
          cardButton('我要调整', { daily_os_calendar_action: 'adjust', period: options.period }, 'default'),
          cardButton('先不排', { daily_os_calendar_action: 'skip', period: options.period }, 'default'),
        ],
      },
      {
        tag: 'note',
        elements: [{ tag: 'plain_text', content: '确认只记录你认可这版草稿；真实写入 Feishu / Apple / Google Calendar 会单独确认。' }],
      },
    ],
  };
}

function workflowActions(workflow: WorkflowName, options?: FeishuSdkMessageOptions): object[] {
  const actions: object[] = [cardButton('看详情', { daily_os_command: 'details', ...(options?.detailId ? { detail_id: options.detailId } : {}) }, 'primary')];
  if (workflow === 'daily_plan') {
    for (const todo of (options?.todos ?? []).slice(0, MAX_TODO_BUTTONS)) {
      actions.push(
        cardButton(`✅ 完成 ${todo.rank}`, { daily_os_todo_action: 'complete', candidate_id: todo.candidateId, rank: String(todo.rank) }, 'default'),
      );
    }
    actions.push(cardButton('就按这个来', { daily_os_command: 'confirm_todo' }, 'default'));
    actions.push(cardButton('我要调整', { daily_os_command: 'revise_todo' }, 'default'));
    actions.push(cardButton('今晚复盘', { daily_os_action: 'daily_review' }, 'default'));
  }
  if (workflow === 'daily_review') {
    actions.push(cardButton('无异议，确认复盘', { daily_os_command: 'confirm_review' }, 'default'));
    actions.push(cardButton('明天继续未闭环任务', { daily_os_command: 'carry_open_review' }, 'default'));
  }
  actions.push(cardButton('重排一次', { daily_os_action: workflow }, 'default'));
  return actions;
}

function cardButton(label: string, value: Record<string, string>, type: 'primary' | 'default'): object {
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: label },
    type,
    value,
  };
}

function cardTitle(workflow?: WorkflowName): string {
  if (workflow === 'daily_plan') return '今日安排';
  if (workflow === 'daily_review') return '今日复盘';
  if (workflow === 'weekly_review') return '本周复盘';
  return 'Daily OS';
}

function headerTemplate(workflow?: WorkflowName): string {
  if (workflow === 'daily_plan') return 'blue';
  if (workflow === 'daily_review') return 'green';
  if (workflow === 'weekly_review') return 'purple';
  return 'wathet';
}

function stripTextOnlyInstructions(text: string): string {
  return text
    .split('\n')
    .filter((line) => !/完整内容我已经保存。需要展开时/.test(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function textPayload(text: string): { msgType: string; content: string } {
  return {
    msgType: 'text',
    content: JSON.stringify({ text }),
  };
}
