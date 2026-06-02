import { spawn } from 'node:child_process';

export interface CommandResult {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
}

export function runCommand(
  command: string,
  args: string[],
  options: { timeoutMs?: number; input?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], env: options.env });
    const timer = options.timeoutMs
      ? setTimeout(() => {
          child.kill('SIGTERM');
        }, options.timeoutMs)
      : undefined;
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      if (timer) clearTimeout(timer);
      resolve({ ok: false, code: null, stdout, stderr: stderr + error.message });
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ ok: code === 0, code, stdout, stderr });
    });
    child.stdin.end(options.input ?? '');
  });
}

export async function commandExists(command: string, env?: NodeJS.ProcessEnv): Promise<boolean> {
  if (command.includes('/')) {
    const result = await runCommand(command, ['--version'], { timeoutMs: 5000, env });
    return result.ok;
  }
  const result = await runCommand('/usr/bin/env', ['which', command], { timeoutMs: 5000, env });
  return result.ok;
}
