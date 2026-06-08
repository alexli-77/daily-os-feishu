import type { AppConfig, WorkflowName } from '../config/schema.js';
import { runAgent } from '../agent/index.js';
import { collectEvidence } from './evidence.js';
import { todayInTimezone } from '../utils/date.js';
import { appendDailyMemory, loadMemory, writeLatestWorkflowOutput } from '../storage/memory.js';
import { sendFeishuMessage } from '../connectors/lark-cli.js';
import { formatWorkflowSummaryForFeishu } from './summary.js';

export async function runWorkflow(config: AppConfig, workflow: WorkflowName, options: { send?: boolean } = {}): Promise<string> {
  const date = todayInTimezone(config);
  const evidence = await collectEvidence(config, date);
  const memory = loadMemory(config);
  const text = await runAgent({ config, workflow, date, evidence, memory });

  appendDailyMemory(config, workflow, date, text);
  writeLatestWorkflowOutput(config, workflow, date, text);
  if (options.send ?? true) await sendFeishuMessage(config, formatWorkflowSummaryForFeishu(workflow, date, text));
  return text;
}
