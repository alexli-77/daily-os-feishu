# Agent Instructions

Before making project management, code, release, or Linear/GitHub workflow changes, read:

- `docs/task-workflow.md`

Before changing anything under `src/ui/` — the server-rendered console — read:

- `docs/adr/0001-ssr-console-scope-and-ui-freeze.md`

That console is frozen for UI polish. The native clients
([macOS](https://github.com/alexli-77/daily-os-macos),
[iOS](https://github.com/alexli-77/daily-os-ios)) now cover the same screens, so
appearance and interaction work done here gets paid for twice. Correctness,
security, accessibility and API-compat changes still belong here; visual and
interaction polish does not. The ADR carries the full criteria and a worked
example against three real issues.

Do not commit local secrets, `.env`, `config/config.yaml`, runtime data, logs, or user-specific decision files.
