export interface FeishuUserMessageRecord {
  id: string;
  text: string;
  raw: unknown;
  createdAt?: Date;
}

export function collectFeishuUserMessageRecords(value: unknown): FeishuUserMessageRecord[] {
  return collectMessageRecords(value)
    .filter((raw) => !isFeishuAppMessageRecord(raw))
    .map((raw) => {
      const createdAt = extractFeishuMessageTimestamp(raw);
      return {
        id: extractFeishuMessageId(raw) || hashFallback(`${extractFeishuMessageText(raw)}:${JSON.stringify(raw).slice(0, 120)}`),
        text: extractFeishuMessageText(raw),
        raw,
        ...(createdAt ? { createdAt } : {}),
      };
    })
    .filter((message) => message.text.trim().length > 0);
}

export function isFeishuAppMessageRecord(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object') return false;
  const sender = (raw as Record<string, unknown>).sender;
  if (!sender || typeof sender !== 'object') return false;
  return (sender as Record<string, unknown>).sender_type === 'app';
}

export function extractFeishuMessageText(value: unknown): string {
  if (typeof value === 'string') {
    const parsed = tryParseJson(value);
    return parsed ? extractFeishuMessageText(parsed) : value;
  }
  if (Array.isArray(value)) return value.map(extractFeishuMessageText).filter(Boolean).join(' ');
  if (!value || typeof value !== 'object') return '';
  const record = value as Record<string, unknown>;
  const direct = [record.text, record.content, record.title, record.message, record.body]
    .map(extractFeishuMessageText)
    .filter(Boolean)
    .join(' ');
  if (direct) return direct;
  return '';
}

export function extractFeishuMessageId(raw: unknown): string {
  if (!raw || typeof raw !== 'object') return '';
  const record = raw as Record<string, unknown>;
  for (const key of ['message_id', 'messageId', 'id']) {
    const value = record[key];
    if (typeof value === 'string') return value;
  }
  return '';
}

export function extractFeishuMessageTimestamp(raw: unknown): Date | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const record = raw as Record<string, unknown>;
  for (const key of ['create_time', 'createTime', 'created_at', 'createdAt', 'timestamp', 'send_time', 'update_time']) {
    const date = dateFromTimestampValue(record[key]);
    if (date) return date;
  }
  return undefined;
}

function collectMessageRecords(value: unknown): unknown[] {
  if (Array.isArray(value)) return value.flatMap(collectMessageRecords);
  if (!value || typeof value !== 'object') return [];
  const record = value as Record<string, unknown>;
  const directText = extractFeishuMessageText(record);
  const directId = extractFeishuMessageId(record);
  const nested = ['items', 'messages', 'data', 'list']
    .flatMap((key) => collectMessageRecords(record[key]))
    .filter(Boolean);
  if (directText && (directId || hasMessageShape(record))) return [record, ...nested];
  return nested;
}

function hasMessageShape(record: Record<string, unknown>): boolean {
  return ['content', 'text', 'message', 'body'].some((key) => key in record);
}

function dateFromTimestampValue(value: unknown): Date | undefined {
  if (typeof value === 'number') {
    const ms = value < 10_000_000_000 ? value * 1000 : value;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? undefined : date;
  }
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (/^\d+$/.test(trimmed)) return dateFromTimestampValue(Number(trimmed));
  const date = new Date(trimmed);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function tryParseJson(value: string): unknown | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return null;
  }
}

function hashFallback(seed: string): string {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) >>> 0;
  }
  return `fm_${hash.toString(16).padStart(8, '0')}`;
}
