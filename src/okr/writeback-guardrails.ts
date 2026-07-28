import type { MatchedKr } from './biweekly-progress.js';

/**
 * Guardrails between the biweekly LLM draft and the local OKR write-back
 * (LEO-248). The parser already rejects bad krIds and out-of-range percents;
 * this layer defends against the two hallucination modes that slipped through
 * in the 2026-07-28 incident:
 *
 * 1. Fabricated evidence attribution — the draft claimed "要务 ✅ 三条路径…"
 *    while no line in the input pack carries a ✅ anywhere near that KR. Each
 *    evidence string is located back in the input pack: its significant
 *    fragments must co-occur inside a small line window, and any completion
 *    marker (✅ etc.) the evidence claims must be present in that same window.
 * 2. Unjustified jumps — a single-review change of ≥50 percentage points is
 *    only accepted when its evidence was successfully located.
 *
 * Flagged KRs are *not* written back; they surface in the preview as
 * "需人工确认" so a human decides. Everything here is deterministic.
 */

export interface FlaggedKr {
  kr: MatchedKr;
  reasons: string[];
}

export interface GuardrailAssessment {
  accepted: MatchedKr[];
  flagged: FlaggedKr[];
}

/** Percentage-point jump that demands verifiable evidence. */
export const BIG_JUMP_THRESHOLD = 50;

/** Fraction of evidence fragments that must co-occur in one pack window. */
const COVERAGE_THRESHOLD = 0.6;

/** Lines per sliding window when locating evidence in the pack. */
const WINDOW_LINES = 3;

/** Completion markers: when the evidence claims one, the located window must contain it. */
const COMPLETION_MARKERS = ['✅', '✔', '☑'];

/** Split an evidence string into significant fragments (CJK runs + latin/number words). */
export function evidenceFragments(evidence: string): string[] {
  const cjk = evidence.match(/[一-鿿㐀-䶿]{2,}/g) || [];
  const latin = evidence.match(/[A-Za-z0-9][A-Za-z0-9./%-]{1,}/g) || [];
  return [...new Set([...cjk, ...latin])];
}

/**
 * Try to locate the evidence inside the input pack. Located means: some window
 * of adjacent lines contains ≥60% of the evidence fragments, and every
 * completion marker the evidence claims appears in that same window (this is
 * what kills "borrowed checkmark" fabrications — the ✅ existed in the pack,
 * just never next to the claimed item).
 */
export function locateEvidence(evidence: string, packText: string): { located: boolean; reason?: string } {
  const trimmed = evidence.trim();
  if (!trimmed) return { located: false, reason: '证据缺失' };
  const fragments = evidenceFragments(trimmed);
  const markers = COMPLETION_MARKERS.filter((marker) => trimmed.includes(marker));
  if (fragments.length === 0) {
    // Nothing checkable (e.g. pure emoji) — treat as unverifiable.
    return { located: false, reason: '证据无可核实内容' };
  }
  // With very few fragments demand all of them; otherwise the coverage ratio.
  const required = fragments.length <= 2 ? fragments.length : Math.ceil(fragments.length * COVERAGE_THRESHOLD);

  const lines = packText.split('\n');
  for (let start = 0; start < lines.length; start += 1) {
    const window = lines.slice(start, start + WINDOW_LINES).join('\n');
    let hits = 0;
    for (const fragment of fragments) {
      if (window.includes(fragment)) hits += 1;
    }
    if (hits < required) continue;
    if (markers.some((marker) => !window.includes(marker))) continue;
    return { located: true };
  }
  return {
    located: false,
    reason: markers.length
      ? '证据无法在 input pack 中核实（完成标记 ✅ 未出现在对应条目附近）'
      : '证据无法在 input pack 中核实',
  };
}

/**
 * Assess proposed KR updates against the input pack. `packText` may be null
 * when the pack file is gone; then evidence cannot be located, so only
 * conservative rules apply: big jumps are flagged, small deltas pass.
 */
export function assessKrProposals(matched: MatchedKr[], packText: string | null): GuardrailAssessment {
  const accepted: MatchedKr[] = [];
  const flagged: FlaggedKr[] = [];
  for (const kr of matched) {
    const reasons: string[] = [];
    const delta = kr.deltaPct != null ? Math.abs(kr.deltaPct) : null;
    const bigJump = delta != null && delta >= BIG_JUMP_THRESHOLD;

    if (packText != null) {
      const location = locateEvidence(kr.evidence, packText);
      if (!location.located) reasons.push(location.reason || '证据无法核实');
    } else if (bigJump) {
      reasons.push(`进度跳变 ${delta} 个百分点（≥${BIG_JUMP_THRESHOLD}）且 input pack 缺失，无法核实证据`);
    }
    if (bigJump && packText != null && reasons.length > 0) {
      reasons.push(`进度跳变 ${delta} 个百分点（≥${BIG_JUMP_THRESHOLD}），必须有可定位证据`);
    }

    if (reasons.length > 0) {
      flagged.push({ kr, reasons });
    } else {
      accepted.push(kr);
    }
  }
  return { accepted, flagged };
}

/** Render "O1-KR1: 0%→100% — 原因1；原因2" lines for previews / replies. */
export function renderFlaggedLines(flagged: FlaggedKr[]): string[] {
  return flagged.map(({ kr, reasons }) => {
    const from = kr.fromPct != null ? `${kr.fromPct}%` : kr.fromProgress || kr.fromCurrent || 'n/a';
    const to = kr.toPct != null ? `${kr.toPct}%` : kr.toProgress || kr.toCurrent || 'n/a';
    return `${kr.krId}: ${from}→${to} — ${reasons.join('；')}`;
  });
}
