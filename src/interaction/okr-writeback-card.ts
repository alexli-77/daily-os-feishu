import type { AppConfig } from '../config/schema.js';
import { loadOkrFromDir } from '../okr/loader.js';
import {
  applyBiweeklyWriteback,
  defaultOkrHistoryPath,
  matchBiweeklyProgress,
  parseBiweeklyProgress,
  renderKrIncrements,
  resolveOkrDir,
  type MatchedKr,
  type WritebackOutcome,
} from '../okr/biweekly-progress.js';

/**
 * Minimal interaction glue for the LEO-109 biweekly OKR write-back confirm card.
 *
 * `buildOkrWritebackPreview` turns a biweekly review draft into the increment
 * lines / obstacles / next-priorities shown on the confirm card. The user must
 * click 确认写回 before `executeConfirmedOkrWriteback` re-derives the same preview
 * from the stored draft and writes each KR back to the local OKR files. Nothing
 * here touches Feishu docs — only local OKR files + the rolling history.
 */

export interface OkrWritebackPreview {
  hasProgress: boolean;
  incrementLines: string[];
  matched: MatchedKr[];
  skipped: Array<{ krId: string; reason: string }>;
  obstacles: string[];
  nextPriorities: string[];
  reason?: string;
}

export function buildOkrWritebackPreview(input: { config: AppConfig; draft: string }): OkrWritebackPreview {
  const empty: OkrWritebackPreview = {
    hasProgress: false,
    incrementLines: [],
    matched: [],
    skipped: [],
    obstacles: [],
    nextPriorities: [],
  };
  const parse = parseBiweeklyProgress(input.draft);
  if (!parse.ok || !parse.contract) {
    return { ...empty, reason: parse.reason || 'no structured progress' };
  }
  const okrDir = resolveOkrDir(input.config.memory.repository_path);
  const model = loadOkrFromDir(okrDir);
  const { matched, skipped } = matchBiweeklyProgress(model, parse.contract);
  return {
    hasProgress: matched.length > 0,
    incrementLines: renderKrIncrements(matched),
    matched,
    skipped,
    obstacles: parse.contract.obstacles,
    nextPriorities: parse.contract.next_priorities,
  };
}

export function executeConfirmedOkrWriteback(input: {
  config: AppConfig;
  draft: string;
  date: string;
}): { outcome: WritebackOutcome; incrementLines: string[] } {
  const preview = buildOkrWritebackPreview({ config: input.config, draft: input.draft });
  const okrDir = resolveOkrDir(input.config.memory.repository_path);
  const outcome = applyBiweeklyWriteback({
    okrDir,
    historyPath: defaultOkrHistoryPath(),
    matched: preview.matched,
    date: input.date,
  });
  return { outcome, incrementLines: preview.incrementLines };
}

/**
 * Confirm-card object for the biweekly OKR write-back. Reuses the existing
 * `daily_os_skill_action` value channel so the shared card-action parser routes
 * the buttons — `confirm_okr_writeback` executes, `dismiss` cancels.
 */
export function renderOkrWritebackCard(options: {
  skillId: string;
  mode: string;
  runId?: string;
  preview: OkrWritebackPreview;
}): object {
  const { preview } = options;
  const incrementBlock = preview.incrementLines.length
    ? preview.incrementLines.map((line) => `- ${line}`).join('\n')
    : '（没有可写回的 KR 进度）';
  const skippedBlock = preview.skipped.length
    ? ['', '**已跳过（未匹配到本地 OKR）**', ...preview.skipped.map((entry) => `- ${entry.krId}：${entry.reason}`)].join('\n')
    : '';
  const obstacleBlock = preview.obstacles.length
    ? ['', '**障碍**', ...preview.obstacles.map((item) => `- ${item}`)].join('\n')
    : '';
  const priorityBlock = preview.nextPriorities.length
    ? ['', '**下周优先级**', ...preview.nextPriorities.map((item) => `- ${item}`)].join('\n')
    : '';
  return {
    config: { wide_screen_mode: true },
    header: {
      template: 'orange',
      title: { tag: 'plain_text', content: '确认写回本地 OKR 进度' },
    },
    elements: [
      {
        tag: 'markdown',
        content: [
          '我准备把这次双周复盘的 KR 进度写回本地 OKR 文件（不写飞书）。',
          '',
          '**KR 进度增量**',
          incrementBlock,
          skippedBlock,
          obstacleBlock,
          priorityBlock,
        ]
          .filter(Boolean)
          .join('\n'),
      },
      { tag: 'hr' },
      {
        tag: 'action',
        actions: [
          okrCardButton('确认写回本地 OKR', {
            daily_os_skill_action: 'confirm_okr_writeback',
            skill_id: options.skillId,
            mode: options.mode,
            ...(options.runId ? { run_id: options.runId } : {}),
          }, 'primary'),
          okrCardButton('先不写回', { daily_os_skill_action: 'dismiss', skill_id: options.skillId, mode: options.mode }, 'default'),
        ],
      },
      {
        tag: 'note',
        elements: [{ tag: 'plain_text', content: '确认后逐条更新 10_OKR 文件的 Current/Progress/Updated，并追加一行滚动历史；只改本地文件。' }],
      },
    ],
  };
}

function okrCardButton(label: string, value: Record<string, unknown>, type: 'primary' | 'default'): object {
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: label },
    type,
    value,
  };
}
