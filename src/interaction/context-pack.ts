import fs from 'node:fs';
import path from 'node:path';
import type { AppConfig, WorkflowName } from '../config/schema.js';
import { ensureDecisionPolicyFiles } from '../decision/policy.js';
import { listPolicyCandidates } from '../decision/candidates.js';
import { readProgressLedger } from '../progress/capture.js';
import { readLatestWorkflowOutput } from '../storage/memory.js';
import { todayInTimezone } from '../utils/date.js';
import { collectEvidence } from '../workflows/evidence.js';
import type { Evidence, EvidenceSource } from '../workflows/types.js';
import { readPendingBackgroundSuggestions, type PendingBackgroundSuggestion } from '../service/background-suggestions.js';

export interface FeishuAgentContextPack {
  generated_at: string;
  date: string;
  purpose: string;
  user: {
    display_name: string;
    timezone: string;
  };
  latest_workflow?: {
    workflow: WorkflowName;
    date: string;
    generated_at: string;
    summary: string;
  };
  progress_ledger?: {
    state: 'available' | 'empty';
    content: string;
  };
  decision_policy?: {
    repository: string;
    yaml: string;
    notes: string;
    pending_candidates: Array<{
      id: string;
      description: string;
      applies_to: string[];
      reason?: string;
    }>;
  };
  evidence?: {
    generated_at: string;
    source_states: Record<string, string>;
    available_sources: ContextEvidenceSource[];
    missing_or_empty_sources: Array<{ name: string; state: string; detail?: string }>;
  };
  pending_background_suggestions?: {
    created_at: string;
    expires_at: string;
    date: string;
    mode: string;
    window_label: string;
    suggestions: PendingBackgroundSuggestion[];
  };
  assistant_guidance: string[];
}

interface ContextEvidenceSource {
  name: string;
  state: string;
  detail?: string;
  samples: string[];
}

export async function buildFeishuAgentContextPack(config: AppConfig): Promise<FeishuAgentContextPack> {
  const date = todayInTimezone(config);
  const packConfig = config.interaction.feishu.agent_mode.context_pack;
  const pack: FeishuAgentContextPack = {
    generated_at: new Date().toISOString(),
    date,
    purpose: 'Compact Daily OS context for Feishu free-form Codex agent conversations.',
    user: {
      display_name: config.user.display_name,
      timezone: config.user.timezone,
    },
    assistant_guidance: [
      '先用这个 context pack 判断用户当前在问计划、复盘、任务执行还是规则校准。',
      '回答时优先引用已确认的 memory、最新 workflow、progress ledger 和可用证据摘要。',
      '区分三类事项：已确认的、暂缓的、新增的。',
      '明确说明哪些事情可以由 Codex 做，哪些需要用户本人判断、沟通或批准。',
      '如果证据不足，说明缺哪类证据，并给出一个最小可执行下一步。',
      '不要把候选规则写成长期规则；长期规则必须由用户确认。',
      '如果用户说“第 N 条”“刚才那条”“忽略/写入/修改”，优先对照 pending_background_suggestions 理解他的自然语言指令。',
      '处理 pending_background_suggestions 时，不要要求用户使用固定命令；能执行就执行，不能执行就说明还缺什么权限或信息。',
    ],
  };

  if (packConfig.include_latest_workflow) {
    const latest = readLatestWorkflowOutput(config);
    if (latest) {
      pack.latest_workflow = {
        workflow: latest.workflow,
        date: latest.date,
        generated_at: latest.generated_at,
        summary: truncate(cleanText(latest.content), packConfig.max_chars_per_item),
      };
    }
  }

  if (packConfig.include_progress_ledger) {
    const ledger = readProgressLedger(config, date).trim();
    pack.progress_ledger = {
      state: ledger ? 'available' : 'empty',
      content: truncate(ledger, packConfig.max_chars_per_item),
    };
  }

  if (packConfig.include_decision_policy) {
    pack.decision_policy = buildDecisionPolicyContext(config, packConfig.max_chars_per_item);
  }

  if (packConfig.include_evidence_summary) {
    pack.evidence = summarizeEvidence(await collectEvidence(config, date), {
      maxSources: packConfig.max_sources,
      maxItemsPerSource: packConfig.max_items_per_source,
      maxCharsPerItem: packConfig.max_chars_per_item,
    });
  }

  const pending = readPendingBackgroundSuggestions(config);
  if (pending) {
    pack.pending_background_suggestions = pending;
  }

  return pack;
}

function buildDecisionPolicyContext(config: AppConfig, maxChars: number): NonNullable<FeishuAgentContextPack['decision_policy']> {
  const files = ensureDecisionPolicyFiles(config);
  return {
    repository: path.basename(files.repositoryPath),
    yaml: readFilePreview(files.policyPath, maxChars),
    notes: readFilePreview(files.notesPath, maxChars),
    pending_candidates: listPolicyCandidates(config, 'pending').slice(0, 8).map((candidate) => ({
      id: candidate.id,
      description: candidate.rule.description,
      applies_to: candidate.rule.applies_to || [],
      ...(candidate.rule.reason ? { reason: candidate.rule.reason } : {}),
    })),
  };
}

function summarizeEvidence(
  evidence: Evidence,
  options: { maxSources: number; maxItemsPerSource: number; maxCharsPerItem: number },
): NonNullable<FeishuAgentContextPack['evidence']> {
  const entries = Object.entries(evidence.sources);
  const available = entries.filter(([, source]) => source.state === 'available');
  const missingOrEmpty = entries.filter(([, source]) => source.state !== 'available');
  return {
    generated_at: evidence.generated_at,
    source_states: Object.fromEntries(entries.map(([name, source]) => [name, source.state])),
    available_sources: available.slice(0, options.maxSources).map(([name, source]) => ({
      name,
      state: source.state,
      ...(source.detail ? { detail: source.detail } : {}),
      samples: sourceSamples(source, options.maxItemsPerSource, options.maxCharsPerItem),
    })),
    missing_or_empty_sources: missingOrEmpty.slice(0, options.maxSources).map(([name, source]) => ({
      name,
      state: source.state,
      ...(source.detail ? { detail: source.detail } : {}),
    })),
  };
}

function sourceSamples(source: EvidenceSource, maxItems: number, maxChars: number): string[] {
  const data = source.data;
  if (data == null) return [];
  if (typeof data === 'string') return splitTextSamples(data, maxItems, maxChars);
  if (Array.isArray(data)) {
    return data.slice(0, maxItems).map((item) => truncate(stringifySample(item), maxChars));
  }
  if (typeof data === 'object') {
    return objectSamples(data as Record<string, unknown>, maxItems, maxChars);
  }
  return [truncate(String(data), maxChars)];
}

function objectSamples(data: Record<string, unknown>, maxItems: number, maxChars: number): string[] {
  const samples: string[] = [];
  for (const [key, value] of Object.entries(data)) {
    if (samples.length >= maxItems) break;
    if (value == null) continue;
    if (typeof value === 'string') {
      samples.push(`${key}: ${truncate(cleanText(value), maxChars)}`);
    } else if (Array.isArray(value)) {
      const preview = value.slice(0, Math.max(1, Math.min(3, maxItems))).map(stringifySample).join(' | ');
      if (preview) samples.push(`${key}: ${truncate(preview, maxChars)}`);
    } else if (typeof value === 'object') {
      samples.push(`${key}: ${truncate(stringifySample(value), maxChars)}`);
    } else {
      samples.push(`${key}: ${String(value)}`);
    }
  }
  return samples;
}

function splitTextSamples(text: string, maxItems: number, maxChars: number): string[] {
  return cleanText(text)
    .split(/\n{2,}|(?<=[。！？.!?])\s+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, maxItems)
    .map((item) => truncate(item, maxChars));
}

function stringifySample(value: unknown): string {
  if (typeof value === 'string') return cleanText(value);
  try {
    return cleanText(JSON.stringify(value));
  } catch {
    return String(value);
  }
}

function readFilePreview(filePath: string, maxChars: number): string {
  if (!fs.existsSync(filePath)) return '';
  return truncate(fs.readFileSync(filePath, 'utf8').trim(), maxChars);
}

function cleanText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}
