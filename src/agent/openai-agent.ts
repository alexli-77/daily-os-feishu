import fs from 'node:fs';
import path from 'node:path';
import OpenAI from 'openai';
import type { AppConfig, WorkflowName } from '../config/schema.js';
import type { Evidence } from '../workflows/types.js';
import type { MemoryBundle } from '../storage/memory.js';

export interface AgentInput {
  config: AppConfig;
  workflow: WorkflowName;
  date: string;
  evidence: Evidence;
  memory: MemoryBundle;
}

export async function runOpenAiAgent(input: AgentInput): Promise<string> {
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is required when llm.provider=openai');
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const response = await client.chat.completions.create({
    model: input.config.llm.model,
    messages: [
      { role: 'system', content: readPrompt('system.md') },
      { role: 'user', content: buildUserPrompt(input) },
    ],
  });
  return response.choices[0]?.message.content?.trim() || '';
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

function readPrompt(name: string): string {
  return fs.readFileSync(path.resolve('prompts', name), 'utf8');
}
