# Daily OS Feishu

Daily OS Feishu is a Mac-first, Feishu-only personal workflow agent. It collects configurable local and remote signals, asks your local Codex CLI or OpenAI API to prepare a daily/weekly message, and sends the result to Feishu through `lark-cli`.

This repository is intentionally generic. It does not include personal tokens, vault content, browser data, memory, or Feishu identifiers. All private values live in `.env`, `config/config.yaml`, and ignored `data/` files.

## First Version Scope

- Runs on macOS as a CLI or a `launchd` background service.
- Includes a local browser UI for setup, source toggles, checks, and manual triggers.
- Sends output to Feishu through `lark-cli`.
- Uses local Codex CLI by default, with OpenAI API as an optional fallback.
- Supports configurable sources:
  - Vault knowledge base through local files. Remote vault-gate can be enabled later.
  - Chrome snapshots from exported local files.
  - Apple Calendar snapshots from exported local JSON.
  - Feishu calendar, tasks, docs, and IM history through `lark-cli`.
  - GitHub assigned issues through `GITHUB_TOKEN`.
  - Linear assigned work through `LINEAR_API_KEY`.

## Requirements

- macOS
- Node.js 22+
- Codex CLI signed in locally, or `OPENAI_API_KEY`
- `lark-cli` installed and authenticated
- A Feishu chat ID configured in `.env`

## Quick Start

```bash
npm ci
npm run alpha:smoke:ci
npm run setup
npm run ui
```

Edit:

- `.env`
- `config/config.yaml`

You can also edit the common fields in the local UI. It writes only to ignored
local files.

Then check the installation:

```bash
npm run doctor
npm run collect
```

Run workflows manually. Use `--no-send` for the first generated result:

```bash
npm run plan -- --no-send
npm run review
npm run weekly
npm run feedback:poll
```

Install the macOS scheduler:

```bash
npm run build
npm run service:install
```

Remove it:

```bash
npm run service:uninstall
```

## Configuration Model

Copy `config/config.example.yaml` to `config/config.yaml`. The checked-in example shows every supported source and output option.

Secrets are read from `.env`; use `.env.example` as the template.

The local UI starts with:

```bash
npm run ui
```

It can save common config fields, save `.env` values, run `doctor`, send a
Feishu test message, trigger plan/review/weekly workflows, poll Feishu feedback,
and install or uninstall the local `launchd` service. Secret fields are stored
locally and are not echoed back in the UI.

In the Sources tab, Feishu can be configured as multiple profiles. Each profile
has its own `id`, `identity`, calendar/tasks/docs/IM switches, and IM chat env
name. Profiles are shown as collapsed rows by default. The Other sources section
has separate local discovery buttons for GitHub and Linear credentials: GitHub
uses `.env`, process env, or `gh auth token`; Linear uses `.env`, process env,
or available local `linear`/`linear-cli` auth commands. Found values are saved
locally without printing the secret. Secret fields show `********` by default;
use the eye button next to the field to reveal the local value.

The Service buttons only manage the macOS scheduler. `Install` creates the
`launchd` job that runs the workflow on schedule; `Uninstall` removes that job.
They do not install or remove the project itself.

Vault local mode has a `Choose folder` button that opens the macOS folder
picker and writes the selected path into the local config. The top status shows
local setup checks, for example `Checks 4/4 OK`; `Run Checks` reruns those local
dependency and required-config checks.

For the full first-install checklist, see
[`docs/first-install-checklist.md`](docs/first-install-checklist.md).

The default LLM provider is:

```yaml
llm:
  provider: "codex"
  model: "default"
```

This calls your local Codex CLI and lets Codex choose the model supported by the account already configured on the Mac.

## Vault Integration

The first version does not require vault-gate. By default, vault collection is disabled. To use a local vault, enable `sources.vault` and set `provider: "local"`.

Remote vault mode is optional for later versions. When enabled, it expects a vault-gate service:

- `GET /scan`
- `GET /read?path=...`

Local vault mode reads configured markdown files directly from `local_path`.

The agent treats missing vault data as missing evidence. It does not write directly to your vault.

## Feishu Integration

This project shells out to `lark-cli` for Feishu capabilities. Configure the target chat with:

```env
FEISHU_CHAT_ID=
```

Use `output.feishu.identity` to choose `bot` or `user`.

## Feishu Feedback Commands

The alpha can poll a configured Feishu chat for lightweight commands. Enable:

```yaml
feedback:
  feishu:
    enabled: true
    command_prefix: "daily-os"
```

Then run:

```bash
npm run feedback:poll
```

Supported messages:

- `daily-os status`
- `daily-os remember <text>`
- `daily-os feedback <text>`
- `daily-os plan`
- `daily-os review`
- `daily-os weekly`

`remember` appends to long-term memory. `feedback` appends to the local feedback
log. Both files live under ignored `data/` paths by default.

## Privacy

Run the local privacy gate before opening a PR or publishing:

```bash
npm run privacy:scan
```

Do not commit:

- `.env`
- `config/config.yaml`
- `data/`
- `logs/`
- `dist/`

These paths are ignored by default.

## Design Notes

The alpha is intentionally local-first: source connectors, personal memory,
tokens, chat IDs, and vault paths stay in user-owned config files that are not
committed to the repository.
