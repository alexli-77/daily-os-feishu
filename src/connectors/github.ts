import type { EvidenceSource } from '../workflows/types.js';
import { sourceFromResult } from '../workflows/types.js';

export async function collectGitHub(enabled: boolean): Promise<EvidenceSource> {
  if (!enabled) return { state: 'disabled' };
  const token = process.env.GITHUB_TOKEN;
  if (!token) return { state: 'missing', detail: 'GITHUB_TOKEN is not configured' };
  try {
    const response = await fetch('https://api.github.com/issues?filter=assigned&state=open&per_page=20', {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'daily-os-feishu',
      },
    });
    if (!response.ok) return { state: 'error', detail: `GitHub HTTP ${response.status}` };
    return sourceFromResult(await response.json());
  } catch (error) {
    return { state: 'error', detail: error instanceof Error ? error.message : String(error) };
  }
}

