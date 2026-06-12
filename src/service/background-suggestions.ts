import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { AppConfig } from '../config/schema.js';
import {
  analyzeChatContext,
  type ChatAnalysisMode,
  type ChatContextAnalysisResult,
  type ChatContextSuggestion,
} from '../chat/context-analysis.js';
import { sendFeishuMessage } from '../connectors/lark-cli.js';

export interface BackgroundSuggestionsState {
  last_run_at?: string;
  next_run_at?: string;
  last_status?: 'success' | 'skipped' | 'error';
  last_error?: string;
  last_error_at?: string;
  last_suggestion_count?: number;
  last_inspected_messages?: number;
  last_sent_at?: string;
  last_signature?: string;
}

export async function runBackgroundSuggestions(config: AppConfig, now = new Date()): Promise<BackgroundSuggestionsState> {
  if (!config.background_suggestions.enabled) return readBackgroundSuggestionsState(config);
  const state = readBackgroundSuggestionsState(config);
  if (!isBackgroundSuggestionDue(config, state, now)) return state;

  try {
    const date = dateInZone(now, config.user.timezone);
    const result = await analyzeChatContext(config, date, config.background_suggestions.mode as ChatAnalysisMode);
    const suggestions = filterSuggestions(config, result.suggestions);
    const signature = suggestionSignature(suggestions);
    const nextState: BackgroundSuggestionsState = {
      ...state,
      last_run_at: now.toISOString(),
      next_run_at: nextRunAt(config, now).toISOString(),
      last_status: 'success',
      last_error: undefined,
      last_error_at: undefined,
      last_suggestion_count: suggestions.length,
      last_inspected_messages: result.inspected_messages,
      last_signature: signature,
    };

    const shouldSend =
      config.background_suggestions.send_to_feishu &&
      suggestions.length > 0 &&
      (!config.background_suggestions.send_on_change_only || signature !== state.last_signature);
    if (shouldSend) {
      await sendFeishuMessage(config, formatBackgroundSuggestionsMessage(result, suggestions));
      nextState.last_sent_at = now.toISOString();
    }

    writeBackgroundSuggestionsState(config, nextState);
    return nextState;
  } catch (error) {
    const nextState: BackgroundSuggestionsState = {
      ...state,
      last_run_at: now.toISOString(),
      next_run_at: nextRunAt(config, now).toISOString(),
      last_status: 'error',
      last_error: safeErrorSummary(error),
      last_error_at: now.toISOString(),
    };
    writeBackgroundSuggestionsState(config, nextState);
    return nextState;
  }
}

export function readBackgroundSuggestionsState(config: AppConfig): BackgroundSuggestionsState {
  const statePath = backgroundSuggestionsStatePath(config);
  if (!fs.existsSync(statePath)) {
    return {
      next_run_at: nextRunAt(config, new Date()).toISOString(),
      last_status: 'skipped',
    };
  }
  try {
    return sanitizeState(JSON.parse(fs.readFileSync(statePath, 'utf8')));
  } catch {
    return {
      next_run_at: nextRunAt(config, new Date()).toISOString(),
      last_status: 'error',
      last_error: 'Could not read background suggestions state file.',
    };
  }
}

function isBackgroundSuggestionDue(config: AppConfig, state: BackgroundSuggestionsState, now: Date): boolean {
  if (!config.chat_analysis.enabled) return false;
  if (!state.last_run_at) return true;
  const lastRun = Date.parse(state.last_run_at);
  if (!Number.isFinite(lastRun)) return true;
  return now.getTime() >= lastRun + config.background_suggestions.interval_minutes * 60_000;
}

function filterSuggestions(config: AppConfig, suggestions: ChatContextSuggestion[]): ChatContextSuggestion[] {
  const minimum = confidenceRank(config.background_suggestions.min_confidence);
  return suggestions.filter((suggestion) => confidenceRank(suggestion.confidence) >= minimum);
}

function formatBackgroundSuggestionsMessage(result: ChatContextAnalysisResult, suggestions: ChatContextSuggestion[]): string {
  return [
    `# 后台工作建议 - ${result.date}`,
    '',
    `我在后台检查了 ${result.inspected_messages} 条聊天信号，发现 ${suggestions.length} 条需要确认的建议。`,
    '',
    ...suggestions.slice(0, 5).flatMap((suggestion, index) => [
      `${index + 1}. ${confidenceLabel(suggestion.confidence)}：${suggestion.title}`,
      `   建议：${suggestion.summary}`,
      `   目标：${suggestion.targets.join('、')}`,
      ...(suggestion.due ? [`   时间：${suggestion.due}`] : []),
    ]),
    '',
    '这些只是后台建议，不会自动修改任务、日历、文档或 Linear。',
  ].join('\n');
}

function suggestionSignature(suggestions: ChatContextSuggestion[]): string {
  const ids = suggestions.map((suggestion) => suggestion.id).sort().join('\n');
  return crypto.createHash('sha256').update(ids).digest('hex').slice(0, 16);
}

function sanitizeState(value: unknown): BackgroundSuggestionsState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const raw = value as Record<string, unknown>;
  const out: BackgroundSuggestionsState = {};
  for (const key of [
    'last_run_at',
    'next_run_at',
    'last_error',
    'last_error_at',
    'last_sent_at',
    'last_signature',
  ] as const) {
    if (typeof raw[key] === 'string') out[key] = raw[key];
  }
  if (raw.last_status === 'success' || raw.last_status === 'skipped' || raw.last_status === 'error') out.last_status = raw.last_status;
  if (typeof raw.last_suggestion_count === 'number') out.last_suggestion_count = raw.last_suggestion_count;
  if (typeof raw.last_inspected_messages === 'number') out.last_inspected_messages = raw.last_inspected_messages;
  return out;
}

function writeBackgroundSuggestionsState(config: AppConfig, state: BackgroundSuggestionsState): void {
  const statePath = backgroundSuggestionsStatePath(config);
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8');
}

function backgroundSuggestionsStatePath(config: AppConfig): string {
  return path.resolve(config.background_suggestions.state_path);
}

function nextRunAt(config: AppConfig, now: Date): Date {
  return new Date(now.getTime() + config.background_suggestions.interval_minutes * 60_000);
}

function dateInZone(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function confidenceRank(value: 'low' | 'medium' | 'high'): number {
  return value === 'high' ? 3 : value === 'medium' ? 2 : 1;
}

function confidenceLabel(value: 'low' | 'medium' | 'high'): string {
  if (value === 'high') return '高置信度';
  if (value === 'medium') return '中置信度';
  return '低置信度';
}

function safeErrorSummary(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/(is required|not configured|disabled)/i.test(message)) return message.replace(/\s+/g, ' ').slice(0, 180);
  if (/Failed to send Feishu message/i.test(message)) return 'Failed to send Feishu message.';
  if (/Failed to read Feishu messages/i.test(message)) return 'Failed to read Feishu messages.';
  return 'Background suggestions run failed. Check service logs.';
}
