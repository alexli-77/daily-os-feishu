export function linearIssueUrl(identifier: string, workspace = '', evidenceUrl = ''): string {
  const issueId = identifier.trim();
  if (!/^[A-Z][A-Z0-9]*-\d+$/i.test(issueId)) return '';

  if (evidenceUrl) {
    try {
      const parsed = new URL(evidenceUrl);
      if (parsed.protocol === 'https:' && parsed.hostname === 'linear.app') return parsed.toString();
    } catch {
      // Fall through to a locally constructed Linear URL.
    }
  }

  const slug = workspace.trim();
  if (slug) return `https://linear.app/${encodeURIComponent(slug)}/issue/${encodeURIComponent(issueId)}`;
  return `https://linear.app/issue/${encodeURIComponent(issueId)}`;
}
