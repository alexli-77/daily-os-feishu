import { z } from 'zod';

const enabled = z.object({ enabled: z.boolean().default(false) });

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
    limit: z.number().int().positive().default(30),
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
    provider: z.enum(['codex', 'openai']).default('codex'),
    model: z.string().default('default'),
  }),
  workflows: z.object({
    daily_plan: z.object({ enabled: z.boolean().default(true), time: z.string().default('08:00') }),
    daily_review: z.object({ enabled: z.boolean().default(true), time: z.string().default('21:30') }),
    weekly_review: z.object({
      enabled: z.boolean().default(true),
      weekday: z.string().default('SUN'),
      time: z.string().default('20:00'),
    }),
  }),
  output: z.object({
    feishu: z.object({
      enabled: z.boolean().default(true),
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
      }),
    })
    .default({
      feishu: {
        enabled: false,
        command_prefix: 'daily-os',
        require_mention_in_groups: true,
        debounce_ms: 600,
        reply_mode: 'markdown',
      },
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
        limit: z.number().int().positive().default(30),
      }),
    }),
    github: enabled,
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
  }),
});

export type AppConfig = z.infer<typeof AppConfigSchema>;

export type WorkflowName = 'daily_plan' | 'daily_review' | 'weekly_review';
