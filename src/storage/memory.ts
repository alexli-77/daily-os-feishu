import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AppConfig, WorkflowName } from '../config/schema.js';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEFAULT_MEMORY_REPOSITORY_PATH = path.join(PROJECT_ROOT, 'memory-vault', 'default');
const MAX_REPOSITORY_FILES = 40;
const MAX_REPOSITORY_FILE_CHARS = 12000;

export interface MemoryBundle {
  repositoryPath: string;
  repository: Array<{ path: string; content: string }>;
  longTerm: string;
  recentDaily: Array<{ path: string; content: string }>;
}

export interface LatestWorkflowOutput {
  workflow: WorkflowName;
  date: string;
  generated_at: string;
  content: string;
}

export interface WorkflowDetailCache extends LatestWorkflowOutput {
  id: string;
}

export function loadMemory(config: AppConfig): MemoryBundle {
  const repositoryPath = resolveMemoryRepositoryPath(config);
  const longTermPath = path.resolve(config.memory.long_term_path);
  const dailyDir = path.resolve(config.memory.daily_dir);
  const longTerm = fs.existsSync(longTermPath) ? fs.readFileSync(longTermPath, 'utf8') : '';
  const repository = loadMemoryRepository(repositoryPath);
  const recentDaily = fs.existsSync(dailyDir)
    ? fs
        .readdirSync(dailyDir)
        .filter((name) => name.endsWith('.md'))
        .sort()
        .slice(-7)
        .map((name) => {
          const filePath = path.join(dailyDir, name);
          return { path: filePath, content: fs.readFileSync(filePath, 'utf8') };
        })
    : [];
  return { repositoryPath, repository, longTerm, recentDaily };
}

export function appendDailyMemory(config: AppConfig, workflow: WorkflowName, date: string, content: string): void {
  const dailyDir = path.resolve(config.memory.daily_dir);
  fs.mkdirSync(dailyDir, { recursive: true });
  const filePath = path.join(dailyDir, `${date}.md`);
  const title = workflow.replaceAll('_', ' ');
  fs.appendFileSync(filePath, `\n\n## ${title}\n\n${content.trim()}\n`);
}

export function writeLatestWorkflowOutput(config: AppConfig, workflow: WorkflowName, date: string, content: string): string {
  const filePath = latestWorkflowOutputPath(config);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const payload: LatestWorkflowOutput = {
    workflow,
    date,
    generated_at: new Date().toISOString(),
    content: content.trim(),
  };
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8');
  return filePath;
}

export function writeWorkflowDetailCache(config: AppConfig, workflow: WorkflowName, date: string, content: string): WorkflowDetailCache {
  const cacheDir = workflowDetailCacheDir(config);
  fs.mkdirSync(cacheDir, { recursive: true });
  const payload: WorkflowDetailCache = {
    id: crypto.randomUUID(),
    workflow,
    date,
    generated_at: new Date().toISOString(),
    content: content.trim(),
  };
  fs.writeFileSync(path.join(cacheDir, `${payload.id}.json`), JSON.stringify(payload, null, 2), 'utf8');
  pruneWorkflowDetailCache(cacheDir);
  return payload;
}

export function readLatestWorkflowOutput(config: AppConfig): LatestWorkflowOutput | null {
  const filePath = latestWorkflowOutputPath(config);
  if (!fs.existsSync(filePath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as LatestWorkflowOutput;
    if (!parsed || typeof parsed.content !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

export function readWorkflowDetailCache(config: AppConfig, id: string): WorkflowDetailCache | null {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const filePath = path.join(workflowDetailCacheDir(config), `${id}.json`);
  if (!fs.existsSync(filePath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as WorkflowDetailCache;
    if (!parsed || parsed.id !== id || typeof parsed.content !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

export function appendLongTermMemory(config: AppConfig, content: string, source = 'manual'): void {
  const longTermPath = path.resolve(config.memory.long_term_path);
  fs.mkdirSync(path.dirname(longTermPath), { recursive: true });
  const timestamp = new Date().toISOString();
  fs.appendFileSync(longTermPath, `\n\n## ${timestamp} ${source}\n\n${content.trim()}\n`);
}

export function appendFeedbackLog(config: AppConfig, content: string, metadata: Record<string, string> = {}): void {
  const logPath = path.resolve(config.feedback.feishu.log_path);
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const timestamp = new Date().toISOString();
  const meta = Object.entries(metadata)
    .map(([key, value]) => `${key}: ${value}`)
    .join('\n');
  fs.appendFileSync(logPath, `\n\n## ${timestamp}\n\n${meta ? `${meta}\n\n` : ''}${content.trim()}\n`);
}

export function ensureMemoryFiles(config: AppConfig): void {
  fs.mkdirSync(path.resolve(config.memory.daily_dir), { recursive: true });
  fs.mkdirSync(path.resolve(config.memory.workflow_runs_dir), { recursive: true });
  fs.mkdirSync(path.resolve(config.progress.ledger_dir), { recursive: true });
  const longTermPath = path.resolve(config.memory.long_term_path);
  fs.mkdirSync(path.dirname(longTermPath), { recursive: true });
  if (!fs.existsSync(longTermPath)) {
    fs.writeFileSync(longTermPath, '# Long-term Memory\n\nKeep durable preferences, standing goals, and recurring constraints here.\n');
  }
}

function latestWorkflowOutputPath(config: AppConfig): string {
  return path.resolve(config.memory.daily_dir, '_latest-workflow.json');
}

function workflowDetailCacheDir(config: AppConfig): string {
  return path.resolve(config.memory.daily_dir, '.workflow-detail-cache');
}

function pruneWorkflowDetailCache(cacheDir: string): void {
  const maxAgeMs = 7 * 24 * 60 * 60 * 1000;
  const cutoff = Date.now() - maxAgeMs;
  for (const entry of fs.readdirSync(cacheDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const filePath = path.join(cacheDir, entry.name);
    const stat = fs.statSync(filePath);
    if (stat.mtimeMs < cutoff) fs.rmSync(filePath, { force: true });
  }
}

export function resolveMemoryRepositoryPath(config: AppConfig): string {
  const configured = config.memory.repository_path.trim();
  return configured ? path.resolve(configured) : DEFAULT_MEMORY_REPOSITORY_PATH;
}

export function defaultMemoryRepositoryPath(): string {
  return DEFAULT_MEMORY_REPOSITORY_PATH;
}

function loadMemoryRepository(root: string): Array<{ path: string; content: string }> {
  if (!fs.existsSync(root)) return [];
  return listMarkdownFiles(root)
    .slice(0, MAX_REPOSITORY_FILES)
    .map((filePath) => ({
      path: path.relative(root, filePath),
      content: fs.readFileSync(filePath, 'utf8').slice(0, MAX_REPOSITORY_FILE_CHARS),
    }));
}

function listMarkdownFiles(root: string): string[] {
  const out: string[] = [];
  walk(root, out);
  return out.sort();
}

function walk(dir: string, out: string[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(fullPath, out);
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      out.push(fullPath);
    }
  }
}
