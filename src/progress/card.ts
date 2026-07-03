import crypto from 'node:crypto';
import type { AppConfig } from '../config/schema.js';
import type { ProgressCaptureResult } from './capture.js';

export type ProgressCardAction = 'confirm_all' | 'ignore_all' | 'details' | 'review';

export interface ParsedProgressCardAction {
  action: ProgressCardAction;
  date: string;
  candidateIds: string[];
}

export function renderProgressConfirmationCard(config: AppConfig, result: ProgressCaptureResult): object {
  const candidateIds = result.candidates.map((candidate) => candidate.id);
  const hasCandidates = result.candidates.length > 0;
  return {
    config: { wide_screen_mode: true },
    header: {
      template: hasCandidates ? 'blue' : 'orange',
      title: { tag: 'plain_text', content: '今日进展确认' },
    },
    elements: [
      {
        tag: 'markdown',
        content:
          result.candidates.length > 0
            ? [
                '我看到这些可能是今天的进展。它们还不是事实，确认后才会写入今日进展账本。',
                '',
                ...candidateSummaryLines(result),
                '',
                '需要看来源和依据时点「查看详情」。',
              ].join('\n')
            : [
                '目前还没有看到可靠的今日进展候选。',
                '',
                '如果你今天确实推进了事情，可以直接在聊天里发一句：',
                '`daily-os remember 今天进展：...`',
              ].join('\n'),
      },
      {
        tag: 'action',
        actions: progressCardButtons(config, result.date, candidateIds, hasCandidates),
      },
    ],
  };
}

export function renderProgressBatchReviewCard(config: AppConfig, result: ProgressCaptureResult): object {
  const candidateIds = result.candidates.map((candidate) => candidate.id);
  return {
    config: { wide_screen_mode: true },
    header: {
      template: 'blue',
      title: { tag: 'plain_text', content: '进展逐条确认' },
    },
    elements: [
      {
        tag: 'markdown',
        content: [
          '一次性回复所有编号即可，不需要一条条确认。',
          '',
          ...result.candidates.map(
            (candidate, index) =>
              `${index + 1}. **${escapeMarkdown(candidate.title)}**\n   > 可回复：${index + 1}完成 / ${index + 1}继续 / ${index + 1}忽略`,
          ),
          '',
          '示例：`1完成，2继续，3忽略`',
          '也可以回复：`全部完成` / `全部明天继续` / `全部忽略`。',
        ].join('\n'),
      },
      {
        tag: 'action',
        actions: [
          button('确认全部', progressActionValue(config, 'confirm_all', result.date, candidateIds), 'primary'),
          button('先不写入', progressActionValue(config, 'ignore_all', result.date, candidateIds), 'default'),
          button('查看详情', progressActionValue(config, 'details', result.date, candidateIds), 'default'),
        ],
      },
    ],
  };
}

export function parseProgressCardAction(value: unknown, config: AppConfig): ParsedProgressCardAction | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const action = raw.daily_os_progress_action;
  const date = raw.daily_os_progress_date;
  const token = raw.daily_os_progress_token;
  const candidateIds = Array.isArray(raw.daily_os_progress_candidate_ids)
    ? raw.daily_os_progress_candidate_ids.filter((id): id is string => typeof id === 'string')
    : [];
  if (!isProgressAction(action) || typeof date !== 'string' || typeof token !== 'string') return null;
  const expected = signProgressAction(config, action, date, candidateIds);
  if (!timingSafeEqual(token, expected)) return null;
  return { action, date, candidateIds };
}

function candidateSummaryLines(result: ProgressCaptureResult): string[] {
  const visible = result.candidates.slice(0, 5).map((candidate, index) => `${index + 1}. **${escapeMarkdown(candidate.title)}**`);
  if (result.candidates.length <= visible.length) return visible;
  return [...visible, `还有 ${result.candidates.length - visible.length} 条候选，点「查看详情」展开。`];
}

function progressCardButtons(config: AppConfig, date: string, candidateIds: string[], hasCandidates: boolean): object[] {
  if (!hasCandidates) {
    return [
      button('查看详情', progressActionValue(config, 'details', date, candidateIds), 'default'),
      button('先不写入', progressActionValue(config, 'ignore_all', date, candidateIds), 'default'),
    ];
  }
  return [
    button('确认全部', progressActionValue(config, 'confirm_all', date, candidateIds), 'primary'),
    button('逐条确认', progressActionValue(config, 'review', date, candidateIds), 'default'),
    button('先不写入', progressActionValue(config, 'ignore_all', date, candidateIds), 'default'),
    button('查看详情', progressActionValue(config, 'details', date, candidateIds), 'default'),
  ];
}

function button(label: string, value: Record<string, unknown>, type: 'primary' | 'default'): object {
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: label },
    type,
    value,
  };
}

function progressActionValue(config: AppConfig, action: ProgressCardAction, date: string, candidateIds: string[]): Record<string, unknown> {
  return {
    daily_os_progress_action: action,
    daily_os_progress_date: date,
    daily_os_progress_candidate_ids: candidateIds,
    daily_os_progress_token: signProgressAction(config, action, date, candidateIds),
  };
}

function signProgressAction(config: AppConfig, action: ProgressCardAction, date: string, candidateIds: string[]): string {
  const secret = process.env.LARK_APP_SECRET || process.env.DAILY_OS_CALLBACK_SECRET || config.assistant.name;
  return crypto.createHmac('sha256', secret).update(`${action}:${date}:${candidateIds.join(',')}`).digest('hex');
}

function timingSafeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function isProgressAction(value: unknown): value is ProgressCardAction {
  return value === 'confirm_all' || value === 'ignore_all' || value === 'details' || value === 'review';
}

function escapeMarkdown(value: string): string {
  return value.replace(/\|/g, '\\|');
}
