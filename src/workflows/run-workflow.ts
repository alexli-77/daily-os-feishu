import type { AppConfig, WorkflowName } from '../config/schema.js';
import { runAgent } from '../agent/index.js';
import { collectEvidence } from './evidence.js';
import { todayInTimezone } from '../utils/date.js';
import { appendDailyMemory, loadMemory, writeLatestWorkflowOutput, writeWorkflowDetailCache } from '../storage/memory.js';
import { sendFeishuMessage } from '../connectors/lark-cli.js';
import { buildWorkflowEvidenceTrace, formatWorkflowSummaryForFeishu } from './summary.js';
import {
  markWorkflowRunFailed,
  markWorkflowRunGenerated,
  markWorkflowRunSucceeded,
  startWorkflowRun,
  type WorkflowRunRecord,
  type WorkflowRunTrigger,
} from './run-ledger.js';

export interface WorkflowRunResult {
  text: string;
  date: string;
  detailId: string;
  run: WorkflowRunRecord;
}

export async function runWorkflow(
  config: AppConfig,
  workflow: WorkflowName,
  options: { send?: boolean; trigger?: WorkflowRunTrigger; source?: string } = {},
): Promise<string> {
  return (await runWorkflowDetailed(config, workflow, options)).text;
}

export async function runWorkflowDetailed(
  config: AppConfig,
  workflow: WorkflowName,
  options: { send?: boolean; trigger?: WorkflowRunTrigger; source?: string } = {},
): Promise<WorkflowRunResult> {
  const date = todayInTimezone(config);
  const sendRequested = options.send ?? true;
  const sendEnabled = sendRequested && config.output.feishu.enabled;
  let run = startWorkflowRun(config, {
    workflow,
    date,
    trigger: options.trigger,
    source: options.source,
    sendEnabled,
    provider: config.output.feishu.provider,
    mode: config.output.feishu.send_mode,
  });
  try {
    const evidence = await collectEvidence(config, date);
    const memory = loadMemory(config);
    const text = await runAgentWithNonEmptyOutput({ config, workflow, date, evidence, memory });
    const evidenceTrace = buildWorkflowEvidenceTrace({ evidence, memory });

    appendDailyMemory(config, workflow, date, text);
    writeLatestWorkflowOutput(config, workflow, date, text, evidenceTrace);
    const detail = writeWorkflowDetailCache(config, workflow, date, text, evidenceTrace);
    run = markWorkflowRunGenerated(config, run, { outputChars: text.length, detailId: detail.id });
    if (sendEnabled) {
      try {
        await sendFeishuMessage(config, formatWorkflowSummaryForFeishu(workflow, date, text, evidence, config), { workflow, date, detailId: detail.id });
      } catch (error) {
        run = markWorkflowRunFailed(config, run, error, { sendFailed: true });
        throw error;
      }
      run = markWorkflowRunSucceeded(config, run, { status: 'succeeded' });
    } else {
      run = markWorkflowRunSucceeded(config, run, { status: 'skipped' });
    }
    return { text, date, detailId: detail.id, run };
  } catch (error) {
    markWorkflowRunFailed(config, run, error);
    throw error;
  }
}

async function runAgentWithNonEmptyOutput(input: Parameters<typeof runAgent>[0]): Promise<string> {
  const attempts = 2;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const text = (await runAgent(input)).trim();
    if (text.length > 0) return text;
    console.warn(`[workflow] ${input.workflow} returned empty output on attempt ${attempt}/${attempts}.`);
  }
  throw new Error(`${input.workflow} generated empty output after ${attempts} attempts; refusing to save or send an empty workflow card.`);
}
