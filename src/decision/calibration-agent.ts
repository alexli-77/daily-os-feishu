import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import OpenAI from 'openai';
import type { AppConfig } from '../config/schema.js';
import { runCommand } from '../utils/command.js';
import { decisionPolicyFiles, ensureDecisionPolicyFiles } from './policy.js';
import { createPolicyCandidate, type PolicyRuleDraft } from './candidates.js';

export interface DecisionCalibrationInput {
  text: string;
  chatId: string;
  senderOpenId: string;
  messageId: string;
}

export async function runDecisionCalibrationAgent(config: AppConfig, input: DecisionCalibrationInput): Promise<string> {
  ensureDecisionPolicyFiles(config);
  const prompt = buildCalibrationPrompt(config, input);
  const raw = config.llm.provider === 'openai' ? await runOpenAiCalibration(config, prompt) : await runCodexCalibration(config, prompt);
  const output = parseCalibrationOutput(raw);
  let reply = output.reply;

  if (output.candidate) {
    const candidate = createPolicyCandidate(config, {
      chatId: input.chatId,
      messageId: input.messageId,
      senderOpenId: input.senderOpenId,
      rawUserText: input.text,
      assistantReply: reply,
      rule: output.candidate,
    });
    reply = [
      reply,
      '',
      `已记录一条待确认候选规则：\`${candidate.id}\``,
      '',
      '确认保存：`daily-os 保存规则 ' + candidate.id + '`',
      '拒绝候选：`daily-os 拒绝规则 ' + candidate.id + '`',
      '在这个决策校准群里，也可以直接回复“保存规则 ' + candidate.id + '”。',
    ].join('\n');
  }

  appendCalibrationLog(config, input, reply);
  return reply;
}

function buildCalibrationPrompt(config: AppConfig, input: DecisionCalibrationInput): string {
  const files = decisionPolicyFiles(config);
  const policy = readFilePreview(files.policyPath, 5000);
  const notes = readFilePreview(files.notesPath, 5000);
  const candidates = readFilePreview(files.candidatesPath, 4000);

  return [
    '# 角色',
    '你是 Daily OS 的决策校准助手。你的任务不是直接替用户做最终决定，而是通过自然对话帮助用户逐步磨合“以后应该如何做决策”的长期规则。',
    '',
    '# 行为规则',
    '- 使用中文回复。',
    '- 像一个可靠的助手一样对话，不要像配置表。',
    '- 每次最多问一个关键追问。',
    '- 如果用户表达了可复用的偏好，先总结成“候选规则”，并明确标注“待确认”。',
    '- 不要声称已经保存长期规则。本版本只记录候选，长期规则必须用户确认后再保存。',
    '- 区分“一次性偏好”和“以后都这样”。如果不确定，就问用户。',
    '- 关注 todo、daily plan、review、weekly review 中如何应用这条规则。',
    '',
    '# 当前用户',
    JSON.stringify(config.user, null, 2),
    '',
    '# 当前结构化决策规则 decision-policy.yaml',
    '```yaml',
    policy.trim() || '（空）',
    '```',
    '',
    '# 当前规则说明 decision-policy.md',
    notes.trim() || '（空）',
    '',
    '# 已有待确认候选规则',
    candidates.trim() || '（空）',
    '',
    '# 用户刚刚在决策校准群里说',
    input.text,
    '',
    '# 输出要求',
    '只输出 JSON，不要输出 Markdown 代码块、隐藏推理或工具调用。',
    'JSON 结构：',
    '{',
    '  "reply": "要发回飞书的中文消息",',
    '  "candidate": null 或 {',
    '    "id": "短横线英文规则ID，可省略",',
    '    "description": "可长期复用的中文规则描述",',
    '    "applies_to": ["daily_plan", "todo", "daily_review", "weekly_review"],',
    '    "when": {"触发条件": "用结构化短句表达"},',
    '    "then": {"执行方式": "用结构化短句表达"},',
    '    "reason": "为什么这条规则值得保存"',
    '  }',
    '}',
    '',
    '只有当用户表达了“以后也应该这样判断”的可复用偏好时，candidate 才能非空；如果只是一次性聊天或信息不足，candidate 必须为 null。',
    'reply 中必须说明候选规则仍待用户确认，不能说已经保存。',
  ].join('\n');
}

async function runCodexCalibration(config: AppConfig, prompt: string): Promise<string> {
  const codexBin = process.env.CODEX_BIN || 'codex';
  const outputPath = path.join(os.tmpdir(), `daily-os-decision-calibration-${Date.now()}-${process.pid}.md`);
  const args = ['exec', '--skip-git-repo-check', '--ignore-rules', '--ephemeral', '--output-last-message', outputPath, '-'];
  if (!['', 'default', 'auto'].includes(config.llm.model.trim())) {
    args.splice(4, 0, '-m', config.llm.model);
  }
  const result = await runCommand(codexBin, args, { input: prompt, timeoutMs: 180000 });
  if (!result.ok) throw new Error(`Codex 决策校准失败：${(result.stderr || result.stdout).slice(0, 2000)}`);
  const text = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf8') : result.stdout;
  fs.rmSync(outputPath, { force: true });
  return text.trim();
}

async function runOpenAiCalibration(config: AppConfig, prompt: string): Promise<string> {
  if (!process.env.OPENAI_API_KEY) throw new Error('llm.provider=openai 时需要配置 OPENAI_API_KEY。');
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const response = await client.chat.completions.create({
    model: config.llm.model,
    messages: [
      { role: 'system', content: '你是 Daily OS 的决策校准助手。请用中文帮助用户磨合长期决策规则。' },
      { role: 'user', content: prompt },
    ],
  });
  return response.choices[0]?.message.content?.trim() || '我收到了，但这次没有生成有效回复。';
}

function appendCalibrationLog(config: AppConfig, input: DecisionCalibrationInput, reply: string): void {
  const files = decisionPolicyFiles(config);
  fs.mkdirSync(path.dirname(files.candidatesPath), { recursive: true });
  const timestamp = new Date().toISOString();
  fs.appendFileSync(
    files.candidatesPath,
    [
      '',
      `## ${timestamp}`,
      '',
      `chat_id: ${input.chatId}`,
      `message_id: ${input.messageId}`,
      `sender_open_id: ${input.senderOpenId}`,
      '',
      '### 用户输入',
      '',
      input.text.trim(),
      '',
      '### 助手回复',
      '',
      reply.trim(),
      '',
    ].join('\n'),
    'utf8',
  );
}

function readFilePreview(filePath: string, limit: number): string {
  if (!fs.existsSync(filePath)) return '';
  return fs.readFileSync(filePath, 'utf8').slice(0, limit);
}

interface CalibrationOutput {
  reply: string;
  candidate: PolicyRuleDraft | null;
}

function parseCalibrationOutput(raw: string): CalibrationOutput {
  const trimmed = raw.trim();
  const jsonText = extractJson(trimmed);
  if (!jsonText) return { reply: trimmed || '我收到了，但这次没有生成有效回复。', candidate: null };
  try {
    const parsed = JSON.parse(jsonText) as unknown;
    if (!isObject(parsed) || typeof parsed.reply !== 'string') {
      return { reply: trimmed || '我收到了，但这次没有生成有效回复。', candidate: null };
    }
    const candidate = parseCandidate(parsed.candidate);
    return {
      reply: parsed.reply.trim() || '我收到了，但这次没有生成有效回复。',
      candidate,
    };
  } catch {
    return { reply: trimmed || '我收到了，但这次没有生成有效回复。', candidate: null };
  }
}

function parseCandidate(value: unknown): PolicyRuleDraft | null {
  if (!isObject(value)) return null;
  if (typeof value.description !== 'string' || !value.description.trim()) return null;
  const candidate: PolicyRuleDraft = {
    ...(typeof value.id === 'string' && value.id.trim() ? { id: value.id.trim() } : {}),
    description: value.description.trim(),
    ...(Array.isArray(value.applies_to) ? { applies_to: value.applies_to.filter((item): item is string => typeof item === 'string') } : {}),
    ...(isObject(value.when) ? { when: value.when } : {}),
    ...(isObject(value.then) ? { then: value.then } : {}),
    ...(typeof value.reason === 'string' && value.reason.trim() ? { reason: value.reason.trim() } : {}),
  };
  return candidate;
}

function extractJson(text: string): string | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1]?.trim() || text;
  const first = candidate.indexOf('{');
  const last = candidate.lastIndexOf('}');
  if (first === -1 || last === -1 || last <= first) return null;
  return candidate.slice(first, last + 1);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
