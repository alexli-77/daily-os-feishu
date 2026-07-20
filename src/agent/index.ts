import type { AgentInput } from './openai-agent.js';
import { runAnthropicAgent } from './anthropic-agent.js';
import { runClaudeAgent } from './claude-agent.js';
import { runCodexAgent } from './codex-agent.js';
import { runOpenAiAgent } from './openai-agent.js';

export async function runAgent(input: AgentInput): Promise<string> {
  const provider = input.config.llm.provider;
  // Policy note (2026-05): Anthropic sanctions headless `claude -p` / Agent SDK usage
  // under a subscription via the monthly Agent SDK credit (Pro $20 / Max $100-$200,
  // billed at API rates; rollout paused as of 2026-06, currently still subscription
  // limits). The `claude` CLI provider is therefore a compliant no-API-key path for
  // the operator's own instance. Customer instances must authenticate the customer's
  // own Claude account (credits are per-user) or use a BYOK API key.
  if (provider === 'codex') {
    console.warn(
      '[provider] codex CLI 用于程序化调度请确认 OpenAI 订阅条款允许，或改用 API-key provider（anthropic/openai）。',
    );
  } else if (provider === 'claude') {
    console.info(
      '[provider] claude CLI（headless）走订阅 Agent SDK 额度（2026-05 政策，Pro $20/月，暂未生效前仍计订阅额度）。注意：额度按用户计，客户实例须用客户自己的账号或 API key。',
    );
  }
  if (provider === 'anthropic') return runAnthropicAgent(input);
  if (provider === 'openai') return runOpenAiAgent(input);
  if (provider === 'claude') return runClaudeAgent(input);
  return runCodexAgent(input);
}
