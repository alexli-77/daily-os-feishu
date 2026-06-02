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
lark-cli --help
```

Then create local config:

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

Use Sources -> Feishu to add one or more collapsed Feishu profiles. Feishu field
names mirror Feishu Developer Platform where applicable: `App ID` and
`App Secret` come from app credentials; `Chat ID` is an IM conversation ID such
as `oc_xxx`. Use Sources -> Other sources to import GitHub or Linear
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
- `lark-cli doctor` passing locally
- Codex CLI signed in locally, or `OPENAI_API_KEY`
- `output.feishu.identity` in `config/config.yaml`
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

## 6. Known Alpha Limits

- Feishu is the only IM output in v0.
- Remote vault-gate is intentionally not required in v0.
- The current UI is a local browser dashboard, not a signed `.app` or DMG yet.
- Feishu feedback commands are supported through polling, not webhooks.
