import type { WorkflowName } from '../config/schema.js';

const MAX_SUMMARY_CHARS = 1800;
const MAX_DETAIL_CHARS = 7000;

export function formatWorkflowSummaryForFeishu(workflow: WorkflowName, date: string, content: string): string {
  const clean = normalize(content);
  const intro = introFor(workflow, clean);
  const overview = workflowOverview(workflow, clean);
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
  return truncate(lines.join('\n'), MAX_SUMMARY_CHARS);
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

function workflowOverview(workflow: WorkflowName, content: string): string[] {
  if (workflow === 'daily_plan') return dailyPlanOverview(content);
  if (workflow === 'daily_review') return dailyReviewOverview(content);
  return weeklyReviewOverview(content);
}

function dailyPlanOverview(content: string): string[] {
  const priorities = extractSectionBullets(content, ['今日重点'], 3);
  const codex = extractSectionBullets(content, ['Codex 可以做', '我可以帮您', '我可以帮您安排 Codex 做'], 3);
  const user = extractSectionBullets(content, ['用户必须做', '需要您批示', '需要您本人处理'], 3);
  const paused = extractSectionBullets(content, ['暂不处理', '阻塞'], 2);
  const confirmedRows = priorities.map((item, index) => taskRow(item, index === 0 ? 'P0' : 'P1', ownerFor(item, codex, user), '今天有明确价值，先推进到可检查结果'));
  const newRows = dedupe(
    [
      ...codex.filter((item) => !overlapsAny(item, priorities)).map((item) => taskRow(item, 'P1', 'Codex', '先产出草稿、检查结果或拆解方案')),
      ...user.filter((item) => !overlapsAny(item, priorities)).map((item) => taskRow(item, 'P1', '您', '需要您判断、沟通或拍板')),
    ],
  ).slice(0, 3);
  const pausedRows = paused.map((item) => taskRow(item, 'P2', '暂缓', '今天先不抢主线，避免分散注意力')).slice(0, 2);
  return groupedOverview('今天先看这几件事', [
    { label: '确认的', rows: confirmedRows.slice(0, 3) },
    { label: '新增的', rows: newRows },
    { label: '暂缓的', rows: pausedRows },
  ]);
}

function dailyReviewOverview(content: string): string[] {
  const done = extractSectionBullets(content, ['已完成', '已推进'], 3);
  const open = extractSectionBullets(content, ['没完成', '未闭环', '明天带走'], 3);
  const codex = extractSectionBullets(content, ['我可以帮您继续做', 'Codex 可以做'], 2);
  return groupedOverview('今天先按这三类看', [
    { label: '确认的', rows: done.map((item) => taskRow(item, '完成', '已推进', '这是今天可以记账的进展')).slice(0, 3) },
    { label: '暂缓的', rows: open.map((item) => taskRow(item, '未闭环', '您', '需要确认明天是否继续')).slice(0, 3) },
    { label: '新增的', rows: codex.map((item) => taskRow(item, '下一步', 'Codex', '我可以先准备后续动作')).slice(0, 2) },
  ]);
}

function weeklyReviewOverview(content: string): string[] {
  const done = extractSectionBullets(content, ['本周已经完成', '已推进'], 2);
  const mit = extractSectionBullets(content, ['下周 MIT'], 1);
  const plan = extractSectionBullets(content, ['下周主要安排'], 4);
  const codex = extractSectionBullets(content, ['我可以帮您安排 Codex 做', 'Codex 可以做'], 2);
  return groupedOverview('下周先这样安排', [
    { label: '确认的', rows: done.map((item) => taskRow(item, '完成', '已推进', '本周已经能沉淀为结果')).slice(0, 2) },
    {
      label: '新增的',
      rows: [
        ...mit.map((item) => taskRow(item, 'P0', ownerFor(item, codex, []), '下周唯一主线')),
        ...plan.map((item, index) => taskRow(item, index === 0 ? 'P0' : 'P1', ownerFor(item, codex, []), '推进到可检查结果')),
        ...codex.map((item) => taskRow(item, 'P1', 'Codex', '先准备可交付产物')),
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

function taskRow(item: string, priority: string, owner: string, goal: string): string {
  const clean = compactItem(item);
  return `**${priority}｜${owner}**：${clean}\n   目标：${goalFromItem(item, goal)}`;
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
  const clean = stripMarkdown(item)
    .replace(/^(MIT|P[0-3]|优先级[:：]?)\s*/i, '')
    .replace(/^(确认的|暂缓的|新增的)[:：\s]*/, '')
    .replace(/^(?:Codex|我可以先|我可以|我|您|用户)\s*(?:可以先|可以|需要|先)?\s*/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .split(/(?:，|。|；|;)\s*(?:完成标准|产物|预期产物|目标|今天需要|因为|依据|原因)(?:是|为|：|:)?/)[0]
    .trim();
  return truncate(
    clean,
    48,
  );
}

function goalFromItem(item: string, fallback: string): string {
  const clean = stripMarkdown(item).replace(/\s+/g, ' ').trim();
  const match =
    clean.match(/(?:完成标准|预期产物|目标|结果|产物)(?:是|为|：|:)\s*([^。；;]+)/) ||
    clean.match(/(?:确保|形成|产出|完成|确认|决定)([^。；;]{6,60})/);
  return truncate(match?.[1]?.trim() || fallback, 30);
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
    .map((line) => truncate(line, 180));
  if (bullets.length > 0) return bullets;
  return text
    .split(/[。！？]\s*/)
    .map((line) => stripMarkdown(line).trim())
    .filter((line) => line.length >= 12)
    .slice(0, 2)
    .map((line) => truncate(line, 180));
}

function sentencePreview(content: string, max: number): string {
  const stripped = stripMarkdown(content)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' ');
  const firstSentence = stripped.match(/^.{20,}?[。！？.!?]/)?.[0] || stripped;
  return truncate(firstSentence, max);
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
