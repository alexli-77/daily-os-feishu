import fs from 'node:fs';
import path from 'node:path';
import type { AppConfig } from '../config/schema.js';
import type { Role } from './auth.js';
import { listRecentWorkflowRuns, type WorkflowRunRecord } from '../workflows/run-ledger.js';
import { openTodoInboxItems } from '../todo/inbox.js';
import { readOkrSnapshot, type OkrObjective } from './okr-lite.js';
import { readArtifactsIndex, findArtifactById, isPreviewableType, type ArtifactRecord } from '../storage/artifacts.js';
import { runManager } from '../service/run-manager.js';

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

export const PLATFORM_PAGES = new Set(['/dashboard', '/today', '/chat', '/schedules', '/runs', '/artifacts']);

const NAV: Array<{ href: string; label: string }> = [
  { href: '/dashboard', label: 'Dashboard' },
  { href: '/today', label: 'Today' },
  { href: '/chat', label: 'Chat' },
  { href: '/schedules', label: 'Schedules' },
  { href: '/runs', label: 'Runs' },
  { href: '/artifacts', label: 'Artifacts' },
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
    <p class="muted small">First run prints a generated <code>admin</code> password to the console and data/runtime/ui.json.</p>
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
  const { config } = ctx;
  const okr = safe(() => readOkrSnapshot(config.memory.repository_path), null);
  const northStarTitle = okr?.northStar.exists
    ? okr.northStar.objectives[0]?.title || okr.northStar.title
    : 'North star OKR not found';
  const cycle = okr?.current.frontmatter.cycle || '—';
  const progress = okr?.currentProgress ?? null;

  const northBar = `
  <section class="north-bar">
    <div class="north-main">
      <span class="north-label">North Star</span>
      <span class="north-title">${escapeHtml(northStarTitle)}</span>
    </div>
    <div class="north-meta">
      <span>Cycle ${escapeHtml(cycle)}</span>
      ${progress === null ? '<span class="muted">no KR progress</span>' : `<span class="north-progress">${progress}%</span>`}
    </div>
  </section>`;

  const okrChain = renderOkrColumn(okr?.current.objectives ?? []);
  const todoCol = renderTodoColumn(ctx);
  const signalCol = renderSignalColumn(ctx);

  return `${northBar}
  <div class="three-col">
    <section class="card col"><h2>OKR chain</h2>${okrChain}</section>
    <section class="card col"><h2>Today's todo</h2>${todoCol}</section>
    <section class="card col"><h2>Signals</h2>${signalCol}</section>
  </div>`;
}

function renderOkrColumn(objectives: OkrObjective[]): string {
  if (objectives.length === 0) return '<p class="muted">No quarterly objectives parsed. Fill memory-vault/default/10_OKR/current-okr.md.</p>';
  return objectives
    .map((obj) => {
      const krs = obj.keyResults.length
        ? obj.keyResults
            .map(
              (kr) => `<li>
                <div class="kr-head"><span class="kr-id">${escapeHtml(kr.id)}</span><span class="kr-prog">${kr.progress === null ? '—' : `${kr.progress}%`}</span></div>
                <div class="kr-desc">${escapeHtml(kr.description)}</div>
                <div class="bar"><span style="width:${kr.progress ?? 0}%"></span></div>
              </li>`,
            )
            .join('')
        : '<li class="muted">No key results.</li>';
      return `<div class="objective"><h3>${escapeHtml(obj.id)}: ${escapeHtml(obj.title)}${obj.parent ? ` <span class="tag">↦ ${escapeHtml(obj.parent)}</span>` : ''}</h3><ul class="kr-list">${krs}</ul></div>`;
    })
    .join('');
}

function renderTodoColumn(ctx: PageContext): string {
  const { config } = ctx;
  const open = safe(() => openTodoInboxItems(config), []);
  const feedback = readTodoFeedback();
  if (open.length === 0) return '<p class="muted">Todo inbox is empty.</p>';
  const rows = open
    .map((item) => {
      const fb = feedback.get(item.id);
      const stateLabel = fb ? (fb === 'check' ? 'checked' : 'deferred') : 'open';
      return `<li class="todo-item state-${stateLabel}">
        <div class="todo-text">${escapeHtml(item.text)}</div>
        <div class="todo-meta"><span class="tag">${escapeHtml(item.type)}</span><span class="muted small">${stateLabel}</span></div>
        <div class="todo-actions">
          <button type="button" data-post="/api/today/todo-feedback" data-payload='${payload({ id: item.id, action: 'check' })}'>Done</button>
          <button type="button" class="secondary" data-post="/api/today/todo-feedback" data-payload='${payload({ id: item.id, action: 'defer' })}'>Defer</button>
        </div>
      </li>`;
    })
    .join('');
  return `<ul class="todo-list">${rows}</ul>`;
}

function renderSignalColumn(ctx: PageContext): string {
  const { config } = ctx;
  const runs = safe(() => listRecentWorkflowRuns(config, 20), []);
  const failures = runs.filter((run) => run.status === 'failed');
  const open = safe(() => openTodoInboxItems(config), []);
  const stale = open.filter((item) => ageDays(item.created_at) >= 3);

  const failureHtml = failures.length
    ? `<ul class="signal-list">${failures
        .slice(0, 6)
        .map((run) => `<li class="signal error"><span>${escapeHtml(run.workflow)}</span><span class="muted small">${escapeHtml(shortTime(run.started_at))}</span></li>`)
        .join('')}</ul>`
    : '<p class="muted small">No recent workflow failures.</p>';

  return `
    <div class="signal-block"><h3>Recent failures (${failures.length})</h3>${failureHtml}</div>
    <div class="signal-block"><h3>Todo pressure</h3>
      <div class="stat-row">
        <div class="stat"><span class="stat-num">${open.length}</span><span class="stat-label">open</span></div>
        <div class="stat"><span class="stat-num">${stale.length}</span><span class="stat-label">3d+ stale</span></div>
      </div>
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
  <section class="chat-wrap" data-role="${escapeHtml(ctx.role)}">
    <aside class="chat-sessions card">
      <div class="card-head"><h2>Chats</h2><button type="button" id="chat-new">New</button></div>
      <ul class="chat-session-list" id="chat-session-list"><li class="muted small">Loading…</li></ul>
    </aside>
    <div class="chat-main card">
      <div class="chat-head">
        <div><h2 id="chat-title">Console assistant</h2><p class="muted small">${escapeHtml(roleHint)}</p></div>
      </div>
      ${agentHint}
      <div class="chat-stream" id="chat-stream"><p class="muted small">Start a new chat or pick one on the left.</p></div>
      <form class="chat-composer" id="chat-composer">
        <textarea id="chat-input" rows="2" placeholder="Ask, or run: plan / review / weekly / progress / 记到 todo：…" autocomplete="off"></textarea>
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
  function api(url,opts){return fetch(url,Object.assign({credentials:'same-origin'},opts||{}));}
  function bubble(role,text){
    var el=document.createElement('div');
    el.className='chat-msg role-'+role;
    el.innerHTML='<span class="who">'+esc(role)+'</span><div class="body">'+esc(text)+'</div>';
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
          '<span class="muted small">'+esc(s.messages)+' msg</span></li>';
      }).join('');
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
    if(!sessionId){return;}
    bubble('user',text);
    var target=bubble('assistant','');
    var statusEl=document.createElement('div');statusEl.className='chat-status muted small';target.parentNode.appendChild(statusEl);
    var acc='';
    setSending(true);
    controller=new AbortController();
    api('/api/chat/send',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({session:sessionId,text:text}),signal:controller.signal})
      .then(function(res){
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
            else if(ev.type==='reply'){acc+=(acc?'\n\n':'')+ev.content;target.textContent=acc;}
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
  form.addEventListener('submit',function(ev){ev.preventDefault();if(sending)return;var t=input.value.trim();if(!t||!sessionId)return;input.value='';send(t);});
  input.addEventListener('keydown',function(ev){if(ev.key==='Enter'&&!ev.shiftKey){ev.preventDefault();form.dispatchEvent(new Event('submit',{cancelable:true}));}});
  stopBtn.addEventListener('click',function(){
    if(controller)controller.abort();
    if(sessionId)api('/api/chat/stop',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({session:sessionId})});
  });
  newBtn.addEventListener('click',function(){
    api('/api/chat/session',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})
      .then(function(r){return r.json();}).then(function(d){if(d&&d.session){return loadSessions().then(function(){return openSession(d.session.id);});}});
  });
  list.addEventListener('click',function(ev){var li=ev.target.closest('.chat-session');if(li)openSession(li.getAttribute('data-id'));});
  loadSessions().then(function(){
    var first=list.querySelector('.chat-session');
    if(first){openSession(first.getAttribute('data-id'));}
  });
})();
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
            role === 'admin' && run.status === 'failed'
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

/** Latest feedback action per todo id from data/runtime/todo-feedback.jsonl. */
function readTodoFeedback(): Map<string, 'check' | 'defer'> {
  const file = path.resolve('./data/runtime/todo-feedback.jsonl');
  const out = new Map<string, 'check' | 'defer'>();
  if (!fs.existsSync(file)) return out;
  try {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const entry = JSON.parse(trimmed) as { id?: string; action?: string };
        if (typeof entry.id === 'string' && (entry.action === 'check' || entry.action === 'defer')) {
          out.set(entry.id, entry.action);
        }
      } catch {
        // skip bad line
      }
    }
  } catch {
    return out;
  }
  return out;
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

function ageDays(iso: string): number {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 0;
  return (Date.now() - t) / (24 * 60 * 60 * 1000);
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
.topbar{display:flex;align-items:center;gap:20px;padding:10px 18px;background:var(--surface);border-bottom:1px solid var(--border);position:sticky;top:0;z-index:5}
.brand{font-weight:600}
.nav{display:flex;gap:6px;flex:1}
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
.three-col{display:grid;grid-template-columns:1fr 1fr 1fr;gap:16px}
.col{min-height:120px}
@media(max-width:900px){.three-col{grid-template-columns:1fr}}
.north-bar{background:var(--surface);border:1px solid var(--border);border-left:4px solid var(--accent);border-radius:12px;padding:14px 16px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px}
.north-label{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin-right:8px}
.north-title{font-weight:600}
.north-progress{font-weight:700;color:var(--accent)}
.north-meta{display:flex;gap:14px;align-items:center}
.objective{margin-bottom:14px}
.kr-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px}
.kr-head{display:flex;justify-content:space-between}
.kr-id{font-weight:600;font-size:12px}
.kr-prog{font-size:12px;color:var(--accent)}
.kr-desc{font-size:12px;color:var(--muted);margin:2px 0}
.bar{height:6px;background:var(--surface-2);border-radius:6px;overflow:hidden}
.bar>span{display:block;height:100%;background:var(--accent)}
.todo-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:10px}
.todo-item{border:1px solid var(--border);border-radius:10px;padding:10px}
.todo-item.state-checked{opacity:.6}
.todo-meta{display:flex;gap:8px;align-items:center;margin:6px 0}
.todo-actions{display:flex;gap:8px}
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
.chat-session{display:flex;flex-direction:column;gap:2px;padding:8px 10px;border-radius:8px;cursor:pointer;border:1px solid transparent}
.chat-session:hover{background:var(--surface-2)}
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
    btn.disabled=true;
    fetch(url,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:body})
      .then(function(r){return r.json().catch(function(){return{ok:r.ok};}).then(function(d){return{status:r.status,data:d};});})
      .then(function(res){
        if(res.status>=200&&res.status<300&&res.data&&res.data.ok!==false){toast('Done');setTimeout(function(){location.reload();},500);}
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
