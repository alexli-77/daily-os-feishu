import type { AppConfig } from '../config/schema.js';
import { runCommand } from '../utils/command.js';
import type { EvidenceSource } from '../workflows/types.js';
import { sourceFromResult } from '../workflows/types.js';

export async function collectLinear(config: AppConfig): Promise<EvidenceSource> {
  const cfg = config.sources.linear;
  if (!cfg.enabled) return { state: 'disabled' };
  const token = process.env.LINEAR_API_KEY;
  if (!token) return collectLinearViaCodex(config);
  return collectLinearViaApi(token, cfg);
}

async function collectLinearViaApi(token: string, cfg: AppConfig['sources']['linear']): Promise<EvidenceSource> {
  try {
    const filters = await buildLinearApiFilters(token, cfg);
    const items = new Map<string, unknown>();
    for (const filter of filters) {
      const data = await linearApiQuery(token, issuesQuery, { filter });
      const nodes = getArrayAtPath(data, ['issues', 'nodes']) || [];
      for (const node of nodes) {
        if (isRecord(node) && typeof node.identifier === 'string') items.set(node.identifier, node);
      }
    }
    return sourceFromLinearResult({ source: 'linear-api', items: [...items.values()] }, cfg);
  } catch (error) {
    return { state: 'error', detail: error instanceof Error ? error.message : String(error) };
  }
}

const openStateFilter = { state: { type: { neq: 'completed' } } };

const issuesQuery = `
  query LinearIssues($filter: IssueFilter) {
    issues(filter: $filter, first: 100, orderBy: updatedAt) {
      nodes {
        identifier
        title
        priority
        url
        state { name type }
        project { name }
        team { name key }
        assignee { name }
        updatedAt
        dueDate
      }
    }
  }
`;

async function buildLinearApiFilters(token: string, cfg: AppConfig['sources']['linear']): Promise<Record<string, unknown>[]> {
  const filters: Record<string, unknown>[] = [];
  const hasScopedAllowlist = cfg.projects_allowlist.length > 0 || cfg.teams_allowlist.length > 0;

  for (const project of cfg.projects_allowlist) {
    filters.push({ ...openStateFilter, project: { name: { eq: project } } });
  }

  for (const team of await resolveLinearTeamNames(token, cfg.teams_allowlist)) {
    filters.push({ ...openStateFilter, team: { name: { eq: team } } });
  }

  if (!hasScopedAllowlist) {
    filters.push({
      ...openStateFilter,
      assignee: { isMe: { eq: true } },
    });
  }

  return filters;
}

async function resolveLinearTeamNames(token: string, allowlist: string[]): Promise<string[]> {
  if (allowlist.length === 0) return [];
  const wanted = normalizeProjectSet(allowlist);
  const data = await linearApiQuery(
    token,
    `query LinearTeams { teams(first: 100) { nodes { name key } } }`,
    {},
  );
  const teams = getArrayAtPath(data, ['teams', 'nodes']) || [];
  return teams
    .filter((team) => {
      if (!isRecord(team)) return false;
      return [team.name, team.key].some((value) => typeof value === 'string' && wanted.has(normalizeProjectName(value)));
    })
    .map((team) => (isRecord(team) && typeof team.name === 'string' ? team.name : ''))
    .filter(Boolean);
}

async function linearApiQuery(token: string, query: string, variables: Record<string, unknown>): Promise<unknown> {
  const response = await fetch('https://api.linear.app/graphql', {
    method: 'POST',
    headers: { Authorization: token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const body = (await response.json()) as { data?: unknown; errors?: { message?: string }[] };
  if (!response.ok || body.errors?.length) {
    const detail = body.errors?.map((error) => error.message).filter(Boolean).join('; ') || `HTTP ${response.status}`;
    throw new Error(`Linear API failed: ${detail}`);
  }
  return body.data;
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
      "team": {"name": "Team name", "key": "TEAM"},
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
- Do not apply project or team filtering yourself; return project/team metadata so the local app can filter deterministically.

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

  const source = sourceFromLinearResult(parsed, config.sources.linear);
  const filterDetail = linearFilterDetail(parsed, source.data, config.sources.linear);
  return {
    ...source,
    detail:
      (source.state === 'available'
        ? 'Collected through Codex Linear connector fallback'
        : 'Codex Linear connector fallback returned no issues') + filterDetail,
  };
}

function sourceFromLinearResult(data: unknown, cfg: AppConfig['sources']['linear']): EvidenceSource {
  const filtered = filterLinearProjectData(data, cfg);
  const source = sourceFromResult(filtered.data);
  if (filtered.active && filtered.after === 0) {
    return {
      state: 'empty',
      detail: `Linear project filter removed ${filtered.before} issue(s).`,
      data: filtered.data,
    };
  }
  return source;
}

function filterLinearProjectData(
  data: unknown,
  cfg: AppConfig['sources']['linear'],
): { active: boolean; before: number; after: number; data: unknown } {
  const allow = normalizeProjectSet(cfg.projects_allowlist);
  const block = normalizeProjectSet(cfg.projects_blocklist);
  const teamAllow = normalizeProjectSet(cfg.teams_allowlist);
  const teamBlock = normalizeProjectSet(cfg.teams_blocklist);
  const active = allow.size > 0 || block.size > 0 || teamAllow.size > 0 || teamBlock.size > 0;
  if (!active || !isRecord(data)) return { active, before: 0, after: 0, data };

  const cloned = JSON.parse(JSON.stringify(data)) as unknown;
  if (!isRecord(cloned)) return { active, before: 0, after: 0, data: cloned };

  const paths = [
    ['items'],
    ['data', 'issues', 'nodes'],
    ['issues', 'nodes'],
  ];

  for (const path of paths) {
    const items = getArrayAtPath(cloned, path);
    if (!items) continue;
    const filtered = items.filter((item) => shouldKeepLinearItem(item, allow, block, teamAllow, teamBlock));
    setAtPath(cloned, path, filtered);
    return { active, before: items.length, after: filtered.length, data: cloned };
  }

  return { active, before: 0, after: 0, data: cloned };
}

function shouldKeepLinearItem(
  item: unknown,
  allow: Set<string>,
  block: Set<string>,
  teamAllow: Set<string>,
  teamBlock: Set<string>,
): boolean {
  const project = normalizeProjectName(getLinearProjectName(item));
  const teams = getLinearTeamNames(item).map(normalizeProjectName).filter(Boolean);
  if (allow.size > 0 && (!project || !allow.has(project))) return false;
  if (project && block.has(project)) return false;
  if (teamAllow.size > 0 && !teams.some((team) => teamAllow.has(team))) return false;
  if (teams.some((team) => teamBlock.has(team))) return false;
  return true;
}

function getLinearProjectName(item: unknown): string {
  if (!isRecord(item)) return '';
  const project = item.project;
  if (typeof project === 'string') return project;
  if (isRecord(project) && typeof project.name === 'string') return project.name;
  return '';
}

function getLinearTeamNames(item: unknown): string[] {
  if (!isRecord(item)) return [];
  const team = item.team;
  if (typeof team === 'string') return [team];
  if (!isRecord(team)) return [];
  return [team.name, team.key].filter((value): value is string => typeof value === 'string');
}

function normalizeProjectSet(values: string[]): Set<string> {
  return new Set(values.map(normalizeProjectName).filter(Boolean));
}

function normalizeProjectName(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_-]+/g, '');
}

function linearFilterDetail(
  beforeData: unknown,
  afterData: unknown,
  cfg: AppConfig['sources']['linear'],
): string {
  const active = cfg.projects_allowlist.length > 0 || cfg.projects_blocklist.length > 0;
  const teamActive = cfg.teams_allowlist.length > 0 || cfg.teams_blocklist.length > 0;
  if (!active && !teamActive) return '';
  const before = countLinearItems(beforeData);
  const after = countLinearItems(afterData);
  return ` Project filter kept ${after}/${before} issue(s).`;
}

function countLinearItems(data: unknown): number {
  if (!isRecord(data)) return 0;
  for (const path of [
    ['items'],
    ['data', 'issues', 'nodes'],
    ['issues', 'nodes'],
  ]) {
    const items = getArrayAtPath(data, path);
    if (items) return items.length;
  }
  return 0;
}

function getArrayAtPath(data: unknown, path: string[]): unknown[] | null {
  let current = data;
  for (const key of path) {
    if (!isRecord(current)) return null;
    current = current[key];
  }
  return Array.isArray(current) ? current : null;
}

function setAtPath(data: unknown, path: string[], value: unknown[]): void {
  let current = data;
  for (const key of path.slice(0, -1)) {
    if (!isRecord(current)) return;
    current = current[key];
  }
  if (isRecord(current)) current[path[path.length - 1]] = value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
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
