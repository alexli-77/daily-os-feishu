import type { AppConfig } from '../config/schema.js';

/**
 * Runtime-environment helpers for the agent providers. daily-os #199: the two
 * subscription CLIs (`claude`, `codex`) connect to their backend but never return
 * when run inside a macOS launchd-managed background service — there is no GUI/TTY
 * to answer the Keychain authorization prompt they fall back to, so they block
 * forever. Raising or removing the timeout cannot fix that (it would hang for
 * good); the only correct outcome there is to tell the user up front and point
 * them at an API-key provider.
 */

/** CLI providers that authenticate through a subscription/Keychain, not an API key. */
export function isCliProvider(provider: string): boolean {
  return provider === 'claude' || provider === 'codex';
}

/**
 * True when we are running as a macOS launchd background agent with no interactive
 * session to answer a Keychain prompt.
 *
 * `DAILY_OS_LAUNCHD=1` is injected into our own launchd plist, so a re-installed
 * service is detected exactly. As a fallback for services installed before this
 * marker existed, launchd also sets `XPC_SERVICE_NAME` to the service label, while
 * an interactive Terminal leaves it unset or `0`.
 */
export function isHeadlessLaunchd(): boolean {
  if (process.platform !== 'darwin') return false;
  if (process.env.DAILY_OS_LAUNCHD === '1') return true;
  const xpc = process.env.XPC_SERVICE_NAME;
  return Boolean(xpc && xpc !== '0');
}

/** The escape hatch for the rare user whose CLI authenticates via an API key env var. */
export function cliUnderLaunchdOverridden(): boolean {
  return process.env.DAILY_OS_ALLOW_CLI_UNDER_LAUNCHD === '1';
}

/** The clear, immediate reminder shown instead of launching a doomed background run. */
export function cliUnderLaunchdMessage(provider: string): string {
  return [
    `provider=${provider} 正运行在 macOS 后台服务(launchd)里，订阅版 CLI 会因为无法弹出 Keychain 授权而永远不返回（daily-os #199）。`,
    '这不是"未登录"，而是这个运行环境结构性地不支持订阅版 CLI。',
    '请改用 API-key provider（把 llm.provider 设为 anthropic 或 openai，并配置对应的 API key），或从终端手动运行工作流。',
    '如果你确知这个 CLI 用的是 API key 认证，可设置环境变量 DAILY_OS_ALLOW_CLI_UNDER_LAUNCHD=1 跳过此检查。',
  ].join('\n');
}

/** Per-run upper bound in ms; 0 means no cap. */
export function resolveAgentTimeoutMs(config: AppConfig): number {
  return config.llm.timeout_ms;
}

/** A timeout message that says which provider/model/prompt size timed out, and why. */
export function describeAgentTimeout(
  provider: string,
  model: string,
  promptChars: number,
  elapsedMs: number,
  timeoutMs: number,
): string {
  const waited = Math.round(elapsedMs / 1000);
  const cap = Math.round(timeoutMs / 1000);
  const tail =
    isCliProvider(provider) && isHeadlessLaunchd()
      ? '在 launchd 后台环境里订阅版 CLI 可能永远不返回（daily-os #199），建议改用 API-key provider（anthropic/openai）。'
      : '如果这是正常的长耗时生成，可调大 config 里的 llm.timeout_ms（设 0 可完全关闭上限），或后续简化 prompt 长度。';
  return `${provider} 运行超过 ${cap}s 被中止（已等待 ${waited}s）。provider=${provider} model=${model || 'default'} prompt≈${promptChars} 字符。${tail}`;
}
