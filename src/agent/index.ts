import type { AgentInput } from './openai-agent.js';
import { runClaudeAgent } from './claude-agent.js';
import { runCodexAgent } from './codex-agent.js';
import { runOpenAiAgent } from './openai-agent.js';

export async function runAgent(input: AgentInput): Promise<string> {
  if (input.config.llm.provider === 'openai') return runOpenAiAgent(input);
  if (input.config.llm.provider === 'claude') return runClaudeAgent(input);
  return runCodexAgent(input);
}
