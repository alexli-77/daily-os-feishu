import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import yaml from 'js-yaml';
import { AppConfigSchema, type AppConfig, type WorkflowName } from '../config/schema.js';
import { loadConfig } from '../config/load-config.js';
import { formatDoctor, runDoctor } from '../cli/doctor.js';
import { collectEvidence } from '../workflows/evidence.js';
import { runWorkflow } from '../workflows/run-workflow.js';
import { todayInTimezone } from '../utils/date.js';
import { pollFeishuFeedback } from '../feedback/feishu-feedback.js';
import { sendFeishuMessage } from '../connectors/lark-cli.js';
import { getLaunchAgentStatus, installLaunchAgent, uninstallLaunchAgent } from '../service/launchd.js';
import { runCommand } from '../utils/command.js';
import { appendUiLog, clearUiLogs, readUiLogs } from '../storage/ui-log.js';

const SECRET_ENV_KEYS = new Set(['OPENAI_API_KEY', 'GITHUB_TOKEN', 'LINEAR_API_KEY', 'VAULT_GATE_TOKEN', 'LARK_APP_SECRET']);
const PLAIN_ENV_KEYS = ['FEISHU_CHAT_ID', 'VAULT_GATE_URL', 'CODEX_BIN', 'CODEX_HOME', 'TZ', 'LARK_APP_ID'];
const ENV_KEYS = [...PLAIN_ENV_KEYS, ...SECRET_ENV_KEYS];

export interface UiServerOptions {
  configPath: string;
  envPath: string;
  host: string;
  port: number;
  open: boolean;
}

export async function startUiServer(options: UiServerOptions): Promise<void> {
  ensureLocalFiles(options.configPath, options.envPath);

  const server = http.createServer((request, response) => {
    void handleRequest(request, response, options);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, resolve);
  });

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : options.port;
  const url = `http://${options.host === '0.0.0.0' ? '127.0.0.1' : options.host}:${port}`;
  console.log(`daily-os-feishu UI running at ${url}`);
  console.log('Press Ctrl+C to stop.');

  if (options.open) {
    const opened = await runCommand('open', [url], { timeoutMs: 5000 });
    if (!opened.ok) console.warn(`Could not open browser: ${opened.stderr || opened.stdout}`);
  }
}

async function handleRequest(request: http.IncomingMessage, response: http.ServerResponse, options: UiServerOptions): Promise<void> {
  const started = Date.now();
  try {
    const url = new URL(request.url || '/', `http://${request.headers.host || '127.0.0.1'}`);
    attachNetworkLog(request, response, url, started);
    if (request.method === 'GET' && url.pathname === '/') return send(response, 200, HTML, 'text/html; charset=utf-8');
    if (request.method === 'GET' && url.pathname === '/assets/app.css') return send(response, 200, CSS, 'text/css; charset=utf-8');
    if (request.method === 'GET' && url.pathname === '/assets/app.js') return send(response, 200, JS, 'application/javascript; charset=utf-8');
    if (request.method === 'GET' && url.pathname === '/api/state') return sendJson(response, await buildState(options));
    if (request.method === 'GET' && url.pathname === '/api/logs') return sendJson(response, { ok: true, logs: readUiLogs() });
    if (request.method === 'GET' && url.pathname === '/api/env-secret') return sendJson(response, readSecret(options, url.searchParams.get('key') || ''));
    if (request.method === 'POST' && url.pathname === '/api/config') return sendJson(response, await saveConfig(options, await readJson(request)));
    if (request.method === 'POST' && url.pathname === '/api/env') return sendJson(response, await saveEnv(options, await readJson(request)));
    if (request.method === 'POST' && url.pathname === '/api/action') return sendJson(response, await runAction(options, await readJson(request)));
    if (request.method === 'DELETE' && url.pathname === '/api/logs') {
      clearUiLogs();
      appendUiLog({ event: 'action', level: 'info', status: 'success', action: 'clear_logs', detail: 'UI logs cleared by user.' });
      return sendJson(response, { ok: true, logs: readUiLogs() });
    }
    return sendJson(response, { ok: false, error: 'Not found' }, 404);
  } catch (error) {
    sendJson(response, { ok: false, error: error instanceof Error ? error.message : String(error) }, 500);
  }
}

function attachNetworkLog(request: http.IncomingMessage, response: http.ServerResponse, url: URL, started: number): void {
  if (!url.pathname.startsWith('/api/') || url.pathname === '/api/logs') return;
  response.once('finish', () => {
    const statusCode = response.statusCode;
    appendUiLog({
      event: 'network',
      level: statusCode >= 500 ? 'error' : statusCode >= 400 ? 'warning' : 'info',
      status: statusCode >= 400 ? 'error' : 'ok',
      method: request.method || 'GET',
      path: safeLogPath(url),
      status_code: statusCode,
      duration_ms: Date.now() - started,
    });
  });
}

function safeLogPath(url: URL): string {
  if (url.pathname === '/api/env-secret') return '/api/env-secret';
  return url.pathname;
}

function readSecret(options: UiServerOptions, key: string): Record<string, unknown> {
  if (!SECRET_ENV_KEYS.has(key)) return { ok: false, error: 'Secret key is not allowed' };
  const env = readEnvFile(options.envPath);
  return { ok: true, key, value: env[key] || process.env[key] || '' };
}

async function buildState(options: UiServerOptions): Promise<Record<string, unknown>> {
  const env = readEnvFile(options.envPath);
  applyEnv(env);
  const config = loadConfig(options.configPath);
  const checks = await runDoctor(config, options.configPath);
  return {
    ok: true,
    configPath: path.resolve(options.configPath),
    envPath: path.resolve(options.envPath),
    config,
    env: redactedEnv(env),
    doctor: checks,
    doctorText: formatDoctor(checks),
    service: await getLaunchAgentStatus(),
  };
}

async function saveConfig(options: UiServerOptions, body: unknown): Promise<Record<string, unknown>> {
  const config = AppConfigSchema.parse(readRecord(body).config);
  fs.mkdirSync(path.dirname(path.resolve(options.configPath)), { recursive: true });
  fs.writeFileSync(path.resolve(options.configPath), `${yaml.dump(config, { lineWidth: 120, noRefs: true })}`, 'utf8');
  return { ok: true, state: await buildState(options) };
}

async function saveEnv(options: UiServerOptions, body: unknown): Promise<Record<string, unknown>> {
  const values = readRecord(readRecord(body).values);
  const existing = readEnvFile(options.envPath);
  const next: Record<string, string> = { ...existing };

  for (const key of ENV_KEYS) {
    const rawValue = values[key];
    if (typeof rawValue !== 'string') continue;
    const value = rawValue.trim();
    if (SECRET_ENV_KEYS.has(key) && !value) continue;
    next[key] = value;
  }

  writeEnvFile(options.envPath, next);
  applyEnv(next);
  return { ok: true, state: await buildState(options) };
}

async function runAction(options: UiServerOptions, body: unknown): Promise<Record<string, unknown>> {
  const request = readRecord(body);
  const action = String(request.action || '');
  const started = Date.now();
  appendUiLog({ event: 'action', level: 'info', status: 'started', action });
  try {
    const result = await runActionInner(options, request, action);
    appendUiLog({
      event: 'action',
      level: 'info',
      status: 'success',
      action,
      duration_ms: Date.now() - started,
      detail: actionResultDetail(action),
    });
    return result;
  } catch (error) {
    appendUiLog({
      event: 'action',
      level: 'error',
      status: 'error',
      action,
      duration_ms: Date.now() - started,
      detail: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

async function runActionInner(options: UiServerOptions, request: Record<string, unknown>, action: string): Promise<Record<string, unknown>> {
  const sendOutput = request.send !== false;
  const env = readEnvFile(options.envPath);

  if (action === 'discover_github_token') {
    return { ok: true, text: await discoverGitHubTokenForUi(options, env) };
  }

  if (action === 'discover_linear_token') {
    return { ok: true, text: discoverLinearTokenForUi(options, env) };
  }

  if (action === 'choose_vault_folder') {
    return chooseVaultFolder();
  }

  applyEnv(env);
  const config = loadConfig(options.configPath);

  if (action === 'doctor') {
    const checks = await runDoctor(config, options.configPath);
    return { ok: true, text: formatDoctor(checks) };
  }

  if (action === 'collect') {
    return { ok: true, text: JSON.stringify(await collectEvidence(config, todayInTimezone(config)), null, 2) };
  }

  if (action === 'feishu_test') {
    if (!config.output.feishu.enabled) throw new Error('Feishu output is disabled in config.');
    await sendFeishuMessage(config, `daily-os-feishu test message\n${new Date().toISOString()}`);
    return { ok: true, text: 'Feishu test message sent.' };
  }

  if (action === 'feedback_poll') {
    return { ok: true, text: JSON.stringify(await pollFeishuFeedback(config, { send: sendOutput }), null, 2) };
  }

  if (action === 'service_install') {
    const plistPath = await installLaunchAgent();
    return { ok: true, text: `Registered launch agent: ${plistPath}`, service: await getLaunchAgentStatus() };
  }

  if (action === 'service_uninstall') {
    const plistPath = await uninstallLaunchAgent();
    return { ok: true, text: `Unregistered launch agent: ${plistPath}`, service: await getLaunchAgentStatus() };
  }

  const workflows: Record<string, WorkflowName> = {
    plan: 'daily_plan',
    review: 'daily_review',
    weekly: 'weekly_review',
  };
  if (action in workflows) {
    return { ok: true, text: await runWorkflow(config, workflows[action], { send: sendOutput }) };
  }

  throw new Error(`Unknown action: ${action}`);
}

function actionResultDetail(action: string): string {
  if (action === 'collect') return 'Evidence collection completed. Response body is not written to logs.';
  if (['plan', 'review', 'weekly'].includes(action)) return 'Workflow completed. Generated content is not written to logs.';
  if (action === 'feedback_poll') return 'Feishu feedback poll completed. Message bodies are not written to logs.';
  if (action === 'feishu_test') return 'Feishu test message sent.';
  return 'Action completed.';
}

async function chooseVaultFolder(): Promise<Record<string, unknown>> {
  const result = await runCommand(
    'osascript',
    ['-e', 'POSIX path of (choose folder with prompt "Select your vault knowledge base folder")'],
    { timeoutMs: 30000 },
  );
  if (!result.ok) {
    throw new Error('Folder selection was cancelled or unavailable.');
  }
  return { ok: true, path: result.stdout.trim(), text: 'Vault folder selected.' };
}

async function discoverGitHubTokenForUi(options: UiServerOptions, env: Record<string, string>): Promise<string> {
  const next = { ...env };
  const github = await discoverGitHubToken(env);
  if (github.value) {
    next.GITHUB_TOKEN = github.value;
    writeEnvFile(options.envPath, next);
    applyEnv(next);
    return `GitHub token found from ${github.source} and saved locally.`;
  }
  return 'GitHub token not found. Run `gh auth login`, then try again, or paste GITHUB_TOKEN manually.';
}

function discoverLinearTokenForUi(options: UiServerOptions, env: Record<string, string>): string {
  const next = { ...env };
  const linear = discoverEnvToken('LINEAR_API_KEY', env);
  if (linear.value) {
    next.LINEAR_API_KEY = linear.value;
    writeEnvFile(options.envPath, next);
    applyEnv(next);
    return `Linear API key found from ${linear.source} and saved locally.`;
  }
  return 'Linear API key not found. No usable local Linear CLI auth token was found. Create one in Linear settings and paste LINEAR_API_KEY manually.';
}

async function discoverGitHubToken(env: Record<string, string>): Promise<{ value?: string; source: string }> {
  const local = discoverEnvToken('GITHUB_TOKEN', env);
  if (local.value) return local;

  const result = await runCommand('gh', ['auth', 'token'], { timeoutMs: 10000 });
  const token = result.ok ? result.stdout.trim() : '';
  if (token) return { value: token, source: 'gh auth token' };

  const hostsPath = path.join(os.homedir(), '.config', 'gh', 'hosts.yml');
  if (fs.existsSync(hostsPath)) return { source: hostsPath };
  return { source: 'local env or GitHub CLI' };
}

function discoverEnvToken(key: string, env: Record<string, string>): { value?: string; source: string } {
  if (env[key]) return { value: env[key], source: 'configured .env' };
  if (process.env[key]) return { value: process.env[key], source: `process.env.${key}` };
  if (key === 'LINEAR_API_KEY') return discoverLinearCliToken();
  return { source: `process.env.${key}` };
}

function discoverLinearCliToken(): { value?: string; source: string } {
  const commands: Array<[string, string[]]> = [
    ['linear', ['auth', 'token']],
    ['linear', ['auth', 'status', '--json']],
    ['linear', ['whoami', '--json']],
    ['linear-cli', ['auth', 'token']],
  ];

  for (const [command, args] of commands) {
    const result = runCommandSync(command, args);
    if (!result) continue;
    const token = extractToken(result);
    if (token) return { value: token, source: `${command} ${args.join(' ')}` };
  }

  return { source: 'local env or Linear CLI auth' };
}

function runCommandSync(command: string, args: string[]): string | null {
  const child = spawnSync(command, args, { encoding: 'utf8', timeout: 5000 });
  if (child.error || child.status !== 0) return null;
  return `${child.stdout || ''}\n${child.stderr || ''}`.trim();
}

function extractToken(text: string): string {
  if (!text) return '';
  try {
    const parsed = JSON.parse(text) as unknown;
    const token = findTokenInObject(parsed);
    if (token) return token;
  } catch {
    // Continue with text patterns.
  }
  const match = text.match(/lin_api_[A-Za-z0-9_-]+|[A-Za-z0-9_-]{40,}/);
  return match?.[0] || '';
}

function findTokenInObject(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  if (Array.isArray(value)) return value.map(findTokenInObject).find(Boolean) || '';
  const record = value as Record<string, unknown>;
  for (const [key, raw] of Object.entries(record)) {
    if (/token|apiKey|api_key|key/i.test(key) && typeof raw === 'string' && raw.length >= 20) return raw;
    const nested = findTokenInObject(raw);
    if (nested) return nested;
  }
  return '';
}

function ensureLocalFiles(configPath: string, envPath: string): void {
  copyIfMissing('.env.example', envPath);
  copyIfMissing('config/config.example.yaml', configPath);
  fs.mkdirSync(path.resolve('data/memory/daily'), { recursive: true });
  fs.mkdirSync(path.resolve('data/logs'), { recursive: true });
  fs.mkdirSync(path.resolve('data/snapshots/chrome'), { recursive: true });
  fs.mkdirSync(path.resolve('data/snapshots/calendar'), { recursive: true });
}

function copyIfMissing(from: string, to: string): void {
  const absoluteTo = path.resolve(to);
  if (fs.existsSync(absoluteTo)) return;
  fs.mkdirSync(path.dirname(absoluteTo), { recursive: true });
  fs.copyFileSync(path.resolve(from), absoluteTo);
}

function readEnvFile(envPath: string): Record<string, string> {
  const absolute = path.resolve(envPath);
  if (!fs.existsSync(absolute)) return {};
  const values: Record<string, string> = {};
  for (const rawLine of fs.readFileSync(absolute, 'utf8').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const [key, ...rest] = line.split('=');
    values[key] = unquote(rest.join('='));
  }
  return values;
}

function writeEnvFile(envPath: string, values: Record<string, string>): void {
  const absolute = path.resolve(envPath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  const existingLines = fs.existsSync(absolute) ? fs.readFileSync(absolute, 'utf8').split('\n') : [];
  const written = new Set<string>();
  const lines = existingLines
    .filter((line, index, allLines) => index < allLines.length - 1 || line.length > 0)
    .map((rawLine) => {
      const trimmed = rawLine.trim();
      if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) return rawLine;
      const [key] = trimmed.split('=');
      if (!(key in values)) return rawLine;
      written.add(key);
      return `${key}=${quoteEnv(values[key])}`;
    });

  for (const key of orderedEnvKeys(values)) {
    if (written.has(key) || !(key in values)) continue;
    lines.push(`${key}=${quoteEnv(values[key])}`);
  }
  fs.writeFileSync(absolute, `${lines.join('\n')}\n`, 'utf8');
}

function orderedEnvKeys(values: Record<string, string>): string[] {
  const known = ENV_KEYS.filter((key) => key in values);
  const custom = Object.keys(values)
    .filter((key) => !ENV_KEYS.includes(key))
    .filter((key) => /^[A-Z][A-Z0-9_]*$/.test(key))
    .sort();
  return [...known, ...custom];
}

function applyEnv(values: Record<string, string>): void {
  for (const [key, value] of Object.entries(values)) {
    if (value) process.env[key] = value;
    else delete process.env[key];
  }
}

function redactedEnv(values: Record<string, string>): Record<string, unknown> {
  const env: Record<string, unknown> = {};
  for (const key of PLAIN_ENV_KEYS) env[key] = values[key] || '';
  for (const key of SECRET_ENV_KEYS) env[`${key}_present`] = Boolean(values[key]);
  return env;
}

function quoteEnv(value: string): string {
  if (!value) return '';
  if (/^[A-Za-z0-9_./:@-]+$/.test(value)) return value;
  return JSON.stringify(value);
}

function unquote(value: string): string {
  return value.trim().replace(/^"(.*)"$/, '$1');
}

async function readJson(request: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

function readRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function sendJson(response: http.ServerResponse, body: unknown, status = 200): void {
  send(response, status, JSON.stringify(body), 'application/json; charset=utf-8');
}

function send(response: http.ServerResponse, status: number, body: string, contentType: string): void {
  response.writeHead(status, {
    'content-type': contentType,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(body);
}

const HTML = String.raw`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Daily OS Feishu</title>
    <link rel="stylesheet" href="/assets/app.css" />
  </head>
  <body>
    <header class="topbar">
      <div>
        <h1>Daily OS Feishu</h1>
        <p id="paths"></p>
      </div>
      <div class="top-status">
        <span class="save-status" aria-live="polite"></span>
        <div class="status" id="summary-status" title="Local setup checks">Loading</div>
      </div>
    </header>

    <main class="layout">
      <nav class="nav" aria-label="Sections">
        <button class="nav-button active" data-section="overview">Overview</button>
        <button class="nav-button" data-section="setup">Setup</button>
        <button class="nav-button" data-section="sources">Sources</button>
        <button class="nav-button" data-section="workflows">Workflows</button>
        <button class="nav-button" data-section="logs">Logs</button>
      </nav>

      <section class="content">
        <form id="config-form">
          <section class="panel active" id="section-overview">
            <div class="panel-head">
              <h2>Overview</h2>
              <button type="button" class="secondary" data-action="doctor" title="Rerun local setup checks">Run Checks</button>
            </div>
            <div class="checks" id="checks"></div>
            <div class="actions">
              <button type="button" data-action="feishu_test">Test Feishu</button>
              <button type="button" data-action="feedback_poll">Poll Feedback</button>
              <button type="button" data-action="collect">Collect</button>
              <label class="inline">
                <input id="send-output" type="checkbox" checked />
                Send output
              </label>
            </div>
            <pre id="output" aria-live="polite"></pre>
          </section>

          <section class="panel" id="section-setup">
            <div class="panel-head">
              <h2>Setup</h2>
              <div class="panel-actions"><span class="save-status" aria-live="polite"></span><button type="submit">Save</button></div>
            </div>
            <div class="grid">
              <label>Display name<input id="user-display-name" /></label>
              <label>Timezone<input id="user-timezone" /></label>
              <label>Language<input id="assistant-language" /></label>
              <label>LLM provider<select id="llm-provider"><option>codex</option><option>openai</option></select></label>
              <label>Model<input id="llm-model" /></label>
              <label>Codex binary<input id="env-CODEX_BIN" /></label>
              <label>Feishu app ID<input id="env-LARK_APP_ID" placeholder="cli_xxx" /></label>
              <div class="form-field">
                <label for="secret-OPENAI_API_KEY">OpenAI API key</label>
                <div class="secret-control"><input id="secret-OPENAI_API_KEY" type="password" autocomplete="new-password" /><button type="button" class="icon-button" data-toggle-secret="OPENAI_API_KEY" aria-label="Show OpenAI API key">&#128065;</button></div>
              </div>
              <label>Feishu chat ID<input id="env-FEISHU_CHAT_ID" /></label>
              <label>Feishu send mode<select id="output-send-mode"><option>markdown</option><option>text</option></select></label>
              <label>Feedback prefix<input id="feedback-prefix" /></label>
              <label>Feedback poll limit<input id="feedback-poll-limit" type="number" min="1" max="100" /></label>
            </div>
            <div class="toggles">
              <label><input id="output-feishu-enabled" type="checkbox" /> Feishu output</label>
              <label><input id="feedback-feishu-enabled" type="checkbox" /> Feishu feedback</label>
            </div>
          </section>

          <section class="panel" id="section-sources">
            <div class="panel-head">
              <h2>Sources</h2>
              <div class="panel-actions"><span class="save-status" aria-live="polite"></span><button type="submit">Save</button></div>
            </div>
            <div class="source-list">
              <fieldset>
                <legend>Vault</legend>
                <label><input id="vault-enabled" type="checkbox" /> Enabled</label>
                <label>Provider<select id="vault-provider"><option>local</option><option>remote</option></select></label>
                <div class="form-field">
                  <label for="vault-local-path">Local path</label>
                  <div class="path-control"><input id="vault-local-path" /><button type="button" class="secondary compact" data-action="choose_vault_folder">Choose folder</button></div>
                </div>
                <label>Vault gate URL<input id="env-VAULT_GATE_URL" /></label>
                <div class="form-field">
                  <label for="secret-VAULT_GATE_TOKEN">Vault gate token</label>
                  <div class="secret-control"><input id="secret-VAULT_GATE_TOKEN" type="password" autocomplete="new-password" /><button type="button" class="icon-button" data-toggle-secret="VAULT_GATE_TOKEN" aria-label="Show Vault gate token">&#128065;</button></div>
                </div>
              </fieldset>

              <fieldset>
                <legend>Feishu</legend>
                <label><input id="source-feishu-enabled" type="checkbox" /> Enabled</label>
                <div id="feishu-profiles" class="profile-list"></div>
                <button type="button" class="secondary" id="add-feishu-profile">Add Feishu profile</button>
              </fieldset>

              <fieldset>
                <legend>Other sources</legend>
                <div class="source-block">
                  <div class="source-row">
                    <label class="check-row"><input id="source-github" type="checkbox" /> GitHub</label>
                    <button type="button" class="secondary compact" data-action="discover_github_token">Find GitHub token</button>
                  </div>
                  <div class="form-field">
                    <label for="secret-GITHUB_TOKEN">GitHub token</label>
                    <div class="secret-control"><input id="secret-GITHUB_TOKEN" type="password" autocomplete="new-password" /><button type="button" class="icon-button" data-toggle-secret="GITHUB_TOKEN" aria-label="Show GitHub token">&#128065;</button></div>
                  </div>
                  <p class="hint status-line" id="github-token-status"></p>
                </div>
                <div class="source-block">
                  <div class="source-row">
                    <label class="check-row"><input id="source-linear" type="checkbox" /> Linear</label>
                    <button type="button" class="secondary compact" data-action="discover_linear_token">Find Linear key</button>
                  </div>
                  <div class="form-field">
                    <label for="secret-LINEAR_API_KEY">Linear API key</label>
                    <div class="secret-control"><input id="secret-LINEAR_API_KEY" type="password" autocomplete="new-password" /><button type="button" class="icon-button" data-toggle-secret="LINEAR_API_KEY" aria-label="Show Linear API key">&#128065;</button></div>
                  </div>
                  <p class="hint">Linear API key is preferred for direct collection. If it is empty, this app will try the local Codex Linear connection as a fallback.</p>
                  <p class="hint status-line" id="linear-token-status"></p>
                </div>
                <label><input id="source-chrome" type="checkbox" /> Chrome snapshot</label>
                <label><input id="source-apple-calendar" type="checkbox" /> Apple Calendar snapshot</label>
              </fieldset>

              <fieldset>
                <legend>Local files</legend>
                <label><input id="local-files-enabled" type="checkbox" /> Enabled</label>
                <label>Files<textarea id="local-files" rows="5" spellcheck="false"></textarea></label>
              </fieldset>
            </div>
          </section>

          <section class="panel" id="section-workflows">
            <div class="panel-head">
              <h2>Workflows</h2>
              <div class="panel-actions"><span class="save-status" aria-live="polite"></span><button type="submit">Save</button></div>
            </div>
            <div class="workflow-grid">
              <fieldset>
                <legend>Daily plan</legend>
                <label><input id="workflow-plan-enabled" type="checkbox" /> Enabled</label>
                <label>Time<input id="workflow-plan-time" type="time" /></label>
                <button type="button" data-action="plan">Run now</button>
              </fieldset>
              <fieldset>
                <legend>Daily review</legend>
                <label><input id="workflow-review-enabled" type="checkbox" /> Enabled</label>
                <label>Time<input id="workflow-review-time" type="time" /></label>
                <button type="button" data-action="review">Run now</button>
              </fieldset>
              <fieldset>
                <legend>Weekly review</legend>
                <label><input id="workflow-weekly-enabled" type="checkbox" /> Enabled</label>
                <label>Weekday<select id="workflow-weekly-weekday"><option>MON</option><option>TUE</option><option>WED</option><option>THU</option><option>FRI</option><option>SAT</option><option>SUN</option></select></label>
                <label>Time<input id="workflow-weekly-time" type="time" /></label>
                <button type="button" data-action="weekly">Run now</button>
              </fieldset>
              <fieldset>
                <legend>Service</legend>
                <p class="hint">Install creates the macOS launchd scheduler. Uninstall removes only that scheduler.</p>
                <div class="service-status" id="service-status" aria-live="polite"></div>
                <button type="button" id="service-install-button" data-action="service_install">Install</button>
                <button type="button" id="service-uninstall-button" class="secondary" data-action="service_uninstall">Uninstall</button>
              </fieldset>
            </div>
          </section>

          <section class="panel" id="section-logs">
            <div class="panel-head">
              <div>
                <h2>Logs</h2>
                <p class="hint">Local UI/API request status and action lifecycle. Retained for 7 days; secrets and response bodies are not logged.</p>
              </div>
              <div class="panel-actions">
                <button type="button" class="secondary" id="refresh-logs">Refresh</button>
                <button type="button" class="secondary" id="clear-logs">Clear logs</button>
              </div>
            </div>
            <div class="log-list" id="logs" aria-live="polite"></div>
          </section>
        </form>
      </section>
    </main>

    <script src="/assets/app.js"></script>
  </body>
</html>`;

const CSS = String.raw`:root {
  color-scheme: light;
  --bg: #f6f7f4;
  --surface: #ffffff;
  --surface-2: #eef3ee;
  --text: #202421;
  --muted: #68726b;
  --border: #d7ddd8;
  --accent: #1f6f58;
  --accent-2: #0d5f8c;
  --danger: #9f2d2d;
  --ok: #1e7a4d;
  --warn: #a06413;
}

* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  letter-spacing: 0;
}

.topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  padding: 1rem 1.25rem;
  border-bottom: 1px solid var(--border);
  background: var(--surface);
}

.top-status, .panel-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: .75rem;
}

.save-status {
  color: var(--ok);
  font-size: .85rem;
  min-width: 4.5rem;
  text-align: right;
}

h1, h2, legend, p { margin: 0; }
h1 { font-size: 1.25rem; font-weight: 700; }
h2 { font-size: 1rem; }
p, .hint { color: var(--muted); font-size: .85rem; }

.status {
  min-width: 8rem;
  text-align: center;
  border: 1px solid var(--border);
  border-radius: .5rem;
  padding: .45rem .65rem;
  color: var(--muted);
}
.status.ok { color: var(--ok); border-color: #98c8aa; background: #edf7ef; }
.status.warn { color: var(--warn); border-color: #dfc497; background: #fff7e8; }

.layout {
  display: grid;
  grid-template-columns: 13rem minmax(0, 1fr);
  min-height: calc(100vh - 73px);
}

.nav {
  padding: 1rem;
  border-right: 1px solid var(--border);
}

.nav-button, button, select, input, textarea {
  font: inherit;
}

.nav-button {
  width: 100%;
  height: 2.5rem;
  text-align: left;
  border: 0;
  border-radius: .5rem;
  padding: 0 .75rem;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
}
.nav-button.active {
  background: var(--surface-2);
  color: var(--text);
  font-weight: 600;
}

.content { padding: 1rem; }
.panel {
  display: none;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: .5rem;
  padding: 1rem;
}
.panel.active { display: block; }
.panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  margin-bottom: 1rem;
}

.grid, .workflow-grid, .source-list {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(17rem, 1fr));
  gap: .85rem;
  align-items: start;
}

label {
  display: grid;
  gap: .35rem;
  color: var(--muted);
  font-size: .85rem;
}

.form-field {
  display: grid;
  gap: .35rem;
  color: var(--muted);
  font-size: .85rem;
}

.inline, .toggles label, label:has(> input[type="checkbox"]), .check-row {
  display: flex;
  align-items: center;
  gap: .5rem;
}

input, select, textarea {
  width: 100%;
  border: 1px solid var(--border);
  border-radius: .45rem;
  background: #fff;
  color: var(--text);
  padding: .55rem .65rem;
}

input, select {
  min-height: 2.5rem;
}

input[type="checkbox"] {
  width: auto;
  min-width: 1rem;
  height: 1rem;
}

textarea {
  min-height: 8rem;
  resize: vertical;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: .82rem;
}

button {
  border: 1px solid var(--accent);
  border-radius: .45rem;
  background: var(--accent);
  color: white;
  min-height: 2.35rem;
  padding: .45rem .75rem;
  cursor: pointer;
}
button.secondary {
  background: white;
  color: var(--accent);
}
button:disabled {
  opacity: .55;
  cursor: progress;
}

.secret-control {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 2.5rem;
  align-items: stretch;
}
.secret-control input {
  border-radius: .45rem 0 0 .45rem;
}
.icon-button {
  min-height: 2.5rem;
  padding: 0;
  border-radius: 0 .45rem .45rem 0;
  background: white;
  color: var(--accent);
}

.path-control {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: .5rem;
  align-items: center;
}

fieldset {
  border: 1px solid var(--border);
  border-radius: .5rem;
  padding: .85rem;
  display: grid;
  gap: .7rem;
  min-width: 0;
  align-content: start;
  grid-auto-rows: max-content;
}
legend {
  padding: 0 .35rem;
  font-weight: 700;
}

.profile-list {
  display: grid;
  gap: .75rem;
}
.profile {
  border: 1px solid var(--border);
  border-radius: .5rem;
  background: #fbfcfb;
}
.profile-summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: .75rem;
  padding: .75rem;
  cursor: pointer;
}
.profile-title {
  font-weight: 700;
}
.profile-meta {
  color: var(--muted);
  font-size: .8rem;
  text-align: right;
}
.profile-body {
  border-top: 1px solid var(--border);
  padding: .75rem;
  display: grid;
  gap: .65rem;
}
.profile-options {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr));
  gap: .5rem;
}

.source-block {
  display: grid;
  gap: .6rem;
  border: 1px solid var(--border);
  border-radius: .5rem;
  padding: .75rem;
  background: #fbfcfb;
}
.source-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: .75rem;
}
.compact {
  min-height: 2rem;
  padding: .3rem .6rem;
}
.status-line {
  min-height: 1.1rem;
}

.service-status {
  border: 1px solid var(--border);
  border-radius: .45rem;
  padding: .55rem .65rem;
  color: var(--muted);
  background: #fbfcfb;
  font-size: .85rem;
}

.service-status.registered {
  color: var(--ok);
  border-color: #98c8aa;
  background: #edf7ef;
}

.manual-help {
  display: grid;
  gap: .55rem;
  border: 1px solid var(--border);
  border-radius: .5rem;
  padding: .65rem;
  background: #fbfcfb;
}

.toggles, .actions {
  display: flex;
  flex-wrap: wrap;
  gap: .75rem;
  margin-top: 1rem;
}

.checks {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr));
  gap: .5rem;
}
.check {
  display: flex;
  justify-content: space-between;
  gap: .75rem;
  border: 1px solid var(--border);
  border-radius: .45rem;
  padding: .6rem .7rem;
  min-height: 2.6rem;
}
.check strong { font-size: .9rem; }
.check span { font-size: .8rem; color: var(--muted); }
.check.ok strong { color: var(--ok); }
.check.warning strong { color: var(--warn); }
.check.missing strong { color: var(--danger); }

.log-list {
  display: grid;
  gap: .5rem;
  max-height: 65vh;
  overflow: auto;
}

.log-entry {
  display: grid;
  grid-template-columns: 10.5rem 5.5rem minmax(0, 1fr) 5rem;
  gap: .75rem;
  align-items: center;
  border: 1px solid var(--border);
  border-radius: .45rem;
  padding: .55rem .65rem;
  background: #fbfcfb;
  font-size: .82rem;
}

.log-time, .log-meta, .log-duration {
  color: var(--muted);
}

.log-target {
  min-width: 0;
  overflow-wrap: anywhere;
}

.log-badge {
  display: inline-flex;
  justify-content: center;
  min-width: 4.5rem;
  border-radius: 999px;
  border: 1px solid var(--border);
  padding: .15rem .45rem;
  font-weight: 700;
  text-transform: uppercase;
}

.log-badge.info { color: var(--ok); border-color: #98c8aa; background: #edf7ef; }
.log-badge.warning { color: var(--warn); border-color: #dfc497; background: #fff7e8; }
.log-badge.error { color: var(--danger); border-color: #d5a4a4; background: #fff0f0; }

pre {
  margin: 1rem 0 0;
  min-height: 14rem;
  max-height: 42vh;
  overflow: auto;
  border: 1px solid var(--border);
  border-radius: .5rem;
  background: #101412;
  color: #eff5ef;
  padding: .85rem;
  white-space: pre-wrap;
  font-size: .82rem;
}

@media (max-width: 760px) {
  .topbar { align-items: flex-start; flex-direction: column; }
  .layout { grid-template-columns: 1fr; }
  .nav {
    display: flex;
    overflow-x: auto;
    border-right: 0;
    border-bottom: 1px solid var(--border);
  }
  .nav-button { flex: 0 0 auto; width: auto; }
  .log-entry { grid-template-columns: 1fr; gap: .35rem; }
}`;

const JS = String.raw`let state;

const $ = (id) => document.getElementById(id);
const set = (id, value) => { const el = $(id); if (el) el.value = value ?? ''; };
const checked = (id, value) => { const el = $(id); if (el) el.checked = Boolean(value); };
const value = (id) => $(id)?.value ?? '';
const isChecked = (id) => Boolean($(id)?.checked);

document.querySelectorAll('.nav-button').forEach((button) => {
  button.addEventListener('click', () => {
    document.querySelectorAll('.nav-button').forEach((item) => item.classList.remove('active'));
    document.querySelectorAll('.panel').forEach((item) => item.classList.remove('active'));
    button.classList.add('active');
    $('section-' + button.dataset.section).classList.add('active');
    if (button.dataset.section === 'logs') void loadLogs();
  });
});

document.querySelectorAll('[data-action]').forEach((button) => {
  button.addEventListener('click', () => runAction(button.dataset.action));
});

document.querySelectorAll('[data-toggle-secret]').forEach((button) => {
  button.addEventListener('click', () => toggleSecret(button.dataset.toggleSecret));
});

document.querySelectorAll('[id^="secret-"]').forEach((input) => {
  input.addEventListener('input', () => {
    input.dataset.masked = 'false';
  });
});

$('add-feishu-profile').addEventListener('click', () => {
  const profiles = getFeishuProfilesForUi(state.config);
  profiles.push(defaultFeishuProfile(profiles.length + 1));
  state.config.sources.feishu.profiles = profiles;
  renderFeishuProfiles(profiles);
});

$('config-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  await saveAll();
});

$('refresh-logs').addEventListener('click', () => loadLogs());
$('clear-logs').addEventListener('click', () => clearLogs());

loadState();

async function loadState() {
  const response = await fetch('/api/state');
  const data = await response.json();
  if (!data.ok) throw new Error(data.error || 'Failed to load state');
  state = data;
  render();
}

function render() {
  const config = state.config;
  $('paths').textContent = state.configPath + '  |  ' + state.envPath;

  set('user-display-name', config.user.display_name);
  set('user-timezone', config.user.timezone);
  set('assistant-language', config.assistant.language);
  set('llm-provider', config.llm.provider);
  set('llm-model', config.llm.model);
  set('env-CODEX_BIN', state.env.CODEX_BIN || 'codex');
  set('env-LARK_APP_ID', state.env.LARK_APP_ID);
  set('env-FEISHU_CHAT_ID', state.env.FEISHU_CHAT_ID);
  set('output-send-mode', config.output.feishu.send_mode);
  checked('output-feishu-enabled', config.output.feishu.enabled);
  checked('feedback-feishu-enabled', config.feedback.feishu.enabled);
  set('feedback-prefix', config.feedback.feishu.command_prefix);
  set('feedback-poll-limit', config.feedback.feishu.poll_limit);

  checked('vault-enabled', config.sources.vault.enabled);
  set('vault-provider', config.sources.vault.provider);
  set('vault-local-path', config.sources.vault.local_path);
  set('env-VAULT_GATE_URL', state.env.VAULT_GATE_URL);

  checked('source-feishu-enabled', config.sources.feishu.enabled);
  config.sources.feishu.profiles = getFeishuProfilesForUi(config);
  renderFeishuProfiles(config.sources.feishu.profiles);
  checked('source-github', config.sources.github.enabled);
  checked('source-linear', config.sources.linear.enabled);
  checked('source-chrome', config.sources.chrome_snapshot.enabled);
  checked('source-apple-calendar', config.sources.apple_calendar_snapshot.enabled);
  checked('local-files-enabled', config.sources.local_files.enabled);
  set('local-files', config.sources.local_files.files.map((file) => file.name + ' | ' + file.path).join('\n'));

  checked('workflow-plan-enabled', config.workflows.daily_plan.enabled);
  set('workflow-plan-time', config.workflows.daily_plan.time);
  checked('workflow-review-enabled', config.workflows.daily_review.enabled);
  set('workflow-review-time', config.workflows.daily_review.time);
  checked('workflow-weekly-enabled', config.workflows.weekly_review.enabled);
  set('workflow-weekly-weekday', config.workflows.weekly_review.weekday);
  set('workflow-weekly-time', config.workflows.weekly_review.time);

  for (const key of ['OPENAI_API_KEY', 'GITHUB_TOKEN', 'LINEAR_API_KEY', 'VAULT_GATE_TOKEN']) renderSecret(key);

  renderChecks(state.doctor);
  renderServiceStatus(state.service);
  $('output').textContent = state.doctorText || '';
}

function renderServiceStatus(service) {
  const installButton = $('service-install-button');
  const uninstallButton = $('service-uninstall-button');
  const status = $('service-status');
  if (!installButton || !uninstallButton || !status) return;

  const registered = Boolean(service?.registered);
  installButton.disabled = registered;
  installButton.textContent = registered ? 'Registered' : 'Install';
  uninstallButton.disabled = !registered && !service?.installed;
  status.className = 'service-status ' + (registered ? 'registered' : '');
  status.textContent = registered
    ? 'Registered with macOS launchd. Scheduled workflows can run in the background.'
    : service?.installed
      ? 'Plist exists, but launchd is not registered. Click Install to register it again.'
      : 'Not registered. Click Install to create and register the macOS scheduler.';
}

function renderChecks(checks) {
  const required = checks.filter((check) => check.level !== 'warning');
  const requiredOk = required.filter((check) => check.ok).length;
  const warnings = checks.filter((check) => check.level === 'warning').length;
  $('summary-status').textContent = warnings > 0
    ? 'Checks ' + requiredOk + '/' + required.length + ' OK, ' + warnings + ' warning'
    : 'Checks ' + requiredOk + '/' + required.length + ' OK';
  $('summary-status').className = 'status ' + (requiredOk === required.length ? (warnings > 0 ? 'warn' : 'ok') : 'warn');
  $('checks').innerHTML = checks.map((check) => {
    const detail = check.detail ? '<span>' + escapeHtml(check.detail) + '</span>' : '';
    const level = check.level || (check.ok ? 'ok' : 'missing');
    const label = level === 'warning' ? 'WARNING' : (check.ok ? 'OK' : 'MISSING');
    return '<div class="check ' + level + '"><div><strong>' +
      label + '</strong><br><span>' + escapeHtml(check.name) + '</span></div>' + detail + '</div>';
  }).join('');
}

async function saveAll() {
  const next = structuredClone(state.config);
  next.user.display_name = value('user-display-name');
  next.user.timezone = value('user-timezone');
  next.assistant.language = value('assistant-language');
  next.llm.provider = value('llm-provider');
  next.llm.model = value('llm-model');
  next.output.feishu.enabled = isChecked('output-feishu-enabled');
  next.output.feishu.send_mode = value('output-send-mode');
  next.feedback.feishu.enabled = isChecked('feedback-feishu-enabled');
  next.feedback.feishu.command_prefix = value('feedback-prefix');
  next.feedback.feishu.poll_limit = Number(value('feedback-poll-limit') || 20);

  next.sources.vault.enabled = isChecked('vault-enabled');
  next.sources.vault.provider = value('vault-provider');
  next.sources.vault.local_path = value('vault-local-path');
  next.sources.feishu.enabled = isChecked('source-feishu-enabled');
  next.sources.feishu.profiles = readFeishuProfiles();
  if (next.sources.feishu.profiles.length > 0) {
    const first = next.sources.feishu.profiles[0];
    next.sources.feishu.calendar = first.calendar;
    next.sources.feishu.tasks = first.tasks;
    next.sources.feishu.docs = first.docs;
    next.sources.feishu.im_history = first.im_history;
  }
  next.sources.github.enabled = isChecked('source-github');
  next.sources.linear.enabled = isChecked('source-linear');
  next.sources.chrome_snapshot.enabled = isChecked('source-chrome');
  next.sources.apple_calendar_snapshot.enabled = isChecked('source-apple-calendar');
  next.sources.local_files.enabled = isChecked('local-files-enabled');
  next.sources.local_files.files = parseFiles(value('local-files'));

  next.workflows.daily_plan.enabled = isChecked('workflow-plan-enabled');
  next.workflows.daily_plan.time = value('workflow-plan-time');
  next.workflows.daily_review.enabled = isChecked('workflow-review-enabled');
  next.workflows.daily_review.time = value('workflow-review-time');
  next.workflows.weekly_review.enabled = isChecked('workflow-weekly-enabled');
  next.workflows.weekly_review.weekday = value('workflow-weekly-weekday');
  next.workflows.weekly_review.time = value('workflow-weekly-time');

  await post('/api/config', { config: next });
  const envValues = {
    CODEX_BIN: value('env-CODEX_BIN'),
    LARK_APP_ID: value('env-LARK_APP_ID'),
    FEISHU_CHAT_ID: value('env-FEISHU_CHAT_ID'),
    VAULT_GATE_URL: value('env-VAULT_GATE_URL'),
    OPENAI_API_KEY: secretValue('OPENAI_API_KEY'),
    GITHUB_TOKEN: secretValue('GITHUB_TOKEN'),
    LINEAR_API_KEY: secretValue('LINEAR_API_KEY'),
    VAULT_GATE_TOKEN: secretValue('VAULT_GATE_TOKEN'),
  };
  const result = await post('/api/env', { values: envValues });
  state = result.state;
  render();
  $('output').textContent = 'Saved local configuration.';
  setSaveStatus('Saved');
}

function renderSecret(key) {
  const input = $('secret-' + key);
  const button = document.querySelector('[data-toggle-secret="' + key + '"]');
  const present = Boolean(state.env[key + '_present']);
  input.type = 'password';
  input.value = present ? '********' : '';
  input.placeholder = present ? '' : 'Not configured';
  input.dataset.masked = present ? 'true' : 'false';
  if (button) button.setAttribute('aria-label', 'Show ' + key);
}

async function toggleSecret(key) {
  const input = $('secret-' + key);
  const button = document.querySelector('[data-toggle-secret="' + key + '"]');
  if (!input) return;

  if (input.dataset.masked === 'true') {
    const result = await fetch('/api/env-secret?key=' + encodeURIComponent(key)).then((response) => response.json());
    if (!result.ok) throw new Error(result.error || 'Failed to read secret');
    input.type = 'text';
    input.value = result.value || '';
    input.dataset.masked = 'false';
    if (button) button.setAttribute('aria-label', 'Hide ' + key);
  } else {
    input.type = 'password';
    input.value = state.env[key + '_present'] ? '********' : '';
    input.dataset.masked = state.env[key + '_present'] ? 'true' : 'false';
    if (button) button.setAttribute('aria-label', 'Show ' + key);
  }
}

function secretValue(key) {
  const input = $('secret-' + key);
  if (!input || input.dataset.masked === 'true') return '';
  return input.value;
}

async function runAction(action) {
  const buttons = [...document.querySelectorAll('button')];
  buttons.forEach((button) => button.disabled = true);
  $('output').textContent = 'Running ' + action + '...';
  try {
    const result = await post('/api/action', { action, send: isChecked('send-output') });
    if (action === 'choose_vault_folder' && result.path) {
      set('vault-local-path', result.path);
      $('output').textContent = result.text || 'Vault folder selected.';
      setSaveStatus('Folder selected');
      return;
    }
    await loadState();
    $('output').textContent = result.text || 'Done.';
    setSourceStatus(action, result.text || 'Done.');
  } catch (error) {
    $('output').textContent = error.message;
    setSourceStatus(action, error.message);
  } finally {
    buttons.forEach((button) => button.disabled = false);
    renderServiceStatus(state?.service);
    if (document.querySelector('.nav-button.active')?.dataset.section === 'logs') void loadLogs();
  }
}

async function loadLogs() {
  const response = await fetch('/api/logs');
  const data = await response.json();
  if (!data.ok) throw new Error(data.error || 'Failed to load logs');
  renderLogs(data.logs || []);
}

async function clearLogs() {
  const response = await fetch('/api/logs', { method: 'DELETE' });
  const data = await response.json();
  if (!data.ok) throw new Error(data.error || 'Failed to clear logs');
  renderLogs(data.logs || []);
}

function renderLogs(logs) {
  if (!logs.length) {
    $('logs').innerHTML = '<p class="hint">No logs yet.</p>';
    return;
  }
  $('logs').innerHTML = logs.map((entry) => {
    const target = entry.event === 'action'
      ? 'Action: ' + (entry.action || 'unknown')
      : (entry.method || 'GET') + ' ' + (entry.path || '');
    const meta = entry.event === 'network'
      ? 'HTTP ' + (entry.status_code || '')
      : entry.status;
    const detail = entry.detail ? '<div class="log-meta">' + escapeHtml(entry.detail) + '</div>' : '';
    return '<div class="log-entry">' +
      '<div class="log-time">' + escapeHtml(formatLogTime(entry.timestamp)) + '</div>' +
      '<div><span class="log-badge ' + escapeHtml(entry.level || 'info') + '">' + escapeHtml(entry.status || 'ok') + '</span></div>' +
      '<div class="log-target"><div>' + escapeHtml(target) + '</div><div class="log-meta">' + escapeHtml(meta) + '</div>' + detail + '</div>' +
      '<div class="log-duration">' + escapeHtml(formatDuration(entry.duration_ms)) + '</div>' +
      '</div>';
  }).join('');
}

function formatLogTime(timestamp) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return timestamp || '';
  return date.toLocaleString();
}

function formatDuration(value) {
  return typeof value === 'number' ? value + ' ms' : '';
}

function setSaveStatus(text) {
  document.querySelectorAll('.save-status').forEach((item) => {
    item.textContent = text;
  });
  window.clearTimeout(setSaveStatus.timer);
  setSaveStatus.timer = window.setTimeout(() => {
    document.querySelectorAll('.save-status').forEach((item) => {
      item.textContent = '';
    });
  }, 3000);
}
setSaveStatus.timer = 0;

function setSourceStatus(action, text) {
  const target = action === 'discover_github_token' ? $('github-token-status') :
    action === 'discover_linear_token' ? $('linear-token-status') : null;
  if (target) target.textContent = text;
}

async function post(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!data.ok) throw new Error(data.error || 'Request failed');
  return data;
}

function parseFiles(text) {
  return text.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
    const [name, ...rest] = line.split('|').map((part) => part.trim());
    return { name, path: rest.join('|') };
  }).filter((file) => file.name && file.path);
}

function getFeishuProfilesForUi(config) {
  if (Array.isArray(config.sources.feishu.profiles) && config.sources.feishu.profiles.length > 0) {
    return structuredClone(config.sources.feishu.profiles);
  }
  return [{
    id: 'default',
    label: 'Default',
    enabled: true,
    identity: 'user',
    calendar: structuredClone(config.sources.feishu.calendar),
    tasks: structuredClone(config.sources.feishu.tasks),
    docs: structuredClone(config.sources.feishu.docs),
    im_history: structuredClone(config.sources.feishu.im_history),
  }];
}

function defaultFeishuProfile(index) {
  return {
    id: 'feishu_' + index,
    label: 'Feishu ' + index,
    enabled: true,
    identity: 'user',
    calendar: { enabled: false, days: 1 },
    tasks: { enabled: false, include_completed: false, page_limit: 5 },
    docs: { enabled: false, documents: [] },
    im_history: { enabled: false, chat_id_env: 'FEISHU_CHAT_ID', limit: 30 },
  };
}

function renderFeishuProfiles(profiles) {
  $('feishu-profiles').innerHTML = profiles.map((profile, index) => '<details class="profile" data-profile-index="' + index + '">' +
    '<summary class="profile-summary"><span class="profile-title">' + escapeHtml(profile.label || profile.id || ('Feishu ' + (index + 1))) + '</span>' +
    '<span class="profile-meta">' + escapeHtml(profileMeta(profile)) + '</span></summary>' +
    '<div class="profile-body">' +
    '<div class="grid">' +
    labelInput('ID', profileFieldId(index, 'id'), profile.id) +
    labelInput('Label', profileFieldId(index, 'label'), profile.label) +
    labelSelect('Identity', profileFieldId(index, 'identity'), profile.identity, ['user', 'bot']) +
    labelInput('IM chat env', profileFieldId(index, 'chat-env'), profile.im_history.chat_id_env) +
    '</div>' +
    '<div class="manual-help">' +
    '<p class="hint"><strong>Required for Feishu source:</strong> lark-cli must be authenticated. Calendar and Tasks use the profile identity. IM history also requires the profile IM chat env to point to a chat ID such as FEISHU_CHAT_ID=oc_xxx in .env.</p>' +
    '<p class="hint">Find values manually: App ID is in Feishu Developer Console app credentials. Chat ID can be copied from a known chat, or inspected with lark-cli IM commands outside this UI.</p>' +
    '</div>' +
    '<div class="profile-options">' +
    labelCheck('Enabled', profileFieldId(index, 'enabled'), profile.enabled) +
    labelCheck('Calendar', profileFieldId(index, 'calendar'), profile.calendar.enabled) +
    labelCheck('Tasks', profileFieldId(index, 'tasks'), profile.tasks.enabled) +
    labelCheck('Docs', profileFieldId(index, 'docs'), profile.docs.enabled) +
    labelCheck('IM history', profileFieldId(index, 'im'), profile.im_history.enabled) +
    '</div>' +
    '<div class="grid">' +
    labelNumber('Calendar days', profileFieldId(index, 'calendar-days'), profile.calendar.days, 1, 30) +
    labelNumber('Task pages', profileFieldId(index, 'task-pages'), profile.tasks.page_limit, 1, 20) +
    labelNumber('IM limit', profileFieldId(index, 'im-limit'), profile.im_history.limit, 1, 100) +
    '</div>' +
    '<button type="button" class="secondary" data-remove-feishu-profile="' + index + '">Remove profile</button>' +
    '</div></details>').join('');

  document.querySelectorAll('[data-remove-feishu-profile]').forEach((button) => {
    button.addEventListener('click', () => {
      const next = readFeishuProfiles();
      next.splice(Number(button.dataset.removeFeishuProfile), 1);
      state.config.sources.feishu.profiles = next;
      renderFeishuProfiles(next);
    });
  });

}

function profileMeta(profile) {
  const parts = ['id: ' + (profile.id || 'default'), profile.identity || 'user'];
  const enabled = [];
  if (profile.calendar?.enabled) enabled.push('calendar');
  if (profile.tasks?.enabled) enabled.push('tasks');
  if (profile.docs?.enabled) enabled.push('docs');
  if (profile.im_history?.enabled) enabled.push('im');
  parts.push(enabled.length > 0 ? enabled.join(', ') : 'no sources');
  return parts.join(' / ');
}

function readFeishuProfiles() {
  return [...document.querySelectorAll('[data-profile-index]')].map((card) => {
    const index = Number(card.dataset.profileIndex);
    const existing = state.config.sources.feishu.profiles?.[index] || {};
    return {
      id: value(profileFieldId(index, 'id')) || 'feishu_' + (index + 1),
      label: value(profileFieldId(index, 'label')) || 'Feishu ' + (index + 1),
      enabled: isChecked(profileFieldId(index, 'enabled')),
      identity: value(profileFieldId(index, 'identity')) || 'user',
      calendar: {
        enabled: isChecked(profileFieldId(index, 'calendar')),
        days: Number(value(profileFieldId(index, 'calendar-days')) || 1),
      },
      tasks: {
        enabled: isChecked(profileFieldId(index, 'tasks')),
        include_completed: Boolean(existing.tasks?.include_completed),
        page_limit: Number(value(profileFieldId(index, 'task-pages')) || 5),
      },
      docs: {
        enabled: isChecked(profileFieldId(index, 'docs')),
        documents: existing.docs?.documents || [],
      },
      im_history: {
        enabled: isChecked(profileFieldId(index, 'im')),
        chat_id_env: value(profileFieldId(index, 'chat-env')) || 'FEISHU_CHAT_ID',
        limit: Number(value(profileFieldId(index, 'im-limit')) || 30),
      },
    };
  });
}

function profileFieldId(index, name) {
  return 'feishu-profile-' + index + '-' + name;
}

function labelInput(label, id, currentValue) {
  return '<label>' + escapeHtml(label) + '<input id="' + id + '" value="' + escapeAttr(currentValue || '') + '" /></label>';
}

function labelNumber(label, id, currentValue, min, max) {
  return '<label>' + escapeHtml(label) + '<input id="' + id + '" type="number" min="' + min + '" max="' + max + '" value="' + escapeAttr(currentValue || '') + '" /></label>';
}

function labelSelect(label, id, currentValue, options) {
  return '<label>' + escapeHtml(label) + '<select id="' + id + '">' + options.map((option) =>
    '<option ' + (option === currentValue ? 'selected' : '') + '>' + escapeHtml(option) + '</option>').join('') + '</select></label>';
}

function labelCheck(label, id, currentValue) {
  return '<label><input id="' + id + '" type="checkbox" ' + (currentValue ? 'checked' : '') + ' /> ' + escapeHtml(label) + '</label>';
}

function escapeAttr(text) {
  return escapeHtml(text).replace(/\x60/g, '&#96;');
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}`;
