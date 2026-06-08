import type { WorkflowName } from '../config/schema.js';

const MAX_SUMMARY_CHARS = 1800;
const MAX_DETAIL_CHARS = 7000;

export function formatWorkflowSummaryForFeishu(workflow: WorkflowName, date: string, content: string): string {
  const clean = normalize(content);
  const intro = introFor(workflow, clean);
  const bullets = [
    ...extractSectionBullets(clean, ['今日重点', '下周 MIT', '已完成', '已推进', '本周已经完成', '本周没做完', '未闭环'], 3),
    ...extractSectionBullets(clean, ['Codex 可以做', '我可以帮您', '我可以帮您安排 Codex 做'], 2),
    ...extractSectionBullets(clean, ['用户必须做', '需要您批示', '需要您本人处理'], 2),
  ];
  const uniqueBullets = dedupe(bullets).slice(0, 6);
  const fallback = sentencePreview(clean, 420);
  const lines = [
    intro,
    '',
    ...(uniqueBullets.length > 0 ? ['我先把关键事项压缩成一屏：', '', ...uniqueBullets.map((item, index) => `${index + 1}. ${item}`)] : [fallback]),
    '',
    '完整内容我已经保存。需要展开时，请回复：`daily-os details`。',
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
  return /^(今日重点|为什么|Codex|用户|暂不|阻塞|重要信号|已完成|已推进|没完成|未闭环|需要您|明天|缺失|本周|下周|OKR|优先级|MIT)/.test(line);
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

function workflowLabel(workflow: WorkflowName): string {
  if (workflow === 'daily_plan') return '今日计划';
  if (workflow === 'daily_review') return '日复盘';
  return '周复盘';
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}
