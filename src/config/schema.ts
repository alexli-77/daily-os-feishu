import { z } from 'zod';

const enabled = z.object({ enabled: z.boolean().default(false) });

const strategyAlignment = z
  .object({
    enabled: z.boolean().default(true),
    primary_source_hint: z.string().default('Primary weekly planning source'),
    primary_labels: z.array(z.string()).default(['weekly priorities', '每周要务']),
    primary_markers: z.array(z.string()).default([]),
    reference_labels: z.array(z.string()).default([]),
    reference_markers: z.array(z.string()).default([]),
    alignment_heading: z.string().default('策略对齐'),
    reference_sources: z.array(z.string()).default(['linear', 'vault', 'feishu', 'calendar', 'github']),
  })
  .default({
    enabled: true,
    primary_source_hint: 'Primary weekly planning source',
    primary_labels: ['weekly priorities', '每周要务'],
    primary_markers: [],
    reference_labels: [],
    reference_markers: [],
    alignment_heading: '策略对齐',
    reference_sources: ['linear', 'vault', 'feishu', 'calendar', 'github'],
  });

const feishuProfile = enabled.extend({
  id: z.string().default('default'),
  label: z.string().default('Default'),
  identity: z.enum(['bot', 'user']).default('user'),
  calendar: enabled.extend({ days: z.number().int().positive().default(1) }),
  tasks: enabled.extend({
    include_completed: z.boolean().default(false),
    page_limit: z.number().int().positive().default(5),
  }),
  docs: enabled.extend({
    documents: z.array(z.object({ name: z.string(), token: z.string() })).default([]),
  }),
  im_history: enabled.extend({
    chat_id_env: z.string().default('FEISHU_CHAT_ID'),
    limit: z.number().int().positive().default(80),
  }),
});

export const AppConfigSchema = z.object({
  assistant: z.object({
    name: z.string().default('daily-os-feishu'),
    language: z.string().default('zh-CN'),
    tone: z.string().default('calm, direct, practical'),
  }),
  user: z.object({
    display_name: z.string().default('User'),
    timezone: z.string().default('UTC'),
  }),
  llm: z.object({
    provider: z.enum(['codex', 'openai', 'claude']).default('codex'),
    model: z.string().default('default'),
  }),
  workflows: z.object({
    daily_plan: z.object({ enabled: z.boolean().default(true), time: z.string().default('08:00') }),
    daily_review: z.object({
      enabled: z.boolean().default(true),
      time: z.string().default('21:30'),
      skip_on_weekly_review_day: z.boolean().default(true),
    }),
    weekly_review: z.object({
      enabled: z.boolean().default(true),
      weekday: z.string().default('SUN'),
      time: z.string().default('20:00'),
    }),
  }),
  planning: z
    .object({
      strategy_alignment: strategyAlignment,
    })
    .default({
      strategy_alignment: {
        enabled: true,
        primary_source_hint: 'Primary weekly planning source',
        primary_labels: ['weekly priorities', '每周要务'],
        primary_markers: [],
        reference_labels: [],
        reference_markers: [],
        alignment_heading: '策略对齐',
        reference_sources: ['linear', 'vault', 'feishu', 'calendar', 'github'],
      },
    }),
  service: z
    .object({
      prevent_sleep: enabled.default({ enabled: false }),
    })
    .default({
      prevent_sleep: { enabled: false },
    }),
  output: z.object({
    feishu: z.object({
      enabled: z.boolean().default(true),
      provider: z.enum(['auto', 'sdk', 'lark_cli']).default('auto'),
      identity: z.enum(['bot', 'user']).default('bot'),
      chat_id_env: z.string().default('FEISHU_CHAT_ID'),
      send_mode: z.enum(['markdown', 'text']).default('markdown'),
    }),
  }),
  feedback: z
    .object({
      feishu: enabled.extend({
        chat_id_env: z.string().default('FEISHU_CHAT_ID'),
        identity: z.enum(['bot', 'user']).default('bot'),
        command_prefix: z.string().default('daily-os'),
        poll_limit: z.number().int().positive().max(100).default(20),
        state_path: z.string().default('./data/memory/feishu-feedback-state.json'),
        log_path: z.string().default('./data/memory/feishu-feedback.md'),
      }),
    })
    .default({
      feishu: {
        enabled: false,
        chat_id_env: 'FEISHU_CHAT_ID',
        identity: 'bot',
        command_prefix: 'daily-os',
        poll_limit: 20,
        state_path: './data/memory/feishu-feedback-state.json',
        log_path: './data/memory/feishu-feedback.md',
      },
    }),
  interaction: z
    .object({
      feishu: enabled.extend({
        command_prefix: z.string().default('daily-os'),
        require_mention_in_groups: z.boolean().default(true),
        debounce_ms: z.number().int().nonnegative().default(600),
        reply_mode: z.enum(['markdown', 'text']).default('markdown'),
        session_catalog_path: z.string().default('./data/memory/feishu-session-catalog.json'),
        agent_mode: z
          .object({
            enabled: z.boolean().default(false),
            workdir: z.string().default(''),
            sandbox: z.enum(['read-only', 'workspace-write', 'danger-full-access']).default('read-only'),
            include_memory: z.boolean().default(true),
            include_evidence: z.boolean().default(false),
            context_pack: z
              .object({
                enabled: z.boolean().default(true),
                include_latest_workflow: z.boolean().default(true),
                include_progress_ledger: z.boolean().default(true),
                include_decision_policy: z.boolean().default(true),
                include_evidence_summary: z.boolean().default(true),
                max_sources: z.number().int().positive().max(30).default(12),
                max_items_per_source: z.number().int().positive().max(20).default(4),
                max_chars_per_item: z.number().int().positive().max(4000).default(900),
              })
              .default({
                enabled: true,
                include_latest_workflow: true,
                include_progress_ledger: true,
                include_decision_policy: true,
                include_evidence_summary: true,
                max_sources: 12,
                max_items_per_source: 4,
                max_chars_per_item: 900,
              }),
            timeout_ms: z.number().int().positive().default(300000),
          })
          .default({
            enabled: false,
            workdir: '',
            sandbox: 'read-only',
            include_memory: true,
            include_evidence: false,
            context_pack: {
              enabled: true,
              include_latest_workflow: true,
              include_progress_ledger: true,
              include_decision_policy: true,
              include_evidence_summary: true,
              max_sources: 12,
              max_items_per_source: 4,
              max_chars_per_item: 900,
            },
            timeout_ms: 300000,
          }),
        security: z
          .object({
            owner_open_id_env: z.string().default('FEISHU_OWNER_OPEN_ID'),
            admin_open_ids: z.array(z.string()).default([]),
            allowed_user_open_ids: z.array(z.string()).default([]),
            allowed_chat_ids: z.array(z.string()).default([]),
            access_level: z.enum(['read_only', 'workspace', 'full']).default('read_only'),
            allowed_workspaces: z.array(z.string()).default([]),
          })
          .default({
            owner_open_id_env: 'FEISHU_OWNER_OPEN_ID',
            admin_open_ids: [],
            allowed_user_open_ids: [],
            allowed_chat_ids: [],
            access_level: 'read_only',
            allowed_workspaces: [],
          }),
      }),
    })
    .default({
      feishu: {
        enabled: false,
        command_prefix: 'daily-os',
        require_mention_in_groups: true,
        debounce_ms: 600,
        reply_mode: 'markdown',
        session_catalog_path: './data/memory/feishu-session-catalog.json',
        agent_mode: {
          enabled: false,
          workdir: '',
          sandbox: 'read-only',
          include_memory: true,
          include_evidence: false,
          context_pack: {
            enabled: true,
            include_latest_workflow: true,
            include_progress_ledger: true,
            include_decision_policy: true,
            include_evidence_summary: true,
            max_sources: 12,
            max_items_per_source: 4,
            max_chars_per_item: 900,
          },
          timeout_ms: 300000,
        },
        security: {
          owner_open_id_env: 'FEISHU_OWNER_OPEN_ID',
          admin_open_ids: [],
          allowed_user_open_ids: [],
          allowed_chat_ids: [],
          access_level: 'read_only',
          allowed_workspaces: [],
        },
      },
    }),
  decision: z
    .object({
      enabled: z.boolean().default(true),
      policy_file: z.string().default('decision-policy.yaml'),
      policy_notes_file: z.string().default('decision-policy.md'),
      candidates_path: z.string().default('./data/memory/decision-policy-candidates.md'),
      onboarding: z
        .object({
          enabled: z.boolean().default(true),
          chat_name: z.string().default('Daily OS - 决策校准'),
          chat_id_env: z.string().default('DAILY_OS_DECISION_CHAT_ID'),
          owner_open_id_env: z.string().default('FEISHU_OWNER_OPEN_ID'),
          state_path: z.string().default('./data/memory/decision-onboarding.json'),
          auto_create_on_setup: z.boolean().default(false),
        })
        .default({
          enabled: true,
          chat_name: 'Daily OS - 决策校准',
          chat_id_env: 'DAILY_OS_DECISION_CHAT_ID',
          owner_open_id_env: 'FEISHU_OWNER_OPEN_ID',
          state_path: './data/memory/decision-onboarding.json',
          auto_create_on_setup: false,
        }),
    })
    .default({
      enabled: true,
      policy_file: 'decision-policy.yaml',
      policy_notes_file: 'decision-policy.md',
      candidates_path: './data/memory/decision-policy-candidates.md',
      onboarding: {
        enabled: true,
        chat_name: 'Daily OS - 决策校准',
        chat_id_env: 'DAILY_OS_DECISION_CHAT_ID',
        owner_open_id_env: 'FEISHU_OWNER_OPEN_ID',
        state_path: './data/memory/decision-onboarding.json',
        auto_create_on_setup: false,
      },
    }),
  progress: z
    .object({
      enabled: z.boolean().default(true),
      ledger_dir: z.string().default('./data/memory/progress'),
      no_progress_reminder_time: z.string().default('16:30'),
      max_candidates: z.number().int().positive().default(12),
    })
    .default({
      enabled: true,
      ledger_dir: './data/memory/progress',
      no_progress_reminder_time: '16:30',
      max_candidates: 12,
    }),
  chat_analysis: z
    .object({
      enabled: z.boolean().default(true),
      default_mode: z.enum(['manual', 'todo', 'review']).default('manual'),
      max_messages: z.number().int().positive().default(80),
      max_suggestions: z.number().int().positive().default(8),
      lookback_messages: z.number().int().positive().optional(),
    })
    .default({
      enabled: true,
      default_mode: 'manual',
      max_messages: 80,
      max_suggestions: 8,
    }),
  background_suggestions: z
    .object({
      enabled: z.boolean().default(false),
      mode: z.enum(['manual', 'todo', 'review']).default('review'),
      interval_minutes: z.number().int().positive().default(120),
      min_confidence: z.enum(['low', 'medium', 'high']).default('medium'),
      send_to_feishu: z.boolean().default(true),
      send_on_change_only: z.boolean().default(true),
      state_path: z.string().default('./data/memory/background-suggestions-state.json'),
      pending_path: z.string().default('./data/memory/background-suggestions-pending.json'),
      pending_ttl_hours: z.number().int().positive().default(24),
    })
    .default({
      enabled: false,
      mode: 'review',
      interval_minutes: 120,
      min_confidence: 'medium',
      send_to_feishu: true,
      send_on_change_only: true,
      state_path: './data/memory/background-suggestions-state.json',
      pending_path: './data/memory/background-suggestions-pending.json',
      pending_ttl_hours: 24,
    }),
  sources: z.object({
    vault: enabled.extend({
      provider: z.enum(['remote', 'local']).default('remote'),
      local_path: z.string().default('/path/to/Private-Vault'),
      remote: z.object({
        base_url_env: z.string().default('VAULT_GATE_URL'),
        token_env: z.string().default('VAULT_GATE_TOKEN'),
        scan: z.object({
          enabled: z.boolean().default(true),
          statuses: z.array(z.string()).default(['active', 'watching', 'considering']),
          due_within_days: z.number().int().nonnegative().default(7),
          limit: z.number().int().positive().default(12),
        }),
        read_paths: z.object({
          todos: z.string().default('99_Meta/todos.md'),
          routing: z.string().default('99_Meta/routing.md'),
          watch_list: z.string().default('99_Meta/watch-list.md'),
        }),
      }),
    }),
    chrome_snapshot: enabled.extend({
      tabs_path: z.string().default('./data/snapshots/chrome/current-tabs.txt'),
      status_path: z.string().default('./data/snapshots/chrome/status.json'),
      tabs_json_path: z.string().default('./data/snapshots/chrome/tabs.json'),
      capture: z
        .object({
          enabled: z.boolean().default(true),
          method: z.enum(['osascript']).default('osascript'),
          refresh_on_collect: z.boolean().default(true),
          background_interval_minutes: z.number().int().positive().default(15),
          timeout_ms: z.number().int().positive().default(5000),
          max_tabs: z.number().int().positive().default(80),
          include_url_query: z.boolean().default(false),
          allowlist: z.array(z.string()).default([]),
          blocklist: z.array(z.string()).default([]),
        })
        .default({
          enabled: true,
          method: 'osascript',
          refresh_on_collect: true,
          background_interval_minutes: 15,
          timeout_ms: 5000,
          max_tabs: 80,
          include_url_query: false,
          allowlist: [],
          blocklist: [],
        }),
    }),
    apple_calendar_snapshot: enabled.extend({
      path: z.string().default('./data/snapshots/calendar/apple-today.json'),
    }),
    feishu: enabled.extend({
      profiles: z.array(feishuProfile).default([]),
      calendar: enabled.extend({ days: z.number().int().positive().default(1) }),
      tasks: enabled.extend({
        include_completed: z.boolean().default(false),
        page_limit: z.number().int().positive().default(5),
      }),
      docs: enabled.extend({
        documents: z.array(z.object({ name: z.string(), token: z.string() })).default([]),
      }),
      im_history: enabled.extend({
        chat_id_env: z.string().default('FEISHU_CHAT_ID'),
        limit: z.number().int().positive().default(80),
      }),
    }),
    github: enabled.extend({
      repositories: z.array(z.string()).default([]),
      per_repo_limit: z.number().int().positive().max(100).default(20),
    }),
    linear: enabled.extend({
      query: z.string().default("assignee = me and state.type != 'completed'"),
      projects_allowlist: z.array(z.string()).default([]),
      projects_blocklist: z.array(z.string()).default([]),
      teams_allowlist: z.array(z.string()).default([]),
      teams_blocklist: z.array(z.string()).default([]),
    }),
    local_files: enabled.extend({
      files: z.array(z.object({ name: z.string(), path: z.string() })).default([]),
    }),
  }),
  memory: z.object({
    repository_path: z.string().default(''),
    long_term_path: z.string().default('./data/memory/long-term.md'),
    daily_dir: z.string().default('./data/memory/daily'),
    workflow_runs_dir: z.string().default('./data/memory/workflow-runs'),
  }),
});

export type AppConfig = z.infer<typeof AppConfigSchema>;

export type WorkflowName = 'daily_plan' | 'daily_review' | 'weekly_review';
