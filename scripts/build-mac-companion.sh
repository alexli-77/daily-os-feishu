#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_NAME="Daily OS Companion"
OUT_DIR="$ROOT/dist/mac-companion"
APP_DIR="$OUT_DIR/$APP_NAME.app"
CONTENTS_DIR="$APP_DIR/Contents"
MACOS_DIR="$CONTENTS_DIR/MacOS"
BIN="$MACOS_DIR/DailyOSCompanion"

mkdir -p "$MACOS_DIR"

swiftc \
  "$ROOT/mac-companion/DailyOSCompanion.swift" \
  -o "$BIN" \
  -framework AppKit \
  -framework Foundation

cat > "$CONTENTS_DIR/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key>
  <string>DailyOSCompanion</string>
  <key>CFBundleIdentifier</key>
  <string>local.daily-os-feishu.companion.prototype</string>
  <key>CFBundleName</key>
  <string>Daily OS Companion</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>0.1.0</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>LSUIElement</key>
  <true/>
</dict>
</plist>
PLIST

echo "Built $APP_DIR"

if [[ "${1:-}" == "--run" ]]; then
  open "$APP_DIR"
fi
