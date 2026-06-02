import type { AppConfig } from '../config/schema.js';
import { runCommand } from '../utils/command.js';
import type { EvidenceSource } from '../workflows/types.js';
import { sourceFromResult } from '../workflows/types.js';

export async function collectLinear(config: AppConfig): Promise<EvidenceSource> {
  const cfg = config.sources.linear;
  if (!cfg.enabled) return { state: 'disabled' };
  const token = process.env.LINEAR_API_KEY;
  if (!token) return collectLinearViaCodex(config);
  const body = {
    query: `
      query AssignedIssues($filter: IssueFilter) {
        issues(filter: $filter, first: 25, orderBy: updatedAt) {
          nodes { identifier title priority url state { name type } project { name } updatedAt dueDate }
        }
      }
    `,
    variables: {
      filter: {
        assignee: { isMe: { eq: true } },
        state: { type: { neq: 'completed' } },
      },
    },
  };
  try {
    const response = await fetch('https://api.linear.app/graphql', {
      method: 'POST',
      headers: { Authorization: token, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) return { state: 'error', detail: `Linear HTTP ${response.status}` };
    return sourceFromResult(await response.json());
  } catch (error) {
    return { state: 'error', detail: error instanceof Error ? error.message : String(error) };
  }
}

async function collectLinearViaCodex(config: AppConfig): Promise<EvidenceSource> {
  const codexBin = process.env.CODEX_BIN || 'codex';
  const prompt = `You are collecting Linear source evidence for a local Daily OS workflow.

Use the Linear connector available to this Codex account, if it is connected.
Return ONLY compact JSON, with no markdown fences and no commentary.

Required JSON shape:
{
  "source": "codex-linear",
  "items": [
    {
      "identifier": "LEO-123",
      "title": "Issue title",
      "priority": 0,
      "url": "https://linear.app/...",
      "state": {"name": "In Progress", "type": "started"},
      "project": {"name": "Project name"},
      "updatedAt": "ISO timestamp or null",
      "dueDate": "YYYY-MM-DD or null"
    }
  ]
}

Scope:
- Current user's assigned Linear issues.
- Exclude completed/canceled issues.
- Prefer issues matching this query when possible: ${config.sources.linear.query}
- Limit to 25 issues.

If the Linear connector is unavailable or not authenticated, return:
{"source":"codex-linear","error":"Linear connector is unavailable or not authenticated","items":[]}
`;

  const result = await runCommand(codexBin, ['exec', '--skip-git-repo-check', '--ignore-rules', '--ephemeral', '-'], {
    input: prompt,
    timeoutMs: 180000,
  });
  if (!result.ok) {
    return {
      state: 'missing',
      detail: `LINEAR_API_KEY is not configured and Codex Linear fallback failed: ${(result.stderr || result.stdout).slice(0, 500)}`,
    };
  }

  const text = result.stdout.trim();
  const parsed = parseCodexJson(text);
  if (!parsed) {
    return {
      state: 'error',
      detail: 'LINEAR_API_KEY is not configured and Codex Linear fallback returned non-JSON output',
      data: text.slice(0, 2000),
    };
  }

  if (typeof parsed === 'object' && parsed && 'error' in parsed) {
    return {
      state: 'missing',
      detail: String((parsed as Record<string, unknown>).error || 'Codex Linear fallback unavailable'),
      data: parsed,
    };
  }

  const source = sourceFromResult(parsed);
  return {
    ...source,
    detail: source.state === 'available' ? 'Collected through Codex Linear connector fallback' : 'Codex Linear connector fallback returned no issues',
  };
}

function parseCodexJson(text: string): unknown | null {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]) as unknown;
    } catch {
      return null;
    }
  }
}
