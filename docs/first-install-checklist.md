# First External Mac Install Checklist

Use this checklist before handing the alpha to another Mac user.

## 1. Clean Install

```bash
git clone <repo-url>
cd daily-os-feishu
npm ci
npm run alpha:smoke:ci
```

The CI smoke command uses temporary config, disables Feishu sending, disables
all private data sources, and verifies that the generic package can build and
collect empty evidence without local secrets.

## 2. Local Account Setup

Install and sign in to the local tools:

```bash
codex --version
codex login status
# Required when using Feishu source collection or lark-cli fallback:
lark-cli --help
```

Then run first-run setup. In an interactive terminal `npm run setup` launches a
wizard that sets the console admin password (scrypt-hashed into SQLite, never
plaintext), configures an LLM provider + API key (BYOK: `ANTHROPIC_API_KEY` or
`OPENAI_API_KEY`), and optionally configures Feishu. In a non-interactive shell,
or with `--no-wizard`, it only seeds the config files.

```bash
npm run setup
npm run ui
```

Edit only local ignored files:

- `.env`
- `config/config.yaml`
- files under `data/`

The local UI can edit the common config and `.env` values directly. Secret
fields are saved locally and are not echoed back in the page.

After installing the background service, the UI should be reachable at
`http://127.0.0.1:14573`. If that port is occupied, run `npm run ui:open`; it
opens the URL saved by the running service in `data/runtime/ui.json`. The running
version is shown in the UI footer and by `npm run doctor`.

### Web chat entry

After logging into the console, open the **Chat** page to talk to the assistant
directly (streaming replies, stop generation). It can trigger plan/review/weekly,
answer with vault/OKR evidence, and capture todos — all without Feishu. Verify a
full turn once: send a message, trigger a plan, watch it stream, capture a todo.
Feishu is now an optional mobile channel, not required for the core loop.

Use Setup -> Codex to configure the customer's Codex installation:

- Click `Find Codex CLI` first.
- If it is not found, click `Choose CLI` and select the local `codex`
  executable.
- Set `Codex home` only when the customer's credentials are not in `~/.codex`.
- Click `Test Codex login`. If it is not logged in, run `codex login` in
  Terminal for the same binary/home, then rerun Checks.

Use Sources -> Feishu to add one or more collapsed Feishu profiles. Feishu field
names mirror Feishu Developer Platform where applicable: `App ID` and
`App Secret` come from app credentials; `Chat ID` is an IM conversation ID such
as `oc_xxx`. Multiple Feishu profiles share the same App ID/App Secret in this
version. Use Sources -> Other sources to import GitHub or Linear
credentials from local standard locations with the per-source discovery buttons
when available. Secret fields are masked by default and can be revealed with the
eye button.

Use Sources -> Vault -> Choose folder to select the local vault path on macOS.
`Checks n/n OK` summarizes local dependency/config checks; `Run Checks` reruns
them.

## 3. Required Local Values

For a Feishu-only alpha, configure:

- `FEISHU_CHAT_ID` in `.env`
- `LARK_APP_ID` and `LARK_APP_SECRET` in `.env`
- `output.feishu.provider` in `config/config.yaml`; use `auto` or `sdk` for official Feishu SDK output
- `lark-cli doctor` passing locally only when Feishu source collection, feedback polling, decision chat creation, or lark-cli output fallback is enabled
- Codex CLI signed in locally, or `OPENAI_API_KEY`
- any enabled source credentials, such as `GITHUB_TOKEN`; `LINEAR_API_KEY` is preferred but optional when Codex Linear fallback is available

Leave unsupported sources disabled for the first run.

## 4. Local Verification

```bash
npm run doctor
npm run collect
npm run plan -- --no-send
```

If the plan output looks correct, send one real message:

```bash
npm run plan
```

Optional Feishu feedback loop:

```bash
npm run feedback:poll -- --no-send
```

Then enable `feedback.feishu.enabled`, send `daily-os status` in the configured
chat, and run `npm run feedback:poll` to verify that the bot replies.

## 5. Privacy Gate

Before opening a PR or publishing:

```bash
npm run privacy:scan
git status --short
```

Do not commit:

- `.env`
- `config/config.yaml`
- `data/`
- `logs/`
- `dist/`
- Feishu chat IDs, API tokens, private vault paths, snapshots, or memory files

## 6. Backup / Restore

Pack and restore the local `data/` + `memory-vault/` (and `config/` in the Docker
shape) volumes:

```bash
./scripts/backup.sh
./scripts/restore.sh backups/daily-os-backup-<timestamp>.tgz --force
```

Stop the service first so the SQLite store is quiescent. `restore.sh` moves any
existing dir aside to `*.pre-restore-*` before extracting, so a bad restore is
itself reversible.

## 7. Known Limits

- Web chat is the in-console interaction entry; Feishu is now an optional mobile
  channel and the only *push* output for scheduled workflows.
- Remote vault-gate is intentionally not required.
- The current UI is a local browser dashboard, not a signed `.app` or DMG yet.
- Feishu feedback commands are supported through polling, not webhooks.
