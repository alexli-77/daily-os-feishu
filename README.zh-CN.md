# Daily OS Feishu

Daily OS Feishu 是一个优先支持 Mac、本地优先、只集成飞书的个人工作流 Agent。它会采集你配置的数据源，调用本机 Codex CLI 或 OpenAI API 生成日计划、日复盘、周复盘，然后通过 `lark-cli` 发送到飞书。

这个仓库是通用版本，不包含任何个人 token、知识库内容、浏览器数据、memory 或飞书 ID。所有私密配置都放在 `.env`、`config/config.yaml` 和被 git 忽略的 `data/` 目录中。

## 第一版范围

- 在 macOS 上以 CLI 或 `launchd` 后台服务运行。
- 提供本地浏览器 UI，用于配置、数据源开关、环境检查和手动触发。
- 通过 `lark-cli` 发送飞书消息。
- 默认使用本机已登录的 Codex CLI，也支持 OpenAI API 作为 fallback。
- 支持可配置数据源：
  - 本地 vault 文件。远程 vault-gate 可以以后再启用。
  - Chrome 快照文件。
  - Apple Calendar 快照 JSON。
  - 飞书日历、任务、文档、IM 历史。
  - GitHub assigned issues。
  - Linear assigned work，可用 `LINEAR_API_KEY` 直连；为空时尝试 Codex Linear fallback。

## 环境要求

- macOS
- Node.js 22+
- 本机已登录 Codex CLI，或配置 `OPENAI_API_KEY`
- 已安装并登录 `lark-cli`
- `.env` 中配置飞书 chat ID

## 快速开始

```bash
npm ci
npm run alpha:smoke:ci
npm run setup
npm run ui
```

然后编辑：

- `.env`
- `config/config.yaml`

常用配置也可以直接在本地 UI 中填写；它只会写入被 git 忽略的本地文件。

检查环境：

```bash
npm run doctor
npm run collect
```

手动触发。第一次生成建议先用 `--no-send`，确认内容后再真实发送：

```bash
npm run plan -- --no-send
npm run review
npm run weekly
npm run feedback:poll
```

安装 macOS 定时服务：

```bash
npm run build
npm run service:install
```

卸载：

```bash
npm run service:uninstall
```

## 配置方式

把 `config/config.example.yaml` 复制成 `config/config.yaml`。示例配置中列出了所有支持的数据源和输出选项。

密钥从 `.env` 读取，模板是 `.env.example`。

本地 UI 启动方式：

```bash
npm run ui
```

它可以保存常用配置、保存 `.env` 值、运行 `doctor`、发送飞书测试消息、手动触发 plan/review/weekly、轮询飞书反馈，并安装或卸载本机 `launchd` 服务。密钥字段只保存在本地，页面不会回显原文。

Sources 页里的 Feishu 支持配置多个 profile。每个 profile 都有自己的
`id`、`identity`、日历/任务/文档/IM 开关，以及 IM chat env 名称。profile 默认折叠显示，
折叠摘要里会显示 profile `id`。Feishu profile 采用手动配置：在 UI 里配置 profile
ID 和 identity，然后在 `.env` 中填写 `IM chat env` 指向的变量，例如
`FEISHU_CHAT_ID=oc_xxx`。

Feishu 必填项：

- `LARK_APP_ID`：飞书开放平台应用凭证页里的 `App ID`。
- `LARK_APP_SECRET`：飞书开放平台应用凭证页里的 `App Secret`。
- `lark-cli` 认证：运行 `lark-cli doctor`，按提示完成本机认证。
- `FEISHU_CHAT_ID`：当需要发送输出、轮询反馈，或某个 profile 启用 IM history 时必填。
- Profile `identity`：日历/任务/IM 走用户授权时选 `user`；机器人已进目标群且具备权限时选 `bot`。

Feishu source profile 是 Daily OS 的本地设置，不是飞书开放平台凭证：

- `Display name`：UI 中显示的本地名称。
- `Access identity`：`user` 或 `bot`，对应 lark-cli 调用时使用的 `--as` 身份。
- `Calendar`、`Tasks`、`Docs`、`IM history`：数据源开关。`Calendar` 和 `Tasks` 使用所选 `Access identity`；`IM history` 还需要 Chat ID env 对应的值。
- Advanced local settings：`Local source key` 控制证据名称，`Chat ID env var` 是保存飞书 `Chat ID` 的 `.env` 变量名。大多数用户保持默认即可。

当前版本中，多个 Feishu source profile 共享同一套 `App ID` 和 `App Secret`。
如果你需要接入不同飞书应用或不同租户，暂时用单独的本地 app config 运行。

手动查找 chat ID：可以从已知飞书会话复制，或在 UI 外运行
`lark-cli im +chat-list --as user --types group,p2p --format json`，再把目标会话的
`oc_xxx` 填入 `.env`。

Other sources 里 GitHub 和 Linear 各有独立的本地查找按钮：GitHub 会查 `.env`、
环境变量和 `gh auth token`；Linear 会查 `.env`、环境变量，以及可用的本地 `linear`/`linear-cli`
认证命令。找到后只保存到本地，不打印密钥。密钥字段默认显示 `********`，点击输入框旁边的眼睛按钮才显示本地原文。

Linear 推荐填写 `LINEAR_API_KEY`，这样会稳定直连 Linear API。若启用了 Linear
但 key 为空，应用会调用本机 Codex CLI，尝试使用 Codex 账号已经关联的 Linear
作为 fallback。这个 fallback 不阻塞执行：Checks 里会显示 warning，而不是失败。

Service 里的按钮只管理 macOS 定时任务。`Install` 是创建 `launchd` 后台定时任务；
`Uninstall` 是删除这个定时任务。它们不是安装或卸载整个项目。

Vault 的 local 模式提供 `Choose folder` 按钮，会打开 macOS 文件夹选择器，
并把选中的路径写入本地配置。顶部的状态例如 `Checks 4/4 OK` 表示本地环境检查结果；
`Run Checks` 会重新检查本地依赖和必填配置。

`Logs` 页会显示本地 UI/API 请求状态和 action 执行生命周期。日志保存在
`data/logs/ui-network.jsonl`，不记录请求正文、响应正文或密钥，并自动只保留最近 7 天。

完整的第一台外部 Mac 安装验收清单见
[`docs/first-install-checklist.zh-CN.md`](docs/first-install-checklist.zh-CN.md)。

默认 LLM 配置是：

```yaml
llm:
  provider: "codex"
  model: "default"
```

这会调用本机 Codex CLI，并让 Codex 使用当前账号支持的默认模型。

## Vault 集成

第一版不要求 vault-gate。默认情况下，vault 采集是关闭的。如果要用本地 vault，可以启用 `sources.vault` 并设置 `provider: "local"`。

远程 vault 模式是后续可选能力。启用后依赖 vault-gate：

- `GET /scan`
- `GET /read?path=...`

本地 vault 模式会直接读取配置中的 markdown 文件。

Agent 会把缺失数据当成缺失证据处理，不会直接写入 vault。

## 飞书集成

本项目通过 `lark-cli` 调用飞书能力。目标会话通过 `.env` 配置：

```env
LARK_APP_ID=
LARK_APP_SECRET=
FEISHU_CHAT_ID=
```

字段名对应飞书开放平台应用凭证页中的 `App ID` 和 `App Secret`。

可以用 `output.feishu.identity` 选择 `bot` 或 `user` 身份。

## 飞书反馈命令

Alpha 可以轮询一个配置好的飞书会话，处理轻量命令。先启用：

```yaml
feedback:
  feishu:
    enabled: true
    command_prefix: "daily-os"
```

然后运行：

```bash
npm run feedback:poll
```

支持的消息：

- `daily-os status`
- `daily-os remember <text>`
- `daily-os feedback <text>`
- `daily-os plan`
- `daily-os review`
- `daily-os weekly`

`remember` 会写入 long-term memory。`feedback` 会写入本地 feedback log。
默认都在被忽略的 `data/` 路径下。

## 隐私边界

发 PR 或发布前先运行本地隐私检查：

```bash
npm run privacy:scan
```

不要提交：

- `.env`
- `config/config.yaml`
- `data/`
- `logs/`
- `dist/`

这些路径默认已经加入 `.gitignore`。

## 设计说明

Alpha 版本刻意保持 local-first：数据源连接器、个人记忆、token、chat ID
和 vault 路径都留在用户自己的本地配置文件中，不提交到仓库。
