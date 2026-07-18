import fs from 'node:fs';
import path from 'node:path';
import OpenAI from 'openai';
import type { AppConfig, WorkflowName } from '../config/schema.js';
import type { Evidence } from '../workflows/types.js';
import type { MemoryBundle } from '../storage/memory.js';
import { billingFromConfig, checkBudget, estimateCostUsd, recordUsage } from './token-meter.js';

export interface AgentInput {
  config: AppConfig;
  workflow: WorkflowName;
  date: string;
  evidence: Evidence;
  memory: MemoryBundle;
  /** Stable id for the current workflow run; used for per-task budget accounting. */
  runId?: string;
}

export async function runOpenAiAgent(input: AgentInput): Promise<string> {
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is required when llm.provider=openai');
  const billing = billingFromConfig(input.config);
  const runId = input.runId ?? `${input.workflow}-${input.date}`;
  // Three-tier budget circuit breaker: block the call if any tier is already spent.
  checkBudget(billing, { runId });
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const response = await client.chat.completions.create(
    {
      model: input.config.llm.model,
      messages: [
        { role: 'system', content: buildSystemPrompt() },
        { role: 'user', content: buildUserPrompt(input) },
      ],
    },
    { timeout: 180000 },
  );
  const inputTokens = response.usage?.prompt_tokens ?? 0;
  const outputTokens = response.usage?.completion_tokens ?? 0;
  const cost = estimateCostUsd(input.config.llm.model, inputTokens, outputTokens, billing.price_overrides);
  recordUsage(runId, 'openai', input.config.llm.model, inputTokens, outputTokens, cost);
  return normalizeAgentOutput(response.choices[0]?.message.content || '');
}

export function buildSystemPrompt(): string {
  return [readPrompt('system.md'), outputContract()].join('\n\n');
}

export function buildCliPrompt(input: AgentInput): string {
  return [`# System\n${buildSystemPrompt()}`, buildUserPrompt(input)].join('\n\n');
}

export function buildUserPrompt(input: AgentInput): string {
  const workflowPrompt = readPrompt(`${input.workflow}.md`);
  return [
    `# Workflow\n${workflowPrompt}`,
    `# User\n${JSON.stringify(input.config.user, null, 2)}`,
    `# Planning Configuration\n${JSON.stringify(input.config.planning, null, 2)}`,
    `# Date\n${input.date}`,
    `# Memory\n${JSON.stringify(input.memory, null, 2)}`,
    `# Evidence\n${JSON.stringify(input.evidence, null, 2)}`,
    '# 输出',
    '只返回最终可直接发送到飞书的消息。不要包含工具调用或隐藏推理过程。',
  ].join('\n\n');
}

export function normalizeAgentOutput(text: string): string {
  return text
    .replace(/^\s*```(?:markdown|md|text)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .split('\n')
    .map((line) =>
      line
        .replace(/^\s*-{3,}\s*$/, '')
        .replace(/^(\s*#{1,4}\s*)?\*\*\s*\d+[.)、]\s*([^*]+?)\s*\*\*\s*$/, '**$2**')
        .replace(/^(\s*#{1,4}\s*)?\d+[.)、]\s+(今日重点|为什么|Codex|用户|暂不|阻塞|重要信号|已完成|已推进|没完成|未闭环|需要您|明天|缺失|本周|下周|OKR|优先级|MIT)(.*)$/, '$1$2$3'),
    )
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function outputContract(): string {
  return [
    '# Daily OS 输出契约',
    '- 这个契约对 codex、claude、openai 三种 provider 都生效；provider 只能影响调用方式，不能影响用户看到的结构和语气。',
    '- 严格按当前 Workflow 要求的栏目输出；不要擅自新增“总结”“分析”“建议”等报告模板栏目。',
    '- 栏目标题不要编号；写“已完成 / 已推进”，不要写“1. 已完成 / 已推进”。',
    '- 不要使用 Markdown 分隔线 `---`、代码块、表格，除非 Workflow 明确要求。',
    '- 语气像真人助理给老板发工作便签：短句、具体、可执行。不要写成长篇项目报告。',
    '- 每条事项必须说明：是什么、为什么重要、下一步怎么处理；不能只写短标签。',
    '- 飞书卡片和看详情使用同一份正文，因此正文必须适合直接展示给用户。',
  ].join('\n');
}

function readPrompt(name: string): string {
  return fs.readFileSync(path.resolve('prompts', name), 'utf8');
}
