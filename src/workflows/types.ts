export type SourceState = 'available' | 'empty' | 'missing' | 'error' | 'disabled';

export interface EvidenceSource {
  state: SourceState;
  detail?: string;
  data?: unknown;
}

export interface Evidence {
  generated_at: string;
  date: string;
  sources: Record<string, EvidenceSource>;
}

export function isEmpty(value: unknown): boolean {
  if (value == null) return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'string') return value.trim().length === 0;
  if (typeof value === 'object') return Object.keys(value as object).length === 0;
  return false;
}

export function sourceFromResult(data: unknown): EvidenceSource {
  return { state: isEmpty(data) ? 'empty' : 'available', data };
}
