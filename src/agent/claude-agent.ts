import os from 'node:os';
import { runCommand } from '../utils/command.js';
import type { AgentInput } from './openai-agent.js';
import { buildUserPrompt } from './openai-agent.js';

export async function runClaudeAgent(input: AgentInput): Promise<string> {
  const claudeBin = process.env.CLAUDE_BIN || 'claude';
  const prompt = buildUserPrompt(input);
  const args = ['-p', '--output-format', 'text', '--strict-mcp-config'];
  if (!['', 'default', 'auto'].includes(input.config.llm.model.trim())) {
    args.push('--model', input.config.llm.model);
  }
  const result = await runCommand(claudeBin, args, {
    input: prompt,
    timeoutMs: 180000,
    cwd: os.tmpdir(),
  });
  if (!result.ok) {
    throw new Error(`Claude Code failed: ${(result.stderr || result.stdout).slice(0, 3000)}`);
  }
  return result.stdout.trim();
}
