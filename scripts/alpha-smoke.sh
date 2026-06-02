#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

SMOKE_ENV="$TMP_DIR/.env"
SMOKE_CONFIG="$TMP_DIR/config.yaml"

cat >"$SMOKE_ENV" <<'EOF'
CODEX_BIN=codex
TZ=UTC
EOF

cat >"$SMOKE_CONFIG" <<'EOF'
assistant:
  name: "daily-os-feishu"
  language: "en"
  tone: "calm, direct, practical"

user:
  display_name: "User"
  timezone: "UTC"

llm:
  provider: "codex"
  model: "default"

workflows:
  daily_plan:
    enabled: true
    time: "08:00"
  daily_review:
    enabled: true
    time: "21:30"
  weekly_review:
    enabled: true
    weekday: "SUN"
    time: "20:00"

output:
  feishu:
    enabled: false
    identity: "bot"
    chat_id_env: "FEISHU_CHAT_ID"
    send_mode: "markdown"

sources:
  vault:
    enabled: false
    provider: "local"
    local_path: "/path/to/Private-Vault"
    remote:
      base_url_env: "VAULT_GATE_URL"
      token_env: "VAULT_GATE_TOKEN"
      scan:
        enabled: true
        statuses: ["active", "watching", "considering"]
        due_within_days: 7
        limit: 12
      read_paths:
        todos: "99_Meta/todos.md"
        routing: "99_Meta/routing.md"
        watch_list: "99_Meta/watch-list.md"
  chrome_snapshot:
    enabled: false
    tabs_path: "./data/snapshots/chrome/current-tabs.txt"
    status_path: "./data/snapshots/chrome/status.json"
  apple_calendar_snapshot:
    enabled: false
    path: "./data/snapshots/calendar/apple-today.json"
  feishu:
    enabled: false
    calendar:
      enabled: false
      days: 1
    tasks:
      enabled: false
      include_completed: false
      page_limit: 5
    docs:
      enabled: false
      documents: []
    im_history:
      enabled: false
      chat_id_env: "FEISHU_CHAT_ID"
      limit: 30
  github:
    enabled: false
  linear:
    enabled: false
    query: "assignee = me and state.type != 'completed'"
  local_files:
    enabled: false
    files: []

memory:
  long_term_path: "__SMOKE_MEMORY__/long-term.md"
  daily_dir: "__SMOKE_MEMORY__/daily"
EOF

SMOKE_MEMORY="$TMP_DIR/memory"
SMOKE_MEMORY_ESC="${SMOKE_MEMORY//&/\\&}"
SMOKE_MEMORY_ESC="${SMOKE_MEMORY_ESC//#/\\#}"
sed -i.bak "s#__SMOKE_MEMORY__#$SMOKE_MEMORY_ESC#g" "$SMOKE_CONFIG"
rm -f "$SMOKE_CONFIG.bak"

mkdir -p "$SMOKE_MEMORY/daily"
touch "$SMOKE_MEMORY/long-term.md"

npm run typecheck
npm run build
npm run privacy:scan

DOCTOR_OUTPUT="$(node dist/index.js --env "$SMOKE_ENV" --config "$SMOKE_CONFIG" doctor)"
echo "$DOCTOR_OUTPUT"
if echo "$DOCTOR_OUTPUT" | rg '^MISSING' >/dev/null; then
  echo "Alpha smoke doctor check failed." >&2
  exit 1
fi
node dist/index.js --env "$SMOKE_ENV" --config "$SMOKE_CONFIG" collect >"$TMP_DIR/collect.json"

if [ "${DAILY_OS_SKIP_AGENT_SMOKE:-0}" != "1" ]; then
  node dist/index.js --env "$SMOKE_ENV" --config "$SMOKE_CONFIG" plan --no-send >"$TMP_DIR/plan.txt"
fi

echo "Alpha smoke test passed."
