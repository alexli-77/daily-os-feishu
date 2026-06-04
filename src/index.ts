#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, loadDotEnv } from './config/load-config.js';
import type { WorkflowName } from './config/schema.js';
import { runWorkflow } from './workflows/run-workflow.js';
import { collectEvidence } from './workflows/evidence.js';
import { todayInTimezone } from './utils/date.js';
import { ensureMemoryFiles } from './storage/memory.js';
import { formatDoctor, runDoctor } from './cli/doctor.js';
import { installLaunchAgent, runScheduler, uninstallLaunchAgent } from './service/launchd.js';
import { pollFeishuFeedback } from './feedback/feishu-feedback.js';
import { startUiServer } from './ui/server.js';
import { startFeishuInteraction } from './interaction/feishu-interaction.js';

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const { command, subcommand } = options;

  if (command === 'setup') {
    setup();
    return;
  }
  if (command === 'help' || command === '--help' || command === '-h') usage(0);

  if (command === 'ui') {
    await startUiServer({
      configPath: options.configPath,
      envPath: options.envPath,
      host: options.host,
      port: options.port,
      open: options.openUi,
    });
    return;
  }

  loadDotEnv(options.envPath);
  const config = loadConfig(options.configPath);

  switch (command) {
    case 'doctor': {
      console.log(formatDoctor(await runDoctor(config, options.configPath)));
      break;
    }
    case 'collect': {
      console.log(JSON.stringify(await collectEvidence(config, todayInTimezone(config)), null, 2));
      break;
    }
    case 'plan':
      await runAndPrint(config, 'daily_plan', options.send);
      break;
    case 'review':
      await runAndPrint(config, 'daily_review', options.send);
      break;
    case 'weekly':
      await runAndPrint(config, 'weekly_review', options.send);
      break;
    case 'service':
      if (subcommand === 'install') {
        const plist = await installLaunchAgent();
        console.log(`Installed launch agent: ${plist}`);
      } else if (subcommand === 'uninstall') {
        const plist = await uninstallLaunchAgent();
        console.log(`Removed launch agent: ${plist}`);
      } else if (subcommand === 'run') {
        console.log('daily-os-feishu scheduler started');
        await runScheduler(config);
      } else {
        usage(1);
      }
      break;
    case 'feedback':
      if (subcommand === 'poll') {
        const result = await pollFeishuFeedback(config, { send: options.send });
        console.log(JSON.stringify(result, null, 2));
      } else {
        usage(1);
      }
      break;
    case 'interaction':
      if (subcommand === 'feishu') {
        const controls = await startFeishuInteraction(config);
        await waitForShutdown(async () => {
          await controls.stop();
        });
      } else {
        usage(1);
      }
      break;
    default:
      usage(command === 'help' ? 0 : 1);
  }
}

interface CliOptions {
  command: string;
  subcommand?: string;
  configPath: string;
  envPath: string;
  send: boolean;
  host: string;
  port: number;
  openUi: boolean;
}

function parseArgs(args: string[]): CliOptions {
  const positional: string[] = [];
  let configPath = process.env.DAILY_OS_CONFIG || 'config/config.yaml';
  let envPath = process.env.DAILY_OS_ENV || '.env';
  let send = true;
  let host = process.env.DAILY_OS_UI_HOST || '127.0.0.1';
  let port = Number(process.env.DAILY_OS_UI_PORT || 14573);
  let openUi = true;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--no-send') {
      send = false;
    } else if (arg === '--no-open') {
      openUi = false;
    } else if (arg === '--host') {
      host = requireValue(args, ++index, '--host');
    } else if (arg.startsWith('--host=')) {
      host = arg.slice('--host='.length);
    } else if (arg === '--port') {
      port = Number(requireValue(args, ++index, '--port'));
    } else if (arg.startsWith('--port=')) {
      port = Number(arg.slice('--port='.length));
    } else if (arg === '--config') {
      configPath = requireValue(args, ++index, '--config');
    } else if (arg.startsWith('--config=')) {
      configPath = arg.slice('--config='.length);
    } else if (arg === '--env') {
      envPath = requireValue(args, ++index, '--env');
    } else if (arg.startsWith('--env=')) {
      envPath = arg.slice('--env='.length);
    } else {
      positional.push(arg);
    }
  }

  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid --port value: ${port}`);
  }

  return {
    command: positional[0] || 'help',
    subcommand: positional[1],
    configPath,
    envPath,
    send,
    host,
    port,
    openUi,
  };
}

function requireValue(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}

async function runAndPrint(config: ReturnType<typeof loadConfig>, workflow: WorkflowName, send: boolean): Promise<void> {
  const text = await runWorkflow(config, workflow, { send });
  console.log(text);
}

async function waitForShutdown(stop: () => Promise<void>): Promise<void> {
  await new Promise<void>((resolve) => {
    const done = (): void => resolve();
    process.once('SIGINT', done);
    process.once('SIGTERM', done);
  });
  await stop();
}

function setup(): void {
  copyIfMissing('.env.example', '.env');
  copyIfMissing('config/config.example.yaml', 'config/config.yaml');
  const config = loadConfig('config/config.yaml');
  ensureMemoryFiles(config);
  fs.mkdirSync(path.resolve('data/snapshots/chrome'), { recursive: true });
  fs.mkdirSync(path.resolve('data/snapshots/calendar'), { recursive: true });
  console.log('Created local .env, config/config.yaml, and data directories. Edit them before running doctor.');
}

function copyIfMissing(from: string, to: string): void {
  if (fs.existsSync(to)) return;
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

function usage(code: number): never {
  console.log(`daily-os-feishu

Commands:
  setup              Create local config files and data directories
  doctor             Check local dependencies and required env vars
  collect            Print collected evidence as JSON
  ui                 Open a local setup and trigger dashboard
  plan [--no-send]   Run daily planning workflow now
  review [--no-send] Run daily review workflow now
  weekly [--no-send] Run weekly review workflow now
  service install    Install macOS launchd scheduler
  service uninstall  Remove macOS launchd scheduler
  service run        Run scheduler in the foreground
  feedback poll      Poll Feishu for daily-os commands and feedback
  interaction feishu Run the Feishu websocket interaction layer

Options:
  --config <path>    Use a config file other than config/config.yaml
  --env <path>       Load env vars from a file other than .env
  --host <host>      Host for the local UI, default 127.0.0.1
  --port <port>      Port for the local UI, default 14573
  --no-open          Start the local UI without opening a browser
  --no-send          Generate workflow output without sending to Feishu
`);
  process.exit(code);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
