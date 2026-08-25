import { spawn } from 'node:child_process';

export interface CommandResult {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
  /** True when the child was killed by the timeout rather than exiting on its own. */
  timedOut?: boolean;
}

export function runCommand(
  command: string,
  args: string[],
  options: { timeoutMs?: number; input?: string; env?: NodeJS.ProcessEnv; cwd?: string } = {},
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], env: options.env, cwd: options.cwd });
    let timedOut = false;
    const timer = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
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
      resolve({ ok: false, code: null, stdout, stderr: stderr + error.message, timedOut });
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      // A SIGTERMed child writes nothing on its way out, so without this note
      // the caller sees a failure with two empty streams and no reason.
      const detail = timedOut ? `${stderr}\n[timeout] killed after ${options.timeoutMs}ms (SIGTERM)`.trim() : stderr;
      resolve({ ok: code === 0 && !timedOut, code, stdout, stderr: detail, timedOut });
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
