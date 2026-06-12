import type { WorkflowName } from '../config/schema.js';
import type { Evidence } from './types.js';

const MAX_SUMMARY_CHARS = 2200;
const MAX_DETAIL_CHARS = 7000;
const MAX_ROW_TITLE_CHARS = 38;
const MAX_ROW_GOAL_CHARS = 30;

export function formatWorkflowSummaryForFeishu(workflow: WorkflowName, date: string, content: string, evidence?: Evidence): string {
  const clean = normalize(content);
  const intro = introFor(workflow, clean);
  const overview = workflowOverview(workflow, clean, evidence);
  const fallback = sentencePreview(clean, 420);
  const fallbackLines = normalizedTextKey(fallback) === normalizedTextKey(intro) ? [] : [fallback];
  const lines = [
    intro,
    '',
    ...(overview.length > 0 ? overview : fallbackLines),
    '',
    actionHint(workflow),
    closingLine(workflow),
  ];
  return trimSummary(lines.join('\n'), MAX_SUMMARY_CHARS);
}

export function formatLatestWorkflowDetails(input: { workflow: WorkflowName; date: string; generated_at: string; content: string }): string {
  return truncate(
    [
      `老板，这是最近一次 ${workflowLabel(input.workflow)} 的完整内容。`,
      `日期：${input.date}`,
      `生成时间：${input.generated_at}`,
      '',
      input.content.trim(),
    ].join('\n'),
    MAX_DETAIL_CHARS,
  );
}

function introFor(workflow: WorkflowName, content: string): string {
  if (workflow === 'daily_plan') {
    return `老板，今天我先帮您压成一张清单。`;
  }
  if (workflow === 'daily_review') {
    return `老板，我把今天的进展先分好类了。`;
  }
  return `老板，我把本周总结和下周安排先压成重点版。`;
}

function extractSectionBullets(content: string, headings: string[], limit: number): string[] {
  const sections = splitSections(content);
  const wanted = headings.map((heading) => heading.toLowerCase());
  return sections
    .filter((section) => wanted.some((heading) => section.heading.toLowerCase().includes(heading)))
    .flatMap((section) => extractBullets(section.body))
    .slice(0, limit);
}

function workflowOverview(workflow: WorkflowName, content: string, evidence?: Evidence): string[] {
  if (workflow === 'daily_plan') return dailyPlanOverview(content, evidence);
  if (workflow === 'daily_review') return dailyReviewOverview(content, evidence);
  return weeklyReviewOverview(content, evidence);
}

function dailyPlanOverview(content: string, evidence?: Evidence): string[] {
  const linear = linearMetadataFromEvidence(evidence);
  const alignment = weeklyAlignmentRows(content);
  const priorities = extractSectionBullets(content, ['今日重点'], 3);
  const codex = extractSectionBullets(content, ['Codex 可以做', '我可以帮您', '我可以帮您安排 Codex 做'], 3);
  const user = extractSectionBullets(content, ['用户必须做', '需要您批示', '需要您本人处理'], 3);
  const paused = extractSectionBullets(content, ['暂不处理', '阻塞'], 2);
  const confirmedRows = priorities.map((item, index) =>
    taskRow(item, index === 0 ? 'P0' : 'P1', ownerFor(item, codex, user), '今天有明确价值，先推进到可检查结果', linear),
  );
  const newRows = dedupe(
    [
      ...codex.filter((item) => !overlapsAny(item, priorities)).map((item) => taskRow(item, 'P1', 'Codex', '先产出草稿、检查结果或拆解方案', linear)),
      ...user.filter((item) => !overlapsAny(item, priorities)).map((item) => taskRow(item, 'P1', '您', '需要您判断、沟通或拍板', linear)),
    ],
  ).slice(0, 3);
  const pausedRows = paused.map((item) => taskRow(item, 'P2', '暂缓', '今天先不抢主线，避免分散注意力', linear)).slice(0, 2);
  const overview = groupedOverview('今天先看这几件事', [
    { label: '确认的', rows: confirmedRows.slice(0, 3) },
    { label: '新增的', rows: newRows },
    { label: '暂缓的', rows: pausedRows },
  ]);
  if (alignment.length === 0 || overview.length === 0) return overview;
  return [overview[0], '', '**每周要务对齐**', ...alignment, ...overview.slice(1)];
}

function dailyReviewOverview(content: string, evidence?: Evidence): string[] {
  const linear = linearMetadataFromEvidence(evidence);
  const done = extractSectionBullets(content, ['已完成', '已推进'], 3);
  const open = extractSectionBullets(content, ['没完成', '未闭环', '明天带走'], 3);
  const codex = extractSectionBullets(content, ['我可以帮您继续做', 'Codex 可以做'], 2);
  return groupedOverview('今天先按这三类看', [
    { label: '确认的', rows: done.map((item) => taskRow(item, '完成', '已推进', '这是今天可以记账的进展', linear)).slice(0, 3) },
    { label: '暂缓的', rows: open.map((item) => taskRow(item, '未闭环', '您', '需要确认明天是否继续', linear)).slice(0, 3) },
    { label: '新增的', rows: codex.map((item) => taskRow(item, '下一步', 'Codex', '我可以先准备后续动作', linear)).slice(0, 2) },
  ]);
}

function weeklyReviewOverview(content: string, evidence?: Evidence): string[] {
  const linear = linearMetadataFromEvidence(evidence);
  const done = extractSectionBullets(content, ['本周已经完成', '已推进'], 2);
  const mit = extractSectionBullets(content, ['下周 MIT'], 1);
  const plan = extractSectionBullets(content, ['下周主要安排'], 4);
  const codex = extractSectionBullets(content, ['我可以帮您安排 Codex 做', 'Codex 可以做'], 2);
  return groupedOverview('下周先这样安排', [
    { label: '确认的', rows: done.map((item) => taskRow(item, '完成', '已推进', '本周已经能沉淀为结果', linear)).slice(0, 2) },
    {
      label: '新增的',
      rows: [
        ...mit.map((item) => taskRow(item, 'P0', ownerFor(item, codex, []), '下周唯一主线', linear)),
        ...plan.map((item, index) => taskRow(item, index === 0 ? 'P0' : 'P1', ownerFor(item, codex, []), '推进到可检查结果', linear)),
        ...codex.map((item) => taskRow(item, 'P1', 'Codex', '先准备可交付产物', linear)),
      ].slice(0, 5),
    },
  ]);
}

function groupedOverview(title: string, groups: Array<{ label: '确认的' | '暂缓的' | '新增的'; rows: string[] }>): string[] {
  const lines: string[] = [`**${title}**`];
  for (const group of groups) {
    const rows = dedupe(group.rows).slice(0, 3);
    if (rows.length === 0) continue;
    lines.push('', `**${group.label}**`);
    rows.forEach((row, index) => lines.push(`${index + 1}. ${row}`));
  }
  return lines.length > 1 ? lines : [];
}

function taskRow(item: string, priority: string, owner: string, goal: string, linear: Map<string, LinearIssueMetadata> = new Map()): string {
  const clean = compactItem(item);
  const meta = linearMetadataLine(item, linear);
  return `**${priority}｜${owner}**：${clean}\n   目标：${goalFromItem(item, goal)}${meta ? `\n   Linear：${meta}` : ''}`;
}

function ownerFor(item: string, codexItems: string[], userItems: string[]): string {
  const key = normalizedTextKey(item);
  if (codexItems.some((candidate) => key.includes(normalizedTextKey(candidate).slice(0, 18)))) return 'Codex';
  if (userItems.some((candidate) => key.includes(normalizedTextKey(candidate).slice(0, 18)))) return '您';
  const codexLike = /codex|我可以帮|助手|自动|生成|整理|检查|草稿|修复|修改|改成|实现|写|补齐/i.test(item);
  const userLike = /您|用户|本人|确认|沟通|审批|判断|批示|联系/.test(item);
  if (codexLike) return 'Codex';
  if (userLike) return '您';
  return '您';
}

function compactItem(item: string): string {
  const clean = completePhrase(
    removeEvidenceTail(
      stripMarkdown(item)
        .replace(/^(MIT|P[0-3]|优先级[:：]?)\s*/i, '')
        .replace(/^(确认的|暂缓的|新增的)[:：\s]*/, '')
        .replace(/^(完成|已推进|未闭环|下一步|P[0-3])\s*[|｜]\s*(?:已推进|您|Codex)?\s*[:：]\s*/, '')
        .replace(/^(?:Codex|我可以先|我可以|我|您|用户)\s*(?:可以先|可以|需要|先)?\s*/, '')
        .replace(/^今天最大的进展是/, '')
        .replace(/\s+/g, ' ')
        .trim(),
    ),
    MAX_ROW_TITLE_CHARS,
  );
  return clean || '需要确认这一项';
}

function goalFromItem(item: string, fallback: string): string {
  const clean = stripMarkdown(item).replace(/\s+/g, ' ').trim();
  const match =
    clean.match(/(?:完成标准|预期产物|目标|结果|产物)(?:是|为|：|:)\s*([^。；;]+)/) ||
    clean.match(/(?:确保|形成|产出|完成|确认|决定)([^。；;，,]{6,60})/);
  return completePhrase(match?.[1]?.trim() || fallback, MAX_ROW_GOAL_CHARS);
}

interface LinearIssueMetadata {
  identifier: string;
  title?: string;
  project?: string;
  dueDate?: string;
  priority?: string;
}

function linearMetadataLine(item: string, linear: Map<string, LinearIssueMetadata>): string {
  const issueIds = Array.from(new Set(stripMarkdown(item).match(/[A-Z][A-Z0-9]+-\d+/g) || []));
  const lines = issueIds
    .map((id) => linear.get(id))
    .filter((meta): meta is LinearIssueMetadata => Boolean(meta))
    .map((meta) =>
      [
        meta.project ? `Project ${meta.project}` : '',
        meta.dueDate ? `Deadline ${meta.dueDate}` : '',
        meta.priority ? `Priority ${meta.priority}` : '',
      ]
        .filter(Boolean)
        .join('；'),
    )
    .filter(Boolean);
  return lines.slice(0, 2).join(' / ');
}

function linearMetadataFromEvidence(evidence?: Evidence): Map<string, LinearIssueMetadata> {
  const out = new Map<string, LinearIssueMetadata>();
  const source = evidence?.sources.linear;
  if (!source || source.state !== 'available') return out;
  for (const item of linearItems(source.data)) {
    if (!isRecord(item) || typeof item.identifier !== 'string') continue;
    const title = typeof item.title === 'string' ? item.title : '';
    out.set(item.identifier, {
      identifier: item.identifier,
      ...(title ? { title } : {}),
      ...(linearProjectName(item) ? { project: linearProjectName(item) } : {}),
      ...(linearDueDate(item, evidence?.date) ? { dueDate: linearDueDate(item, evidence?.date) } : {}),
      ...(linearPriority(item) ? { priority: linearPriority(item) } : {}),
    });
  }
  return out;
}

function linearItems(data: unknown): unknown[] {
  for (const path of [
    ['items'],
    ['data', 'issues', 'nodes'],
    ['issues', 'nodes'],
  ]) {
    const items = getArrayAtPath(data, path);
    if (items) return items;
  }
  return [];
}

function getArrayAtPath(data: unknown, path: string[]): unknown[] | null {
  let current = data;
  for (const key of path) {
    if (!isRecord(current)) return null;
    current = current[key];
  }
  return Array.isArray(current) ? current : null;
}

function linearProjectName(item: Record<string, unknown>): string {
  const project = item.project;
  if (typeof project === 'string') return project;
  if (isRecord(project) && typeof project.name === 'string') return project.name;
  return '';
}

function linearDueDate(item: Record<string, unknown>, date?: string): string {
  if (typeof item.dueDate === 'string' && item.dueDate) return item.dueDate;
  const title = typeof item.title === 'string' ? item.title : '';
  const match = title.match(/\[(\d{1,2})\/(\d{1,2})\]/);
  if (!match) return '';
  const year = date?.match(/^(\d{4})-/)?.[1] || String(new Date().getFullYear());
  return `${year}-${match[1].padStart(2, '0')}-${match[2].padStart(2, '0')}`;
}

function linearPriority(item: Record<string, unknown>): string {
  const title = typeof item.title === 'string' ? item.title : '';
  const titlePriority = title.match(/\[(P[0-4])\]/i)?.[1]?.toUpperCase();
  if (titlePriority) return titlePriority;
  return linearPriorityLabel(item.priority);
}

function linearPriorityLabel(value: unknown): string {
  if (typeof value !== 'number') return '';
  if (value === 0) return 'None (0)';
  if (value === 1) return 'Urgent (1)';
  if (value === 2) return 'High (2)';
  if (value === 3) return 'Medium (3)';
  if (value === 4) return 'Low (4)';
  return String(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function weeklyAlignmentRows(content: string): string[] {
  const rows = extractSectionBullets(content, ['每周要务对齐', 'Weekly 对齐', 'Weekly对齐', '本周要务', '🐶'], 2);
  return rows.map((row) => `- ${completePhrase(row, 120)}`).slice(0, 2);
}

function removeEvidenceTail(value: string): string {
  return value
    .split(/(?:证据来自|证据为|依据[:：]?|来源[:：]?|Feishu IM|Linear |local files|Chrome snapshot|GitHub |Vault )/i)[0]
    .split(/(?:。|；|;)\s*(?:证据|依据|来源|Linear|Feishu|Vault|GitHub|Chrome)/i)[0]
    .split(/(?:，|,)\s*(?:证据|依据|来源|Linear|Feishu|Vault|GitHub|Chrome|但|不过)/i)[0]
    .trim();
}

function completePhrase(value: string, max: number): string {
  const clean = value
    .replace(/^(MIT|P[0-3]|优先级[:：]?)\s*/i, '')
    .replace(/^(确认的|暂缓的|新增的)[:：\s]*/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[「“"']+|[」”"']+$/g, '');
  if (clean.length <= max) return clean;
  const explicitTask = clean.match(/(?:LEO|CUTTO|POLY|MOOSE|SWAT|PR|#)-?\d*[\w-]*\s*[^，。；;]{0,24}/i)?.[0]?.trim();
  if (explicitTask && explicitTask.length <= max) return tidyPhrase(explicitTask);
  for (const delimiter of ['。', '；', ';', '，', ',', '：', ':', '（', '(']) {
    const head = clean.split(delimiter)[0]?.trim();
    if (head && head.length >= 6 && head.length <= max) return tidyPhrase(head);
  }
  return tidyPhrase(clean.slice(0, max).replace(/[，,、：:｜|/\\\s-]+$/u, '').trim());
}

function tidyPhrase(value: string): string {
  return value.replace(/^[「“"']+|[」”"']+$/g, '').trim();
}

function actionHint(workflow: WorkflowName): string {
  if (workflow === 'daily_plan') {
    return '如果这张安排不对，点「我要调整」，或直接回复：daily-os 修改今日安排：……';
  }
  if (workflow === 'daily_review') {
    return '如果复盘有漏记，直接回复：daily-os 修改今日复盘：……';
  }
  return '如果下周安排要改，直接回复：daily-os 修改周计划：……';
}

function closingLine(workflow: WorkflowName): string {
  if (workflow === 'daily_plan') return '您看这样排可以吗？';
  if (workflow === 'daily_review') return '您确认一下，哪些可以记为今天完成？';
  return '您看下周先按这个节奏走可以吗？';
}

function splitSections(content: string): Array<{ heading: string; body: string }> {
  const lines = content.split('\n');
  const sections: Array<{ heading: string; body: string[] }> = [];
  let current: { heading: string; body: string[] } = { heading: '开头', body: [] };
  for (const line of lines) {
    const heading = line.match(/^(?:#{1,4}\s*)?(?:\d+[.)、]\s*)?(.{2,48})$/);
    const trimmed = stripMarkdown(line).trim();
    if (heading && looksLikeHeading(trimmed)) {
      if (current.body.length > 0) sections.push(current);
      current = { heading: trimmed, body: [] };
    } else {
      current.body.push(line);
    }
  }
  if (current.body.length > 0) sections.push(current);
  return sections.map((section) => ({ heading: section.heading, body: section.body.join('\n') }));
}

function looksLikeHeading(line: string): boolean {
  const normalized = line.replace(/^\d+[.)、]\s*/, '').trim();
  return /^(今日重点|为什么|Codex|用户|暂不|阻塞|重要信号|已完成|已推进|没完成|未闭环|需要您|明天|缺失|本周|下周|OKR|优先级|MIT)/.test(
    normalized,
  );
}

function extractBullets(text: string): string[] {
  const bullets = text
    .split('\n')
    .map((line) => stripMarkdown(line).trim())
    .filter((line) => /^[-*]\s+|^\d+[.)、]\s+/.test(line))
    .map((line) => line.replace(/^[-*]\s+|^\d+[.)、]\s+/, '').trim())
    .filter((line) => line.length >= 8)
    .map((line) => completePhrase(line, 160));
  if (bullets.length > 0) return bullets;
  return text
    .split(/[。！？]\s*/)
    .map((line) => stripMarkdown(line).trim())
    .filter((line) => line.length >= 12)
    .slice(0, 2)
    .map((line) => completePhrase(line, 160));
}

function sentencePreview(content: string, max: number): string {
  const stripped = stripMarkdown(content)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' ');
  const firstSentence = stripped.match(/^.{20,}?[。！？.!?]/)?.[0] || stripped;
  return completePhrase(firstSentence, max);
}

function normalize(content: string): string {
  return content.replace(/\r\n/g, '\n').trim();
}

function stripMarkdown(value: string): string {
  return value
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/^#+\s*/, '')
    .trim();
}

function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function normalizedTextKey(value: string): string {
  return stripMarkdown(value).replace(/\s+/g, '').toLowerCase();
}

function overlapsAny(item: string, existing: string[]): boolean {
  const key = normalizedTextKey(compactItem(item));
  if (!key) return false;
  return existing.some((candidate) => {
    const other = normalizedTextKey(compactItem(candidate));
    if (!other) return false;
    if (key.includes(other.slice(0, 8)) || other.includes(key.slice(0, 8))) return true;
    return sharedChineseTokens(key, other);
  });
}

function sharedChineseTokens(left: string, right: string): boolean {
  const tokens = left.match(/[\u4e00-\u9fa5]{4,}/g) || [];
  return tokens.some((token) => {
    for (let index = 0; index <= token.length - 4; index += 1) {
      if (right.includes(token.slice(index, index + 4))) return true;
    }
    return false;
  });
}

function workflowLabel(workflow: WorkflowName): string {
  if (workflow === 'daily_plan') return '今日计划';
  if (workflow === 'daily_review') return '日复盘';
  return '周复盘';
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function trimSummary(value: string, max: number): string {
  if (value.length <= max) return value;
  const lines = value.split('\n');
  const kept: string[] = [];
  let length = 0;
  for (const line of lines) {
    if (length + line.length + 1 > max - 24) break;
    kept.push(line);
    length += line.length + 1;
  }
  return [...kept, '', '更多内容请点「看详情」。'].join('\n').trim();
}
