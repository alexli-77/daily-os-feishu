import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import type { AppConfig } from '../config/schema.js';
import { runCommand } from '../utils/command.js';
import { todayInTimezone } from '../utils/date.js';
import { loadMemory, readLatestWorkflowOutput } from '../storage/memory.js';
import { readProgressLedger } from '../progress/capture.js';
import { listRecentWorkflowRuns } from '../workflows/run-ledger.js';
import { collectEvidence } from '../workflows/evidence.js';

type SkillEntry = AppConfig['skills']['registry'][number];
type SkillProvider = SkillEntry['provider'];

export interface SkillSummary {
  id: string;
  provider: SkillProvider;
  path: string;
  workdir: string;
  defaultMode?: string;
  available: boolean;
  effects: string[];
  requiresConfirmation: string[];
}

export interface SkillRunInput {
  config: AppConfig;
  skillId: string;
  mode?: string;
  userText?: string;
  source: string;
  messageId: string;
}

export interface SkillRunResult {
  runId?: string;
  skillId: string;
  provider: 'codex' | 'claude';
  mode: string;
  inputPackPath: string;
  output: string;
  draftOnly: boolean;
}

const SKILL_FILE_LIMIT = 80_000;
const INPUT_PACK_LIMIT = 40_000;

export function listConfiguredSkills(config: AppConfig): SkillSummary[] {
  return config.skills.registry.map((entry) => {
    const skillPath = expandPath(entry.path);
    const workdir = skillWorkdir(entry);
    return {
      id: entry.id,
      provider: entry.provider,
      path: skillPath,
      workdir,
      defaultMode: entry.default_mode || undefined,
      available: fs.existsSync(skillPath),
      effects: entry.effects,
      requiresConfirmation: entry.require_confirmation_for,
    };
  });
}

export function formatSkillList(config: AppConfig): string {
  if (!config.skills.enabled) return 'Skills are disabled. Set `skills.enabled=true` in config/config.yaml first.';
  const skills = listConfiguredSkills(config);
  if (skills.length === 0) return 'No skills configured. Add entries under `skills.registry` in config/config.yaml.';
  return [
    '# Daily OS Skills',
    '',
    ...skills.map((skill) =>
      [
        `- ${skill.id} (${skill.available ? 'available' : 'missing'})`,
        `  provider: ${skill.provider}`,
        skill.defaultMode ? `  default mode: ${skill.defaultMode}` : '',
        `  effects: ${skill.effects.join(', ') || 'read'}`,
        skill.requiresConfirmation.length ? `  confirmation required: ${skill.requiresConfirmation.join(', ')}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    ),
    '',
    'Run one with: `daily-os skill run <id>: <optional request>`',
  ].join('\n');
}

export async function runConfiguredSkill(input: SkillRunInput): Promise<SkillRunResult> {
  if (!input.config.skills.enabled) throw new Error('Skills are disabled. Set `skills.enabled=true` in config/config.yaml first.');
  const entry = input.config.skills.registry.find((candidate) => candidate.id === input.skillId);
  if (!entry) throw new Error(`Skill not found: ${input.skillId}`);

  const skillPath = expandPath(entry.path);
  if (!fs.existsSync(skillPath)) throw new Error(`Skill file not found: ${skillPath}`);
  const workdir = skillWorkdir(entry);
  const mode = input.mode || entry.default_mode || 'default';
  const inputPack = await buildSkillInputPack(input.config, {
    skillId: entry.id,
    mode,
    userText: input.userText || '',
    source: input.source,
    messageId: input.messageId,
  });
  const inputPackPath = writeSkillInputPack(input.config, entry.id, mode, inputPack);
  const prompt = buildSkillPrompt({
    entry,
    skillPath,
    workdir,
    mode,
    userText: input.userText || '',
    inputPack,
    inputPackPath,
    skillFiles: loadSkillFiles(skillPath),
  });
  const provider = resolveProvider(input.config, entry);
  const output = provider === 'claude' ? await runClaudeSkill(prompt, workdir, input.config) : await runCodexSkill(prompt, workdir, input.config);
  const result = {
    runId: crypto.randomUUID(),
    skillId: entry.id,
    provider,
    mode,
    inputPackPath,
    output: normalizeSkillOutput(output),
    draftOnly: true,
  };
  recordLatestSkillRun(input.config, result);
  return result;
}

export interface StoredSkillRunResult extends SkillRunResult {
  runId: string;
  createdAt: string;
}

export function readLatestSkillRun(config: AppConfig, skillId: string, mode?: string, runId?: string): StoredSkillRunResult | null {
  const runs = readSkillRunState(config);
  const candidates = runs
    .filter((run) => run.skillId === skillId)
    .filter((run) => !mode || run.mode === mode)
    .filter((run) => !runId || run.runId === runId)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  return candidates[0] || null;
}

async function buildSkillInputPack(
  config: AppConfig,
  input: { skillId: string; mode: string; userText: string; source: string; messageId: string },
): Promise<string> {
  const date = todayInTimezone(config);
  const memory = loadMemory(config);
  const latest = readLatestWorkflowOutput(config);
  const progress = readRecentProgressLedgers(config, 14);
  const runs = listRecentWorkflowRuns(config, 10);
  const evidence = await collectEvidence(config, date);
  const evidenceSummary = Object.entries(evidence.sources).map(([name, source]) => ({
    name,
    state: source.state,
    detail: source.detail || '',
    sample: summarizeSourceData(source.data),
  }));

  return redactSensitive(
    [
      '# Daily OS Skill Input Pack',
      '',
      `Generated at: ${new Date().toISOString()}`,
      `Date: ${date}`,
      `Skill: ${input.skillId}`,
      `Mode: ${input.mode}`,
      `Source: ${input.source}:${input.messageId}`,
      '',
      '## Safety Contract',
      '- This input pack is for draft/review only.',
      '- Do not write to Feishu, Linear, calendar, vault, local files, or external services in this run.',
      '- Do not reveal tokens, document IDs, open IDs, chat IDs, file-system secrets, or hidden reasoning.',
      '- If the weekly-review skill config says auto_write=true, ignore that for this Daily OS draft run and ask for explicit confirmation before write-back.',
      '',
      '## User Request',
      input.userText || '(none)',
      '',
      '## Latest Workflow',
      latest ? JSON.stringify(latest, null, 2) : '(none)',
      '',
      '## Recent Daily Memory',
      truncate(memory.recentDaily.map((file) => `### ${file.path}\n${file.content}`).join('\n\n'), INPUT_PACK_LIMIT),
      '',
      '## Long-term Memory Preview',
      truncate(memory.longTerm, 6000),
      '',
      '## Memory Repository Files',
      truncate(memory.repository.map((file) => `### ${file.path}\n${file.content}`).join('\n\n'), INPUT_PACK_LIMIT),
      '',
      '## Progress Ledger',
      progress || '(none)',
      '',
      '## Recent Workflow Runs',
      JSON.stringify(runs, null, 2),
      '',
      '## Evidence Summary',
      JSON.stringify(evidenceSummary, null, 2),
    ].join('\n'),
  );
}

function writeSkillInputPack(config: AppConfig, skillId: string, mode: string, content: string): string {
  const dir = path.resolve(config.skills.inputs_dir);
  fs.mkdirSync(dir, { recursive: true });
  const safeSkill = skillId.replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '') || 'skill';
  const safeMode = mode.replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '') || 'default';
  const filePath = path.join(dir, `${safeSkill}-${safeMode}-${Date.now()}.md`);
  fs.writeFileSync(filePath, content, 'utf8');
  return filePath;
}

function recordLatestSkillRun(config: AppConfig, result: SkillRunResult): void {
  if (!result.runId) return;
  const filePath = skillRunStatePath(config);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const runs = readSkillRunState(config).filter((run) => run.runId !== result.runId);
  runs.push({ ...result, runId: result.runId, createdAt: new Date().toISOString() });
  const kept = runs
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    .slice(-20);
  fs.writeFileSync(filePath, `${JSON.stringify(kept, null, 2)}\n`, 'utf8');
}

function readSkillRunState(config: AppConfig): StoredSkillRunResult[] {
  const filePath = skillRunStatePath(config);
  if (!fs.existsSync(filePath)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as StoredSkillRunResult[];
    return Array.isArray(parsed)
      ? parsed.filter((run) => run && typeof run.runId === 'string' && typeof run.skillId === 'string' && typeof run.output === 'string')
      : [];
  } catch {
    return [];
  }
}

function skillRunStatePath(config: AppConfig): string {
  return path.resolve(config.skills.inputs_dir, '_skill-runs.json');
}

function buildSkillPrompt(input: {
  entry: SkillEntry;
  skillPath: string;
  workdir: string;
  mode: string;
  userText: string;
  inputPack: string;
  inputPackPath: string;
  skillFiles: Array<{ path: string; content: string }>;
}): string {
  return [
    '# Daily OS Skill Bridge',
    '',
    'You are running a configured Daily OS skill in draft-only mode.',
    'Return the final answer that should be sent back to the user in Feishu.',
    '',
    'Hard rules:',
    '- Do not execute shell commands, lark-cli, network calls, or external writes.',
    '- Do not write to Feishu, Linear, calendar, vault, local files, or code in this run.',
    '- Do not read or reveal `config.yaml`; real tokens and block IDs must remain local.',
    '- If the skill instructions mention auto_write=true, treat this Daily OS run as an explicit dry run.',
    '- Use the Daily OS input pack as the source of normal runtime context.',
    '- If a write-back is needed, produce a draft and a clear confirmation request instead.',
    '',
    'Skill metadata:',
    JSON.stringify(
      {
        id: input.entry.id,
        provider: input.entry.provider,
        mode: input.mode,
        effects: input.entry.effects,
        require_confirmation_for: input.entry.require_confirmation_for,
        skill_path: input.skillPath,
        workdir: input.workdir,
        input_pack_path: input.inputPackPath,
      },
      null,
      2,
    ),
    '',
    '# Skill Files',
    input.skillFiles.map((file) => `## ${file.path}\n${file.content}`).join('\n\n'),
    '',
    '# Daily OS Input Pack',
    input.inputPack,
    '',
    '# User Request',
    input.userText || '(none)',
    '',
    '# Output Requirements',
    '- Chinese by default.',
    '- For weekly-review, output a concise weekly review draft with completed items, unfinished items, and next-week plan.',
    '- Include a short note that no Feishu write-back was performed.',
  ].join('\n');
}

function loadSkillFiles(skillPath: string): Array<{ path: string; content: string }> {
  const root = path.dirname(skillPath);
  const candidates = [
    skillPath,
    ...listFiles(path.join(root, 'engine')),
    ...listFiles(path.join(root, 'frameworks')),
    ...listFiles(path.join(root, 'modes')),
    path.join(root, 'config.example.yaml'),
  ];
  const seen = new Set<string>();
  return candidates
    .filter((filePath) => {
      const absolute = path.resolve(filePath);
      if (seen.has(absolute) || !fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) return false;
      seen.add(absolute);
      return path.basename(absolute) !== 'config.yaml';
    })
    .map((filePath) => ({
      path: path.relative(root, filePath) || path.basename(filePath),
      content: truncate(fs.readFileSync(filePath, 'utf8'), SKILL_FILE_LIMIT),
    }));
}

function listFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => !name.startsWith('.') && (name.endsWith('.md') || name.endsWith('.yaml') || name.endsWith('.yml')))
    .sort()
    .map((name) => path.join(dir, name));
}

function skillWorkdir(entry: SkillEntry): string {
  if (entry.workdir.trim()) return expandPath(entry.workdir);
  return path.dirname(expandPath(entry.path));
}

function resolveProvider(config: AppConfig, entry: SkillEntry): 'codex' | 'claude' {
  if (entry.provider === 'codex' || entry.provider === 'claude') return entry.provider;
  return config.llm.provider === 'claude' ? 'claude' : 'codex';
}

async function runCodexSkill(prompt: string, workdir: string, config: AppConfig): Promise<string> {
  const outputPath = path.join(os.tmpdir(), `daily-os-skill-${Date.now()}-${process.pid}.md`);
  const args = ['exec', '--skip-git-repo-check', '--ignore-rules', '--ephemeral', '--sandbox', 'read-only', '--output-last-message', outputPath, '--cd', workdir, '-'];
  if (!['', 'default', 'auto'].includes(config.llm.model.trim())) {
    args.splice(4, 0, '-m', config.llm.model);
  }
  const result = await runCommand(process.env.CODEX_BIN || 'codex', args, { input: prompt, timeoutMs: 180000, cwd: workdir });
  const text = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf8') : result.stdout;
  fs.rmSync(outputPath, { force: true });
  if (!result.ok) throw new Error(`Codex skill failed: ${(result.stderr || result.stdout).slice(0, 3000)}`);
  return text;
}

async function runClaudeSkill(prompt: string, workdir: string, config: AppConfig): Promise<string> {
  const args = ['-p', '--output-format', 'text', '--strict-mcp-config'];
  if (!['', 'default', 'auto'].includes(config.llm.model.trim())) {
    args.push('--model', config.llm.model);
  }
  const result = await runCommand(process.env.CLAUDE_BIN || 'claude', args, { input: prompt, timeoutMs: 180000, cwd: workdir });
  if (!result.ok) throw new Error(`Claude skill failed: ${(result.stderr || result.stdout).slice(0, 3000)}`);
  return result.stdout;
}

function readRecentProgressLedgers(config: AppConfig, limit: number): string {
  const dir = path.resolve(config.progress.ledger_dir);
  if (!fs.existsSync(dir)) return '';
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.md'))
    .sort()
    .slice(-limit)
    .map((name) => {
      const filePath = path.join(dir, name);
      return `### ${name}\n${readProgressLedger(config, name.replace(/\.md$/, ''))}`;
    })
    .join('\n\n');
}

function summarizeSourceData(data: unknown): string {
  if (data == null) return '';
  if (typeof data === 'string') return truncate(data.replace(/\s+/g, ' ').trim(), 1000);
  try {
    return truncate(JSON.stringify(data), 1000);
  } catch {
    return truncate(String(data), 1000);
  }
}

function expandPath(value: string): string {
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return path.resolve(value);
}

function normalizeSkillOutput(text: string): string {
  return text
    .replace(/^\s*```(?:markdown|md|text)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function truncate(value: string, maxChars: number): string {
  return value.length > maxChars ? `${value.slice(0, maxChars)}\n...[truncated]` : value;
}

function redactSensitive(value: string): string {
  return value
    .replace(/\b(?:oc|ou|om|cli)_[A-Za-z0-9_-]{8,}\b/g, '[redacted-feishu-id]')
    .replace(/\b(?:doccn|doxcn)[A-Za-z0-9_-]{8,}\b/g, '[redacted-doc-token]')
    .replace(/(docx\/)[A-Za-z0-9_-]+/g, '$1[redacted-doc-token]')
    .replace(/("?(?:token|secret|api[_-]?key|app_secret|chat_id|open_id)"?\s*[:=]\s*)["']?[^"',\n}]+["']?/gi, '$1[redacted]');
}
