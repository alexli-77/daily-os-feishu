import fs from 'node:fs';
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
  const longTermPath = path.resolve(config.memory.long_term_path);
  fs.mkdirSync(path.dirname(longTermPath), { recursive: true });
  if (!fs.existsSync(longTermPath)) {
    fs.writeFileSync(longTermPath, '# Long-term Memory\n\nKeep durable preferences, standing goals, and recurring constraints here.\n');
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
