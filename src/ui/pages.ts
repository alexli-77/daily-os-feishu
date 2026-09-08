import fs from 'node:fs';
import path from 'node:path';
import type { AppConfig } from '../config/schema.js';
import type { Role } from './auth.js';
import { listRecentWorkflowRuns, type WorkflowRunRecord } from '../workflows/run-ledger.js';
import {
  listTodoInboxHistory,
  openTodoInboxItems,
  purgeExpiredTodoInboxHistory,
  TODO_HISTORY_RETENTION_DAYS,
  type TodoInboxItem,
} from '../todo/inbox.js';
import { readLatestWorkflowOutput } from '../storage/memory.js';
import { extractDailyPlanTodos } from '../workflows/summary.js';
import { todayInTimezone } from '../utils/date.js';
import { listTodoFeedback } from '../todo/feedback.js';
import { readOkrSnapshot, type OkrFile, type OkrObjective } from './okr-lite.js';
import { readArtifactsIndex, findArtifactById, isPreviewableType, type ArtifactRecord } from '../storage/artifacts.js';
import { runManager } from '../service/run-manager.js';
import { linearIssueUrl } from '../utils/linear-link.js';

/**
 * Server-rendered pages for the LEO-210 web console. These are plain HTML
 * strings (no front-end framework, no npm deps) that share the existing
 * server.ts rendering style. Data is read from disk at request time and always
 * degrades gracefully when a file is missing.
 */

export interface PageContext {
  config: AppConfig;
  role: Role;
  username: string;
  url: URL;
}

export const PLATFORM_PAGES = new Set(['/dashboard', '/today', '/cycles', '/okr', '/chat', '/schedules', '/runs', '/artifacts']);

const NAV: Array<{ href: string; label: string }> = [
  { href: '/dashboard', label: 'Dashboard' },
  { href: '/today', label: 'Today' },
  { href: '/cycles', label: 'Cycles' },
  { href: '/okr', label: 'OKR' },
  { href: '/chat', label: 'Chat' },
  { href: '/schedules', label: 'Schedules' },
  { href: '/runs', label: 'Runs' },
  { href: '/artifacts', label: 'Artifacts' },
  { href: '/console', label: 'Config' },
];

export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function renderPlatformPage(pathname: string, ctx: PageContext): string {
  switch (pathname) {
    case '/dashboard':
      return layout('/dashboard', ctx, renderDashboard(ctx));
    case '/today':
      return layout('/today', ctx, renderToday(ctx));
    case '/cycles':
      return layout('/cycles', ctx, renderCyclesPage(ctx));
    case '/okr':
      return layout('/okr', ctx, renderOkrPage(ctx));
    case '/chat':
      return layout('/chat', ctx, renderChat(ctx));
    case '/schedules':
      return layout('/schedules', ctx, renderSchedules(ctx));
    case '/runs':
      return layout('/runs', ctx, renderRuns(ctx));
    case '/artifacts':
      return layout('/artifacts', ctx, renderArtifacts(ctx));
    default:
      return layout('/dashboard', ctx, '<p>Unknown page.</p>');
  }
}

// --- layout -----------------------------------------------------------------

function layout(active: string, ctx: PageContext, body: string): string {
  const nav = NAV.map(
    (item) => `<a class="nav-link${item.href === active ? ' active' : ''}" href="${item.href}">${escapeHtml(item.label)}</a>`,
  ).join('');
  const roleBadge = ctx.role === 'admin' ? 'admin' : 'member';
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Daily OS Console</title>
  <style>${CONSOLE_CSS}</style>
</head>
<body>
  <header class="topbar">
    <div class="brand">Daily OS · Console</div>
    <nav class="nav">${nav}</nav>
    <div class="session">
      <a class="setup-link" href="/">Setup</a>
      <span class="role role-${roleBadge}">${escapeHtml(ctx.username)} · ${roleBadge}</span>
      <button type="button" class="logout" data-logout>Logout</button>
    </div>
  </header>
  <main class="page">${body}</main>
  <div class="toast" id="toast" hidden></div>
  <script>${CONSOLE_JS}</script>
</body>
</html>`;
}

export function renderLoginPage(error?: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Daily OS Console · Login</title>
  <style>${CONSOLE_CSS}</style>
</head>
<body class="login-body">
  <form class="login-card" method="post" action="/api/login" id="login-form">
    <h1>Daily OS Console</h1>
    <p class="muted">Sign in with your local account.</p>
    ${error ? `<p class="error">${escapeHtml(error)}</p>` : ''}
    <label>Username<input name="username" autocomplete="username" autofocus required /></label>
    <label>Password<input name="password" type="password" autocomplete="current-password" required /></label>
    <button type="submit">Sign in</button>
    <p class="muted small">Lost the password? Run <code>npm run admin:reset-password</code> (or <code>daily-os admin reset-password</code>) to set a new one, then sign in.</p>
    <p class="muted small"><a href="/console">← Open the config console without signing in</a></p>
  </form>
  <script>${LOGIN_JS}</script>
</body>
</html>`;
}

// --- dashboard --------------------------------------------------------------

function renderDashboard(ctx: PageContext): string {
  const { config } = ctx;
  const schedule = workflowSchedule(config);
  const fired = readFiredKeys();
  const today = utcDay();
  const scheduleRows = schedule
    .map((item) => {
      const key = `${today}:${item.workflow}:${item.time}`;
      const status = !item.enabled ? 'disabled' : fired.has(key) ? 'fired today' : 'waiting';
      return `<tr><td>${escapeHtml(item.label)}</td><td>${escapeHtml(item.time)}</td><td>${escapeHtml(item.enabled ? 'on' : 'off')}</td><td>${escapeHtml(status)}</td></tr>`;
    })
    .join('');

  const runs = safe(() => listRecentWorkflowRuns(config, 8), []);
  const runsHtml = runs.length
    ? `<table class="grid"><thead><tr><th>Workflow</th><th>Trigger</th><th>Status</th><th>Started</th></tr></thead><tbody>${runs
        .map(
          (run) =>
            `<tr><td>${escapeHtml(run.workflow)}</td><td>${escapeHtml(run.trigger)}</td><td>${statusPill(run.status)}</td><td>${escapeHtml(shortTime(run.started_at))}</td></tr>`,
        )
        .join('')}</tbody></table>`
    : '<p class="muted">No workflow runs recorded yet.</p>';

  const usage = readUsageSummary();
  const usageHtml = usage.enabled
    ? `<div class="stat-row">
        <div class="stat"><span class="stat-num">${usage.todayCalls}</span><span class="stat-label">calls today</span></div>
        <div class="stat"><span class="stat-num">${formatTokens(usage.todayTokens)}</span><span class="stat-label">tokens today</span></div>
        <div class="stat"><span class="stat-num">$${usage.todayCost.toFixed(4)}</span><span class="stat-label">est. cost today</span></div>
        <div class="stat"><span class="stat-num">$${usage.monthCost.toFixed(2)}</span><span class="stat-label">est. cost (${escapeHtml(usage.month)})</span></div>
      </div><p class="muted small">Source: data/runtime/usage-ledger.jsonl (UTC).</p>`
    : '<p class="muted">Token usage ledger not enabled. Nothing recorded at data/runtime/usage-ledger.jsonl yet.</p>';

  return `
  <section class="card">
    <h2>Today's workflows</h2>
    <table class="grid"><thead><tr><th>Workflow</th><th>Time</th><th>Enabled</th><th>Status</th></tr></thead><tbody>${scheduleRows}</tbody></table>
  </section>
  <section class="card">
    <h2>Recent runs</h2>
    ${runsHtml}
  </section>
  <section class="card">
    <h2>Token usage</h2>
    ${usageHtml}
  </section>
  ${ctx.role === 'admin' ? renderAdminUsers() : ''}
  `;
}

function renderAdminUsers(): string {
  return `
  <section class="card">
    <h2>Users <span class="tag">admin only</span></h2>
    <form class="inline-form" data-post="/api/admin/users">
      <input name="username" placeholder="username" required />
      <input name="password" type="password" placeholder="password (min 8)" required />
      <select name="role"><option value="member">member</option><option value="admin">admin</option></select>
      <input type="hidden" name="action" value="add" />
      <button type="submit">Add user</button>
    </form>
    <p class="muted small">Members are read-only in the console except for whitelisted Today actions.</p>
  </section>`;
}

// --- today ------------------------------------------------------------------

function renderToday(ctx: PageContext): string {
  const planCol = renderPlanColumn(ctx);
  const myTodoCol = renderMyTodoColumn(ctx);

  return `
  <div class="two-col">
    <section class="card col"><h2>Today's plan</h2>${planCol}</section>
    <section class="card col"><h2>My todos</h2>${myTodoCol}</section>
  </div>`;
}

/** Today's plan — the todos the daily_plan workflow generated (read-only view). */
function renderPlanColumn(ctx: PageContext): string {
  const { config } = ctx;
  const latest = safe(() => readLatestWorkflowOutput(config), null);
  if (!latest || latest.workflow !== 'daily_plan') {
    return '<p class="muted">还没有今日 plan。在 Chat 里发 <code>daily-os plan</code>，或等定时任务生成。</p>';
  }
  const todos = safe(() => extractDailyPlanTodos(latest.content), []);
  if (todos.length === 0) {
    return '<p class="muted">最近一次 plan 没有解析出待办条目。</p>';
  }
  const today = safe(() => todayInTimezone(config), '');
  const staleNote =
    latest.date && today && latest.date !== today
      ? `<p class="muted small">来自 ${escapeHtml(latest.date)} 的 plan（今天还没跑）。</p>`
      : '';
  // Latest feedback per candidateId for today, so the card reflects what the
  // user already ticked (the evening daily_review reconciles the same ledger).
  const feedbackState = new Map<string, string>();
  for (const entry of safe(() => listTodoFeedback(config), [])) {
    if (entry.date !== today) continue;
    if (entry.event === 'complete' || entry.event === 'defer' || entry.event === 'update') {
      feedbackState.set(entry.candidateId, entry.event);
    }
  }
  const workspace = config.sources.linear.workspace;
  const resendRow = `<div class="plan-toolbar"><button type="button" class="secondary compact" data-post="/api/today/resend">发飞书</button></div>`;
  const rows = todos
    .map((todo) => {
      const state = todo.candidateId ? feedbackState.get(todo.candidateId) : undefined;
      const stateLabel = state === 'complete' ? 'done' : state === 'defer' ? 'deferred' : state === 'update' ? 'updated' : '';
      const issueId = todo.candidateId.startsWith('linear:') ? todo.candidateId.slice('linear:'.length) : '';
      const tag = issueId
        ? `<a class="tag tag-link" href="${escapeHtml(linearIssueUrl(issueId, workspace))}" target="_blank" rel="noopener">${escapeHtml(issueId)}</a>`
        : todo.candidateId
          ? `<span class="tag">${escapeHtml(todo.candidateId)}</span>`
          : '';
      const actions = todo.candidateId
        ? `<div class="todo-actions plan-actions">
            <button type="button" class="secondary" data-post="/api/today/todo-feedback" data-note-prompt="记录一条更新（可留空）" data-payload='${payload({ candidateId: todo.candidateId, rank: todo.rank, event: 'update' })}'>更新</button>
            <button type="button" class="secondary" data-post="/api/today/todo-feedback" data-payload='${payload({ candidateId: todo.candidateId, rank: todo.rank, event: 'defer' })}'>延期</button>
            <button type="button" data-post="/api/today/todo-feedback" data-payload='${payload({ candidateId: todo.candidateId, rank: todo.rank, event: 'complete' })}'>完成</button>
          </div>`
        : '';
      return `<li class="todo-item${state === 'complete' ? ' state-checked' : ''}">
        <div class="todo-text"><span class="plan-rank">${todo.rank}</span> ${escapeHtml(todo.text)}</div>
        <div class="todo-meta">${tag}${stateLabel ? `<span class="muted small">${stateLabel}</span>` : ''}</div>
        ${actions}
      </li>`;
    })
    .join('');
  return `${resendRow}${staleNote}<ul class="todo-list">${rows}</ul>`;
}

/** My todos — the user's own quick captures, with add / done / defer / delete. */
function renderMyTodoColumn(ctx: PageContext): string {
  const { config } = ctx;
  // Retire anything past the retention window before reading the history lists.
  safe(() => purgeExpiredTodoInboxHistory(config), 0);
  const open = safe(() => openTodoInboxItems(config), []);
  const done = safe(() => listTodoInboxHistory(config, 'done'), []);
  const deferred = safe(() => listTodoInboxHistory(config, 'deferred'), []);
  const captureForm = `
    <form class="inline-form todo-capture" data-post="/api/capture">
      <input name="text" placeholder="记一条 todo…" autocomplete="off" required />
      <button type="submit">Add</button>
    </form>`;
  const openList =
    open.length === 0
      ? '<p class="muted">还没有记录。</p>'
      : `<ul class="todo-list">${open
          .map(
            (item) => `<li class="todo-item">
        <div class="todo-text">${escapeHtml(item.text)}</div>
        <div class="todo-meta"><span class="tag">${escapeHtml(item.type)}</span><span class="muted small">open</span></div>
        <div class="todo-actions">
          <button type="button" data-post="/api/today/todo-feedback" data-payload='${payload({ id: item.id, action: 'check' })}'>Done</button>
          <button type="button" class="secondary" data-post="/api/today/todo-feedback" data-payload='${payload({ id: item.id, action: 'defer' })}'>Defer</button>
          <button type="button" class="secondary" data-post="/api/todo-inbox" data-payload='${payload({ id: item.id, status: 'deleted' })}'>Delete</button>
        </div>
      </li>`,
          )
          .join('')}</ul>`;
  return `${captureForm}${openList}${renderTodoHistorySection('History', 'done', done)}${renderTodoHistorySection('Deferred', 'deferred', deferred)}`;
}

/**
 * A collapsed History / Deferred list: the last month of done (or deferred) todos,
 * each restorable back to open or deletable outright. Anything older than the
 * retention window has already been retired before this renders.
 */
function renderTodoHistorySection(label: string, state: 'done' | 'deferred', items: TodoInboxItem[]): string {
  const rows =
    items.length === 0
      ? `<p class="muted small">最近 ${TODO_HISTORY_RETENTION_DAYS} 天没有${state === 'done' ? '完成' : '延期'}的 todo。</p>`
      : `<ul class="todo-list">${items
          .map(
            (item) => `<li class="todo-item state-${state === 'done' ? 'checked' : 'deferred'}">
        <div class="todo-text">${escapeHtml(item.text)}</div>
        <div class="todo-meta"><span class="tag">${escapeHtml(item.type)}</span><span class="muted small">${escapeHtml(formatTodoHistoryDate(item.updated_at || item.created_at))}</span></div>
        <div class="todo-actions">
          <button type="button" data-post="/api/todo-inbox" data-payload='${payload({ id: item.id, status: 'open' })}'>Restore</button>
          <button type="button" class="secondary" data-post="/api/todo-inbox" data-payload='${payload({ id: item.id, status: 'deleted' })}'>Delete</button>
        </div>
      </li>`,
          )
          .join('')}</ul>`;
  return `<details class="todo-history"><summary>${escapeHtml(label)} <span class="muted small">${items.length} · 最近 ${TODO_HISTORY_RETENTION_DAYS} 天</span></summary>${rows}</details>`;
}

/** `2026-08-04 14:30` — enough to tell two same-day entries apart, no timezone noise. */
function formatTodoHistoryDate(value: string): string {
  const ts = Date.parse(value);
  if (Number.isNaN(ts)) return value;
  const date = new Date(ts);
  const pad = (input: number): string => String(input).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// --- okr --------------------------------------------------------------------

/**
 * Read-only view of the two long-horizon OKR files, side by side. The files are
 * edited in Config → OKR; this page only parses and renders them, so every
 * failure mode (missing file, unparseable body, objective without KRs) has to
 * degrade into a message rather than a blank column.
 */
function renderOkrPage(ctx: PageContext): string {
  const okr = safe(() => readOkrSnapshot(ctx.config.memory.repository_path), null);
  if (!okr) {
    return `<section class="card">
      <h2>OKR</h2>
      <p class="muted">读不到 OKR 目录。检查 config 里的 <code>memory.repository_path</code>，或到 <a href="/console#okr">Config → OKR</a> 填写。</p>
    </section>`;
  }
  return `
  <div class="two-col">
    ${renderOkrPanel('5 年 North Star', 'north-star-okr.md', okr.northStar)}
    ${renderOkrPanel('年度 Annual', 'annual-okr.md', okr.annual)}
  </div>
  <p class="muted small">来源目录 <code>${escapeHtml(okr.dir)}</code> · 只读视图，编辑请到 <a href="/console#okr">Config → OKR</a>。</p>`;
}

function renderOkrPanel(label: string, fileName: string, file: OkrFile): string {
  const head = `<div class="card-head"><h2>${escapeHtml(label)}</h2><span class="tag">${escapeHtml(fileName)}</span></div>`;
  if (!file.exists) {
    return `<section class="card col">${head}
      <p class="muted">还没有 <code>${escapeHtml(fileName)}</code>。到 <a href="/console#okr">Config → OKR</a> 写入后这里会显示。</p>
    </section>`;
  }
  const meta = [
    file.frontmatter.cycle ? `周期 ${file.frontmatter.cycle}` : '',
    file.frontmatter.status ? `状态 ${file.frontmatter.status}` : '',
    file.frontmatter.updated ? `更新于 ${file.frontmatter.updated}` : '',
  ].filter(Boolean);
  const krCount = file.objectives.reduce((sum, obj) => sum + obj.keyResults.length, 0);
  const summary = `${file.objectives.length} 个 Objective · ${krCount} 个 KR`;
  const body =
    file.objectives.length === 0
      ? `<p class="muted">这个文件里没有解析出 Objective。需要 <code>## Objective &lt;id&gt;: &lt;title&gt;</code> 标题，以及 <code>KR ID | Description | Target | Current | Progress | Updated</code> 这张表。</p>`
      : file.objectives.map(renderOkrObjective).join('');
  return `<section class="card col">${head}
    <p class="muted small">${escapeHtml([summary, ...meta].join(' · '))}</p>
    ${body}
  </section>`;
}

/**
 * `Parent: none` is how the top-level files spell "nothing above this". Both
 * north-star-okr.md and annual-okr.md use it on every objective, so rendering it
 * verbatim puts a meaningless `↦ none` tag on every heading of this page.
 */
function okrParentLabel(parent: string | undefined): string {
  const value = String(parent ?? '').trim();
  return /^(none|n\/a|-|—)$/i.test(value) ? '' : value;
}

/**
 * Target/Current are blank for most KRs in the long-horizon files — the numbers
 * only get filled in on the quarterly file. Emitting the row anyway would put
 * `目标 — · 当前 —` under every single KR, so drop it when there is nothing in it.
 */
function renderKrMeta(kr: OkrObjective['keyResults'][number]): string {
  const placeholder = (value: string) => (/^(-|—|n\/a)?$/i.test(String(value ?? '').trim()) ? '' : String(value).trim());
  const parts = [
    placeholder(kr.target) && `目标 ${escapeHtml(placeholder(kr.target))}`,
    placeholder(kr.current) && `当前 ${escapeHtml(placeholder(kr.current))}`,
    placeholder(kr.updated) && escapeHtml(placeholder(kr.updated)),
  ].filter(Boolean);
  return parts.length ? `<div class="kr-meta muted small">${parts.join(' · ')}</div>` : '';
}

function renderOkrObjective(obj: OkrObjective): string {
  const parent = okrParentLabel(obj.parent);
  const krs = obj.keyResults.length
    ? obj.keyResults
        .map(
          (kr) => `<li>
            <div class="kr-head"><span class="kr-id">${escapeHtml(kr.id)}</span><span class="kr-prog">${kr.progress === null ? '—' : `${kr.progress}%`}</span></div>
            <div class="kr-desc">${escapeHtml(kr.description)}</div>
            <div class="bar"><span style="width:${kr.progress ?? 0}%"></span></div>
            ${renderKrMeta(kr)}
          </li>`,
        )
        .join('')
    : '<li class="muted">这个 Objective 下还没有 KR。</li>';
  return `<div class="objective">
    <h3>${escapeHtml(obj.id)}: ${escapeHtml(obj.title)}${parent ? ` <span class="tag">↦ ${escapeHtml(parent)}</span>` : ''}</h3>
    <ul class="kr-list">${krs}</ul>
  </div>`;
}

// --- chat (LEO-236) ---------------------------------------------------------

function renderChat(ctx: PageContext): string {
  const agentEnabled = ctx.config.interaction.feishu.agent_mode.enabled;
  const roleHint =
    ctx.role === 'admin'
      ? 'Admin: full command surface + free-form assistant.'
      : 'Member: whitelisted commands only (plan / review / weekly / progress / todo).';
  const agentHint = agentEnabled
    ? ''
    : '<p class="muted small">Free-form assistant (agent mode) is disabled in config; command shortcuts still work.</p>';
  return `
  <script>window.__LINEAR_WS__=${JSON.stringify(ctx.config.sources.linear.workspace)};</script>
  <section class="chat-wrap" data-role="${escapeHtml(ctx.role)}">
    <aside class="chat-sessions card">
      <div class="card-head"><h2>Chats</h2><button type="button" id="chat-new">New</button></div>
      <ul class="chat-session-list" id="chat-session-list"><li class="muted small">Loading…</li></ul>
    </aside>
    <div class="chat-main card">
      <div class="chat-head">
        <div><h2 id="chat-title">Console assistant</h2><p class="muted small">${escapeHtml(roleHint)}</p>
        <ul class="muted small chat-hint-list">
          <li><code>plan</code> — 生成今日安排（可追加说明：<code>plan：今天优先做X</code>）</li>
          <li><code>review</code> — 生成今日复盘 · <code>weekly</code> — 周复盘</li>
          <li><code>biweekly</code> — 双周复盘（可追加：<code>biweekly：本期上下文</code>）</li>
          <li>复盘后写回飞书周表：<code>写回预览</code> 先看内容 → <code>确认写回</code> 才写入</li>
          <li>复盘后写回本地 OKR 进度：<code>okr writeback</code> 先看增量 → <code>确认写回 okr</code> 才写入</li>
        </ul></div>
        <a class="top-link" href="/console#guide">使用指南</a>
      </div>
      ${agentHint}
      <div class="chat-stream" id="chat-stream"><p class="muted small">Start a new chat or pick one on the left.</p></div>
      <form class="chat-composer" id="chat-composer">
        <textarea id="chat-input" rows="2" placeholder="直接发关键词：plan / review / weekly / progress / status，或 daily-os 记到 todo：…" autocomplete="off"></textarea>
        <div class="chat-composer-actions">
          <button type="submit" id="chat-send">Send</button>
          <button type="button" id="chat-stop" class="danger" hidden>Stop</button>
        </div>
      </form>
    </div>
  </section>
  <script>${CHAT_JS}</script>`;
}

const CHAT_JS = String.raw`
(function(){
  var sessionId=null;
  var sending=false;
  var controller=null;
  var list=document.getElementById('chat-session-list');
  var stream=document.getElementById('chat-stream');
  var input=document.getElementById('chat-input');
  var form=document.getElementById('chat-composer');
  var sendBtn=document.getElementById('chat-send');
  var stopBtn=document.getElementById('chat-stop');
  var newBtn=document.getElementById('chat-new');
  function esc(s){var d=document.createElement('div');d.textContent=s==null?'':String(s);return d.innerHTML;}
  var LINEAR_WS=window.__LINEAR_WS__||'';
  function linkify(html){
    if(!LINEAR_WS)return html;
    return html.replace(/\b([A-Z][A-Z0-9]{1,9}-\d+)\b/g,function(m,id){
      return '<a href="https://linear.app/'+encodeURIComponent(LINEAR_WS)+'/issue/'+id+'" target="_blank" rel="noopener">'+id+'</a>';
    });
  }
  function api(url,opts){return fetch(url,Object.assign({credentials:'same-origin'},opts||{}));}
  function bubble(role,text){
    var el=document.createElement('div');
    el.className='chat-msg role-'+role;
    el.innerHTML='<span class="who">'+esc(role)+'</span><div class="body">'+linkify(esc(text))+'</div>';
    stream.appendChild(el);stream.scrollTop=stream.scrollHeight;
    return el.querySelector('.body');
  }
  function clearStream(){stream.innerHTML='';}
  function loadSessions(){
    return api('/api/chat/sessions').then(function(r){return r.json();}).then(function(d){
      var items=(d&&d.sessions)||[];
      if(!items.length){list.innerHTML='<li class="muted small">No chats yet.</li>';return;}
      list.innerHTML=items.map(function(s){
        return '<li class="chat-session'+(s.id===sessionId?' active':'')+'" data-id="'+esc(s.id)+'">'+
          '<span class="s-title">'+esc(s.title)+'</span>'+
          '<span class="muted small">'+esc(s.messages)+' msg</span>'+
          '<button type="button" class="chat-session-delete" data-del="'+esc(s.id)+'" title="Delete chat">×</button></li>';
      }).join('');
    });
  }
  function deleteSession(id){
    if(!window.confirm('删除这个会话？'))return;
    api('/api/chat/session/delete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({session:id})})
      .then(function(){
        if(id===sessionId){sessionId=null;stream.innerHTML='<p class="muted small">Start a new chat or pick one on the left.</p>';}
        return loadSessions();
      });
  }
  function openSession(id){
    sessionId=id;
    Array.prototype.forEach.call(list.querySelectorAll('.chat-session'),function(li){
      li.classList.toggle('active',li.getAttribute('data-id')===id);
    });
    clearStream();
    return api('/api/chat/messages?session='+encodeURIComponent(id)).then(function(r){return r.json();}).then(function(d){
      var msgs=(d&&d.messages)||[];
      if(!msgs.length){bubble('system','Empty chat. Say hello or run a command.');return;}
      msgs.forEach(function(m){bubble(m.role,m.content);});
    });
  }
  function setSending(on){
    sending=on;sendBtn.disabled=on;input.disabled=on;stopBtn.hidden=!on;
  }
  function send(text){
    bubble('user',text);
    var target=bubble('assistant','');
    var statusEl=document.createElement('div');statusEl.className='chat-status muted small';target.parentNode.appendChild(statusEl);
    var acc='';
    setSending(true);
    controller=new AbortController();
    api('/api/chat/send',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({session:sessionId,text:text}),signal:controller.signal})
      .then(function(res){
        var resolvedSession=res.headers.get('x-chat-session-id');
        if(resolvedSession){sessionId=resolvedSession;}
        if(res.status===403){return res.json().then(function(d){target.textContent='拒绝：'+((d&&d.error)||'permission denied');throw 'handled';});}
        if(!res.body){return res.text().then(function(t){target.textContent=t;});}
        var reader=res.body.getReader();var dec=new TextDecoder();var buf='';
        function pump(){return reader.read().then(function(res){
          if(res.done){return;}
          buf+=dec.decode(res.value,{stream:true});
          var parts=buf.split('\n\n');buf=parts.pop();
          parts.forEach(function(chunk){
            var line=chunk.split('\n').filter(function(l){return l.indexOf('data:')===0;}).map(function(l){return l.slice(5);}).join('');
            if(!line)return;var ev;try{ev=JSON.parse(line);}catch(e){return;}
            if(ev.type==='status'){statusEl.textContent=ev.message;}
            else if(ev.type==='reply'){acc+=(acc?'\n\n':'')+ev.content;target.innerHTML=linkify(esc(acc));}
            else if(ev.type==='denied'){acc=ev.message;target.textContent=ev.message;}
            else if(ev.type==='error'){acc=ev.message;target.textContent='错误：'+ev.message;}
            else if(ev.type==='stopped'){statusEl.textContent='已停止。';}
            stream.scrollTop=stream.scrollHeight;
          });
          return pump();
        });}
        return pump();
      })
      .then(function(){statusEl.remove();})
      .catch(function(e){if(e!=='handled'){if(controller&&controller.signal.aborted){statusEl.textContent='已停止。';}else{target.textContent='连接中断：'+String(e);}}})
      .then(function(){setSending(false);controller=null;loadSessions();});
  }
  form.addEventListener('submit',function(ev){ev.preventDefault();if(sending)return;var t=input.value.trim();if(!t)return;input.value='';send(t);});
  // An IME sends Enter to accept the highlighted candidate. Without the
  // composing guard that keypress submitted a half-typed message — hitting
  // anyone typing Chinese, every time they picked a candidate. isComposing is
  // the standard signal; keyCode 229 is the older browsers equivalent, and the
  // composing flag covers the gap between compositionstart and the first keydown.
  // (No backticks in here: this block lives inside a JS template literal.)
  var composing=false;
  input.addEventListener('compositionstart',function(){composing=true;});
  input.addEventListener('compositionend',function(){composing=false;});
  input.addEventListener('keydown',function(ev){
    if(ev.key!=='Enter'||ev.shiftKey)return;
    if(composing||ev.isComposing||ev.keyCode===229)return;
    ev.preventDefault();
    form.dispatchEvent(new Event('submit',{cancelable:true}));
  });
  stopBtn.addEventListener('click',function(){
    if(controller)controller.abort();
    if(sessionId)api('/api/chat/stop',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({session:sessionId})});
  });
  newBtn.addEventListener('click',function(){
    api('/api/chat/session',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})
      .then(function(r){return r.json();}).then(function(d){if(d&&d.session){return loadSessions().then(function(){return openSession(d.session.id);});}});
  });
  list.addEventListener('click',function(ev){
    var del=ev.target.closest('.chat-session-delete');
    if(del){ev.stopPropagation();deleteSession(del.getAttribute('data-del'));return;}
    var li=ev.target.closest('.chat-session');if(li)openSession(li.getAttribute('data-id'));
  });
  loadSessions().then(function(){
    var first=list.querySelector('.chat-session');
    if(first){openSession(first.getAttribute('data-id'));}
  });
})();
`;

// --- cycles (LEO-286) -------------------------------------------------------

/**
 * The Cycles page: my own cycles on the left, one selected cycle rendered as
 * three cards on the right.
 *
 * It used to be a section of the config console. It is not configuration — it is
 * the place the user reads and writes their own biweekly priorities, retro and
 * review — so it lives here, next to Today, with the same top nav as every other
 * platform page.
 *
 * The markup below is the full, static skeleton: the three cards, the read-only
 * banner, the frontmatter warning and the zoom dialog all exist in the DOM from
 * the first byte, and the client script only fills them in. That is deliberate:
 * "a teammate's card has no save control" is then an assertable property of real
 * elements (`hidden` / `disabled`) rather than of a string of generated HTML.
 */
function renderCyclesPage(ctx: PageContext): string {
  // Pulling teammates is a write against the remote and is admin-only server
  // side; offering a button that always 403s to members would be a lie.
  const syncButton =
    ctx.role === 'admin'
      ? '<button type="button" class="secondary compact" id="cycles-team-sync">同步队友</button>'
      : '';
  const cards = [
    { key: 'priorities', title: '要务', placeholder: '- **MIT** 这个周期最重要的一件事', save: '保存要务' },
    { key: 'retro', title: 'retro', placeholder: '这个周期实际发生了什么、哪里没做到', save: '保存 retro' },
    { key: 'review', title: 'review', placeholder: '对这个周期的评价与下一步建议', save: '保存 review' },
  ]
    .map(
      (card) => `
      <section class="card cycle-card" id="cycle-card-${card.key}" aria-labelledby="cycle-title-${card.key}">
        <div class="card-head">
          <div>
            <h3 id="cycle-title-${card.key}">${escapeHtml(card.title)}</h3>
            <p class="muted small" id="cycle-meta-${card.key}"></p>
          </div>
          <button type="button" class="secondary compact" data-cycle-zoom="${card.key}" id="cycle-zoom-${card.key}">放大</button>
        </div>
        <textarea id="cycle-md-${card.key}" spellcheck="false" placeholder="${escapeHtml(card.placeholder)}"></textarea>
        <div class="cycle-card-actions" id="cycle-actions-${card.key}">
          <button type="button" id="cycle-save-${card.key}" data-cycle-save="${card.key}">${escapeHtml(card.save)}</button>
        </div>
        <p class="muted small" id="cycle-status-${card.key}"></p>
      </section>`,
    )
    .join('');

  return `
  <section class="cycles-wrap">
    <aside class="cycles-side">
      <section class="card">
        <div class="card-head"><h2>我的周期</h2><button type="button" class="secondary compact" id="cycles-refresh">Refresh</button></div>
        <p class="muted small mono" id="cycles-dir"></p>
        <div class="cycle-list" id="cycle-list"></div>
        <p class="muted small" id="cycles-empty" hidden>还没有任何周期文件。跑一次双周复盘（<code>npm run weekly</code>）之后，周期目录里会出现 <code>&lt;开始日期&gt;_&lt;周期标签&gt;.md</code>，例如 <code>2026-08-24_8.24-9.6.md</code>。也可以先手动建一个同名文件，再点 Refresh。</p>
      </section>
      <section class="card">
        <div class="card-head"><h2>团队成员</h2>${syncButton}</div>
        <div class="cycle-list" id="cycle-members"></div>
        <p class="muted small" id="cycle-team-status"></p>
      </section>
    </aside>
    <div class="cycles-main">
      <section class="card">
        <div class="card-head">
          <div><h2 id="cycle-heading">周期</h2><p class="muted small" id="cycle-subheading"></p></div>
        </div>
        <p class="muted small mono" id="cycle-file-path"></p>
        <div class="cycle-readonly" id="cycle-readonly" role="status" hidden></div>
        <div class="cycle-warning" id="cycle-frontmatter-error" role="alert" hidden></div>
      </section>
      <div class="cycle-cards" id="cycle-cards">${cards}</div>
      <p class="muted" id="cycle-detail-empty" hidden>左边挑一个周期，或者点一位队友看他们最新的周期。</p>
    </div>
  </section>
  <div class="cycle-modal" id="cycle-modal" role="dialog" aria-modal="true" aria-labelledby="cycle-modal-title" hidden>
    <div class="cycle-modal-card">
      <div class="card-head">
        <div><h3 id="cycle-modal-title"></h3><p class="muted small" id="cycle-modal-meta"></p></div>
        <button type="button" class="secondary compact" id="cycle-modal-close">关闭 (Esc)</button>
      </div>
      <textarea id="cycle-modal-text" spellcheck="false"></textarea>
      <div class="cycle-card-actions" id="cycle-modal-actions">
        <button type="button" id="cycle-modal-save">保存</button>
      </div>
      <p class="muted small" id="cycle-modal-status"></p>
    </div>
  </div>
  <script>${CYCLES_JS}</script>`;
}

/**
 * Client script for /cycles. Top-level (not an IIFE) on purpose: the regression
 * suite evaluates this exact string against a DOM stub, which is the only way to
 * prove that a teammate's card really has no reachable save control.
 * `CONSOLE_JS` keeps its own scope, so nothing here collides with it.
 */
export const CYCLES_JS = String.raw`
// Slug <-> markdown heading. '要务' is a poor element id, so the page keys
// everything by slug and maps back at the API boundary.
var CYCLE_SECTION_KEYS = [['priorities', '要务'], ['retro', 'retro'], ['review', 'review']];
// The writing prompts, kept here as well as in the markup: a teammate's empty
// section must not tell me what to write in it.
var CYCLE_PLACEHOLDERS = {
  priorities: '- **MIT** 这个周期最重要的一件事',
  retro: '这个周期实际发生了什么、哪里没做到',
  review: '对这个周期的评价与下一步建议',
};
var cyclesData = { cycles: { dir: '', items: [] }, team: null };
// Unsaved typing, keyed by cycle id + section slug. Re-filling a section someone
// is halfway through writing would eat a hand-written retro — the one thing this
// page must never do. Keying by cycle rather than by section alone extends that
// to switching cycles: click another one and come back, and the draft is still
// there. Only Refresh discards.
var cycleDrafts = new Map();
var selectedCycleId = '';
// Whose cycles the page shows: '' is me, otherwise a teammate's owner uuid.
// Uuid, never member_id — the label is renameable and the cache is not filed
// under it.
var selectedOwnerId = '';
// Selected cycle per owner, so switching to a teammate and back lands on the
// cycle you were reading — and, because drafts are keyed by cycle id, on your
// unsaved text as well.
var selectedCycleByOwner = new Map();
var cycleModalKey = '';
var cycleModalReturn = null;

function cycleEl(id) { return document.getElementById(id); }
function cycleSetText(id, text) { var el = cycleEl(id); if (el) el.textContent = text; }
function cycleSetValue(id, text) { var el = cycleEl(id); if (el) el.value = text == null ? '' : text; }
function cycleValue(id) { var el = cycleEl(id); return el ? el.value : ''; }
function cycleEscapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function cycleTime(value) {
  var date = new Date(value);
  return isNaN(date.getTime()) ? (value || '') : date.toLocaleString();
}
function cycleSectionName(key) {
  for (var i = 0; i < CYCLE_SECTION_KEYS.length; i += 1) if (CYCLE_SECTION_KEYS[i][0] === key) return CYCLE_SECTION_KEYS[i][1];
  return '';
}
function cycleToast(message) {
  var el = cycleEl('toast');
  if (!el) return;
  el.textContent = message;
  el.hidden = false;
  setTimeout(function () { el.hidden = true; }, 2600);
}

/** Newest start date first; ties fall back to the id, which starts with it. */
function sortCycles(items) {
  return (items || []).slice().sort(function (left, right) {
    var a = (left && left.startDate) || '';
    var b = (right && right.startDate) || '';
    if (a !== b) return a < b ? 1 : -1;
    var la = (left && left.id) || '';
    var lb = (right && right.id) || '';
    return la < lb ? 1 : la > lb ? -1 : 0;
  });
}

function cycleMemberById(ownerId) {
  var members = (cyclesData.team && cyclesData.team.members) || [];
  for (var i = 0; i < members.length; i += 1) if (members[i].userId === ownerId) return members[i];
  return null;
}

function loadCycles() {
  return fetch('/api/cycles/state', { credentials: 'same-origin' })
    .then(function (r) { return r.json(); })
    .then(function (d) {
      if (!d || d.ok === false) throw new Error((d && d.error) || 'failed');
      cyclesData = { cycles: d.cycles || { dir: '', items: [] }, team: d.team || null };
      renderCyclesPage();
    })
    .catch(function (error) { cycleSetText('cycle-team-status', '读取周期失败：' + String(error)); });
}

function renderCyclesPage() {
  var team = cyclesData.team;
  renderCycleMembers(team);
  renderCycleTeamStatus(team);

  // A teammate who is no longer in the state (signed out, cache cleared, team
  // changed) falls back to my own cycles instead of rendering a blank page.
  var member = selectedOwnerId ? cycleMemberById(selectedOwnerId) : null;
  if (selectedOwnerId && !member) { selectedOwnerId = ''; member = null; }
  var viewingSelf = !selectedOwnerId;

  var mine = sortCycles((cyclesData.cycles && cyclesData.cycles.items) || []);
  // A teammate view is their *latest* cycle only: it answers "what are they on
  // right now", and their older files are not mine to browse through here.
  var items = viewingSelf ? mine : sortCycles(member.cycles || []).slice(0, 1);

  var dir = cyclesData.cycles && cyclesData.cycles.dir;
  cycleSetText('cycles-dir', viewingSelf ? (dir ? '周期目录：' + dir : '') : '');
  var emptyMine = cycleEl('cycles-empty');
  if (emptyMine) emptyMine.hidden = mine.length > 0;

  var cards = cycleEl('cycle-cards');
  var detailEmpty = cycleEl('cycle-detail-empty');
  if (items.length === 0) {
    selectedCycleId = '';
    if (cards) cards.hidden = true;
    if (detailEmpty) {
      detailEmpty.hidden = false;
      detailEmpty.textContent = viewingSelf
        ? '还没有周期文件可以显示。'
        : '还没有同步到 ' + ((member && member.label) || '这位队友') + ' 的周期。'
          + (team && team.syncedAt
            ? '上次同步于 ' + cycleTime(team.syncedAt) + '，那时对方还没有写过任何周期文件。'
            : '还没有成功同步过。确认双方都已登录同一个团队，再点「同步队友」。');
    }
    cycleSetText('cycle-heading', viewingSelf ? '周期' : ((member && member.label) || '队友'));
    cycleSetText('cycle-subheading', '');
    cycleSetText('cycle-file-path', '');
    var banner = cycleEl('cycle-readonly');
    if (banner) { banner.hidden = viewingSelf; banner.textContent = viewingSelf ? '' : '只读'; }
    var warn = cycleEl('cycle-frontmatter-error');
    if (warn) warn.hidden = true;
    renderCycleList(mine, viewingSelf);
    closeCycleModal();
    return;
  }
  if (cards) cards.hidden = false;
  if (detailEmpty) detailEmpty.hidden = true;

  // Newest cycle by default, and keep the current pick across re-renders.
  var picked = null;
  for (var i = 0; i < items.length; i += 1) if (items[i].id === selectedCycleId) picked = items[i];
  if (!picked) { picked = items[0]; selectedCycleId = picked.id; }
  selectedCycleByOwner.set(selectedOwnerId, selectedCycleId);
  renderCycleList(mine, viewingSelf);
  renderCycleDetail(picked, member, team);
}

function renderCycleList(items, viewingSelf) {
  var list = cycleEl('cycle-list');
  if (!list) return;
  list.innerHTML = items.map(function (item) {
    var active = viewingSelf && item.id === selectedCycleId;
    var broken = item.frontmatterError ? '<span class="cycle-item-broken">frontmatter 解析失败</span>' : '';
    var updated = item.updatedAt ? '更新于 ' + cycleTime(item.updatedAt) : '未记录更新时间';
    return '<button type="button" class="cycle-item' + (active ? ' active' : '') + '"' +
      ' data-cycle-id="' + cycleEscapeHtml(item.id) + '"' + (active ? ' aria-current="true"' : '') + '>' +
      '<strong>' + cycleEscapeHtml(item.cycle || item.id) + '</strong>' +
      '<span>' + cycleEscapeHtml(item.startDate + ' · ' + (item.mode || '')) + '</span>' +
      '<span>' + cycleEscapeHtml(updated) + '</span>' + broken +
      '</button>';
  }).join('');
}

function renderCycleMembers(team) {
  var box = cycleEl('cycle-members');
  if (!box) return;
  var members = (team && team.members) || [];
  var ready = Boolean(team && team.status === 'ready' && members.length > 0);
  if (!ready) {
    selectedOwnerId = '';
    box.innerHTML = '<p class="muted small">还没有队友的周期可以看。</p>';
    return;
  }
  var selfLabel = (team.self && (team.self.displayName || team.self.memberId)) || '';
  var html = '<button type="button" class="cycle-item cycle-member' + (selectedOwnerId ? '' : ' active') + '" data-owner-id="">' +
    '<strong>' + cycleEscapeHtml(selfLabel ? '我（' + selfLabel + '）' : '我') + '</strong>' +
    '<span>本地 20_CYCLES</span></button>';
  members.forEach(function (member) {
    var cycles = member.cycles || [];
    var latest = sortCycles(cycles)[0];
    html += '<button type="button" class="cycle-item cycle-member' + (member.userId === selectedOwnerId ? ' active' : '') + '"' +
      ' data-owner-id="' + cycleEscapeHtml(member.userId) + '">' +
      '<strong>' + cycleEscapeHtml(member.label || member.userId) + '</strong>' +
      '<span>' + cycleEscapeHtml(latest ? '最新 ' + (latest.cycle || latest.id) : '还没有同步到周期') + '</span>' +
      '<span>只读</span></button>';
  });
  box.innerHTML = html;
}

function renderCycleTeamStatus(team) {
  var line = cycleEl('cycle-team-status');
  if (!line) return;
  if (!team) { line.textContent = ''; return; }
  // Not-ready is a normal state, not a failure: local editing is unaffected, so
  // say what is off rather than showing an error.
  if (team.status !== 'ready') { line.textContent = '团队同步：' + (team.reason || '未启用'); return; }
  var parts = [team.syncedAt ? '同步于 ' + cycleTime(team.syncedAt) : '还没有成功同步过'];
  if (!(team.members || []).length) parts.push('团队里还没有其他成员');
  if (team.lastError) parts.push('上次同步失败：' + team.lastError);
  line.textContent = '团队同步：' + parts.join(' · ');
}

function renderCycleDetail(item, member, team) {
  if (!item) return;
  var readOnly = Boolean(member);
  cycleSetText('cycle-heading', (item.cycle || item.id) + (readOnly ? ' · ' + ((member && member.label) || '队友') : ''));
  cycleSetText('cycle-subheading', item.startDate + ' 开始 · ' + (item.mode || '') + (item.updatedAt ? ' · 更新于 ' + cycleTime(item.updatedAt) : ''));
  // Where the bytes on screen actually came from: my vault, or the read-only
  // teammate cache. Never nothing — "whose file is this" is the question the
  // page has to keep answering.
  cycleSetText('cycle-file-path', readOnly
    ? (team && team.cacheDir ? '只读缓存：' + team.cacheDir + '/' + selectedOwnerId : '')
    : (item.path || ''));

  var banner = cycleEl('cycle-readonly');
  if (banner) {
    banner.hidden = !readOnly;
    banner.textContent = readOnly
      ? '来自 ' + ((member && member.label) || '队友') + ' · 只读 · ' +
        (team && team.syncedAt ? '同步于 ' + cycleTime(team.syncedAt) : '同步时间未知')
      : '';
  }

  // A file whose frontmatter will not parse is read-only here: the write path
  // refuses it, so letting someone type a full retro first would just lose it.
  var broken = Boolean(item.frontmatterError);
  var warning = cycleEl('cycle-frontmatter-error');
  if (warning) {
    warning.hidden = !broken;
    warning.textContent = broken
      ? 'frontmatter 无法解析（' + item.frontmatterError + '）。保存已禁用：写回会丢掉整段 frontmatter。请先用编辑器修好 ' + (item.path || '这个文件') + ' 里的 YAML，再回来点 Refresh。'
      : '';
  }

  CYCLE_SECTION_KEYS.forEach(function (pair) {
    var key = pair[0];
    var stored = item.sections ? item.sections[pair[1]] : null;
    var draftKey = item.id + '::' + key;
    // Drafts belong to my own files only, so a teammate view always shows what
    // was synced, never something I happened to have typed under the same id.
    if (!readOnly && cycleDrafts.has(draftKey)) cycleSetValue('cycle-md-' + key, cycleDrafts.get(draftKey));
    else cycleSetValue('cycle-md-' + key, stored ? stored.content || '' : '');
    // A missing key and an empty string mean different things: never written vs.
    // written and then cleared.
    cycleSetText('cycle-meta-' + key, stored
      ? '来源 ' + (stored.source || 'unknown') + ' · ' + (stored.updatedAt ? '更新于 ' + cycleTime(stored.updatedAt) : '未记录更新时间')
      : '这一段还没写过（文件里没有这个小节）');
    var textarea = cycleEl('cycle-md-' + key);
    // readonly rather than disabled for a teammate: the text still has to be
    // selectable and scrollable, it just cannot be changed.
    if (textarea) {
      textarea.disabled = broken;
      textarea.readOnly = readOnly;
      textarea.placeholder = readOnly ? '（这一段是空的）' : CYCLE_PLACEHOLDERS[key];
    }
    var button = cycleEl('cycle-save-' + key);
    if (button) button.disabled = broken || readOnly;
    // The whole action row goes away in a teammate view, so there is no save
    // control to click at all. The server rejects the write regardless.
    var actions = cycleEl('cycle-actions-' + key);
    if (actions) actions.hidden = readOnly;
  });
  if (cycleModalKey) syncCycleModal();
}

function selectCycle(id) {
  if (!id) return;
  // Clicking a cycle in "我的周期" is also the way back from a teammate view.
  if (selectedOwnerId) selectedOwnerId = '';
  else if (id === selectedCycleId) return;
  selectedCycleId = id;
  // Drafts survive the switch: they are keyed by cycle, and renderCycleDetail
  // restores this cycle's own. Only Refresh and a successful save clear them.
  clearCycleStatuses();
  renderCyclesPage();
}

function selectCycleOwner(ownerId) {
  var next = ownerId || '';
  if (next === selectedOwnerId) return;
  selectedOwnerId = next;
  selectedCycleId = selectedCycleByOwner.get(next) || '';
  clearCycleStatuses();
  closeCycleModal();
  renderCyclesPage();
}

function clearCycleStatuses() {
  CYCLE_SECTION_KEYS.forEach(function (pair) { cycleSetText('cycle-status-' + pair[0], ''); });
  cycleSetText('cycle-modal-status', '');
}

async function saveCycleSection(key) {
  var statusId = 'cycle-status-' + key;
  var section = cycleSectionName(key);
  if (selectedOwnerId) { cycleSetText(statusId, '队友的周期是只读的，不能在这里保存。'); return; }
  if (!selectedCycleId) { cycleSetText(statusId, '还没有选中任何周期。'); return; }
  cycleSetText(statusId, 'Saving...');
  var response = await fetch('/api/cycles/section', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: selectedCycleId, section: section, content: cycleValue('cycle-md-' + key) }),
  });
  var result = await response.json().catch(function () { return {}; });
  if (!response.ok || result.ok === false) throw new Error(result.error || ('Failed (' + response.status + ')'));
  cycleDrafts.delete(selectedCycleId + '::' + key);
  // The save endpoint answers with the full console state; take the cycles and
  // the team view out of it rather than paying for a second round trip.
  if (result.state) {
    cyclesData = {
      cycles: result.state.cycles || cyclesData.cycles,
      team: (result.state.team && result.state.team.view) || cyclesData.team,
    };
  }
  renderCyclesPage();
  cycleSetText(statusId, (result.savedAt ? cycleTime(result.savedAt) + ' · ' : '') + (result.text || 'Saved.'));
  cycleToast('已保存 ' + section);
}

async function runCycleSave(key) {
  try {
    await saveCycleSection(key);
  } catch (error) {
    var message = error && error.message ? error.message : String(error);
    cycleSetText('cycle-status-' + key, message);
    cycleSetText('cycle-modal-status', cycleModalKey === key ? message : '');
    cycleToast('保存失败：' + message);
  }
}

// --- zoom dialog -------------------------------------------------------------

/**
 * The card, full size. Editable when the cycle is mine and writable, plain
 * read-only text for a teammate — the modal mirrors the card's own state rather
 * than deciding for itself, so there is one rule for "can this be written".
 */
function openCycleModal(key) {
  var modal = cycleEl('cycle-modal');
  var textarea = cycleEl('cycle-md-' + key);
  if (!modal || !textarea) return;
  cycleModalKey = key;
  cycleModalReturn = cycleEl('cycle-zoom-' + key);
  modal.hidden = false;
  syncCycleModal();
  var target = textarea.readOnly || textarea.disabled ? cycleEl('cycle-modal-close') : cycleEl('cycle-modal-text');
  if (target && target.focus) target.focus();
}

/** Copy the card's content and state into the open dialog. */
function syncCycleModal() {
  var key = cycleModalKey;
  if (!key) return;
  var textarea = cycleEl('cycle-md-' + key);
  if (!textarea) return;
  cycleSetText('cycle-modal-title', cycleSectionName(key));
  var meta = cycleEl('cycle-meta-' + key);
  cycleSetText('cycle-modal-meta', meta ? meta.textContent : '');
  cycleSetValue('cycle-modal-text', textarea.value);
  var modalText = cycleEl('cycle-modal-text');
  if (modalText) { modalText.readOnly = textarea.readOnly; modalText.disabled = textarea.disabled; }
  var actions = cycleEl('cycle-modal-actions');
  if (actions) actions.hidden = Boolean(textarea.readOnly);
  var save = cycleEl('cycle-modal-save');
  if (save) { save.disabled = Boolean(textarea.readOnly || textarea.disabled); save.textContent = '保存' + cycleSectionName(key); }
}

function closeCycleModal() {
  var modal = cycleEl('cycle-modal');
  if (!modal || modal.hidden) { cycleModalKey = ''; return; }
  modal.hidden = true;
  cycleModalKey = '';
  cycleSetText('cycle-modal-status', '');
  // Focus goes back to the control that opened the dialog, not to the top of
  // the document.
  if (cycleModalReturn && cycleModalReturn.focus) cycleModalReturn.focus();
  cycleModalReturn = null;
}

/** Keep Tab inside the dialog: three stops, wrapped by hand. */
function cycleModalFocusables() {
  var stops = [cycleEl('cycle-modal-close'), cycleEl('cycle-modal-text'), cycleEl('cycle-modal-save')];
  return stops.filter(function (el) { return el && !el.hidden && !el.disabled && !(el.id === 'cycle-modal-save' && cycleEl('cycle-modal-actions') && cycleEl('cycle-modal-actions').hidden); });
}

function onCycleModalKeydown(event) {
  if (!cycleModalKey) return;
  if (event.key === 'Escape') { if (event.preventDefault) event.preventDefault(); closeCycleModal(); return; }
  if (event.key !== 'Tab') return;
  var stops = cycleModalFocusables();
  if (!stops.length) return;
  var index = stops.indexOf(document.activeElement);
  var next = event.shiftKey ? index - 1 : index + 1;
  if (index < 0) next = event.shiftKey ? stops.length - 1 : 0;
  else if (next < 0) next = stops.length - 1;
  else if (next >= stops.length) next = 0;
  else return;
  if (event.preventDefault) event.preventDefault();
  if (stops[next] && stops[next].focus) stops[next].focus();
}

// --- wiring ------------------------------------------------------------------

if (cycleEl('cycle-list')) cycleEl('cycle-list').addEventListener('click', function (event) {
  var item = event.target.closest ? event.target.closest('[data-cycle-id]') : null;
  if (item) selectCycle(item.dataset.cycleId);
});
if (cycleEl('cycle-members')) cycleEl('cycle-members').addEventListener('click', function (event) {
  var button = event.target.closest ? event.target.closest('[data-owner-id]') : null;
  if (button) selectCycleOwner(button.dataset.ownerId || '');
});
if (cycleEl('cycle-cards')) cycleEl('cycle-cards').addEventListener('click', function (event) {
  var zoom = event.target.closest ? event.target.closest('[data-cycle-zoom]') : null;
  if (zoom) { openCycleModal(zoom.dataset.cycleZoom); return; }
  var save = event.target.closest ? event.target.closest('[data-cycle-save]') : null;
  if (save) void runCycleSave(save.dataset.cycleSave);
});
CYCLE_SECTION_KEYS.forEach(function (pair) {
  var textarea = cycleEl('cycle-md-' + pair[0]);
  if (!textarea) return;
  textarea.addEventListener('input', function () {
    // Teammate views are read-only, so there is nothing to draft. It also keeps
    // the draft map single-owner: a teammate's cycle id can be identical to one
    // of mine, and two people's unsaved text under one key is a way to lose a
    // retro.
    if (selectedOwnerId || !selectedCycleId) return;
    cycleDrafts.set(selectedCycleId + '::' + pair[0], textarea.value);
    if (cycleModalKey === pair[0]) cycleSetValue('cycle-modal-text', textarea.value);
  });
});
if (cycleEl('cycle-modal-text')) cycleEl('cycle-modal-text').addEventListener('input', function () {
  if (!cycleModalKey) return;
  var textarea = cycleEl('cycle-md-' + cycleModalKey);
  if (!textarea || textarea.readOnly) return;
  textarea.value = cycleValue('cycle-modal-text');
  if (!selectedOwnerId && selectedCycleId) cycleDrafts.set(selectedCycleId + '::' + cycleModalKey, textarea.value);
});
if (cycleEl('cycle-modal-close')) cycleEl('cycle-modal-close').addEventListener('click', function () { closeCycleModal(); });
if (cycleEl('cycle-modal-save')) cycleEl('cycle-modal-save').addEventListener('click', function () { if (cycleModalKey) void runCycleSave(cycleModalKey); });
if (cycleEl('cycle-modal')) cycleEl('cycle-modal').addEventListener('click', function (event) {
  // Click the backdrop, not the card, to dismiss.
  if (event.target === cycleEl('cycle-modal')) closeCycleModal();
});
document.addEventListener('keydown', onCycleModalKeydown);
if (cycleEl('cycles-refresh')) cycleEl('cycles-refresh').addEventListener('click', function () {
  // Refresh is the explicit discard: drafts survive everything else.
  cycleDrafts.clear();
  clearCycleStatuses();
  void loadCycles().then(function () { cycleToast('已重新读取周期'); });
});
if (cycleEl('cycles-team-sync')) cycleEl('cycles-team-sync').addEventListener('click', function () {
  // Drafts are untouched: this pulls teammates' files, it does not reload mine.
  var button = cycleEl('cycles-team-sync');
  button.disabled = true;
  fetch('/api/team/sync', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    .then(function (r) { return r.json(); })
    .then(function (result) {
      var sync = (result && result.sync) || {};
      if (sync.status === 'ok') cycleToast('已同步：拉取 ' + (sync.pulled || 0) + ' 个队友周期，上传 ' + (sync.pushed || 0) + ' 个');
      else cycleToast('同步未执行：' + (sync.reason || sync.status || 'unknown'));
      return loadCycles();
    })
    .catch(function (error) { cycleToast('同步失败：' + String(error)); })
    .then(function () { button.disabled = false; });
});

void loadCycles();
`;

// --- schedules --------------------------------------------------------------

function renderSchedules(ctx: PageContext): string {
  const { config, role } = ctx;
  const schedule = workflowSchedule(config);
  const fired = readFiredKeys();
  const today = utcDay();
  const runs = safe(() => listRecentWorkflowRuns(config, 40), []);
  const locks = readSchedulerLocks();

  const rows = schedule
    .map((item) => {
      const key = `${today}:${item.workflow}:${item.time}`;
      const last = runs.find((run) => run.workflow === item.workflow);
      const plan = item.weekday ? `weekly ${item.weekday} ${item.time}` : `daily ${item.time}`;
      const firedToday = fired.has(key);
      const actions = role === 'admin'
        ? `<button type="button" data-post="/api/schedules/backfill" data-payload='${payload({ workflow: item.workflow })}'>Backfill now</button>`
        : '<span class="muted small">read-only</span>';
      return `<tr>
        <td>${escapeHtml(item.label)}<div class="muted small">${escapeHtml(item.enabled ? plan : 'disabled')}</div></td>
        <td>${last ? statusPill(last.status) : '<span class="muted">—</span>'}<div class="muted small">${last ? escapeHtml(shortTime(last.started_at)) : ''}</div></td>
        <td>${firedToday ? 'fired today' : item.enabled ? 'waiting' : 'off'}</td>
        <td class="row-actions">${actions}<a class="secondary btn" href="/api/schedules/logs?name=launchd.err.log" target="_blank" rel="noopener">Logs</a></td>
      </tr>`;
    })
    .join('');

  return `
  <section class="card">
    <h2>Schedules</h2>
    <table class="grid"><thead><tr><th>Task</th><th>Last run</th><th>Today</th><th>Actions</th></tr></thead><tbody>${rows}</tbody></table>
    <p class="muted small">Scheduler locks held: ${locks}. Next trigger follows the configured time in ${escapeHtml(config.user.timezone)}.</p>
  </section>`;
}

// --- runs -------------------------------------------------------------------

function renderRuns(ctx: PageContext): string {
  const { config, role } = ctx;
  const active = runManager.list();
  const recent = safe(() => listRecentWorkflowRuns(config, 20), []);

  const activeHtml = active.length
    ? `<table class="grid"><thead><tr><th>Run</th><th>Workflow</th><th>Age</th><th>Actions</th></tr></thead><tbody>${active
        .map(
          (run) => `<tr>
            <td class="mono">${escapeHtml(run.runId)}</td>
            <td>${escapeHtml(run.workflow || '—')}</td>
            <td>${Math.round(run.ageMs / 1000)}s</td>
            <td>${role === 'admin' ? `<button type="button" class="danger" data-post="/api/runs/cancel" data-payload='${payload({ runId: run.runId })}'>Cancel</button>` : '<span class="muted small">read-only</span>'}</td>
          </tr>`,
        )
        .join('')}</tbody></table>`
    : '<p class="muted">No runs currently in flight.</p>';

  const recentHtml = recent.length
    ? `<table class="grid"><thead><tr><th>Workflow</th><th>Trigger</th><th>Status</th><th>Started</th><th>Send</th><th>Actions</th></tr></thead><tbody>${recent
        .map((run) => {
          const send = run.send.enabled ? run.send.status : 'skipped';
          const rerun =
            role === 'admin' && run.status === 'failed' && ['daily_plan', 'daily_review', 'weekly_review'].includes(run.workflow)
              ? `<button type="button" data-post="/api/runs/rerun" data-payload='${payload({ workflow: run.workflow })}'>Rerun</button>`
              : '';
          return `<tr>
            <td>${escapeHtml(run.workflow)}</td>
            <td>${escapeHtml(run.trigger)}</td>
            <td>${statusPill(run.status)}${run.error ? `<div class="muted small">${escapeHtml(run.error.slice(0, 80))}</div>` : ''}</td>
            <td>${escapeHtml(shortTime(run.started_at))}</td>
            <td>${escapeHtml(send)}</td>
            <td>${rerun}</td>
          </tr>`;
        })
        .join('')}</tbody></table>`
    : '<p class="muted">No run history.</p>';

  return `
  <section class="card"><h2>In flight (${active.length})</h2>${activeHtml}</section>
  <section class="card"><h2>Recent runs</h2>${recentHtml}</section>`;
}

// --- artifacts --------------------------------------------------------------

function renderArtifacts(ctx: PageContext): string {
  const { url, role } = ctx;
  const all = safe(() => readArtifactsIndex(), []);
  const q = (url.searchParams.get('q') || '').trim().toLowerCase();
  const typeFilter = (url.searchParams.get('type') || '').trim();
  const dateFilter = (url.searchParams.get('date') || '').trim();
  const previewId = (url.searchParams.get('preview') || '').trim();

  let filtered = all;
  if (q) filtered = filtered.filter((a) => a.name.toLowerCase().includes(q) || a.rel_path.toLowerCase().includes(q) || a.tags.some((t) => t.toLowerCase().includes(q)));
  if (typeFilter) filtered = filtered.filter((a) => a.type === typeFilter);
  if (dateFilter) filtered = filtered.filter((a) => a.mtime.slice(0, 10) === dateFilter);

  const types = [...new Set(all.map((a) => a.type))].sort();
  const typeOptions = ['<option value="">all types</option>', ...types.map((t) => `<option value="${escapeHtml(t)}"${t === typeFilter ? ' selected' : ''}>${escapeHtml(t)}</option>`)].join('');

  const rows = filtered.length
    ? filtered
        .map(
          (a) => `<tr>
        <td><a href="?${buildQuery(url, { preview: a.id })}">${escapeHtml(a.name)}</a><div class="muted small">${escapeHtml(a.rel_path)}</div></td>
        <td><span class="tag">${escapeHtml(a.type)}</span></td>
        <td>${formatBytes(a.size)}</td>
        <td>${escapeHtml(a.mtime.slice(0, 16).replace('T', ' '))}</td>
        <td>${escapeHtml(a.source)}</td>
      </tr>`,
        )
        .join('')
    : '<tr><td colspan="5" class="muted">No artifacts match.</td></tr>';

  const preview = previewId ? renderArtifactPreview(previewId) : '';
  const reindex = role === 'admin' ? '<button type="button" data-post="/api/artifacts/reindex" data-payload="{}">Reindex</button>' : '';

  return `
  <section class="card">
    <div class="card-head"><h2>Artifacts (${all.length})</h2>${reindex}</div>
    <form class="filter-bar" method="get">
      <input name="q" placeholder="keyword" value="${escapeHtml(url.searchParams.get('q') || '')}" />
      <select name="type">${typeOptions}</select>
      <input name="date" type="date" value="${escapeHtml(dateFilter)}" />
      <button type="submit">Filter</button>
      <a class="secondary btn" href="/artifacts">Reset</a>
    </form>
    <table class="grid"><thead><tr><th>Name</th><th>Type</th><th>Size</th><th>Modified</th><th>Source</th></tr></thead><tbody>${rows}</tbody></table>
  </section>
  ${preview}`;
}

function renderArtifactPreview(id: string): string {
  const record = findArtifactById(id);
  if (!record) return '<section class="card"><h2>Preview</h2><p class="error">Artifact not found in index.</p></section>';
  if (!isPreviewableType(record.type)) {
    return `<section class="card"><h2>Preview · ${escapeHtml(record.name)}</h2><p class="muted">${escapeHtml(record.type)} is not previewable as text (${formatBytes(record.size)}).</p></section>`;
  }
  let content = '';
  try {
    const raw = fs.readFileSync(record.path, 'utf8');
    content = raw.length > 200_000 ? `${raw.slice(0, 200_000)}\n… (truncated)` : raw;
  } catch (error) {
    return `<section class="card"><h2>Preview</h2><p class="error">${escapeHtml(error instanceof Error ? error.message : String(error))}</p></section>`;
  }
  return `<section class="card"><h2>Preview · ${escapeHtml(record.name)}</h2><pre class="preview">${escapeHtml(content)}</pre></section>`;
}

// --- data readers -----------------------------------------------------------

interface ScheduleItem {
  workflow: 'daily_plan' | 'daily_review' | 'weekly_review';
  label: string;
  time: string;
  enabled: boolean;
  weekday?: string;
}

function workflowSchedule(config: AppConfig): ScheduleItem[] {
  return [
    { workflow: 'daily_plan', label: 'Daily plan', time: config.workflows.daily_plan.time, enabled: config.workflows.daily_plan.enabled },
    { workflow: 'daily_review', label: 'Daily review', time: config.workflows.daily_review.time, enabled: config.workflows.daily_review.enabled },
    {
      workflow: 'weekly_review',
      label: 'Weekly review',
      time: config.workflows.weekly_review.time,
      enabled: config.workflows.weekly_review.enabled,
      weekday: config.workflows.weekly_review.weekday,
    },
  ];
}

function readFiredKeys(): Set<string> {
  const file = path.resolve('./data/memory/scheduler-state.json');
  if (!fs.existsSync(file)) return new Set();
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { fired?: unknown };
    if (!Array.isArray(parsed.fired)) return new Set();
    return new Set(parsed.fired.filter((k): k is string => typeof k === 'string'));
  } catch {
    return new Set();
  }
}

function readSchedulerLocks(): number {
  const dir = path.resolve('./data/runtime/scheduler-locks');
  if (!fs.existsSync(dir)) return 0;
  try {
    return fs.readdirSync(dir).filter((name) => name.endsWith('.lock')).length;
  } catch {
    return 0;
  }
}

interface UsageSummary {
  enabled: boolean;
  todayCalls: number;
  todayTokens: number;
  todayCost: number;
  monthCost: number;
  month: string;
}

function readUsageSummary(): UsageSummary {
  const file = path.resolve('./data/runtime/usage-ledger.jsonl');
  const today = utcDay();
  const month = today.slice(0, 7);
  const empty: UsageSummary = { enabled: false, todayCalls: 0, todayTokens: 0, todayCost: 0, monthCost: 0, month };
  if (!fs.existsSync(file)) return empty;
  let todayCalls = 0;
  let todayTokens = 0;
  let todayCost = 0;
  let monthCost = 0;
  try {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let entry: { day?: string; month?: string; inputTokens?: number; outputTokens?: number; estCostUsd?: number };
      try {
        entry = JSON.parse(trimmed);
      } catch {
        continue;
      }
      const cost = Number(entry.estCostUsd) || 0;
      if (entry.month === month || (entry.day && entry.day.slice(0, 7) === month)) monthCost += cost;
      if (entry.day === today) {
        todayCalls += 1;
        todayTokens += (Number(entry.inputTokens) || 0) + (Number(entry.outputTokens) || 0);
        todayCost += cost;
      }
    }
  } catch {
    return empty;
  }
  return { enabled: true, todayCalls, todayTokens, todayCost, monthCost, month };
}

// --- small helpers ----------------------------------------------------------

function statusPill(status: WorkflowRunRecord['status']): string {
  const cls = status === 'succeeded' ? 'ok' : status === 'failed' ? 'bad' : 'run';
  return `<span class="pill ${cls}">${escapeHtml(status)}</span>`;
}

function payload(value: unknown): string {
  return escapeHtml(JSON.stringify(value));
}

function buildQuery(url: URL, overrides: Record<string, string>): string {
  const params = new URLSearchParams(url.search);
  for (const [key, value] of Object.entries(overrides)) params.set(key, value);
  return params.toString();
}

function utcDay(): string {
  return new Date().toISOString().slice(0, 10);
}

function shortTime(iso: string): string {
  return typeof iso === 'string' ? iso.slice(0, 16).replace('T', ' ') : '';
}


function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function formatBytes(n: number): string {
  if (n >= 1_048_576) return `${(n / 1_048_576).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

// --- styles + client script -------------------------------------------------

const CONSOLE_CSS = `
:root{color-scheme:light;--bg:#f6f7f4;--surface:#fff;--surface-2:#eef3ee;--text:#202421;--muted:#68726b;--border:#d7ddd8;--accent:#1f6f58;--danger:#9f2d2d;--ok:#1e7a4d;--run:#0d5f8c;}
*{box-sizing:border-box}
body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:var(--bg);color:var(--text);font-size:14px}
.topbar{display:flex;align-items:center;gap:20px;padding:10px 18px;background:var(--surface);border-bottom:1px solid var(--border);position:sticky;top:0;z-index:5;flex-wrap:wrap}
.brand{font-weight:600}
.nav{display:flex;gap:6px;flex:1;flex-wrap:wrap}
.nav-link{padding:6px 12px;border-radius:8px;text-decoration:none;color:var(--muted)}
.nav-link.active,.nav-link:hover{background:var(--surface-2);color:var(--text)}
.session{display:flex;align-items:center;gap:10px}
.setup-link{color:var(--muted);text-decoration:none;font-size:13px}
.role{font-size:12px;color:var(--muted)}
.role-admin{color:var(--accent);font-weight:600}
.logout{border:1px solid var(--border);background:var(--surface);border-radius:8px;padding:5px 10px;cursor:pointer}
.page{max-width:1100px;margin:0 auto;padding:18px;display:flex;flex-direction:column;gap:16px}
.card{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:16px}
.card-head{display:flex;justify-content:space-between;align-items:center}
h2{margin:0 0 12px;font-size:16px}
h3{margin:0 0 8px;font-size:14px}
.grid{width:100%;border-collapse:collapse}
.grid th,.grid td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--border);vertical-align:top}
.grid th{color:var(--muted);font-weight:500;font-size:12px;text-transform:uppercase;letter-spacing:.04em}
.muted{color:var(--muted)}
.small{font-size:12px}
.mono,.preview{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.pill{display:inline-block;padding:2px 8px;border-radius:999px;font-size:12px;background:var(--surface-2)}
.pill.ok{background:#dff2e6;color:var(--ok)}
.pill.bad{background:#f7e0e0;color:var(--danger)}
.pill.run{background:#dcecf6;color:var(--run)}
.tag{display:inline-block;padding:1px 7px;border-radius:6px;background:var(--surface-2);color:var(--muted);font-size:11px}
button{font:inherit;border:1px solid var(--accent);background:var(--accent);color:#fff;border-radius:8px;padding:6px 12px;cursor:pointer}
button.secondary,.btn.secondary{background:var(--surface);color:var(--text);border-color:var(--border)}
button.danger{background:var(--danger);border-color:var(--danger)}
.btn{display:inline-block;text-decoration:none;border-radius:8px;padding:6px 12px}
.stat-row{display:flex;gap:18px;flex-wrap:wrap}
.stat{display:flex;flex-direction:column}
.stat-num{font-size:20px;font-weight:600}
.stat-label{font-size:12px;color:var(--muted)}
.two-col{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.col{min-height:120px;min-width:0}
@media(max-width:900px){.two-col{grid-template-columns:1fr}}
.objective{margin-bottom:14px}
.kr-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px}
.kr-head{display:flex;justify-content:space-between}
.kr-id{font-weight:600;font-size:12px}
.kr-prog{font-size:12px;color:var(--accent)}
.kr-desc{font-size:12px;color:var(--muted);margin:2px 0;overflow-wrap:anywhere}
.kr-meta{margin-top:4px}
.bar{height:6px;background:var(--surface-2);border-radius:6px;overflow:hidden}
.bar>span{display:block;height:100%;background:var(--accent)}
.todo-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:10px}
.todo-item{border:1px solid var(--border);border-radius:10px;padding:10px}
.plan-rank{display:inline-block;min-width:18px;font-weight:600;color:var(--muted)}
.plan-actions{justify-content:flex-end}
.plan-toolbar{display:flex;justify-content:flex-end;margin-bottom:8px}
.chat-hint-list{margin:6px 0 0;padding-left:16px;display:flex;flex-direction:column;gap:2px}
.top-link{font-weight:600;text-decoration:none;color:var(--accent,#0a7);border:1px solid var(--border);border-radius:6px;padding:4px 10px;white-space:nowrap;font-size:13px}
.top-link:hover{background:var(--surface-2)}
.tag-link{text-decoration:none}
.tag-link:hover{text-decoration:underline}
.todo-capture{display:flex;gap:8px;margin-bottom:10px}
.todo-capture input{flex:1;min-width:0}
.todo-item.state-checked{opacity:.6}
.todo-item.state-checked .todo-text{text-decoration:line-through}
.todo-item.state-deferred{opacity:.75;border-style:dashed}
.todo-meta{display:flex;gap:8px;align-items:center;margin:6px 0}
.todo-actions{display:flex;gap:8px}
.todo-history{margin-top:12px;border-top:1px solid var(--border);padding-top:10px}
.todo-history>summary{cursor:pointer;font-weight:600;list-style:none;display:flex;gap:8px;align-items:center}
.todo-history>summary::-webkit-details-marker{display:none}
.todo-history>summary::before{content:"▸";color:var(--muted);font-weight:400}
.todo-history[open]>summary::before{content:"▾"}
.todo-history>summary:hover{color:var(--accent)}
.todo-history>*:not(summary){margin-top:10px}
.signal-block{margin-bottom:14px}
.signal-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px}
.signal{display:flex;justify-content:space-between;padding:6px 8px;border-radius:8px;background:var(--surface-2)}
.signal.error{background:#f7e0e0}
.filter-bar{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px}
.filter-bar input,.filter-bar select,.inline-form input,.inline-form select,.login-card input{font:inherit;padding:6px 10px;border:1px solid var(--border);border-radius:8px;background:var(--surface)}
.inline-form{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.row-actions{display:flex;gap:8px;align-items:center}
.preview{background:#0f1512;color:#e6efe9;padding:14px;border-radius:10px;max-height:520px;overflow:auto;white-space:pre-wrap;word-break:break-word}
.toast{position:fixed;bottom:20px;right:20px;background:var(--text);color:#fff;padding:10px 16px;border-radius:10px;z-index:20}
.error{color:var(--danger)}
.login-body{display:flex;min-height:100vh;align-items:center;justify-content:center}
.login-card{background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:26px;width:340px;display:flex;flex-direction:column;gap:12px}
.login-card h1{font-size:18px;margin:0}
.login-card label{display:flex;flex-direction:column;gap:4px;font-size:13px;color:var(--muted)}
.chat-wrap{display:grid;grid-template-columns:240px 1fr;gap:16px;align-items:start}
@media(max-width:800px){.chat-wrap{grid-template-columns:1fr}}
.chat-sessions{max-height:70vh;overflow:auto}
.chat-session-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:4px}
.chat-session{position:relative;display:flex;flex-direction:column;gap:2px;padding:8px 26px 8px 10px;border-radius:8px;cursor:pointer;border:1px solid transparent}
.chat-session:hover{background:var(--surface-2)}
.chat-session-delete{position:absolute;top:6px;right:6px;border:none;background:none;color:var(--muted);font-size:14px;line-height:1;padding:2px 4px;border-radius:4px;cursor:pointer;visibility:hidden}
.chat-session:hover .chat-session-delete{visibility:visible}
.chat-session-delete:hover{background:var(--border);color:var(--text)}
.chat-session.active{background:var(--surface-2);border-color:var(--border)}
.s-title{font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.chat-main{display:flex;flex-direction:column;min-height:60vh}
.chat-head{display:flex;justify-content:space-between;align-items:flex-start}
.chat-stream{flex:1;overflow:auto;display:flex;flex-direction:column;gap:12px;padding:8px 2px;max-height:60vh}
.chat-msg{display:flex;flex-direction:column;gap:2px}
.chat-msg .who{font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted)}
.chat-msg .body{white-space:pre-wrap;word-break:break-word;padding:8px 12px;border-radius:10px;background:var(--surface-2)}
.chat-msg.role-user .body{background:#dcecf6;align-self:flex-start}
.chat-msg.role-assistant .body{background:var(--surface-2)}
.chat-msg.role-system .body{background:transparent;color:var(--muted);padding:2px 0}
.chat-status{padding:2px 0}
.chat-composer{display:flex;gap:8px;align-items:flex-end;margin-top:10px;border-top:1px solid var(--border);padding-top:10px}
.chat-composer textarea{flex:1;font:inherit;padding:8px 10px;border:1px solid var(--border);border-radius:8px;resize:vertical;background:var(--surface)}
.chat-composer-actions{display:flex;flex-direction:column;gap:6px}
.cycles-wrap{display:grid;grid-template-columns:270px 1fr;gap:16px;align-items:start}
@media(max-width:900px){.cycles-wrap{grid-template-columns:1fr}}
.cycles-side{display:flex;flex-direction:column;gap:16px}
.cycles-main{display:flex;flex-direction:column;gap:16px}
.cycle-list{display:flex;flex-direction:column;gap:6px;max-height:42vh;overflow:auto}
.cycle-item{display:flex;flex-direction:column;gap:2px;text-align:left;padding:8px 10px;border:1px solid var(--border);border-radius:10px;background:var(--surface);color:var(--text);cursor:pointer}
.cycle-item:hover{background:var(--surface-2)}
.cycle-item.active{border-color:var(--accent);background:var(--surface-2)}
.cycle-item strong{font-size:13px}
.cycle-item span{font-size:11px;color:var(--muted)}
.cycle-item-broken{font-size:11px;color:var(--danger)}
.cycle-cards{display:flex;flex-direction:column;gap:16px}
.cycle-cards[hidden]{display:none}
.cycle-card textarea,.cycle-modal-card textarea{width:100%;font:inherit;padding:10px;border:1px solid var(--border);border-radius:10px;background:var(--surface);resize:vertical}
.cycle-card textarea{min-height:11rem}
/* Read-only is not broken, so it borrows the muted surface rather than the
   danger colours: nothing is wrong, this is just someone else's file. */
.cycle-card textarea[readonly],.cycle-modal-card textarea[readonly]{background:var(--surface-2)}
.cycle-card-actions{display:flex;gap:8px;align-items:center;margin-top:8px}
.cycle-card-actions[hidden]{display:none}
.cycle-readonly{margin-top:8px;padding:8px 10px;border-radius:10px;background:var(--surface-2);color:var(--muted);font-size:12px}
.cycle-warning{margin-top:8px;padding:10px;border-radius:10px;background:#f7e0e0;color:var(--danger);font-size:12px}
button.compact{padding:4px 10px;font-size:12px}
.cycle-modal{position:fixed;inset:0;z-index:30;background:rgba(20,24,22,.55);display:flex;align-items:center;justify-content:center;padding:24px}
.cycle-modal[hidden]{display:none}
.cycle-modal-card{background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:18px;width:min(880px,100%);max-height:86vh;display:flex;flex-direction:column;gap:10px}
.cycle-modal-card textarea{flex:1;min-height:46vh}
`;

const CONSOLE_JS = `
(function(){
  function toast(msg){var t=document.getElementById('toast');if(!t)return;t.textContent=msg;t.hidden=false;setTimeout(function(){t.hidden=true},2600);}
  document.addEventListener('click',function(ev){
    var logout=ev.target.closest('[data-logout]');
    if(logout){ev.preventDefault();fetch('/api/logout',{method:'POST',credentials:'same-origin'}).then(function(){location.href='/login';});return;}
    var btn=ev.target.closest('button[data-post],a[data-post]');
    if(!btn)return;
    ev.preventDefault();
    var url=btn.getAttribute('data-post');
    var payload=btn.getAttribute('data-payload');
    var body=payload?payload:'{}';
    var notePrompt=btn.getAttribute('data-note-prompt');
    if(notePrompt){
      var note=window.prompt(notePrompt,'');
      if(note===null)return;
      try{var obj=JSON.parse(body);if(note.trim())obj.note=note.trim();body=JSON.stringify(obj);}catch(e){}
    }
    btn.disabled=true;
    fetch(url,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:body})
      .then(function(r){return r.json().catch(function(){return{ok:r.ok};}).then(function(d){return{status:r.status,data:d};});})
      .then(function(res){
        if(res.status>=200&&res.status<300&&res.data&&res.data.ok!==false){toast((res.data&&res.data.text)||'Done');setTimeout(function(){location.reload();},600);}
        else{btn.disabled=false;toast((res.data&&res.data.error)||('Failed ('+res.status+')'));}
      })
      .catch(function(e){btn.disabled=false;toast(String(e));});
  });
  document.addEventListener('submit',function(ev){
    var form=ev.target.closest('form.inline-form[data-post]');
    if(!form)return;
    ev.preventDefault();
    var url=form.getAttribute('data-post');
    var obj={};new FormData(form).forEach(function(v,k){obj[k]=v;});
    fetch(url,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify(obj)})
      .then(function(r){return r.json().catch(function(){return{ok:r.ok};}).then(function(d){return{status:r.status,data:d};});})
      .then(function(res){
        if(res.status>=200&&res.status<300&&res.data&&res.data.ok!==false){toast('Saved');setTimeout(function(){location.reload();},500);}
        else{toast((res.data&&res.data.error)||('Failed ('+res.status+')'));}
      })
      .catch(function(e){toast(String(e));});
  });
})();
`;

const LOGIN_JS = `
(function(){
  var form=document.getElementById('login-form');
  if(!form)return;
  form.addEventListener('submit',function(ev){
    ev.preventDefault();
    var obj={};new FormData(form).forEach(function(v,k){obj[k]=v;});
    fetch('/api/login',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify(obj)})
      .then(function(r){return r.json().catch(function(){return{ok:false};}).then(function(d){return{status:r.status,data:d};});})
      .then(function(res){
        if(res.status>=200&&res.status<300&&res.data&&res.data.ok){location.href='/dashboard';}
        else{var p=document.querySelector('.error')||document.createElement('p');p.className='error';p.textContent=(res.data&&res.data.error)||'Login failed';form.insertBefore(p,form.children[2]);}
      })
      .catch(function(e){alert(String(e));});
  });
})();
`;
