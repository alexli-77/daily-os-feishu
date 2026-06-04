import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import OpenAI from 'openai';
import type { AppConfig } from '../config/schema.js';
import { runCommand } from '../utils/command.js';
import { decisionPolicyFiles, ensureDecisionPolicyFiles } from './policy.js';

export interface DecisionCalibrationInput {
  text: string;
  chatId: string;
  senderOpenId: string;
  messageId: string;
}

export async function runDecisionCalibrationAgent(config: AppConfig, input: DecisionCalibrationInput): Promise<string> {
  ensureDecisionPolicyFiles(config);
  const prompt = buildCalibrationPrompt(config, input);
  const reply = config.llm.provider === 'openai' ? await runOpenAiCalibration(config, prompt) : await runCodexCalibration(config, prompt);
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
    '只输出要发回飞书的中文消息。不要输出隐藏推理、JSON 或工具调用。',
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
