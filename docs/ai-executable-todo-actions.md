# AI Executable Todo Actions

Daily OS treats AI-executable todo work as a safe handoff layer, not as an automatic executor.

## Current behavior

- `daily-os actions` lists open Todo Inbox items that can be drafted by AI.
- `daily-os action draft <index|todo text|todo id>` creates a local draft and appends an audit record.
- `daily-os action confirm <action id>` confirms the draft record locally.
- `daily-os action dispatch <action id>` can submit a confirmed draft to a configured external adapter.
- By default, dispatch is skipped because `ai_actions.dry_run: true` and `ai_actions.executor.enabled: false`.
- The current default setup does not send email, write external documents, run code, or call remote tools.

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

## Adapter contract

Daily OS emits one provider-neutral JSON payload:

```json
{
  "schema_version": "daily-os.ai_action.v1",
  "source": {
    "app": "daily-os-feishu",
    "action_id": "act-...",
    "created_at": "2026-06-25T00:00:00.000Z"
  },
  "action": {
    "id": "act-...",
    "todo_id": "todo-...",
    "todo_text": "Write the portfolio review checklist",
    "kind": "doc_draft",
    "provider": "hermes",
    "title": "Write the portfolio review checklist: draft doc update",
    "draft": "Goal..."
  },
  "execution": {
    "mode": "draft_handoff",
    "require_user_confirmation": true,
    "dry_run": false
  },
  "constraints": {
    "no_external_writes_without_confirmation": true,
    "preserve_audit_trail": true,
    "return_result_summary": true
  }
}
```

Configure an external adapter with:

```yaml
ai_actions:
  dry_run: false
  executor:
    enabled: true
    type: webhook
    endpoint_url: "http://127.0.0.1:8787/daily-os/actions"
    api_key_env: "DAILY_OS_ACTION_EXECUTOR_TOKEN"
```

The webhook can be implemented by Hermes, a Hermes shim, Codex, Claude, or a custom local service. Daily OS only requires an HTTP 2xx response to mark the action as dispatched.

## Hermes boundary

Hermes currently exposes several programmatic integration shapes, including ACP stdio, a TUI gateway JSON-RPC mode, and an OpenAI-compatible HTTP API. Daily OS does not bind to any of those directly. Instead:

- Daily OS sends `daily-os.ai_action.v1` to a webhook adapter.
- The adapter translates the payload to Hermes, Codex, Claude, or another executor.
- The adapter returns a compact accepted/failed result.
- Daily OS records the result in the local audit ledger.

This keeps Hermes optional and replaceable.

## Safety defaults

Keep `ai_actions.dry_run: true` until an executor has:

- explicit user confirmation
- provider-specific permission boundaries
- a rollback or no-op test path
- visible success/failure feedback
- regression coverage for duplicate and retry behavior
