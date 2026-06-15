import type { EvidenceSource } from './types.js';

export interface WeeklyPriorityItem {
  source: string;
  scope: string;
  week: string;
  okr: string;
  item: string;
}

export function extractWeeklyPrioritiesFromFeishuDocs(source: EvidenceSource | undefined, date: string): EvidenceSource {
  if (!source || source.state !== 'available') return { state: 'missing', detail: 'Feishu docs source is unavailable' };
  const week = weekLabel(date);
  const items: WeeklyPriorityItem[] = [];
  for (const doc of documentContents(source.data)) {
    items.push(...extractWeeklyPrioritiesFromXml(doc.content, week, doc.name));
  }
  return items.length > 0
    ? { state: 'available', detail: `Extracted ${items.length} weekly priority items for ${week}`, data: { week, items } }
    : { state: 'empty', detail: `No Feishu weekly priorities found for ${week}`, data: { week, items: [] } };
}

export function extractWeeklyPrioritiesFromXml(xml: string, week: string, source = 'document'): WeeklyPriorityItem[] {
  const out: WeeklyPriorityItem[] = [];
  for (const table of xml.split(/<table>/).slice(1).map((value) => value.split('</table>')[0] || '')) {
    const rows = table.split(/<tr>/).slice(1).map((value) => value.split('</tr>')[0] || '');
    if (rows.length < 2 || !table.includes(`${week} 要务`)) continue;
    const headers = tableCells(rows[0]).map(stripDocXml);
    const weekIndex = headers.findIndex((header) => header.includes(`${week} 要务`));
    if (weekIndex < 0) continue;
    const scope = scopeFromHeader(headers[0] || '');
    for (const row of rows.slice(1)) {
      const cells = tableCells(row);
      const okr = stripDocXml(cells[0] || '');
      const weeklyCell = cells[weekIndex] || '';
      if (!weeklyCell.trim()) continue;
      for (const item of listItems(weeklyCell)) {
        out.push({ source, scope, week, okr: completeText(okr, 220), item: completeText(item, 260) });
      }
    }
  }
  return out;
}

function weekLabel(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  const day = d.getUTCDay();
  const monday = new Date(d);
  monday.setUTCDate(d.getUTCDate() + (day === 0 ? -6 : 1 - day));
  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);
  return `${monday.getUTCMonth() + 1}.${monday.getUTCDate()}-${sunday.getUTCMonth() + 1}.${sunday.getUTCDate()}`;
}

function documentContents(data: unknown): Array<{ name: string; content: string }> {
  const docs: Array<{ name: string; content: string }> = [];
  visit(data, (value, path) => {
    if (typeof value === 'string' && value.includes('<table>') && value.includes('要务')) {
      docs.push({ name: path.slice(-5).find((part) => part && part !== 'content') || 'document', content: value });
    }
  });
  return docs;
}

function visit(value: unknown, fn: (value: unknown, path: string[]) => void, path: string[] = []): void {
  fn(value, path);
  if (Array.isArray(value)) {
    value.forEach((item, index) => visit(item, fn, [...path, String(index)]));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) visit(child, fn, [...path, key]);
}

function tableCells(row: string): string[] {
  return row.split(/<td[^>]*>/).slice(1).map((value) => value.split('</td>')[0] || '');
}

function listItems(cell: string): string[] {
  const matches = Array.from(cell.matchAll(/<li(?:\s[^>]*)?>([\s\S]*?)<\/li>/g)).map((match) => stripDocXml(match[1] || ''));
  const cleaned = matches.map((item) => completeText(item, 260)).filter((item) => item.length >= 4);
  if (cleaned.length > 0) return cleaned;
  const fallback = stripDocXml(cell);
  return fallback ? [fallback] : [];
}

function stripDocXml(value: string): string {
  return value
    .replace(/<cite[^>]*title="([^"]+)"[^>]*><\/cite>/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/\s+/g, ' ')
    .trim();
}

function completeText(value: string, max: number): string {
  const clean = value.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  return clean.slice(0, max - 1).replace(/[，,、；;\s-]+$/u, '').trim() + '…';
}

function scopeFromHeader(value: string): string {
  const match = value.match(/[🐧🐶]/u);
  return match?.[0] || value.replace(/\s*重点OKR\s*/g, '').trim() || 'weekly';
}
