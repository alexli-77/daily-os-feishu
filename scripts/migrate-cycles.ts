#!/usr/bin/env -S npx tsx
/**
 * LEO-280 — one-shot history migration into cycle files.
 *
 *   npx tsx scripts/migrate-cycles.ts --dry-run
 *   npx tsx scripts/migrate-cycles.ts
 *
 * Sources: the life-review-os `.runs` records (要务 + AI review) and the Feishu
 * weekly document (hand-written retro). Feishu is read through one paged block
 * dump and never written to.
 *
 * 🐶 cycles land in the vault's `20_CYCLES` via `src/cycles/file.ts`. 🐧 cycles
 * are exported to a separate directory instead — she runs her own Daily OS and
 * syncs through Supabase, so her history must not enter this machine's vault.
 *
 * Re-running is safe: a section is rewritten only when its content changed, and
 * a section the user owns (`source: user`) is never overwritten.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import yaml from 'js-yaml';

import { loadConfig } from '../src/config/load-config.js';
import type { AppConfig } from '../src/config/schema.js';
import { cyclesDir, readCycle } from '../src/cycles/file.js';
import {
  applyCyclePlan,
  loadRuns,
  parseFeishuTables,
  planCycles,
  tableMarker,
  type CycleApplyResult,
  type CyclePlan,
  type FeishuTable,
} from '../src/cycles/migration.js';
import { runCommand } from '../src/utils/command.js';

interface Options {
  dryRun: boolean;
  configPath: string;
  runsDir: string;
  doc: string;
  blocksFile: string;
  dumpBlocksTo: string;
  partnerOut: string;
  selfMarker: string;
  partnerMarker: string;
  year: number;
}

const USAGE = `Usage: npx tsx scripts/migrate-cycles.ts [options]

  --dry-run              Report what would change; write nothing.
  --config <path>        Daily OS config (default config/config.yaml).
  --runs-dir <dir>       life-review-os .runs directory
                         (default: <weekly-review skill workdir>/.runs).
  --doc <token>          Weekly document token
                         (default: the weekly-review skill's own config.yaml).
  --blocks <file>        Use a saved block dump instead of calling Feishu.
  --dump-blocks <file>   Save the fetched block dump to this file.
  --partner-out <dir>    Export root for 🐧 cycles (default data/exports/penguin-cycles).
  --self-marker <emoji>  Owner marker for this machine's vault (default 🐶).
  --partner-marker <e>   Owner marker exported instead of stored (default 🐧).
  --year <yyyy>          Year the weekly document covers (default: from the runs).
`;

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const config = loadConfig(options.configPath);

  const runsDir = options.runsDir || defaultRunsDir(config);
  const runs = loadRuns(runsDir);
  if (runs.length === 0) throw new Error(`No run records found in ${runsDir}. Pass --runs-dir.`);

  const blocks = await readBlocks(config, options);
  const tables = parseFeishuTables(blocks);
  const year = options.year || runs.map((run) => run.docYear).find((value) => value > 0) || new Date().getUTCFullYear();

  const plans = planCycles({
    runs,
    tables,
    selfMarker: options.selfMarker,
    partnerMarker: options.partnerMarker,
    year,
  });

  const partnerRoot = path.resolve(options.partnerOut);
  if (!options.dryRun) fs.mkdirSync(partnerRoot, { recursive: true });
  const partnerConfig: AppConfig = { ...config, memory: { ...config.memory, repository_path: partnerRoot } };
  const partnerReadable = fs.existsSync(partnerRoot);

  const results: CycleApplyResult[] = [];
  for (const plan of plans) {
    const target = plan.owner === 'self' ? config : partnerConfig;
    const readable = plan.owner === 'self' ? true : partnerReadable;
    const existing = readable ? readCycle(target, plan.id) : null;
    results.push(applyCyclePlan(target, plan, existing, { dryRun: options.dryRun }));
  }

  report({ options, runsDir, runs: runs.length, tables, plans, results, config, partnerConfig, year });
  if (results.some((result) => result.status === 'failed')) process.exitCode = 1;
}

// --- sources -----------------------------------------------------------------

async function readBlocks(config: AppConfig, options: Options): Promise<unknown[]> {
  if (options.blocksFile) {
    const parsed = JSON.parse(fs.readFileSync(path.resolve(options.blocksFile), 'utf8')) as unknown;
    if (!Array.isArray(parsed)) throw new Error(`${options.blocksFile} is not a block array.`);
    return parsed;
  }
  const doc = options.doc || defaultDocToken(config);
  if (!doc) throw new Error('No weekly document token. Pass --doc or --blocks.');

  // One paged dump rebuilds every table in the document. Reading cell by cell is
  // the same data at roughly a hundred times the requests.
  const blocks: unknown[] = [];
  let pageToken = '';
  for (let page = 0; page < 100; page += 1) {
    const params: Record<string, unknown> = { page_size: 500 };
    if (pageToken) params.page_token = pageToken;
    const result = await runCommand(
      'lark-cli',
      ['api', 'GET', `/open-apis/docx/v1/documents/${doc}/blocks`, '--params', JSON.stringify(params), '--as', 'user', '--format', 'json'],
      { timeoutMs: 60_000 },
    );
    if (!result.ok) throw new Error(`lark-cli failed while dumping blocks: ${result.stderr.slice(0, 400)}`);
    const payload = JSON.parse(result.stdout) as { code?: number; data?: { items?: unknown[]; page_token?: string; has_more?: boolean } };
    if (payload.code) throw new Error(`Feishu returned code ${payload.code} while dumping blocks.`);
    blocks.push(...(payload.data?.items || []));
    pageToken = payload.data?.page_token || '';
    if (!payload.data?.has_more) break;
  }
  if (options.dumpBlocksTo) {
    const file = path.resolve(options.dumpBlocksTo);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(blocks), 'utf8');
  }
  return blocks;
}

function weeklyReviewWorkdir(config: AppConfig): string {
  const entry = config.skills.registry.find((candidate) => candidate.id === 'weekly-review');
  if (!entry) return '';
  return expandPath(entry.workdir.trim() || path.dirname(entry.path));
}

function defaultRunsDir(config: AppConfig): string {
  const workdir = weeklyReviewWorkdir(config);
  if (!workdir) throw new Error('No weekly-review skill is configured. Pass --runs-dir.');
  return path.join(workdir, '.runs');
}

/** The document token lives in the skill's own ignored config, not in ours. */
function defaultDocToken(config: AppConfig): string {
  const workdir = weeklyReviewWorkdir(config);
  if (!workdir) return '';
  const file = path.join(workdir, 'config.yaml');
  if (!fs.existsSync(file)) return '';
  const parsed = yaml.load(fs.readFileSync(file, 'utf8')) as { documents?: { weekly?: Array<{ token?: string }> } };
  return parsed?.documents?.weekly?.[0]?.token || '';
}

function expandPath(value: string): string {
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return path.resolve(value);
}

// --- report ------------------------------------------------------------------

function report(input: {
  options: Options;
  runsDir: string;
  runs: number;
  tables: FeishuTable[];
  plans: CyclePlan[];
  results: CycleApplyResult[];
  config: AppConfig;
  partnerConfig: AppConfig;
  year: number;
}): void {
  const { options, plans, results } = input;
  // 🐶 and 🐧 share cycle labels, so a plain id is not a unique key here.
  const byId = new Map(results.map((result) => [`${result.owner}/${result.id}`, result]));

  console.log(`# Cycle history migration${options.dryRun ? ' (dry run — nothing written)' : ''}`);
  console.log(`runs:   ${input.runs} records from ${input.runsDir}`);
  console.log(`tables: ${input.tables.length} (${input.tables.map((table) => `${tableMarker(table) || '?'} ${table.rows}x${table.columns} ${table.layout}`).join(', ')})`);
  console.log(`year:   ${input.year}`);
  console.log(`🐶 ->   ${cyclesDir(input.config)}`);
  console.log(`🐧 ->   ${options.dryRun && !fs.existsSync(path.resolve(options.partnerOut)) ? path.join(path.resolve(options.partnerOut), '20_CYCLES') : cyclesDir(input.partnerConfig)}`);

  for (const owner of ['self', 'partner'] as const) {
    const scoped = plans.filter((plan) => plan.owner === owner);
    console.log(`\n## ${owner === 'self' ? '🐶 vault' : '🐧 export'} — ${scoped.length} cycles`);
    for (const plan of scoped) {
      const result = byId.get(`${plan.owner}/${plan.id}`);
      const sections = (['要务', 'retro', 'review'] as const)
        .map((section) => (plan.sections[section] ? `${section}(${plan.sections[section]!.length})` : `${section}=–`))
        .join(' ');
      console.log(`- ${plan.id}  [${plan.mode}] ${result?.status}  ${sections}`);
      if (result?.written.length) console.log(`    write: ${result.written.join(', ')}`);
      for (const skip of result?.skipped || []) console.log(`    skip:  ${skip.section} (${skip.reason})`);
      for (const note of plan.notes) console.log(`    note:  ${note}`);
      if (result?.error) console.log(`    ERROR: ${result.error}`);
    }
  }

  const counts = new Map<string, number>();
  for (const result of results) counts.set(result.status, (counts.get(result.status) || 0) + 1);
  console.log(`\n## summary`);
  console.log([...counts].map(([status, count]) => `${status}=${count}`).join(' ') || 'nothing to do');
}

// --- args --------------------------------------------------------------------

function parseArgs(argv: string[]): Options {
  const options: Options = {
    dryRun: false,
    configPath: 'config/config.yaml',
    runsDir: '',
    doc: '',
    blocksFile: '',
    dumpBlocksTo: '',
    partnerOut: 'data/exports/penguin-cycles',
    selfMarker: '🐶',
    partnerMarker: '🐧',
    year: 0,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = (): string => {
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`${arg} needs a value.`);
      index += 1;
      return value;
    };
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--config') options.configPath = next();
    else if (arg === '--runs-dir') options.runsDir = next();
    else if (arg === '--doc') options.doc = next();
    else if (arg === '--blocks') options.blocksFile = next();
    else if (arg === '--dump-blocks') options.dumpBlocksTo = next();
    else if (arg === '--partner-out') options.partnerOut = next();
    else if (arg === '--self-marker') options.selfMarker = next();
    else if (arg === '--partner-marker') options.partnerMarker = next();
    else if (arg === '--year') options.year = Number(next()) || 0;
    else if (arg === '--help' || arg === '-h') {
      console.log(USAGE);
      process.exit(0);
    } else throw new Error(`Unknown argument: ${arg}\n\n${USAGE}`);
  }
  return options;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
