import fs from 'node:fs';
import path from 'node:path';
import type { AppConfig } from '../config/schema.js';
import { resolveMemoryRepositoryPath } from '../storage/memory.js';

const DEFAULT_POLICY_YAML = `version: 1
updated_at: null
status: draft
rules:
  - id: confirm-before-durable-policy-change
    description: Durable decision rules must be confirmed by the user before they are saved.
    when:
      event: policy_change_proposed
    then:
      require_confirmation: true
      bucket: pending_policy_candidate
`;

const DEFAULT_POLICY_MD = `# Decision Policy

This file explains how Daily OS should make planning decisions for this user.

Daily OS should use this policy for:

- Daily plan
- Todo triage
- Daily review
- Weekly review
- Codex delegation suggestions

## Current Principles

- Ask when tradeoffs are unclear.
- Treat one-time preferences as temporary unless the user confirms a durable rule.
- Do not silently save or modify durable decision rules.
- Separate what Codex can do from what the user must personally decide or execute.

## Calibration Notes

Use the Feishu decision calibration chat to refine these rules over time.
`;

const DEFAULT_POLICY_SKILL = `---
name: daily-os-decision-policy
description: Apply the user's confirmed Daily OS decision policy when planning, triaging todos, reviewing work, and proposing Codex delegation.
---

# Daily OS Decision Policy Skill

Use this local policy skill only as a companion to the user's memory repository.

Before making planning decisions:

1. Read \`decision-policy.yaml\` for executable rules.
2. Read \`decision-policy.md\` for human-readable rationale and calibration notes.
3. If evidence conflicts and the policy does not resolve it, ask a short clarification question instead of guessing.
4. Do not persist a new durable rule unless the user explicitly confirms it.

Output should distinguish:

- Today focus
- Why this matters
- Codex can do
- User must do
- Waiting or blocked
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
  writeIfMissing(files.candidatesPath, '# Decision Policy Candidates\n\nProposed rules wait here until the user confirms them.\n');
  return files;
}

export function decisionPolicyStatusText(config: AppConfig): string {
  const files = ensureDecisionPolicyFiles(config);
  const policy = readPreview(files.policyPath, 2000);
  const notes = readPreview(files.notesPath, 1200);
  return [
    'Decision policy is ready.',
    '',
    `Repository: ${files.repositoryPath}`,
    `Policy: ${path.relative(files.repositoryPath, files.policyPath)}`,
    `Notes: ${path.relative(files.repositoryPath, files.notesPath)}`,
    `Policy skill: ${path.relative(files.repositoryPath, files.skillPath)}`,
    `Pending candidates: ${files.candidatesPath}`,
    '',
    'Current policy preview:',
    '```yaml',
    policy.trim(),
    '```',
    '',
    'Notes preview:',
    notes.trim() || '(empty)',
  ].join('\n');
}

export function decisionCalibrationPrompt(config: AppConfig): string {
  ensureDecisionPolicyFiles(config);
  return [
    'Decision calibration started.',
    '',
    'This chat is for shaping how Daily OS should decide priorities with you.',
    '',
    'Reply naturally. When a durable rule is clear, I will propose it first. It will not become a saved rule until you confirm it.',
    '',
    'Good first questions:',
    '1. When deadlines conflict with long-term goals, which should win?',
    '2. Which projects are protected focus areas?',
    '3. What kind of work can Codex do without asking?',
    '4. What always requires your personal judgment or approval?',
    '5. What should never become the MIT unless you explicitly say so?',
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
