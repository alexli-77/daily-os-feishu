import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import type { AppConfig } from '../config/schema.js';
import { runCommand, type CommandResult } from '../utils/command.js';
import { addDays } from '../utils/date.js';
import { readLatestSkillRun } from './runner.js';

type SkillEntry = AppConfig['skills']['registry'][number];

interface WeeklyReviewSkillConfig {
  user?: {
    symbol?: string;
    timezone?: string;
  };
  documents?: {
    weekly?: Array<{
      year?: number;
      token?: string;
      table_block_id?: string;
      okr_heading?: string;
      table_marker?: string;
      task_header_suffix?: string;
      retro_header_suffix?: string;
    }>;
  };
}

interface WeeklyDocTarget {
  year: number;
  token: string;
  tableBlockId: string;
  marker: string;
  taskHeaderSuffix: string;
  retroHeaderSuffix: string;
  docLabel: string;
}

interface TableSnapshot {
  blockId: string;
  rowCount: number;
  columnCount: number;
  cells: string[];
  headers: string[];
  firstColumn: string[];
}

type TableLayout = 'retro_before_task' | 'task_before_retro';

export interface WeeklyReviewWritebackItem {
  text: string;
  targetRow: number;
  targetRowLabel: string;
  isMit: boolean;
}

export interface WeeklyReviewWritebackPlan {
  token: string;
  skillId: string;
  mode: string;
  runId?: string;
  createdAt: string;
  expiresAt: string;
  target: {
    docLabel: string;
    year: number;
    weekLabel: string;
    taskHeader: string;
    retroHeader: string;
    tableMarker: string;
    layout: TableLayout;
    action: 'append_to_existing_empty_column' | 'insert_columns';
    taskColumnIndex: number;
    retroColumnIndex: number;
  };
  items: WeeklyReviewWritebackItem[];
}

export interface WeeklyReviewWritebackResult {
  weekLabel: string;
  taskHeader: string;
  itemCount: number;
  insertedColumns: boolean;
}

const PENDING_TTL_MS = 30 * 60 * 1000;

export async function prepareWeeklyReviewWriteback(input: {
  config: AppConfig;
  skillId: string;
  mode?: string;
  runId?: string;
  now?: Date;
}): Promise<WeeklyReviewWritebackPlan> {
  if (input.skillId !== 'weekly-review') throw new Error('Only weekly-review write-back is supported.');
  const mode = input.mode || 'weekly';
  if (mode !== 'weekly') throw new Error(`Write-back is currently supported for weekly mode only, got: ${mode}`);
  const run = readLatestSkillRun(input.config, input.skillId, mode, input.runId);
  if (!run) throw new Error('No recent weekly-review draft found. Run `daily-os weekly deep` first.');
  const items = extractWeeklyWritebackItems(run.output);
  if (items.length === 0) throw new Error('No write-backable next-week plan items were found in the latest skill draft.');

  const entry = skillEntry(input.config, input.skillId);
  const skillConfig = loadWeeklyReviewSkillConfig(entry);
  const targetDate = targetWeekDate(input.config, input.now);
  const week = weekRange(targetDate);
  const doc = weeklyDocTarget(skillConfig, week.start);
  const snapshot = await readTableSnapshot(doc);
  validateTableMarker(snapshot, doc.marker);
  const layout = detectTableLayout(snapshot.headers, doc.retroHeaderSuffix, doc.taskHeaderSuffix);
  const taskHeader = `${week.label} ${doc.taskHeaderSuffix}`;
  const retroHeader = layout === 'retro_before_task' ? doc.retroHeaderSuffix : `${week.label} ${doc.retroHeaderSuffix}`;
  const existingTaskColumn = findHeaderIndex(snapshot.headers, taskHeader);
  const existingRetroColumn = findRetroColumn(snapshot.headers, doc.retroHeaderSuffix, existingTaskColumn, layout);
  const taskColumnIndex = existingTaskColumn >= 0 ? existingTaskColumn : layout === 'retro_before_task' ? 2 : 1;
  const retroColumnIndex = existingTaskColumn >= 0 ? existingRetroColumn : layout === 'retro_before_task' ? 1 : 2;
  if (existingTaskColumn >= 0) await ensureTargetColumnEmpty(doc, snapshot, existingTaskColumn);

  const plan: WeeklyReviewWritebackPlan = {
    token: crypto.randomUUID(),
    skillId: input.skillId,
    mode,
    runId: run.runId,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + PENDING_TTL_MS).toISOString(),
    target: {
      docLabel: doc.docLabel,
      year: doc.year,
      weekLabel: week.label,
      taskHeader,
      retroHeader,
      tableMarker: doc.marker,
      layout,
      action: existingTaskColumn >= 0 ? 'append_to_existing_empty_column' : 'insert_columns',
      taskColumnIndex,
      retroColumnIndex,
    },
    items: assignItemsToRows(items, snapshot.firstColumn),
  };
  savePendingPlan(input.config, plan);
  return plan;
}

export async function executeWeeklyReviewWriteback(config: AppConfig, token: string): Promise<WeeklyReviewWritebackResult> {
  const plan = readPendingPlan(config, token);
  if (!plan) throw new Error('Write-back confirmation expired or was not found. Please prepare write-back again.');
  if (new Date(plan.expiresAt).getTime() < Date.now()) throw new Error('Write-back confirmation expired. Please prepare write-back again.');

  const doc = weeklyDocTarget(loadWeeklyReviewSkillConfig(skillEntry(config, plan.skillId)), `${plan.target.year}-01-01`);
  const snapshot = await readTableSnapshot(doc);
  validateTableMarker(snapshot, doc.marker);
  const existingTaskColumn = findHeaderIndex(snapshot.headers, plan.target.taskHeader);
  let taskColumn = existingTaskColumn;
  let insertedColumns = false;

  if (taskColumn >= 0) {
    await ensureTargetColumnEmpty(doc, snapshot, taskColumn);
  } else {
    insertedColumns = true;
    await insertWeekColumns(doc, plan.target.layout, plan.target.retroColumnIndex);
    const updated = await readTableSnapshot(doc);
    validateTableMarker(updated, doc.marker);
    taskColumn = findHeaderIndex(updated.headers, plan.target.taskHeader);
    if (taskColumn < 0) {
      const retroColumn = plan.target.layout === 'retro_before_task' ? 1 : 2;
      const taskHeaderColumn = plan.target.layout === 'retro_before_task' ? 2 : 1;
      await writePlainTextBlock(doc, updated.cells[0 * updated.columnCount + retroColumn], plan.target.retroHeader);
      await writePlainTextBlock(doc, updated.cells[0 * updated.columnCount + taskHeaderColumn], plan.target.taskHeader);
      taskColumn = taskHeaderColumn;
    }
  }

  const finalSnapshot = await readTableSnapshot(doc);
  await ensureTargetColumnEmpty(doc, finalSnapshot, taskColumn);
  const grouped = groupItemsByRow(plan.items, finalSnapshot.rowCount);
  for (const [rowIndex, items] of grouped) {
    if (rowIndex <= 0 || rowIndex >= finalSnapshot.rowCount) continue;
    const cellId = finalSnapshot.cells[rowIndex * finalSnapshot.columnCount + taskColumn];
    for (const [index, item] of items.entries()) {
      await writeOrderedBlock(doc, cellId, item.text, item.isMit, index);
    }
  }
  removePendingPlan(config, token);
  return {
    weekLabel: plan.target.weekLabel,
    taskHeader: plan.target.taskHeader,
    itemCount: plan.items.length,
    insertedColumns,
  };
}

export function extractWeeklyWritebackItems(output: string): string[] {
  const lines = output.split('\n').map((line) => line.trim()).filter(Boolean);
  const headingIndex = lines.findIndex((line) => isNextWeekPlanHeading(stripMarkdown(line)));
  const startIndex = headingIndex >= 0 ? headingIndex : lines.findIndex((line) => /下周|next[-\s]?week|带走|计划/.test(stripMarkdown(line)));
  const relevant = startIndex >= 0 ? lines.slice(startIndex + 1) : lines;
  const items: string[] = [];
  for (let index = 0; index < relevant.length; index += 1) {
    const raw = stripMarkdown(relevant[index] || '');
    if (!raw) continue;
    if (/^-{3,}$/.test(raw)) continue;
    if (/^\[?如有余力\]?/.test(raw)) break;
    if (/^(如果|您确认|你确认|想看|按钮|已写入|目标文档|写回)/.test(raw)) break;
    if (/^>?\s*基于\s/.test(raw)) continue;
    const mit = raw.match(/^MIT\s*🔴?[：:]\s*(.+)$/i);
    if (mit?.[1]) {
      items.push(`MIT 🔴: ${mit[1].trim()}`);
      continue;
    }
    const numbered = raw.match(/^(?:[-*]|\d+[.、])\s*(.+)$/);
    if (!numbered?.[1]) continue;
    let item = numbered[1].replace(/\s+MIT\/[—-]$/i, '').trim();
    if (/^完成标准[：:]/.test(item)) continue;
    const next = stripMarkdown(relevant[index + 1] || '');
    if (/^目标[：:]/.test(next)) {
      item = `${item}；${next}`;
      index += 1;
    }
    if (item && !/^目标[：:]/.test(item)) items.push(item);
  }
  return Array.from(new Set(items)).slice(0, 10);
}

function isNextWeekPlanHeading(value: string): boolean {
  return /^(?:#{1,6}\s*)?(?:📋\s*)?(?:下周计划|下周带走|next[-\s]?week plan)(?:\s|（|\(|$)/i.test(value);
}

export function detectTableLayout(headers: string[], retroSuffix: string, taskSuffix: string): TableLayout {
  const retroIndex = headers.findIndex((header, index) => index > 0 && header.toLowerCase().includes(retroSuffix.toLowerCase()));
  const taskIndex = headers.findIndex((header, index) => index > 0 && header.includes(taskSuffix));
  return retroIndex >= 0 && taskIndex >= 0 && retroIndex < taskIndex ? 'retro_before_task' : 'task_before_retro';
}

export function targetWeekLabelForDate(date: string): string {
  return weekRange(date).label;
}

function assignItemsToRows(items: string[], firstColumn: string[]): WeeklyReviewWritebackItem[] {
  return items.map((item) => {
    const row = bestRowForItem(item, firstColumn);
    return {
      text: item,
      targetRow: row,
      targetRowLabel: summarizeRow(firstColumn[row] || '未匹配主线'),
      isMit: /MIT|🔴/.test(item),
    };
  });
}

function bestRowForItem(item: string, rows: string[]): number {
  let best = 1;
  let bestScore = 0;
  for (let row = 1; row < rows.length; row += 1) {
    const score = overlapScore(item, rows[row] || '');
    if (score > bestScore) {
      best = row;
      bestScore = score;
    }
  }
  return bestScore >= 2 ? best : 1;
}

function overlapScore(left: string, right: string): number {
  const leftTokens = tokenSet(left);
  const rightTokens = tokenSet(right);
  let score = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) score += token.length > 4 ? 2 : 1;
  }
  return score;
}

function tokenSet(value: string): Set<string> {
  const normalized = value.toLowerCase();
  const tokens = new Set<string>();
  for (const token of normalized.match(/[a-z0-9][a-z0-9_-]{2,}/g) || []) tokens.add(token);
  for (const token of normalized.match(/[\p{Script=Han}]{2,}/gu) || []) {
    for (let index = 0; index < token.length - 1; index += 1) tokens.add(token.slice(index, index + 2));
  }
  return tokens;
}

function groupItemsByRow(items: WeeklyReviewWritebackItem[], rowCount: number): Map<number, WeeklyReviewWritebackItem[]> {
  const grouped = new Map<number, WeeklyReviewWritebackItem[]>();
  for (const item of items) {
    const row = item.targetRow > 0 && item.targetRow < rowCount ? item.targetRow : 1;
    grouped.set(row, [...(grouped.get(row) || []), item]);
  }
  return grouped;
}

async function insertWeekColumns(doc: WeeklyDocTarget, layout: TableLayout, retroColumnIndex: number): Promise<void> {
  if (layout === 'retro_before_task') {
    await patchTable(doc, { insert_table_column: { column_index: retroColumnIndex } });
    await patchTable(doc, { insert_table_column: { column_index: retroColumnIndex + 1 } });
    return;
  }
  await patchTable(doc, { insert_table_column: { column_index: retroColumnIndex - 1 } });
  await patchTable(doc, { insert_table_column: { column_index: retroColumnIndex } });
}

async function readTableSnapshot(doc: WeeklyDocTarget): Promise<TableSnapshot> {
  const tableResult = await larkApi('GET', `/open-apis/docx/v1/documents/${doc.token}/blocks/${doc.tableBlockId}`);
  const block = asRecord(asRecord(asRecord(tableResult).data).block);
  const table = asRecord(block.table);
  const property = asRecord(table.property);
  const cells = asStringArray(table.cells);
  const columnCount = numberValue(property.column_size || property.column_count || property.col_count);
  const rowCount = numberValue(property.row_size || property.row_count);
  if (!columnCount || !rowCount || cells.length < columnCount * rowCount) {
    throw new Error('Weekly table block did not include valid row/column metadata.');
  }
  const headers: string[] = [];
  for (let col = 0; col < columnCount; col += 1) headers.push(await readCellText(doc, cells[col]));
  const firstColumn: string[] = [];
  for (let row = 0; row < rowCount; row += 1) firstColumn.push(await readCellText(doc, cells[row * columnCount]));
  return { blockId: doc.tableBlockId, rowCount, columnCount, cells, headers, firstColumn };
}

async function readCellText(doc: WeeklyDocTarget, cellId: string): Promise<string> {
  const cellResult = await larkApi('GET', `/open-apis/docx/v1/documents/${doc.token}/blocks/${cellId}`);
  const cell = asRecord(asRecord(asRecord(cellResult).data).block);
  const children = asStringArray(cell.children);
  const chunks: string[] = [];
  for (const childId of children) {
    const childResult = await larkApi('GET', `/open-apis/docx/v1/documents/${doc.token}/blocks/${childId}`);
    chunks.push(textFromUnknown(asRecord(asRecord(childResult).data).block));
  }
  return chunks.join(' ').replace(/\s+/g, ' ').trim();
}

async function writePlainTextBlock(doc: WeeklyDocTarget, cellId: string, content: string): Promise<void> {
  await postCellChildren(doc, cellId, {
    children: [
      {
        block_type: 2,
        text: {
          elements: [{ text_run: { content } }],
          style: {},
        },
      },
    ],
    index: 0,
  });
}

async function writeOrderedBlock(doc: WeeklyDocTarget, cellId: string, content: string, isMit: boolean, index: number): Promise<void> {
  await postCellChildren(doc, cellId, {
    children: [
      {
        block_type: 13,
        ordered: {
          elements: isMit
            ? [
                { text_run: { content: content.replace(/\s*🔴\s*/g, ' ').trim() } },
                { text_run: { content: ' 🔴', text_element_style: { text_color: 1 } } },
              ]
            : [{ text_run: { content } }],
          style: {},
        },
      },
    ],
    index,
  });
}

async function patchTable(doc: WeeklyDocTarget, data: object): Promise<void> {
  await larkApi('PATCH', `/open-apis/docx/v1/documents/${doc.token}/blocks/${doc.tableBlockId}`, data);
}

async function postCellChildren(doc: WeeklyDocTarget, cellId: string, data: object): Promise<void> {
  await larkApi('POST', `/open-apis/docx/v1/documents/${doc.token}/blocks/${cellId}/children`, data);
}

async function larkApi(method: 'GET' | 'POST' | 'PATCH', apiPath: string, data?: object): Promise<unknown> {
  const args = ['api', method, apiPath, '--as', 'user', '--format', 'json'];
  if (data) args.push('--data', JSON.stringify(data));
  const result: CommandResult = await runCommand('lark-cli', args, { timeoutMs: 30000 });
  if (!result.ok) throw new Error(`lark-cli ${method} failed: ${safeError(result.stderr || result.stdout)}`);
  try {
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    if (parsed.code !== undefined && parsed.code !== 0) {
      throw new Error(`lark-cli ${method} failed: ${safeError(JSON.stringify(parsed).slice(0, 1000))}`);
    }
    return parsed;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('lark-cli')) throw error;
    throw new Error(`lark-cli ${method} returned invalid JSON: ${safeError(result.stdout.slice(0, 500))}`);
  }
}

function skillEntry(config: AppConfig, skillId: string): SkillEntry {
  const entry = config.skills.registry.find((candidate) => candidate.id === skillId);
  if (!entry) throw new Error(`Skill not configured: ${skillId}`);
  return entry;
}

function loadWeeklyReviewSkillConfig(entry: SkillEntry): WeeklyReviewSkillConfig {
  const configPath = path.join(skillWorkdir(entry), 'config.yaml');
  if (!fs.existsSync(configPath)) throw new Error('weekly-review config.yaml is missing. Create it locally from config.example.yaml first.');
  const parsed = yaml.load(fs.readFileSync(configPath, 'utf8')) as WeeklyReviewSkillConfig;
  if (!parsed || typeof parsed !== 'object') throw new Error('weekly-review config.yaml is invalid.');
  return parsed;
}

function weeklyDocTarget(config: WeeklyReviewSkillConfig, date: string): WeeklyDocTarget {
  const year = Number(date.slice(0, 4));
  const docs = config.documents?.weekly || [];
  const selected = docs.find((doc) => doc.year === year) || docs[0];
  if (!selected?.token || !selected.table_block_id) throw new Error(`weekly-review config.yaml is missing token/table_block_id for ${year}.`);
  return {
    year: selected.year || year,
    token: selected.token,
    tableBlockId: selected.table_block_id,
    marker: selected.table_marker || config.user?.symbol || '🐶',
    taskHeaderSuffix: selected.task_header_suffix || '要务',
    retroHeaderSuffix: selected.retro_header_suffix || 'retro',
    docLabel: `Weekly ${selected.year || year}`,
  };
}

function targetWeekDate(config: AppConfig, now = new Date()): string {
  const date = new Intl.DateTimeFormat('en-CA', {
    timeZone: config.user.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return day === 0 ? addDays(date, 1) : date;
}

function weekRange(date: string): { start: string; end: string; label: string } {
  const d = new Date(`${date}T00:00:00Z`);
  const day = d.getUTCDay();
  const monday = new Date(d);
  monday.setUTCDate(d.getUTCDate() + (day === 0 ? -6 : 1 - day));
  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);
  const start = monday.toISOString().slice(0, 10);
  const end = sunday.toISOString().slice(0, 10);
  return { start, end, label: `${monday.getUTCMonth() + 1}.${monday.getUTCDate()}-${sunday.getUTCMonth() + 1}.${sunday.getUTCDate()}` };
}

function validateTableMarker(snapshot: TableSnapshot, marker: string): void {
  const sample = [...snapshot.headers, ...snapshot.firstColumn].join('\n');
  if (!sample.includes(marker)) throw new Error(`Target table marker check failed. Expected marker: ${marker}`);
}

async function ensureTargetColumnEmpty(doc: WeeklyDocTarget, snapshot: TableSnapshot, column: number): Promise<void> {
  const filledRows: number[] = [];
  for (let row = 1; row < snapshot.rowCount; row += 1) {
    const cellId = snapshot.cells[row * snapshot.columnCount + column];
    const text = await readCellText(doc, cellId);
    if (text.trim()) filledRows.push(row);
  }
  if (filledRows.length > 0) throw new Error(`Target column already has content in rows: ${filledRows.join(', ')}. Write-back stopped to avoid overwrite.`);
}

function findHeaderIndex(headers: string[], label: string): number {
  const normalized = label.replace(/\s+/g, '').toLowerCase();
  return headers.findIndex((header) => header.replace(/\s+/g, '').toLowerCase().includes(normalized));
}

function findRetroColumn(headers: string[], retroSuffix: string, taskColumn: number, layout: TableLayout): number {
  if (taskColumn < 0) return layout === 'retro_before_task' ? 1 : 2;
  const candidate = layout === 'retro_before_task' ? taskColumn - 1 : taskColumn + 1;
  if (headers[candidate]?.toLowerCase().includes(retroSuffix.toLowerCase())) return candidate;
  return candidate;
}

function savePendingPlan(config: AppConfig, plan: WeeklyReviewWritebackPlan): void {
  const filePath = pendingPath(config);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const plans = readPendingPlans(config)
    .filter((candidate) => candidate.token !== plan.token)
    .filter((candidate) => new Date(candidate.expiresAt).getTime() > Date.now());
  plans.push(plan);
  fs.writeFileSync(filePath, `${JSON.stringify(plans.slice(-20), null, 2)}\n`, 'utf8');
}

function readPendingPlan(config: AppConfig, token: string): WeeklyReviewWritebackPlan | null {
  return readPendingPlans(config).find((plan) => plan.token === token) || null;
}

function removePendingPlan(config: AppConfig, token: string): void {
  const filePath = pendingPath(config);
  const plans = readPendingPlans(config).filter((plan) => plan.token !== token);
  fs.writeFileSync(filePath, `${JSON.stringify(plans, null, 2)}\n`, 'utf8');
}

function readPendingPlans(config: AppConfig): WeeklyReviewWritebackPlan[] {
  const filePath = pendingPath(config);
  if (!fs.existsSync(filePath)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as WeeklyReviewWritebackPlan[];
    return Array.isArray(parsed) ? parsed.filter((plan) => plan && typeof plan.token === 'string') : [];
  } catch {
    return [];
  }
}

function pendingPath(config: AppConfig): string {
  return path.resolve(config.skills.inputs_dir, '_weekly-review-writeback-pending.json');
}

function skillWorkdir(entry: SkillEntry): string {
  if (entry.workdir.trim()) return expandPath(entry.workdir);
  return path.dirname(expandPath(entry.path));
}

function expandPath(value: string): string {
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return path.resolve(value);
}

function stripMarkdown(value: string): string {
  return value
    .replace(/^#+\s*/, '')
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .replace(/^>\s*/, '')
    .trim();
}

function summarizeRow(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, 80) || '未匹配主线';
}

function textFromUnknown(value: unknown): string {
  const chunks: string[] = [];
  const visit = (current: unknown): void => {
    if (typeof current === 'string') return;
    if (Array.isArray(current)) {
      current.forEach(visit);
      return;
    }
    if (!current || typeof current !== 'object') return;
    const record = current as Record<string, unknown>;
    if (typeof record.content === 'string') chunks.push(record.content);
    Object.values(record).forEach(visit);
  };
  visit(value);
  return chunks.join('').trim();
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function numberValue(value: unknown): number {
  return typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : 0;
}

function safeError(value: string): string {
  return value
    .replace(/\b(?:doccn|doxcn)[A-Za-z0-9_-]{8,}\b/g, '[redacted-doc-token]')
    .replace(/(documents\/)[A-Za-z0-9_-]+/g, '$1[redacted-doc-token]')
    .replace(/(blocks\/)[A-Za-z0-9_-]+/g, '$1[redacted-block-id]')
    .slice(0, 1200);
}
