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

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const { command, subcommand } = options;

  if (command === 'setup') {
    setup();
    return;
  }
  if (command === 'help' || command === '--help' || command === '-h') usage(0);

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
}

function parseArgs(args: string[]): CliOptions {
  const positional: string[] = [];
  let configPath = process.env.DAILY_OS_CONFIG || 'config/config.yaml';
  let envPath = process.env.DAILY_OS_ENV || '.env';
  let send = true;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--no-send') {
      send = false;
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

  return {
    command: positional[0] || 'help',
    subcommand: positional[1],
    configPath,
    envPath,
    send,
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
  plan [--no-send]   Run daily planning workflow now
  review [--no-send] Run daily review workflow now
  weekly [--no-send] Run weekly review workflow now
  service install    Install macOS launchd scheduler
  service uninstall  Remove macOS launchd scheduler
  service run        Run scheduler in the foreground

Options:
  --config <path>    Use a config file other than config/config.yaml
  --env <path>       Load env vars from a file other than .env
  --no-send          Generate workflow output without sending to Feishu
`);
  process.exit(code);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
