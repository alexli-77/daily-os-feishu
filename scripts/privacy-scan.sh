#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

FILES_FILE="$(mktemp)"
trap 'rm -f "$FILES_FILE"' EXIT

if command -v rg >/dev/null 2>&1; then
  git ls-files --cached --others --exclude-standard |
    rg -v '^(node_modules|dist|logs|data|\.git)/' |
    rg -v '^scripts/privacy-scan\.sh$' >"$FILES_FILE" || true
else
  git ls-files --cached --others --exclude-standard |
    grep -Ev '^(node_modules|dist|logs|data|\.git)/' |
    grep -Ev '^scripts/privacy-scan\.sh$' >"$FILES_FILE" || true
fi

if [ ! -s "$FILES_FILE" ]; then
  echo "No files to scan."
  exit 0
fi

patterns=(
  '^(OPENAI_API_KEY|GITHUB_TOKEN|LINEAR_API_KEY|VAULT_GATE_TOKEN|FEISHU_CHAT_ID|LARK_APP_SECRET|LARK_APP_ID|DISCORD_TOKEN|CODEX_HOME)=[^#[:space:]].+'
  'oc_[A-Za-z0-9_-]{12,}'
  '/Users/[^/[:space:]]+'
  'alex\.geekai'
  'Leon_os'
  'Leon × AI'
)

failed=0
for pattern in "${patterns[@]}"; do
  while IFS= read -r file; do
    if command -v rg >/dev/null 2>&1; then
      scan_command=(rg -n --hidden "$pattern" -- "$file")
    else
      scan_command=(grep -nE "$pattern" "$file")
    fi
    if "${scan_command[@]}"; then
      failed=1
    fi
  done <"$FILES_FILE"
done

if [ "$failed" -ne 0 ]; then
  echo "Privacy scan failed. Remove secrets, chat IDs, personal paths, or private identifiers from tracked files." >&2
  exit 1
fi

echo "Privacy scan passed."
