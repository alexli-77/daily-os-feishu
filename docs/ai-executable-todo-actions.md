# AI Executable Todo Actions

Daily OS treats AI-executable todo work as a safe handoff layer, not as an automatic executor.

## Current behavior

- `daily-os actions` lists open Todo Inbox items that can be drafted by AI.
- `daily-os action draft <index|todo text|todo id>` creates a local draft and appends an audit record.
- `daily-os action confirm <action id>` confirms the draft record locally.
- The current implementation does not send email, write external documents, run code, or call remote tools.

## Why this shape

Daily OS receives daily context from Feishu, Dashboard, Vault, Linear, and local memory. Before binding that context to an agent runtime, it needs a stable action schema:

- todo id and source text
- action kind
- provider hint
- draft-only safety status
- local audit ledger

This lets Codex, Claude, Hermes, or a manual workflow consume the same action contract later.

## Provider roles

- `codex`: good default for code, docs, local repo edits, and test planning.
- `claude`: useful for drafting, restructuring, and long-form writing.
- `hermes`: future candidate for a tool-using agent runtime once deployment and permissions are reviewed.
- `manual`: no agent handoff; use the generated checklist yourself.

Hermes should be integrated behind this action contract instead of being hard-wired into Todo Inbox parsing.

## Safety defaults

Keep `ai_actions.dry_run: true` until an executor has:

- explicit user confirmation
- provider-specific permission boundaries
- a rollback or no-op test path
- visible success/failure feedback
- regression coverage for duplicate and retry behavior
