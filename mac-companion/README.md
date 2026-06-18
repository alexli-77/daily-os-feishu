# Daily OS Companion Prototype

This is a local macOS companion prototype for LEO-46. It is intentionally small and optional: it opens the existing Daily OS dashboard, shows service state, triggers existing workflow actions through the local UI API, and reads recent workflow run records.

The app shows a short `DO` menu bar marker. On crowded menu bars where macOS may hide status items, it also shows a small floating desktop character near the upper-right corner of each screen. Click the character to open the Daily OS menu; drag it to move it anywhere on screen.

The prototype loads `mac-companion/assets/penguin-idle.png` and `mac-companion/assets/penguin-blink.png` when present. Keep both frames on the same transparent canvas size so the character does not jump while blinking. If the frame assets are missing, it falls back to `penguin-avatar.png`, then to the blue `DO` badge.

It does not replace the Feishu bot, scheduler, or web dashboard. It also does not package a release build, sign an app, or add a new runtime dependency.

## Run

```bash
npm run mac:companion:run
```

That builds:

```text
dist/mac-companion/Daily OS Companion.app
```

## Safety Notes

- Workflow actions call the existing local UI endpoint: `POST /api/action`.
- If the local API is down, the app reports the error instead of running a separate workflow path.
- Service restart uses the existing launchd label: `com.daily-os-feishu.agent`.
- The repo root is discovered from `DAILY_OS_REPO_ROOT`, `--repo`, or the app bundle location under `dist/mac-companion`.

## Prototype Boundary

Keep this as a prototype until the entry-point decision is clear:

- menu bar app only
- floating desktop companion
- both
- no macOS companion

If the menu bar shape is accepted, the next step is to decide whether to fold it into a proper signed app target.
