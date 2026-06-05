import crypto from 'node:crypto';
import type { LarkChannel, NormalizedMessage } from '@larksuiteoapi/node-sdk';
import type { AppConfig } from '../config/schema.js';

export type AgentRunCardStatus = 'running' | 'stopping' | 'success' | 'failed' | 'timeout' | 'stopped';

export interface AgentRunCardEvent {
  type: 'started' | 'thread' | 'progress' | 'stderr' | 'final';
  message: string;
}

export interface AgentRunCardAction {
  action: 'stop' | 'followup';
  runId: string;
  scopeId: string;
  text?: string;
}

interface AgentRunCardState {
  runId: string;
  scopeId: string;
  status: AgentRunCardStatus;
  startedAt: string;
  updatedAt: string;
  title: string;
  progress: string[];
  result?: string;
  error?: string;
}

interface AgentRunCardControllerInput {
  config: AppConfig;
  channel: LarkChannel;
  message: NormalizedMessage;
  runId: string;
  scopeId: string;
  title?: string;
}

const MAX_PROGRESS_LINES = 8;
const MAX_RESULT_CHARS = 2500;
const UPDATE_THROTTLE_MS = 900;

export class AgentRunCardController {
  private readonly config: AppConfig;
  private readonly channel: LarkChannel;
  private readonly message: NormalizedMessage;
  private readonly state: AgentRunCardState;
  private messageId?: string;
  private lastUpdateAt = 0;
  private updateTimer?: NodeJS.Timeout;
  private pending = false;

  constructor(input: AgentRunCardControllerInput) {
    this.config = input.config;
    this.channel = input.channel;
    this.message = input.message;
    this.state = {
      runId: input.runId,
      scopeId: input.scopeId,
      status: 'running',
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      title: input.title || 'Codex 正在处理',
      progress: ['已收到请求，正在启动 Codex。'],
    };
  }

  async send(): Promise<void> {
    const result = await this.channel.send(
      this.message.chatId,
      { card: renderAgentRunCard(this.config, this.state) },
      {
        replyTo: this.message.messageId,
        ...(this.message.threadId ? { replyInThread: true } : {}),
      },
    );
    this.messageId = result.messageId;
  }

  record(event: AgentRunCardEvent): void {
    if (event.type === 'stderr' && !event.message.trim()) return;
    this.pushProgress(event.message);
    void this.updateThrottled();
  }

  async markStopping(): Promise<void> {
    this.state.status = 'stopping';
    this.pushProgress('已收到停止请求，正在结束当前 Codex 任务。');
    await this.updateNow();
  }

  async finalize(status: Exclude<AgentRunCardStatus, 'running' | 'stopping'>, result: string): Promise<void> {
    this.state.status = status;
    if (status === 'failed') this.state.error = result;
    else this.state.result = result;
    this.pushProgress(finalProgressText(status));
    await this.updateNow();
  }

  private pushProgress(message: string): void {
    const normalized = message.replace(/\s+/g, ' ').trim();
    if (!normalized) return;
    const last = this.state.progress[this.state.progress.length - 1];
    if (last !== normalized) this.state.progress.push(normalized);
    this.state.progress = this.state.progress.slice(-MAX_PROGRESS_LINES);
    this.state.updatedAt = new Date().toISOString();
  }

  private async updateThrottled(): Promise<void> {
    if (!this.messageId) {
      this.pending = true;
      return;
    }
    const elapsed = Date.now() - this.lastUpdateAt;
    if (elapsed >= UPDATE_THROTTLE_MS) {
      await this.updateNow();
      return;
    }
    if (this.updateTimer) return;
    this.updateTimer = setTimeout(() => {
      this.updateTimer = undefined;
      void this.updateNow();
    }, UPDATE_THROTTLE_MS - elapsed);
  }

  private async updateNow(): Promise<void> {
    if (!this.messageId) {
      this.pending = true;
      return;
    }
    if (this.updateTimer) {
      clearTimeout(this.updateTimer);
      this.updateTimer = undefined;
    }
    this.pending = false;
    this.lastUpdateAt = Date.now();
    try {
      await this.channel.updateCard(this.messageId, renderAgentRunCard(this.config, this.state));
    } catch (error) {
      console.warn(`[interaction] failed to update run card ${this.state.runId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async flushPending(): Promise<void> {
    if (this.pending) await this.updateNow();
  }
}

export function parseAgentRunCardAction(value: unknown, config: AppConfig): AgentRunCardAction | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const action = raw.daily_os_agent_action;
  const runId = raw.daily_os_run_id;
  const scopeId = raw.daily_os_scope_id;
  const token = raw.daily_os_token;
  if ((action !== 'stop' && action !== 'followup') || typeof runId !== 'string' || typeof scopeId !== 'string' || typeof token !== 'string') {
    return null;
  }
  const expected = signAgentRunAction(config, { action, runId, scopeId });
  if (!timingSafeEqual(token, expected)) return null;
  const text = typeof raw.daily_os_followup_text === 'string' ? raw.daily_os_followup_text : undefined;
  return { action, runId, scopeId, ...(text ? { text } : {}) };
}

function renderAgentRunCard(config: AppConfig, state: AgentRunCardState): object {
  return {
    config: { wide_screen_mode: true },
    header: {
      template: headerTemplate(state.status),
      title: { tag: 'plain_text', content: headerTitle(state.status) },
    },
    elements: [
      {
        tag: 'markdown',
        content: [
          `**${state.title}**`,
          '',
          `状态：${statusText(state.status)}`,
          `Run ID：\`${state.runId}\``,
          `更新时间：${formatTime(state.updatedAt)}`,
        ].join('\n'),
      },
      { tag: 'hr' },
      {
        tag: 'markdown',
        content: state.progress.map((line) => `- ${line}`).join('\n') || '- 等待进度。',
      },
      ...resultElements(state),
      ...actionElements(config, state),
    ],
  };
}

function actionElements(config: AppConfig, state: AgentRunCardState): object[] {
  if (state.status === 'running' || state.status === 'stopping') {
    return [
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '停止' },
            type: 'danger',
            value: actionValue(config, state, 'stop'),
          },
        ],
      },
    ];
  }
  if (state.status === 'success') {
    return [
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '继续讨论' },
            type: 'default',
            value: {
              ...actionValue(config, state, 'followup'),
              daily_os_followup_text: '请基于刚才的结果，继续说明下一步建议。',
            },
          },
        ],
      },
    ];
  }
  return [];
}

function actionValue(config: AppConfig, state: AgentRunCardState, action: AgentRunCardAction['action']): Record<string, string> {
  return {
    daily_os_agent_action: action,
    daily_os_run_id: state.runId,
    daily_os_scope_id: state.scopeId,
    daily_os_token: signAgentRunAction(config, { action, runId: state.runId, scopeId: state.scopeId }),
  };
}

function resultElements(state: AgentRunCardState): object[] {
  if (state.status === 'failed' && state.error) {
    return [
      { tag: 'hr' },
      { tag: 'markdown', content: `**错误**\n${truncate(state.error, MAX_RESULT_CHARS)}` },
    ];
  }
  if ((state.status === 'success' || state.status === 'stopped' || state.status === 'timeout') && state.result) {
    return [
      { tag: 'hr' },
      { tag: 'markdown', content: truncate(state.result, MAX_RESULT_CHARS) },
    ];
  }
  return [];
}

function signAgentRunAction(
  config: AppConfig,
  input: { action: AgentRunCardAction['action']; runId: string; scopeId: string },
): string {
  const secret = process.env.LARK_APP_SECRET || process.env.DAILY_OS_CALLBACK_SECRET || config.assistant.name;
  return crypto.createHmac('sha256', secret).update(`${input.action}:${input.runId}:${input.scopeId}`).digest('hex');
}

function timingSafeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function headerTemplate(status: AgentRunCardStatus): string {
  if (status === 'success') return 'green';
  if (status === 'failed' || status === 'timeout') return 'red';
  if (status === 'stopped') return 'orange';
  return 'blue';
}

function headerTitle(status: AgentRunCardStatus): string {
  if (status === 'success') return 'Daily OS 已完成';
  if (status === 'failed') return 'Daily OS 执行失败';
  if (status === 'timeout') return 'Daily OS 执行超时';
  if (status === 'stopped') return 'Daily OS 已停止';
  if (status === 'stopping') return 'Daily OS 正在停止';
  return 'Daily OS 正在运行';
}

function statusText(status: AgentRunCardStatus): string {
  return {
    running: '运行中',
    stopping: '停止中',
    success: '成功',
    failed: '失败',
    timeout: '超时',
    stopped: '已停止',
  }[status];
}

function finalProgressText(status: Exclude<AgentRunCardStatus, 'running' | 'stopping'>): string {
  return {
    success: 'Codex 已完成并返回结果。',
    failed: 'Codex 执行失败。',
    timeout: 'Codex 执行超时。',
    stopped: 'Codex 已停止。',
  }[status];
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString('zh-CN', { hour12: false });
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}...` : value;
}
