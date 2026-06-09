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
    '请您批示。',
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
  const first = sentencePreview(content, 220);
  if (workflow === 'daily_plan') {
    return first.startsWith('老板') ? first : `老板您好，我帮您整理了今天的安排。${first}`;
  }
  if (workflow === 'daily_review') {
    return first.startsWith('老板') ? first : `老板，我帮您整理了今天的进展。${first}`;
  }
  return first.startsWith('老板') ? first : `老板，我帮您整理了本周总结和下周安排。${first}`;
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
  const rows = [
    ...priorities.map((item, index) => overviewRow(item, index === 0 ? 'P0' : 'P1', ownerFor(item, codex, user), '完成今天最关键的推进')),
    ...codex.map((item) => overviewRow(item, 'P1', 'Codex', '产出可交付草稿或检查结果')),
    ...user.map((item) => overviewRow(item, 'P1', '您', '完成判断、沟通或确认')),
  ];
  return overviewBlock('今日概述', dedupe(rows).slice(0, 6));
}

function dailyReviewOverview(content: string): string[] {
  const done = extractSectionBullets(content, ['已完成', '已推进'], 3);
  const open = extractSectionBullets(content, ['没完成', '未闭环', '明天带走'], 3);
  const codex = extractSectionBullets(content, ['我可以帮您继续做', 'Codex 可以做'], 2);
  const rows = [
    ...done.map((item) => overviewRow(item, '完成', '已推进', '确认今日实际进展')),
    ...open.map((item) => overviewRow(item, '未闭环', '您', '决定明天是否继续')),
    ...codex.map((item) => overviewRow(item, '下一步', 'Codex', '准备后续动作')),
  ];
  return overviewBlock('复盘概述', dedupe(rows).slice(0, 6));
}

function weeklyReviewOverview(content: string): string[] {
  const done = extractSectionBullets(content, ['本周已经完成', '已推进'], 2);
  const mit = extractSectionBullets(content, ['下周 MIT'], 1);
  const plan = extractSectionBullets(content, ['下周主要安排'], 4);
  const codex = extractSectionBullets(content, ['我可以帮您安排 Codex 做', 'Codex 可以做'], 2);
  const rows = [
    ...done.map((item) => overviewRow(item, '完成', '已推进', '沉淀本周结果')),
    ...mit.map((item) => overviewRow(item, 'P0', ownerFor(item, codex, []), '下周唯一主线')),
    ...plan.map((item, index) => overviewRow(item, index === 0 ? 'P0' : 'P1', ownerFor(item, codex, []), '推进下周计划')),
    ...codex.map((item) => overviewRow(item, 'P1', 'Codex', '先准备可交付产物')),
  ];
  return overviewBlock('周计划概述', dedupe(rows).slice(0, 6));
}

function overviewBlock(title: string, rows: string[]): string[] {
  if (rows.length === 0) return [];
  return [`**${title}**`, '', ...rows.map((row, index) => `${index + 1}. ${row}`)];
}

function overviewRow(item: string, priority: string, owner: string, goal: string): string {
  const clean = compactItem(item);
  return `[${priority}][${owner}] ${clean} ｜目标：${goalFromItem(item, goal)}`;
}

function ownerFor(item: string, codexItems: string[], userItems: string[]): string {
  const key = normalizedTextKey(item);
  if (codexItems.some((candidate) => key.includes(normalizedTextKey(candidate).slice(0, 18)))) return 'Codex';
  if (userItems.some((candidate) => key.includes(normalizedTextKey(candidate).slice(0, 18)))) return '您';
  if (/codex|我可以帮|助手|自动|生成|整理|检查|草稿/i.test(item)) return 'Codex';
  if (/您|用户|本人|确认|沟通|审批|判断|批示|联系/.test(item)) return '您';
  return '您';
}

function compactItem(item: string): string {
  return truncate(
    stripMarkdown(item)
      .replace(/^(MIT|P[0-3]|优先级[:：]?)\s*/i, '')
      .replace(/\s+/g, ' ')
      .trim(),
    96,
  );
}

function goalFromItem(item: string, fallback: string): string {
  const clean = stripMarkdown(item).replace(/\s+/g, ' ').trim();
  const match =
    clean.match(/(?:完成标准|预期产物|目标|结果|产物)(?:是|为|：|:)\s*([^。；;]+)/) ||
    clean.match(/(?:确保|形成|产出|完成|确认|决定)([^。；;]{6,60})/);
  return truncate(match?.[1]?.trim() || fallback, 54);
}

function actionHint(workflow: WorkflowName): string {
  if (workflow === 'daily_plan') {
    return '需要看原因请点「展开完整内容」。如果要调整，请点「我要调整」或直接回复：daily-os 修改今日安排：……';
  }
  if (workflow === 'daily_review') {
    return '需要看证据和解释请点「展开完整内容」。如果要修正复盘，请直接回复：daily-os 修改今日复盘：……';
  }
  return '需要看完整解释请点「展开完整内容」。如果要调整下周安排，请直接回复：daily-os 修改周计划：……';
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

function workflowLabel(workflow: WorkflowName): string {
  if (workflow === 'daily_plan') return '今日计划';
  if (workflow === 'daily_review') return '日复盘';
  return '周复盘';
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}
