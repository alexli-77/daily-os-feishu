import type { AppConfig, WorkflowName } from '../config/schema.js';
import { runAgent } from '../agent/index.js';
import { collectEvidence } from './evidence.js';
import { todayInTimezone } from '../utils/date.js';
import { appendDailyMemory, loadMemory, writeLatestWorkflowOutput, writeWorkflowDetailCache } from '../storage/memory.js';
import { sendFeishuCard, sendFeishuMessage } from '../connectors/lark-cli.js';
import { collectSyncDrift, filterUndecidedFindings, renderSyncDriftCard } from '../progress/sync-drift.js';
import { buildWorkflowEvidenceTrace, extractDailyPlanTodos, formatWorkflowSummaryForFeishu } from './summary.js';
import { buildScoredTodos } from '../todo/scorer.js';
import { recordTodoPresented } from '../todo/feedback.js';
import {
  markWorkflowRunFailed,
  markWorkflowRunGenerated,
  markWorkflowRunSucceeded,
  startWorkflowRun,
  type WorkflowRunRecord,
  type WorkflowRunTrigger,
} from './run-ledger.js';
import { runManager } from '../service/run-manager.js';

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
  // Minimal RunManager wiring: register this run so the console /runs page can
  // show it as in-flight and operators can request a cancel. The workflow runs
  // in-process (no killable child pid), so cancellation writes the ledger back
  // to failed via onCancel rather than signalling the server's own process.
  let cancelled = false;
  runManager.register(run.id, {}, {
    workflow,
    onCancel: () => {
      cancelled = true;
      run = markWorkflowRunFailed(config, run, 'Cancelled by operator from console.');
    },
  });
  try {
    const evidence = await collectEvidence(config, date);
    if (workflow === 'daily_plan') {
      // LEO-209: programmatically score the four todo sources and hand the LLM a
      // ranked top-N (with breakdown) instead of an unscored blob.
      evidence.sources.todo_scored = { state: 'available', data: buildScoredTodos(config, evidence, date) };
    }
    const memory = loadMemory(config);
    const text = await runAgentWithNonEmptyOutput({ config, workflow, date, evidence, memory, runId: run.id });
    const evidenceTrace = buildWorkflowEvidenceTrace({ evidence, memory });

    appendDailyMemory(config, workflow, date, text);
    writeLatestWorkflowOutput(config, workflow, date, text, evidenceTrace);
    const detail = writeWorkflowDetailCache(config, workflow, date, text, evidenceTrace);
    run = markWorkflowRunGenerated(config, run, { outputChars: text.length, detailId: detail.id });
    if (sendEnabled) {
      try {
        const todos = workflow === 'daily_plan' ? extractDailyPlanTodos(text) : [];
        await sendFeishuMessage(config, formatWorkflowSummaryForFeishu(workflow, date, text, evidence, config), {
          workflow,
          date,
          detailId: detail.id,
          ...(todos.length ? { todos } : {}),
        });
        if (todos.length) {
          recordTodoPresented(config, date, todos.map((todo) => ({ candidateId: todo.candidateId, rank: todo.rank })));
        }
      } catch (error) {
        run = markWorkflowRunFailed(config, run, error, { sendFailed: true });
        throw error;
      }
      // LEO-120: companion "possible sync drift" card with ignore / mark-handled /
      // draft buttons. Only sent for daily_review when the optional check is on
      // and there are undecided findings. A failure here never fails the run.
      if (workflow === 'daily_review' && config.progress_sync_check.enabled) {
        try {
          const findings = filterUndecidedFindings(collectSyncDrift(evidence, config).findings, date);
          if (findings.length > 0) {
            await sendFeishuCard(config, renderSyncDriftCard(config, date, findings), '有今天的进展可能还没同步到 GitHub / Linear。');
          }
        } catch (error) {
          console.warn(`[workflow] sync-drift companion card skipped: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      run = markWorkflowRunSucceeded(config, run, { status: 'succeeded' });
    } else {
      run = markWorkflowRunSucceeded(config, run, { status: 'skipped' });
    }
    return { text, date, detailId: detail.id, run };
  } catch (error) {
    if (!cancelled) markWorkflowRunFailed(config, run, error);
    throw error;
  } finally {
    runManager.unregister(run.id);
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
