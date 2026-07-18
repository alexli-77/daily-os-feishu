import type { AgentInput } from './openai-agent.js';
import { buildSystemPrompt, buildUserPrompt, normalizeAgentOutput } from './openai-agent.js';
import {
  billingFromConfig,
  checkBudget,
  estimateCostUsd,
  recordUsage,
} from './token-meter.js';

/**
 * Anthropic API-key provider — a first-class programmatic provider that talks to
 * the Anthropic Messages API directly over Node 22's built-in fetch. No SDK, no
 * new dependency. This is the compliant path for scheduled/programmatic runs
 * (subscription CLIs are not licensed for automation).
 */

const ANTHROPIC_MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MODEL = 'claude-sonnet-5';
const TIMEOUT_MS = 180000;
const MAX_TOKENS = 4096;

interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
}

interface AnthropicResponse {
  content?: Array<{ type?: string; text?: string }>;
  usage?: AnthropicUsage;
  error?: { type?: string; message?: string };
}

export function resolveAnthropicModel(model: string): string {
  const trimmed = (model ?? '').trim();
  if (['', 'default', 'auto'].includes(trimmed)) return DEFAULT_MODEL;
  return trimmed;
}

function runIdFor(input: AgentInput): string {
  return input.runId ?? `${input.workflow}-${input.date}`;
}

export async function runAnthropicAgent(input: AgentInput): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is required when llm.provider=anthropic');

  const model = resolveAnthropicModel(input.config.llm.model);
  const billing = billingFromConfig(input.config);
  const runId = runIdFor(input);

  // Three-tier budget circuit breaker: block the call if any tier is already spent.
  checkBudget(billing, { runId });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(ANTHROPIC_MESSAGES_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model,
        max_tokens: MAX_TOKENS,
        system: buildSystemPrompt(),
        messages: [{ role: 'user', content: buildUserPrompt(input) }],
      }),
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`Anthropic API timed out after ${TIMEOUT_MS}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }

  const raw = await response.text();
  let payload: AnthropicResponse;
  try {
    payload = JSON.parse(raw) as AnthropicResponse;
  } catch {
    throw new Error(`Anthropic API returned non-JSON response (status ${response.status}): ${raw.slice(0, 500)}`);
  }

  if (!response.ok || payload.error) {
    const message = payload.error?.message || raw.slice(0, 500);
    throw new Error(`Anthropic API failed (status ${response.status}): ${message}`);
  }

  const text = (payload.content ?? [])
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('');

  const inputTokens = payload.usage?.input_tokens ?? 0;
  const outputTokens = payload.usage?.output_tokens ?? 0;
  const cost = estimateCostUsd(model, inputTokens, outputTokens, billing.price_overrides);
  recordUsage(runId, 'anthropic', model, inputTokens, outputTokens, cost);

  return normalizeAgentOutput(text);
}
