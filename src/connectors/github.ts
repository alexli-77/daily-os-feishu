import type { EvidenceSource } from '../workflows/types.js';
import { sourceFromResult } from '../workflows/types.js';
import type { AppConfig } from '../config/schema.js';

/**
 * How much of an issue body survives into the evidence.
 *
 * A planning agent needs to know what an issue is about, not to read it. The
 * raw field runs to 24k characters on a long PR description, and forty of those
 * is the whole context window — so the first paragraph or two is the deal:
 * enough to rank the issue against the rest of the day, nothing like enough to
 * work from. Whoever actually picks the issue up opens `url`.
 */
const BODY_LIMIT = 500;

/**
 * The fields a daily plan can act on.
 *
 * Everything else the REST API returns is addressing and bookkeeping —
 * `labels_url`, `events_url`, `timeline_url`, `node_id`,
 * `performed_via_github_app`, a full user object per issue, a reactions
 * breakdown. None of it can change what the user should do today, and together
 * with untruncated bodies it accounted for 42% of a prompt that no longer fit
 * in any model's context window.
 */
interface LeanIssue {
  number: number;
  title: string;
  state: string;
  url: string;
  is_pull_request: boolean;
  draft?: boolean;
  author: string;
  assignees: string[];
  labels: string[];
  comments: number;
  created_at: string;
  updated_at: string;
  body?: string;
  body_truncated?: true;
}

export async function collectGitHub(config: AppConfig): Promise<EvidenceSource> {
  const cfg = config.sources.github;
  if (!cfg.enabled) return { state: 'disabled' };
  const token = process.env.GITHUB_TOKEN;
  if (!token) return { state: 'missing', detail: 'GITHUB_TOKEN is not configured' };
  try {
    const repositories = cfg.repositories.map(normalizeRepo).filter(Boolean);
    if (repositories.length === 0) {
      const response = await githubFetch('https://api.github.com/issues?filter=assigned&state=open&per_page=20', token);
      if (!response.ok) return { state: 'error', detail: `GitHub HTTP ${response.status}` };
      return sourceFromResult(leanIssues(await response.json()));
    }

    const results = await Promise.all(
      repositories.map(async (repo) => {
        const response = await githubFetch(
          `https://api.github.com/repos/${repo}/issues?state=open&per_page=${cfg.per_repo_limit}`,
          token,
        );
        if (!response.ok) {
          return { repo, state: 'error', detail: `GitHub HTTP ${response.status}` };
        }
        const issues = leanIssues(await response.json());
        return { repo, state: issues.length > 0 ? 'available' : 'empty', issues };
      }),
    );
    return sourceFromResult(results);
  } catch (error) {
    return { state: 'error', detail: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Narrow the REST payload at the door.
 *
 * Done here rather than at prompt-assembly time so the noise never enters the
 * evidence at all: the run ledger, the console's evidence view and anything
 * else that reads a collected source all get the small shape, and there is no
 * second place that has to remember to trim.
 */
export function leanIssues(payload: unknown): LeanIssue[] {
  if (!Array.isArray(payload)) return [];
  return payload.filter(isRecord).map(leanIssue);
}

function leanIssue(raw: Record<string, unknown>): LeanIssue {
  const body = typeof raw.body === 'string' ? raw.body.trim() : '';
  const truncated = body.length > BODY_LIMIT;
  return {
    number: typeof raw.number === 'number' ? raw.number : 0,
    title: str(raw.title),
    state: str(raw.state),
    url: str(raw.html_url),
    is_pull_request: isRecord(raw.pull_request),
    ...(typeof raw.draft === 'boolean' ? { draft: raw.draft } : {}),
    author: isRecord(raw.user) ? str(raw.user.login) : '',
    assignees: logins(raw.assignees),
    labels: labelNames(raw.labels),
    comments: typeof raw.comments === 'number' ? raw.comments : 0,
    created_at: str(raw.created_at),
    updated_at: str(raw.updated_at),
    ...(body ? { body: truncated ? `${body.slice(0, BODY_LIMIT)}…` : body } : {}),
    ...(truncated ? { body_truncated: true as const } : {}),
  };
}

function labelNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  // The API returns objects, but a label can also arrive as a bare string when
  // the issue was created through some older integrations.
  return value.map((label) => (typeof label === 'string' ? label : isRecord(label) ? str(label.name) : '')).filter(Boolean);
}

function logins(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((user) => (isRecord(user) ? str(user.login) : '')).filter(Boolean);
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function githubFetch(url: string, token: string): Promise<Response> {
  return fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'daily-os-feishu',
    },
  });
}

function normalizeRepo(value: string): string {
  return value.trim().replace(/^https:\/\/github\.com\//, '').replace(/\/$/, '');
}
