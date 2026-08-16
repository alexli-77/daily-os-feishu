import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import type { AppConfig } from '../config/schema.js';
import { runCommand } from '../utils/command.js';
import { todayInTimezone } from '../utils/date.js';
import { loadMemory, readLatestWorkflowOutput } from '../storage/memory.js';
import { readProgressLedger } from '../progress/capture.js';
import {
  listRecentWorkflowRuns,
  markWorkflowRunFailed,
  markWorkflowRunSucceeded,
  startWorkflowRun,
  type WorkflowRunTrigger,
} from '../workflows/run-ledger.js';
import { runManager } from '../service/run-manager.js';
import { collectEvidence } from '../workflows/evidence.js';
import type { EvidenceSource } from '../workflows/types.js';
import { loadOkrFromDir, buildOkrSummary } from '../okr/loader.js';
import { resolveOkrDir } from '../okr/biweekly-progress.js';
import { isLifeReviewOsEntry, runLifeReviewOsSkill } from './life-review-os.js';

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
  const mode = input.mode || entry.default_mode || 'default';

  // Ledger + in-flight registration: skill runs (e.g. biweekly) show up on the
  // console Runs page — In flight while running, Recent runs afterwards — just
  // like plan/review. The run executes in-process, so cancel only writes the
  // ledger back to failed via onCancel.
  const label = `skill:${entry.id}:${mode}`;
  const trigger: WorkflowRunTrigger = input.source.startsWith('web-chat')
    ? 'ui'
    : input.source.startsWith('feishu')
      ? 'feishu_command'
      : 'cli';
  let ledger = startWorkflowRun(input.config, {
    workflow: label,
    trigger,
    source: input.source,
    date: todayInTimezone(input.config),
    sendEnabled: false,
  });
  let cancelled = false;
  runManager.register(ledger.id, {}, {
    workflow: label,
    onCancel: () => {
      cancelled = true;
      ledger = markWorkflowRunFailed(input.config, ledger, 'Cancelled by operator from console.');
    },
  });
  try {
    const result = await runConfiguredSkillInner(input, entry, mode);
    if (!cancelled) markWorkflowRunSucceeded(input.config, ledger);
    return result;
  } catch (error) {
    if (!cancelled) markWorkflowRunFailed(input.config, ledger, error);
    throw error;
  } finally {
    runManager.unregister(ledger.id);
  }
}

async function runConfiguredSkillInner(
  input: SkillRunInput,
  entry: AppConfig['skills']['registry'][number],
  mode: string,
): Promise<SkillRunResult> {
  const skillPath = expandPath(entry.path);
  if (!fs.existsSync(skillPath)) throw new Error(`Skill file not found: ${skillPath}`);
  const workdir = skillWorkdir(entry);
  const inputPack = await buildSkillInputPack(input.config, {
    skillId: entry.id,
    mode,
    userText: input.userText || '',
    source: input.source,
    messageId: input.messageId,
  });
  const inputPackPath = writeSkillInputPack(input.config, entry.id, mode, inputPack);
  const provider = resolveProvider(input.config, entry);
  if (isLifeReviewOsEntry(entry) && (mode === 'weekly' || mode === 'biweekly')) {
    const lifeReview = await runLifeReviewOsSkill({
      entry,
      mode,
      provider,
      userText: input.userText || '',
      inputPackPath,
    });
    const result = {
      runId: lifeReview.runId,
      skillId: entry.id,
      provider,
      mode,
      inputPackPath,
      output: normalizeSkillOutput(lifeReview.draft),
      draftOnly: true,
    };
    recordLatestSkillRun(input.config, result);
    return result;
  }
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
  const structuredEvidence = compactEvidenceForWeeklyPlanning(evidence);
  const okrChainSummary = loadLocalOkrChainSummary(config);

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
      // Keep the local OKR chain near the top: the biweekly skill only reads the
      // first ~20k chars of this pack, so the krId source must survive truncation.
      '## Local OKR Chain',
      '本地 10_OKR 的 north-star / annual / current 三层解析结果（krId 权威来源）。biweekly 的 kr_progress 块里的 krId 必须来自此处（形如 O1-KR2）；无法从证据确认进度的 KR 不要写进 kr_progress。',
      '',
      '进度评分标准（里程碑档位制，LEO-248）：',
      '- progress 只允许 0% / 25% / 50% / 75% / 100% 五档，对照该 KR 的 Target 判断处于哪个里程碑；禁止自由填写其他百分比。',
      '- 每次复盘最多上调一档；要跨档（如 0%→100%）必须有能逐字定位的完成证据，否则保持原档。',
      '- evidence 字段必须逐字引用本 input pack 中真实存在的一行原文（会被程序反查校验，查不到该 KR 不会写回）；严禁改写、拼接或把别处条目的 ✅ 归到当前 KR 上。',
      '- 100% 仅在 Current 达到 Target 且有明确完成证据时使用。',
      '',
      '计划条目规则（下双周要务）：',
      '- 延续上期未完成的要务时**逐字照搬上期原文**（含 Linear 编号），不要换措辞改写——改写不产生信息。',
      '- 仅当 Review / retro 对该 KR 有明确反馈（太重、被阻塞、要换策略）时才调整，且调整必须体现该反馈（减量、拆小步、按 retro 描述换切入点）。',
      '- 无法判断怎么安排的 KR 行**留空不写**，禁止编一条凑数。',
      '- 条目若与本 pack Linear 证据中的 issue 确定对应，在末尾以 `(LEO-97)` 形式标注编号（只写编号；多个用空格分隔）；拿不准就不标，禁止猜编号。',
      '- 照搬是默认动作，不是唯一动作：上期要务列是种子不是边界。必须同时按下面 Linear Issue Snapshot 做双向核对——已开工但要务列没有的 issue 要逐条给出「纳入」或「本期不做」的结论；要务列还挂着但 Linear 已 completed / canceled 的条目不许照搬进新周期。',
      okrChainSummary || '(no local OKR chain found)',
      '',
      // Same reason as the OKR chain above: life-review-os only reads the first
      // ~20k chars of this pack, and the full Linear dump under "Structured
      // Evidence" lands well past that cut — so the planner never actually saw
      // the issue list it was told to cross-check against. This compact block
      // is the machine-readable copy that survives truncation.
      '## Linear Issue Snapshot',
      'Linear 当前活跃 issue 快照，供计划环节做「未覆盖」与「已完成核销」核对。',
      '每行格式：`编号 | 状态 | 状态类型 | 优先级 | 截止 | 标题`。状态类型 `started` = 进行中或评审中，`completed` / `canceled` = 已收尾。',
      linearIssueSnapshot(evidence.sources.linear) || '(no linear issues collected)',
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
      '',
      '## Structured Evidence For Weekly Planning',
      'Use this as supplemental context only. The weekly-review engine must still map every selected item to the Feishu 🐶 OKR table row before write-back.',
      JSON.stringify(structuredEvidence, null, 2),
    ].join('\n'),
  );
}

/**
 * Load the local OKR strategy stack as a krId reference block for the skill
 * input pack. The biweekly `kr_progress` write-back contract requires the LLM to
 * cite real local krIds (O1-KR2), which live in the vault's 10_OKR files rather
 * than in the Feishu weekly table. Degrades to '' when no OKR chain is present.
 */
function loadLocalOkrChainSummary(config: AppConfig): string {
  try {
    const okrDir = resolveOkrDir(config.memory.repository_path);
    if (!fs.existsSync(okrDir)) return '';
    const model = loadOkrFromDir(okrDir);
    return buildOkrSummary(model);
  } catch {
    return '';
  }
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

const LINEAR_SNAPSHOT_LIMIT = 60;

/**
 * One line per Linear issue, ordered so the actionable ones come first.
 * Deliberately terse: this block is budgeted to stay inside the first 20k chars
 * of the input pack, which is all life-review-os reads.
 */
export function linearIssueSnapshot(source: EvidenceSource | undefined): string {
  if (!source || source.state !== 'available') return '';
  const items = [...linearSnapshotItems(source.data, 'items'), ...linearSnapshotItems(source.data, 'recently_completed')];
  if (items.length === 0) return '';
  const rank = (item: LinearSnapshotItem): number => (item.stateType === 'started' ? 0 : item.stateType === 'unstarted' ? 1 : 2);
  return items
    .sort((left, right) => rank(left) - rank(right))
    .slice(0, LINEAR_SNAPSHOT_LIMIT)
    .map((item) =>
      [item.identifier, item.stateName || '-', item.stateType || '-', item.priority || '-', item.dueDate || '-', truncate(item.title, 80)].join(' | '),
    )
    .join('\n');
}

interface LinearSnapshotItem {
  identifier: string;
  title: string;
  stateName: string;
  stateType: string;
  priority: string;
  dueDate: string;
}

function linearSnapshotItems(data: unknown, key: 'items' | 'recently_completed'): LinearSnapshotItem[] {
  const raw = isRecord(data) && Array.isArray(data[key]) ? (data[key] as unknown[]) : [];
  const priorities: Record<number, string> = { 1: 'Urgent', 2: 'High', 3: 'Medium', 4: 'Low' };
  return raw.filter(isRecord).flatMap((item) => {
    if (typeof item.identifier !== 'string' || !item.identifier) return [];
    const state = isRecord(item.state) ? item.state : undefined;
    return [
      {
        identifier: item.identifier,
        title: typeof item.title === 'string' ? item.title : '',
        stateName: typeof state?.name === 'string' ? state.name : '',
        stateType: typeof state?.type === 'string' ? state.type : '',
        priority: typeof item.priority === 'number' ? priorities[item.priority] || 'None' : '',
        dueDate: typeof item.dueDate === 'string' ? item.dueDate : '',
      },
    ];
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function compactEvidenceForWeeklyPlanning(evidence: Awaited<ReturnType<typeof collectEvidence>>): Record<string, unknown> {
  const useful = Object.entries(evidence.sources)
    .filter(([name, source]) => {
      if (source.state !== 'available') return ['todo_inbox', 'linear', 'weekly_priorities'].includes(name);
      return (
        name === 'linear' ||
        name === 'todo_inbox' ||
        name === 'weekly_priorities' ||
        name === 'progress_ledger' ||
        name.includes('vault') ||
        name.includes('feishu')
      );
    })
    .map(([name, source]) => [
      name,
      {
        state: source.state,
        ...(source.detail ? { detail: source.detail } : {}),
        data_preview: previewSourceData(source.data),
      },
    ]);
  return {
    generated_at: evidence.generated_at,
    date: evidence.date,
    sources: Object.fromEntries(useful),
  };
}

function previewSourceData(data: unknown): string {
  if (data == null) return '';
  if (typeof data === 'string') return truncate(data, 8000);
  try {
    return truncate(JSON.stringify(data, null, 2), 8000);
  } catch {
    return truncate(String(data), 8000);
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
