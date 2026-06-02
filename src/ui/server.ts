import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import { AppConfigSchema, type AppConfig, type WorkflowName } from '../config/schema.js';
import { loadConfig } from '../config/load-config.js';
import { formatDoctor, runDoctor } from '../cli/doctor.js';
import { collectEvidence } from '../workflows/evidence.js';
import { runWorkflow } from '../workflows/run-workflow.js';
import { todayInTimezone } from '../utils/date.js';
import { pollFeishuFeedback } from '../feedback/feishu-feedback.js';
import { sendFeishuMessage } from '../connectors/lark-cli.js';
import { installLaunchAgent, uninstallLaunchAgent } from '../service/launchd.js';
import { runCommand } from '../utils/command.js';

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
  try {
    const url = new URL(request.url || '/', `http://${request.headers.host || '127.0.0.1'}`);
    if (request.method === 'GET' && url.pathname === '/') return send(response, 200, HTML, 'text/html; charset=utf-8');
    if (request.method === 'GET' && url.pathname === '/assets/app.css') return send(response, 200, CSS, 'text/css; charset=utf-8');
    if (request.method === 'GET' && url.pathname === '/assets/app.js') return send(response, 200, JS, 'application/javascript; charset=utf-8');
    if (request.method === 'GET' && url.pathname === '/api/state') return sendJson(response, await buildState(options));
    if (request.method === 'POST' && url.pathname === '/api/config') return sendJson(response, await saveConfig(options, await readJson(request)));
    if (request.method === 'POST' && url.pathname === '/api/env') return sendJson(response, await saveEnv(options, await readJson(request)));
    if (request.method === 'POST' && url.pathname === '/api/action') return sendJson(response, await runAction(options, await readJson(request)));
    return sendJson(response, { ok: false, error: 'Not found' }, 404);
  } catch (error) {
    sendJson(response, { ok: false, error: error instanceof Error ? error.message : String(error) }, 500);
  }
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
  const sendOutput = request.send !== false;
  const env = readEnvFile(options.envPath);

  if (action === 'discover_tokens') {
    return { ok: true, text: await discoverLocalTokens(options, env) };
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
    return { ok: true, text: `Installed launch agent: ${await installLaunchAgent()}` };
  }

  if (action === 'service_uninstall') {
    return { ok: true, text: `Removed launch agent: ${await uninstallLaunchAgent()}` };
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

async function discoverLocalTokens(options: UiServerOptions, env: Record<string, string>): Promise<string> {
  const next = { ...env };
  const notes: string[] = [];

  const github = await discoverGitHubToken(env);
  if (github.value) {
    next.GITHUB_TOKEN = github.value;
    notes.push(`GitHub token found from ${github.source} and saved to ${path.resolve(options.envPath)}.`);
  } else {
    notes.push('GitHub token not found. Run `gh auth login`, then try again, or paste GITHUB_TOKEN manually.');
  }

  const linear = discoverEnvToken('LINEAR_API_KEY', env);
  if (linear.value) {
    next.LINEAR_API_KEY = linear.value;
    notes.push(`Linear API key found from ${linear.source} and saved to ${path.resolve(options.envPath)}.`);
  } else {
    notes.push('Linear API key not found. Create one in Linear settings and paste LINEAR_API_KEY manually.');
  }

  writeEnvFile(options.envPath, next);
  applyEnv(next);
  return notes.join('\n');
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
  return { source: `process.env.${key}` };
}

function ensureLocalFiles(configPath: string, envPath: string): void {
  copyIfMissing('.env.example', envPath);
  copyIfMissing('config/config.example.yaml', configPath);
  fs.mkdirSync(path.resolve('data/memory/daily'), { recursive: true });
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

  for (const key of ENV_KEYS) {
    if (written.has(key) || !(key in values)) continue;
    lines.push(`${key}=${quoteEnv(values[key])}`);
  }
  fs.writeFileSync(absolute, `${lines.join('\n')}\n`, 'utf8');
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
      <div class="status" id="summary-status">Loading</div>
    </header>

    <main class="layout">
      <nav class="nav" aria-label="Sections">
        <button class="nav-button active" data-section="overview">Overview</button>
        <button class="nav-button" data-section="setup">Setup</button>
        <button class="nav-button" data-section="sources">Sources</button>
        <button class="nav-button" data-section="workflows">Workflows</button>
      </nav>

      <section class="content">
        <form id="config-form">
          <section class="panel active" id="section-overview">
            <div class="panel-head">
              <h2>Overview</h2>
              <button type="button" class="secondary" data-action="doctor">Run Doctor</button>
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
              <button type="submit">Save</button>
            </div>
            <div class="grid">
              <label>Display name<input id="user-display-name" /></label>
              <label>Timezone<input id="user-timezone" /></label>
              <label>Language<input id="assistant-language" /></label>
              <label>LLM provider<select id="llm-provider"><option>codex</option><option>openai</option></select></label>
              <label>Model<input id="llm-model" /></label>
              <label>Codex binary<input id="env-CODEX_BIN" /></label>
              <label>OpenAI API key<input id="secret-OPENAI_API_KEY" type="password" autocomplete="new-password" /></label>
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
              <button type="submit">Save</button>
            </div>
            <div class="source-list">
              <fieldset>
                <legend>Vault</legend>
                <label><input id="vault-enabled" type="checkbox" /> Enabled</label>
                <label>Provider<select id="vault-provider"><option>local</option><option>remote</option></select></label>
                <label>Local path<input id="vault-local-path" /></label>
                <label>Vault gate URL<input id="env-VAULT_GATE_URL" /></label>
                <label>Vault gate token<input id="secret-VAULT_GATE_TOKEN" type="password" autocomplete="new-password" /></label>
              </fieldset>

              <fieldset>
                <legend>Feishu</legend>
                <label><input id="source-feishu-enabled" type="checkbox" /> Enabled</label>
                <div id="feishu-profiles" class="profile-list"></div>
                <button type="button" class="secondary" id="add-feishu-profile">Add Feishu profile</button>
              </fieldset>

              <fieldset>
                <legend>Other sources</legend>
                <button type="button" class="secondary" data-action="discover_tokens">Find local tokens</button>
                <label><input id="source-github" type="checkbox" /> GitHub</label>
                <label>GitHub token<input id="secret-GITHUB_TOKEN" type="password" autocomplete="new-password" /></label>
                <label><input id="source-linear" type="checkbox" /> Linear</label>
                <label>Linear API key<input id="secret-LINEAR_API_KEY" type="password" autocomplete="new-password" /></label>
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
              <button type="submit">Save</button>
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
                <button type="button" data-action="service_install">Install</button>
                <button type="button" class="secondary" data-action="service_uninstall">Uninstall</button>
              </fieldset>
            </div>
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
}

label {
  display: grid;
  gap: .35rem;
  color: var(--muted);
  font-size: .85rem;
}

.inline, .toggles label, fieldset > label:has(input[type="checkbox"]) {
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

fieldset {
  border: 1px solid var(--border);
  border-radius: .5rem;
  padding: .85rem;
  display: grid;
  gap: .7rem;
  min-width: 0;
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
  padding: .75rem;
  display: grid;
  gap: .65rem;
  background: #fbfcfb;
}
.profile-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: .75rem;
}
.profile-title {
  font-weight: 700;
}
.profile-options {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr));
  gap: .5rem;
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
.check.missing strong { color: var(--danger); }

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
  });
});

document.querySelectorAll('[data-action]').forEach((button) => {
  button.addEventListener('click', () => runAction(button.dataset.action));
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

  for (const key of ['OPENAI_API_KEY', 'GITHUB_TOKEN', 'LINEAR_API_KEY', 'VAULT_GATE_TOKEN']) {
    const input = $('secret-' + key);
    input.value = '';
    input.placeholder = state.env[key + '_present'] ? 'Saved locally' : '';
  }

  renderChecks(state.doctor);
  $('output').textContent = state.doctorText || '';
}

function renderChecks(checks) {
  const ok = checks.filter((check) => check.ok).length;
  $('summary-status').textContent = ok + '/' + checks.length + ' OK';
  $('summary-status').className = 'status ' + (ok === checks.length ? 'ok' : 'warn');
  $('checks').innerHTML = checks.map((check) => {
    const detail = check.detail ? '<span>' + escapeHtml(check.detail) + '</span>' : '';
    return '<div class="check ' + (check.ok ? 'ok' : 'missing') + '"><div><strong>' +
      (check.ok ? 'OK' : 'MISSING') + '</strong><br><span>' + escapeHtml(check.name) + '</span></div>' + detail + '</div>';
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
    FEISHU_CHAT_ID: value('env-FEISHU_CHAT_ID'),
    VAULT_GATE_URL: value('env-VAULT_GATE_URL'),
    OPENAI_API_KEY: value('secret-OPENAI_API_KEY'),
    GITHUB_TOKEN: value('secret-GITHUB_TOKEN'),
    LINEAR_API_KEY: value('secret-LINEAR_API_KEY'),
    VAULT_GATE_TOKEN: value('secret-VAULT_GATE_TOKEN'),
  };
  const result = await post('/api/env', { values: envValues });
  state = result.state;
  render();
  $('output').textContent = 'Saved local configuration.';
}

async function runAction(action) {
  const buttons = [...document.querySelectorAll('button')];
  buttons.forEach((button) => button.disabled = true);
  $('output').textContent = 'Running ' + action + '...';
  try {
    const result = await post('/api/action', { action, send: isChecked('send-output') });
    await loadState();
    $('output').textContent = result.text || 'Done.';
  } catch (error) {
    $('output').textContent = error.message;
  } finally {
    buttons.forEach((button) => button.disabled = false);
  }
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
  $('feishu-profiles').innerHTML = profiles.map((profile, index) => '<div class="profile" data-profile-index="' + index + '">' +
    '<div class="profile-head"><span class="profile-title">' + escapeHtml(profile.label || profile.id || ('Feishu ' + (index + 1))) + '</span>' +
    '<button type="button" class="secondary" data-remove-feishu-profile="' + index + '">Remove</button></div>' +
    '<div class="grid">' +
    labelInput('ID', profileFieldId(index, 'id'), profile.id) +
    labelInput('Label', profileFieldId(index, 'label'), profile.label) +
    labelSelect('Identity', profileFieldId(index, 'identity'), profile.identity, ['user', 'bot']) +
    labelInput('IM chat env', profileFieldId(index, 'chat-env'), profile.im_history.chat_id_env) +
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
    '</div>').join('');

  document.querySelectorAll('[data-remove-feishu-profile]').forEach((button) => {
    button.addEventListener('click', () => {
      const next = readFeishuProfiles();
      next.splice(Number(button.dataset.removeFeishuProfile), 1);
      state.config.sources.feishu.profiles = next;
      renderFeishuProfiles(next);
    });
  });
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
