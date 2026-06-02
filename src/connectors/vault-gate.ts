import fs from 'node:fs';
import path from 'node:path';
import type { AppConfig } from '../config/schema.js';
import type { EvidenceSource } from '../workflows/types.js';
import { sourceFromResult } from '../workflows/types.js';

export async function collectVault(config: AppConfig): Promise<Record<string, EvidenceSource>> {
  const source = config.sources.vault;
  if (!source.enabled) return { vault: { state: 'disabled' } };
  if (source.provider === 'remote') return collectRemoteVault(config);
  return collectLocalVault(config);
}

async function collectRemoteVault(config: AppConfig): Promise<Record<string, EvidenceSource>> {
  const cfg = config.sources.vault.remote;
  const baseUrl = process.env[cfg.base_url_env]?.replace(/\/+$/, '');
  const token = process.env[cfg.token_env];
  if (!baseUrl || !token) return { vault: { state: 'missing', detail: `${cfg.base_url_env} or ${cfg.token_env} is not configured` } };

  const headers = { Authorization: `Bearer ${token}` };
  const result: Record<string, EvidenceSource> = {};
  if (cfg.scan.enabled) {
    const endpoint = new URL('/scan', baseUrl);
    endpoint.searchParams.set('statuses', cfg.scan.statuses.join(','));
    endpoint.searchParams.set('due_within_days', String(cfg.scan.due_within_days));
    endpoint.searchParams.set('limit', String(cfg.scan.limit));
    result.vault_scan = await fetchJson(endpoint, headers);
  }

  for (const [name, relativePath] of Object.entries(cfg.read_paths)) {
    const endpoint = new URL('/read', baseUrl);
    endpoint.searchParams.set('path', relativePath);
    result[`vault_${name}`] = await fetchJson(endpoint, headers);
  }
  return result;
}

async function fetchJson(url: URL, headers: Record<string, string>): Promise<EvidenceSource> {
  try {
    const response = await fetch(url, { headers });
    if (!response.ok) return { state: response.status === 404 ? 'missing' : 'error', detail: `HTTP ${response.status}` };
    return sourceFromResult(await response.json());
  } catch (error) {
    return { state: 'error', detail: error instanceof Error ? error.message : String(error) };
  }
}

function collectLocalVault(config: AppConfig): Record<string, EvidenceSource> {
  const root = config.sources.vault.local_path;
  if (!fs.existsSync(root)) return { vault: { state: 'missing', detail: `vault path not found: ${root}` } };
  const todosPath = path.join(root, config.sources.vault.remote.read_paths.todos);
  const watchPath = path.join(root, config.sources.vault.remote.read_paths.watch_list);
  const out: Record<string, EvidenceSource> = {};
  out.vault_todos = fs.existsSync(todosPath)
    ? sourceFromResult({ path: config.sources.vault.remote.read_paths.todos, content: fs.readFileSync(todosPath, 'utf8') })
    : { state: 'missing', detail: `missing: ${config.sources.vault.remote.read_paths.todos}` };
  out.vault_watch_list = fs.existsSync(watchPath)
    ? sourceFromResult({ path: config.sources.vault.remote.read_paths.watch_list, content: fs.readFileSync(watchPath, 'utf8') })
    : { state: 'missing', detail: `missing: ${config.sources.vault.remote.read_paths.watch_list}` };
  return out;
}

