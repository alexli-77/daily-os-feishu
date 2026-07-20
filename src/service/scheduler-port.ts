/**
 * SchedulerPort — one codebase, two runtime shapes.
 *
 * The scheduling *semantics* (catch-up, per-workflow lock, retry-with-backoff,
 * fired-state persistence) live in `launchd.ts` and are shared verbatim. This
 * port only decides how the tick loop is supervised:
 *
 *   - LaunchdDriver: macOS native. The `launchctl` KeepAlive supervisor keeps
 *     the `start` process alive; the process itself runs the in-process tick
 *     loop (identical to today's behavior — zero change).
 *   - LoopDriver: Docker / Linux. No launchd available, so the process owns a
 *     `setInterval` tick loop directly and Docker's `restart: unless-stopped`
 *     is the supervisor.
 *
 * No new npm dependency: the loop is a plain 60s `setInterval` calling the
 * shared `runSchedulerTick`.
 */
import fs from 'node:fs';
import type { AppConfig, WorkflowName } from '../config/schema.js';
import {
  createSchedulerState,
  runScheduler,
  runSchedulerTick,
  type SchedulerControls,
  type SchedulerRuntimeState,
  type SchedulerTickOptions,
} from './launchd.js';

export type SchedulerDriverKind = 'launchd' | 'loop';

export interface SchedulerJob {
  workflow: WorkflowName;
  time: string;
  weekday?: string;
  enabled: boolean;
}

export interface SchedulerPort {
  readonly driver: SchedulerDriverKind;
  start(): Promise<void>;
  stop(): Promise<void>;
  listJobs(): SchedulerJob[];
}

type ConfigProvider = AppConfig | (() => AppConfig);

function readRuntimeConfig(config: ConfigProvider): AppConfig {
  return typeof config === 'function' ? config() : config;
}

export function listSchedulerJobs(config: AppConfig): SchedulerJob[] {
  return [
    { workflow: 'daily_plan', time: config.workflows.daily_plan.time, enabled: config.workflows.daily_plan.enabled },
    { workflow: 'daily_review', time: config.workflows.daily_review.time, enabled: config.workflows.daily_review.enabled },
    {
      workflow: 'weekly_review',
      time: config.workflows.weekly_review.time,
      weekday: config.workflows.weekly_review.weekday,
      enabled: config.workflows.weekly_review.enabled,
    },
  ];
}

/**
 * Best-effort container detection: an explicit env flag, the cgroup marker the
 * runtime sets, or the `/.dockerenv` file Docker drops into every container.
 */
export function isContainer(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.DAILY_OS_IN_CONTAINER === '1' || env.container) return true;
  try {
    if (fs.existsSync('/.dockerenv')) return true;
  } catch {
    // ignore fs errors — treat as "not a container"
  }
  return false;
}

export function resolveSchedulerDriver(
  config: AppConfig,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): SchedulerDriverKind {
  const raw = (env.DAILY_OS_SCHEDULER || config.scheduler.driver || 'auto').toLowerCase();
  if (raw === 'launchd' || raw === 'loop') return raw;
  // auto: launchd only makes sense on a real macOS host outside a container.
  if (platform !== 'darwin') return 'loop';
  if (isContainer(env)) return 'loop';
  return 'launchd';
}

export interface LoopDriverOptions extends SchedulerTickOptions {
  intervalMs?: number;
}

class LoopDriver implements SchedulerPort {
  readonly driver = 'loop' as const;
  private timer: ReturnType<typeof setInterval> | null = null;
  private state: SchedulerRuntimeState = createSchedulerState();
  private readonly intervalMs: number;
  private readonly tickOptions: SchedulerTickOptions;

  constructor(private readonly config: ConfigProvider, options: LoopDriverOptions = {}) {
    const { intervalMs, ...tickOptions } = options;
    this.intervalMs = intervalMs ?? 60_000;
    this.tickOptions = tickOptions;
  }

  async start(): Promise<void> {
    this.state = createSchedulerState();
    await runSchedulerTick(this.config, this.state, this.tickOptions);
    this.timer = setInterval(() => void runSchedulerTick(this.config, this.state, this.tickOptions), this.intervalMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Drive a single tick immediately (used by tests and manual catch-up). */
  async tick(): Promise<void> {
    await runSchedulerTick(this.config, this.state, this.tickOptions);
  }

  listJobs(): SchedulerJob[] {
    return listSchedulerJobs(readRuntimeConfig(this.config));
  }
}

class LaunchdDriver implements SchedulerPort {
  readonly driver = 'launchd' as const;
  private controls: SchedulerControls | null = null;

  constructor(private readonly config: ConfigProvider, private readonly options: SchedulerTickOptions = {}) {}

  async start(): Promise<void> {
    this.controls = await runScheduler(this.config, this.options);
  }

  async stop(): Promise<void> {
    this.controls?.stop();
    this.controls = null;
  }

  listJobs(): SchedulerJob[] {
    return listSchedulerJobs(readRuntimeConfig(this.config));
  }
}

export interface CreateSchedulerOptions extends LoopDriverOptions {
  /** Force a driver, bypassing env/config/platform resolution (mostly for tests). */
  driver?: SchedulerDriverKind;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

export function createScheduler(config: ConfigProvider, options: CreateSchedulerOptions = {}): SchedulerPort {
  const { driver, env, platform, ...driverOptions } = options;
  const resolved = driver ?? resolveSchedulerDriver(readRuntimeConfig(config), env, platform);
  return resolved === 'loop' ? new LoopDriver(config, driverOptions) : new LaunchdDriver(config, driverOptions);
}

export { LoopDriver, LaunchdDriver };
