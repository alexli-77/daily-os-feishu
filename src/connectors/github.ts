import type { EvidenceSource } from '../workflows/types.js';
import { sourceFromResult } from '../workflows/types.js';
import type { AppConfig } from '../config/schema.js';

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
      return sourceFromResult(await response.json());
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
        const issues = await response.json();
        return { repo, state: Array.isArray(issues) && issues.length > 0 ? 'available' : 'empty', issues };
      }),
    );
    return sourceFromResult(results);
  } catch (error) {
    return { state: 'error', detail: error instanceof Error ? error.message : String(error) };
  }
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
