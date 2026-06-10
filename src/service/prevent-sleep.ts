import { spawn, type ChildProcess } from 'node:child_process';

export interface PreventSleepControls {
  active: boolean;
  stop: () => Promise<void>;
}

export function startPreventSleep(enabled: boolean): PreventSleepControls {
  if (!enabled || process.platform !== 'darwin') return inactiveControls();

  const child = spawn('caffeinate', ['-i'], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });

  child.on('error', (error) => {
    console.warn(`[service] 防睡眠模式启动失败：${error.message}`);
  });
  child.stderr?.on('data', (chunk) => {
    const message = String(chunk).trim();
    if (message) console.warn(`[service] caffeinate: ${message}`);
  });
  child.on('exit', (code, signal) => {
    if (code !== null && code !== 0) console.warn(`[service] caffeinate 已退出，code=${code}`);
    if (signal) console.warn(`[service] caffeinate 已退出，signal=${signal}`);
  });

  console.log('daily-os-feishu 防睡眠模式已启动（caffeinate -i）。盒盖或电池策略仍可能让 macOS 强制睡眠。');
  return {
    active: true,
    stop: () => stopChild(child),
  };
}

function inactiveControls(): PreventSleepControls {
  return {
    active: false,
    stop: async () => undefined,
  };
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
    child.kill();
    setTimeout(resolve, 1500).unref();
  });
}
