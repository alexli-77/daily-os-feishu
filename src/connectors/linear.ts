import type { AppConfig } from '../config/schema.js';
import type { EvidenceSource } from '../workflows/types.js';
import { sourceFromResult } from '../workflows/types.js';

export async function collectLinear(config: AppConfig): Promise<EvidenceSource> {
  const cfg = config.sources.linear;
  if (!cfg.enabled) return { state: 'disabled' };
  const token = process.env.LINEAR_API_KEY;
  if (!token) return { state: 'missing', detail: 'LINEAR_API_KEY is not configured' };
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

