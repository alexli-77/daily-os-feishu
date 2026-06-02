#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if ! command -v rg >/dev/null 2>&1; then
  echo "privacy-scan requires ripgrep (rg)." >&2
  exit 1
fi

FILES_FILE="$(mktemp)"
trap 'rm -f "$FILES_FILE"' EXIT

git ls-files --cached --others --exclude-standard |
  rg -v '^(node_modules|dist|logs|data|\.git)/' |
  rg -v '^scripts/privacy-scan\.sh$' >"$FILES_FILE" || true

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
    if rg -n --hidden "$pattern" -- "$file"; then
      failed=1
    fi
  done <"$FILES_FILE"
done

if [ "$failed" -ne 0 ]; then
  echo "Privacy scan failed. Remove secrets, chat IDs, personal paths, or private identifiers from tracked files." >&2
  exit 1
fi

echo "Privacy scan passed."
