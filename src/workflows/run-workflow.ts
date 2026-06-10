import type { AppConfig, WorkflowName } from '../config/schema.js';
import { runAgent } from '../agent/index.js';
import { collectEvidence } from './evidence.js';
import { todayInTimezone } from '../utils/date.js';
import { appendDailyMemory, loadMemory, writeLatestWorkflowOutput, writeWorkflowDetailCache } from '../storage/memory.js';
import { sendFeishuMessage } from '../connectors/lark-cli.js';
import { formatWorkflowSummaryForFeishu } from './summary.js';

export async function runWorkflow(config: AppConfig, workflow: WorkflowName, options: { send?: boolean } = {}): Promise<string> {
  const date = todayInTimezone(config);
  const evidence = await collectEvidence(config, date);
  const memory = loadMemory(config);
  const text = await runAgentWithNonEmptyOutput({ config, workflow, date, evidence, memory });

  appendDailyMemory(config, workflow, date, text);
  writeLatestWorkflowOutput(config, workflow, date, text);
  const detail = writeWorkflowDetailCache(config, workflow, date, text);
  if (options.send ?? true) {
    await sendFeishuMessage(config, formatWorkflowSummaryForFeishu(workflow, date, text), { workflow, date, detailId: detail.id });
  }
  return text;
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
