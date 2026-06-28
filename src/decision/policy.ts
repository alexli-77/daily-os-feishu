import fs from 'node:fs';
import path from 'node:path';
import type { AppConfig } from '../config/schema.js';
import { resolveMemoryRepositoryPath } from '../storage/memory.js';

const DEFAULT_POLICY_YAML = `version: 1
updated_at: null
status: draft
rules:
  - id: confirm-before-durable-policy-change
    description: 长期决策规则必须先由用户确认，才能保存生效。
    when:
      event: policy_change_proposed
    then:
      require_confirmation: true
      bucket: pending_policy_candidate
`;

const DEFAULT_POLICY_MD = `# 决策规则

<!-- This file is user-editable. Write stable preferences here in plain language. -->
<!-- Daily OS reads this when making daily plans, todo routing, daily reviews, weekly reviews, and AI delegation suggestions. -->

## 使用范围

<!-- Keep this list unless you want to narrow where these rules apply. -->

- 日计划
- Todo 分流
- 日复盘
- 周复盘
- Codex / Claude 分工建议

## 核心原则

<!-- Add durable principles here. These should be true most of the time. -->

- 权衡不清楚时先问用户。
- 用户没有明确确认前，把偏好视为一次性偏好，不写成长期规则。
- 不要静默保存或修改长期决策规则。
- 区分 AI 可以代做的事，以及必须由用户本人判断或执行的事。

## 信息源优先级

<!-- Add rules about which source should win when sources conflict. -->
<!-- Example: Feishu Weekly is the main source for weekly priorities; Linear is supporting evidence. -->

- 

## 每日计划规则

<!-- Add rules for daily-os plan / todo generation. -->
<!-- Example: Always include user-captured daily todos before adding optional Linear work. -->

- 

## 复盘规则

<!-- Add rules for daily review and weekly review. -->
<!-- Example: Review should first check unfinished weekly commitments before proposing new work. -->

- 

## AI 分工规则

<!-- Add rules for what AI may do, draft, or only suggest. -->
<!-- Example: Codex may prepare drafts, but user must approve external messages before sending. -->

- 

## 不要做

<!-- Add hard boundaries here. These rules should prevent unwanted behavior. -->
<!-- Example: Do not treat stale Linear due dates as today's task unless Feishu confirms it. -->

- 

## 已确认规则

<!-- Daily OS may append confirmed long-term rules here. -->
<!-- You can edit wording, but keep each rule specific and actionable. -->

## 校准记录

<!-- Add short notes when an output feels wrong. Repeated notes can become confirmed rules later. -->

通过飞书决策校准群逐步磨合和修订这些规则。
`;

const DEFAULT_POLICY_SKILL = `---
name: daily-os-decision-policy
description: 在计划、Todo 分流、复盘和 Codex 分工建议中，应用用户已经确认的 Daily OS 决策规则。
---

# Daily OS 决策规则 Skill

这个本地 policy skill 只作为用户 memory repository 的配套规则。

做计划判断前：

1. 读取 \`decision-policy.yaml\` 中可执行的规则。
2. 读取 \`decision-policy.md\` 中给人看的解释和校准记录。
3. 如果证据冲突且规则无法解决，提出一个简短澄清问题，不要假装确定。
4. 除非用户明确确认，不要保存新的长期规则。

输出中需要区分：

- 今日重点
- 为什么重要
- Codex 可以做
- 用户必须做
- 等待或阻塞
`;

export interface DecisionPolicyFiles {
  repositoryPath: string;
  policyPath: string;
  notesPath: string;
  skillPath: string;
  candidatesPath: string;
}

export function decisionPolicyFiles(config: AppConfig): DecisionPolicyFiles {
  const repositoryPath = resolveMemoryRepositoryPath(config);
  return {
    repositoryPath,
    policyPath: path.join(repositoryPath, config.decision.policy_file),
    notesPath: path.join(repositoryPath, config.decision.policy_notes_file),
    skillPath: path.join(repositoryPath, 'policy-skill', 'SKILL.md'),
    candidatesPath: path.resolve(config.decision.candidates_path),
  };
}

export function ensureDecisionPolicyFiles(config: AppConfig): DecisionPolicyFiles {
  const files = decisionPolicyFiles(config);
  writeIfMissing(files.policyPath, DEFAULT_POLICY_YAML);
  writeIfMissing(files.notesPath, DEFAULT_POLICY_MD);
  writeIfMissing(files.skillPath, DEFAULT_POLICY_SKILL);
  writeIfMissing(files.candidatesPath, '# 决策规则候选\n\n这里保存助手提出但尚未由用户确认的规则。\n');
  return files;
}

export function decisionPolicyStatusText(config: AppConfig): string {
  const files = ensureDecisionPolicyFiles(config);
  const policy = readPreview(files.policyPath, 2000);
  const notes = readPreview(files.notesPath, 1200);
  return [
    '决策规则已准备好。',
    '',
    `规则仓库：${files.repositoryPath}`,
    `结构化规则：${path.relative(files.repositoryPath, files.policyPath)}`,
    `规则说明：${path.relative(files.repositoryPath, files.notesPath)}`,
    `Policy skill：${path.relative(files.repositoryPath, files.skillPath)}`,
    `待确认候选规则：${files.candidatesPath}`,
    '',
    '当前结构化规则预览：',
    '```yaml',
    policy.trim(),
    '```',
    '',
    '规则说明预览：',
    notes.trim() || '（空）',
  ].join('\n');
}

export function decisionCalibrationPrompt(config: AppConfig): string {
  ensureDecisionPolicyFiles(config);
  return [
    '决策校准已开始。',
    '',
    '这个聊天用于和你一起磨合 Daily OS 的优先级判断方式。',
    '',
    '你可以像和人聊天一样自然回复。当某条长期规则变清楚时，我会先提出候选规则；只有你确认后，它才会被保存为长期规则。',
    '',
    '常用确认命令：',
    '- 候选规则',
    '- 保存规则 <候选ID>',
    '- 拒绝规则 <候选ID>',
    '',
    '可以先从这些问题开始：',
    '1. 当短期 deadline 和长期目标冲突时，应该优先谁？',
    '2. 哪些项目是必须保护的重点方向？',
    '3. 哪些工作可以让 Codex 直接做或先准备草稿？',
    '4. 哪些事情一定需要你本人判断、沟通或批准？',
    '5. 哪些事情除非你明确点名，否则永远不应该成为 MIT？',
  ].join('\n');
}

function writeIfMissing(filePath: string, content: string): void {
  if (fs.existsSync(filePath)) return;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

function readPreview(filePath: string, limit: number): string {
  if (!fs.existsSync(filePath)) return '';
  return fs.readFileSync(filePath, 'utf8').slice(0, limit);
}
