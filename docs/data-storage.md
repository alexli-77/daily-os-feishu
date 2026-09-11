# Where your data lives

Daily OS is local-first. Everything it produces stays on your machine, split
between one SQLite database and a set of files. This page is the map: what is
stored, where, what to back up, and what a re-install leaves behind.

## Accounts are a login door, not a data partition

The account you create is **only a login gate for the local console**. Nothing in
the database or the files is partitioned by account:

- One machine has **one owner**. The first account you register is the admin/owner.
- **No table carries an owner column** — creating a second account does not create
  a second, separate dataset. Whoever logs in sees the same data.
- The data a run reads and writes comes from the **paths in `config/config.yaml`**
  (`memory.repository_path`, `vault.local_path`, `memory.daily_dir`, …), not from
  the account. So "load an existing local directory" means pointing those config
  paths at that directory in **Config → Setup / Sources** — there is no per-account
  "link a folder" step.
- The local account is **separate from a Supabase team member**. Your local
  username never leaves the machine except that, when you sign up for a team, it
  is used as your Supabase `display_name` so the two identities line up. Password
  hash and salt always stay local.

> If you want each account to have its own isolated data directory, that is a
> different product shape (full multi-tenancy) and is tracked separately — the
> single-owner model above is what ships today.

## SQLite — `data/runtime/daily-os.db`

A single WAL-mode SQLite file. Owner-only readable (chmod 0600).

| Table | What it records |
| --- | --- |
| `users` | Accounts: username, role, **scrypt salt + hash** (never the plaintext), email, avatar seed. |
| `artifacts` (+ `artifacts_fts`) | Index of produced files: path, name, type, tags, source, size, mtime. FTS5 powers the /artifacts search. |
| `chat_messages` | **The full text of your console chat** — session id, channel, role, and the complete message content. |
| `calendar_draft_snapshots` | The exact calendar draft shown on a card, kept so "confirm" writes back what you saw. |
| `calendar_batches` / `calendar_writebacks` | Calendar write-back bookkeeping: which events were created, their ids, and the batch that `calendar undo` deletes. |
| `calendar_adjustments` | Stored "move / drop / resize" adjustments folded into the next draft. |

Sessions live next to it in `data/runtime/sessions.json` (login tokens), not in
the database.

## Files

A large part of your data is plain files, not SQLite:

| Path | What it records |
| --- | --- |
| `memory-vault/` (or your configured `vault.local_path`) | Your OKR / cycle markdown — the source of truth. |
| `data/memory/workflow-runs/` | The run ledger: every plan/review/weekly run. |
| `data/memory/daily/` | Daily plan and review memory notes. |
| `data/memory/skill-inputs/` | Input packs handed to the weekly-review skill. |
| `data/memory/todo-inbox.jsonl` | The quick-capture todo inbox. |
| `data/memory/progress/` | Progress ledger / sync-drift decisions. |
| `data/runtime/sessions.json` | Active login sessions (tokens). |
| `data/runtime/usage-ledger.jsonl` | Per-turn token usage. |
| `.env` / `config/config.yaml` | Secrets and configuration (gitignored). |

## Back up / uninstall

- **To back up everything**, take `data/`, `memory-vault/` (or your configured
  vault), `.env`, and `config/config.yaml`.
- Your vault and memory files are yours regardless of the app — they are ordinary
  markdown/JSON on disk.
- **Uninstalling the app does not delete `data/` or your vault.** Those are your
  files; remove them by hand if you want them gone. The `chat_messages` table in
  particular holds your full conversations verbatim, so include it when you decide
  what to keep or wipe.
