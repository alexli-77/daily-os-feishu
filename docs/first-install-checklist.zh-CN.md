# 第一台外部 Mac 安装验收清单

把 alpha 交给另一台 Mac 使用前，先按这份清单验收。

## 1. 干净安装

```bash
git clone <repo-url>
cd daily-os-feishu
npm ci
npm run alpha:smoke:ci
```

`alpha:smoke:ci` 会使用临时配置，关闭飞书发送，关闭所有私有数据源，并确认通用包可以完成构建和空数据采集，不依赖本地 secret。

## 2. 本地账号准备

安装并登录本地工具：

```bash
codex --version
codex login status
# 使用飞书数据源采集或 lark-cli 回退时需要：
lark-cli --help
```

首次配置。在交互式终端里，`npm run setup` 会进入向导：设置控制台 admin 密码
（scrypt 加盐哈希存入 SQLite，不落明文）、配置 LLM provider + API key
（BYOK：`ANTHROPIC_API_KEY` 或 `OPENAI_API_KEY`）、并可选配置飞书。非交互终端
（或加 `--no-wizard`）时只 seed 配置文件。

```bash
npm run setup
npm run ui
```

只编辑这些被 git 忽略的本地文件：

- `.env`
- `config/config.yaml`
- `data/` 下的文件

本地 UI 可以直接编辑常用配置和 `.env` 值。密钥字段只会保存在本地，
页面不会回显原文。

安装后台服务后，UI 默认可以从 `http://127.0.0.1:14573` 打开。如果这个端口被占用，
运行 `npm run ui:open`，它会打开后台服务保存到 `data/runtime/ui.json` 的实际 URL。
版本号显示在 UI 页脚和 `npm run doctor` 输出中。

### Web chat 入口

登录控制台后，进入 **Chat** 页可直接与助手对话（流式输出 + 停止生成）。它能触发
plan/review/weekly、带 vault/OKR 证据问答、快捷捕获 todo——全程不需要飞书。首次
验一遍完整对话：发消息 → 触发一次 plan → 看流式结果 → 勾一个 todo。飞书现在退为
可选的移动通道，核心闭环不依赖它。

在 Setup -> Codex 配置客户电脑上的 Codex：

- 先点击 `Find Codex CLI`。
- 如果找不到，点击 `Choose CLI`，手动选择本机的 `codex` 可执行文件。
- 只有当客户没有使用默认 `~/.codex` 凭证目录时，才需要填写 `Codex home`。
- 点击 `Test Codex login`。如果未登录，请在 Terminal 中用同一套 binary/home 运行
  `codex login`，然后回到 UI 重新 Run Checks。

在 Sources -> Feishu 可以添加一个或多个默认折叠的飞书 profile。Feishu 字段名会尽量和飞书开放平台一致：
`App ID` 和 `App Secret` 来自应用凭证页；`Chat ID` 是 IM 会话 ID，例如 `oc_xxx`。
当前版本中，多个 Feishu profile 共享同一套 App ID/App Secret。
在 Sources -> Other sources 里可以分别点击 GitHub 或 Linear 的本地查找按钮，从本地标准位置导入凭证。
密钥字段默认用星号遮住，可以用眼睛按钮显示原文。

在 Sources -> Vault -> Choose folder 可以用 macOS 文件夹选择器选择本地 vault 路径。
`Checks n/n OK` 是本地依赖/配置检查摘要；`Run Checks` 会重新检查。

## 3. 必填本地配置

Feishu-only alpha 至少需要：

- `.env` 中的 `FEISHU_CHAT_ID`
- `.env` 中的 `LARK_APP_ID` 和 `LARK_APP_SECRET`
- `config/config.yaml` 中的 `output.feishu.provider`；推荐 `auto`，也可以用 `sdk` 强制官方 SDK 输出
- 只有启用飞书数据源采集、反馈轮询、决策校准拉群，或 lark-cli 输出回退时，才需要本机 `lark-cli doctor` 通过
- 本机已登录 Codex CLI，或配置 `OPENAI_API_KEY`
- 已启用数据源所需的凭证，例如 `GITHUB_TOKEN`；`LINEAR_API_KEY` 推荐填写，但如果可用 Codex Linear fallback，则不是必填

第一次运行时，把暂不支持或暂未配置的数据源保持 disabled。

## 4. 本地验证

```bash
npm run doctor
npm run collect
npm run plan -- --no-send
```

如果生成内容正确，再发送一条真实飞书消息：

```bash
npm run plan
```

可选的飞书反馈闭环：

```bash
npm run feedback:poll -- --no-send
```

然后启用 `feedback.feishu.enabled`，在配置好的群里发送 `daily-os status`，
再运行 `npm run feedback:poll`，确认 bot 会回复。

## 5. 隐私检查

发 PR 或发布前运行：

```bash
npm run privacy:scan
git status --short
```

不要提交：

- `.env`
- `config/config.yaml`
- `data/`
- `logs/`
- `dist/`
- 飞书 chat ID、API token、私有 vault 路径、快照或 memory 文件

## 6. 备份 / 恢复

打包并恢复本地 `data/` + `memory-vault/`（Docker 形态还含 `config/`）卷：

```bash
./scripts/backup.sh
./scripts/restore.sh backups/daily-os-backup-<时间戳>.tgz --force
```

先停服务，保证 SQLite 处于静止态。`restore.sh` 会把已有目录先移到
`*.pre-restore-*` 再解包，所以恢复出错本身也可回退。

## 7. 已知边界

- Web chat 是控制台内的交互入口；飞书现在是可选移动通道，也是定时 workflow 的
  唯一*推送*输出。
- 不要求远程 vault-gate。
- 当前 UI 是本地浏览器 dashboard，还不是已签名的 `.app` 或 DMG。
- 飞书反馈命令通过轮询支持，还不是 webhook。
