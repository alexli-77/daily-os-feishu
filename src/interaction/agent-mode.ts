import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AppConfig } from '../config/schema.js';
import { collectEvidence } from '../workflows/evidence.js';
import { todayInTimezone } from '../utils/date.js';
import { loadMemory } from '../storage/memory.js';
import type { FeishuAccessDecision } from './access-policy.js';
import type { FeishuControlEffect } from './access-policy.js';
import type { FeishuSessionRecord } from './session-catalog.js';

export interface FeishuAgentBridgeContext {
  chatId: string;
  chatType: 'p2p' | 'group';
  senderId: string;
  threadId?: string;
  messageIds: string[];
  scopeId: string;
  scopeHash: string;
  source: 'feishu';
}

export interface FeishuAgentModeInput {
  config: AppConfig;
  text: string;
  bridge: FeishuAgentBridgeContext;
  access: FeishuAccessDecision;
  session: FeishuSessionRecord;
}

export interface FeishuAgentModeResult {
  reply: string;
  threadId?: string;
}

export interface FeishuAgentModeRun {
  runId: string;
  done: Promise<FeishuAgentModeResult>;
  stop: () => Promise<void>;
}

export async function startFeishuAgentModeRun(input: FeishuAgentModeInput): Promise<FeishuAgentModeRun> {
  const runId = `run_${Date.now()}_${process.pid}`;
  const outputPath = path.join(os.tmpdir(), `daily-os-feishu-agent-${runId}.md`);
  const codexBin = process.env.CODEX_BIN || 'codex';
  const workdir = agentWorkdir(input.config);
  const args = codexArgs(input, outputPath, workdir);
  const prompt = await buildFeishuAgentPrompt(input);
  const child = spawn(codexBin, args, { stdio: ['pipe', 'pipe', 'pipe'], cwd: workdir, env: { ...process.env } });
  let stdout = '';
  let stderr = '';
  let threadId = input.session.codex_session_id;
  let stopped = false;
  let settled = false;

  const timeout = setTimeout(() => {
    stopped = true;
    stopChild(child);
  }, input.config.interaction.feishu.agent_mode.timeout_ms);

  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8');
    threadId = parseThreadId(stdout) || threadId;
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });
  child.stdin.end(prompt, 'utf8');

  const done = new Promise<FeishuAgentModeResult>((resolve, reject) => {
    child.on('error', (error) => {
      clearTimeout(timeout);
      settled = true;
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      settled = true;
      const reply = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf8').trim() : '';
      fs.rmSync(outputPath, { force: true });
      if (code === 0 || stopped) {
        resolve({
          reply: stopped ? '已停止当前 Codex 会话。' : reply || 'Codex 已完成，但没有返回可发送内容。',
          ...(threadId ? { threadId } : {}),
        });
        return;
      }
      reject(new Error(`Codex agent mode failed: ${(stderr || stdout).slice(0, 2000)}`));
    });
  });

  return {
    runId,
    done,
    stop: async () => {
      if (settled) return;
      stopped = true;
      await stopChild(child);
    },
  };
}

export function agentWorkdir(config: AppConfig): string {
  return path.resolve(config.interaction.feishu.agent_mode.workdir.trim() || process.cwd());
}

export function agentModeControlEffect(config: AppConfig): FeishuControlEffect {
  const sandbox = config.interaction.feishu.agent_mode.sandbox;
  if (sandbox === 'read-only') return 'workspace_read';
  if (sandbox === 'workspace-write') return 'workspace_write';
  return 'full_control';
}

function codexArgs(input: FeishuAgentModeInput, outputPath: string, workdir: string): string[] {
  const agent = input.config.interaction.feishu.agent_mode;
  const common = ['--skip-git-repo-check', '--ignore-rules', '--json', '--output-last-message', outputPath];
  if (!['', 'default', 'auto'].includes(input.config.llm.model.trim())) {
    common.push('-m', input.config.llm.model);
  }

  if (input.session.codex_session_id) {
    return ['exec', 'resume', ...common, input.session.codex_session_id, '-'];
  }

  if (agent.sandbox === 'danger-full-access') {
    common.push('--sandbox', 'danger-full-access');
  } else {
    common.push('--sandbox', agent.sandbox);
  }
  return ['exec', ...common, '--cd', workdir, '-'];
}

async function buildFeishuAgentPrompt(input: FeishuAgentModeInput): Promise<string> {
  const context = await buildOptionalContext(input);
  return [
    section('bridge_context', input.bridge),
    section('session', {
      scope_id: input.session.scope_id,
      has_codex_session: Boolean(input.session.codex_session_id),
      workdir: agentWorkdir(input.config),
      sandbox: input.config.interaction.feishu.agent_mode.sandbox,
      access_role: input.access.role,
      access_level: input.config.interaction.feishu.security.access_level,
    }),
    section('instructions', [
      '你是 Daily OS 的 Feishu 远程 Codex agent mode。',
      '用中文回复，回复内容会直接发回飞书。',
      '优先像助手一样和用户自然协作；如果需要执行代码或读取文件，遵守当前 sandbox 和远程控制策略。',
      '不要泄露 token、密钥、完整本地隐私路径或隐藏推理。',
      '如果用户要求超出当前权限，解释缺少的配置或权限，不要假装已经执行。',
      '如果你完成了可以由 Codex 代做的工作，简短说明结果、文件或下一步。',
    ]),
    context ? section('daily_os_context', context) : '',
    section('user_input', { text: input.text }),
  ]
    .filter(Boolean)
    .join('\n\n');
}

async function buildOptionalContext(input: FeishuAgentModeInput): Promise<unknown> {
  const agent = input.config.interaction.feishu.agent_mode;
  const context: Record<string, unknown> = {};
  if (agent.include_memory) context.memory = loadMemory(input.config);
  if (agent.include_evidence) context.evidence = await buildEvidenceContext(input.config);
  return Object.keys(context).length > 0 ? context : null;
}

export async function buildEvidenceContext(config: AppConfig): Promise<unknown | null> {
  if (!config.interaction.feishu.agent_mode.include_evidence) return null;
  return collectEvidence(config, todayInTimezone(config));
}

function section(tag: string, value: unknown): string {
  return `<${tag}>\n${safeJson(value)}\n</${tag}>`;
}

function safeJson(value: unknown): string {
  return (JSON.stringify(value, null, 2) || 'null')
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function parseThreadId(stdout: string): string | undefined {
  for (const line of stdout.split('\n')) {
    try {
      const parsed = JSON.parse(line) as { type?: unknown; thread_id?: unknown };
      if (parsed.type === 'thread.started' && typeof parsed.thread_id === 'string') return parsed.thread_id;
    } catch {
      // Ignore non-JSON progress lines.
    }
  }
  return undefined;
}

async function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      resolve();
    }, 5000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
