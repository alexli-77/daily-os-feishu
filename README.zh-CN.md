# Daily OS Feishu

Daily OS Feishu 是一个优先支持 Mac、本地优先、只集成飞书的个人工作流 Agent。它会采集你配置的数据源，调用本机 Codex CLI 或 OpenAI API 生成日计划、日复盘、周复盘，然后通过飞书官方 SDK 或兼容的 `lark-cli` 路径发送到飞书。

这个仓库是通用版本，不包含任何个人 token、私人知识库内容、浏览器数据、个人 memory 或飞书 ID。仓库只包含一个通用 memory vault 模板。所有私密配置都放在 `.env`、`config/config.yaml` 和被 git 忽略的 `data/` 目录中。

## 第一版范围

- 在 macOS 上以 CLI 或 `launchd` 后台服务运行。
- 提供本地浏览器 UI，用于配置、数据源开关、环境检查和手动触发。
- 配置 `LARK_APP_ID` 和 `LARK_APP_SECRET` 后，通过飞书官方 SDK 发送 workflow 输出；缺少 SDK 凭证时可回退到 `lark-cli`。
- 可选 Feishu websocket interaction layer，用于直接在聊天里发命令和点操作卡片。
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
- 使用 SDK 输出或飞书实时交互层时，需要配置 `LARK_APP_ID` 和 `LARK_APP_SECRET`
- 采集飞书日历/任务/文档/IM 历史，或使用 lark-cli 输出回退时，需要已安装并登录 `lark-cli`
- 如果要发送飞书输出、轮询反馈或采集 IM history，需要在 `.env` 中配置飞书 chat ID

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

配置完成后，日常使用的总入口是：

```bash
npm run start
```

它会打开本地 UI，启动 plan/review/weekly 的前台 scheduler，并在
`interaction.feishu.enabled=true` 时启动飞书 websocket 实时交互层。保持这个终端窗口运行即可。
如果 Mac 进入睡眠，本地进程和飞书长连接也会暂停；醒来后，scheduler 会在 3 小时窗口内补跑错过的任务。

检查环境：

```bash
npm run doctor
npm run collect
```

手动触发。第一次生成建议先用 `--no-send`，确认内容后再真实发送：

```bash
npm run plan -- --no-send
npm run chat
npm run progress
npm run review
npm run weekly
npm run feedback:poll
```

## 飞书聊天上下文建议

Daily OS 可以检查最近的飞书 IM history，并提出 todo、日历、文档、Linear、记忆库或今日计划的变更建议。
这一层只做建议，不会自动写入外部系统，避免把聊天里的误读直接变成任务变更。

命令行：

```bash
npm run chat
npm run chat -- todo
npm run chat -- review
```

飞书实时交互中发送：

```text
daily-os chat
daily-os chat todo
daily-os chat review
```

它会识别新增待办、延期/改期、完成信号、阻塞、负责人变化、日历/文档更新线索，以及和现有 evidence
可能冲突的事项。

扫描窗口按使用场景定义：

- `manual`：最近已配置的 IM history 消息。
- `todo`：昨天 00:00 到今天 `daily_plan.time`，适合生成今日 todo 前使用。
- `review`：今天 `daily_plan.time` 到当前时间，并且不超过 `daily_review.time`，适合日复盘前使用。

推荐只配置 `chat_analysis.default_mode`、`chat_analysis.max_messages` 和
`chat_analysis.max_suggestions`。Feishu source profile 里的 `im_history.limit`
建议不小于 `chat_analysis.max_messages`。

计划、复盘和周报发送到飞书时默认会压缩成一屏摘要。完整内容仍然保存在本地；
需要展开最近一次完整内容时，在飞书里发送 `daily-os details`。

## 今日进展捕获

Daily OS 可以在晚间复盘前先收集“可能的今日进展”。这些候选只来自证据源，不会直接当成事实；
用户确认后才会写入今日进展账本。

命令行：

```bash
npm run progress
npm run progress:confirm
```

飞书实时交互中发送：

```text
daily-os progress
```

Daily OS 会回复一张确认卡片。点击 **确认全部** 后，候选进展会写入
`progress.ledger_dir` 下按日期保存的 progress ledger。日复盘和周复盘会把这个 ledger
作为 `progress_ledger` 证据源读取。如果 scheduler 到了
`progress.no_progress_reminder_time` 仍没有看到候选进展，会发一条轻提醒，而不是等到晚上才让用户回忆。

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

日常使用建议优先运行 `npm run start`。只有想单独打开配置面板、不启动前台 scheduler
和飞书实时交互服务时，才单独运行 `npm run ui`。

Setup 页提供 Codex 配置：

- `Find Codex CLI`：从客户本机 PATH 和常见安装路径查找 Codex CLI，并保存 `CODEX_BIN`。
- `Choose CLI`：当自动查找失败时，手动选择 `codex` 可执行文件。
- `Codex home`：可选。客户如果没有使用默认 `~/.codex`，可以在这里指定 Codex 凭证目录。
- `Test Codex login`：用当前配置运行 `codex --version` 和 `codex login status`。

如果提示 Codex 未登录，请在 Terminal 中用同一个 binary/home 运行 `codex login`，再回 UI 里
重新 Run Checks。应用不会保存 Codex 凭证，只会保存客户本机 Codex 安装位置和可选 home 路径。

Sources 页里的 Feishu 先点 **Auto configure from lark-cli**。应用会读取本机
`lark-cli` 里的 App ID、用户 open_id、可用身份和已授权 scope，并把能安全保存的本地值写入
`.env`。它无法可靠判断的内容，会作为剩余手动步骤提示出来。

Feishu 配置现在按能力需要才填写：

- `lark-cli` 认证：飞书采集、lark-cli 发送和轮询都需要。若自动配置找不到，请运行 `lark-cli config init` 和 `lark-cli auth login`。
- `FEISHU_CHAT_ID`：只有需要发送输出、轮询反馈，或某个 profile 启用 IM history 时才需要。
- Docs URL/token：只有启用 Docs 的 profile 需要。在 profile 中按行填写 `名称 | 文档 URL 或 token`。Docs 采集默认走 `lark-cli docs +fetch --api-version v2 --as user`，也就是复用本机已登录用户对文档的访问权限；读取文档不使用 Chat ID。
- `LARK_APP_ID` 和 `LARK_APP_SECRET`：只有启用可选的 Feishu websocket interaction layer 时才需要。App ID 通常可从 lark-cli 自动发现；App Secret 不能从 lark-cli/keychain 读回，所以只有启用 interaction 时才手动粘贴。
- Profile `identity`：日历/任务/文档/IM 走用户授权时选 `user`；机器人已进目标群且具备权限时选 `bot`。

每个 Feishu profile 都有自己的本地显示名、`identity`、日历/任务/文档/IM 开关、文档列表和
IM chat env 名称。profile 默认折叠显示，避免配置页太乱。

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

可以用 Linear project filters 避免无关项目进入计划。`Allowed projects` 是精确项目名
白名单；为空时表示不限制项目，但会排除 `Blocked projects` 里的项目名。这个过滤会同时作用于
Linear API 直连和 Codex Linear fallback。

如果你的 Linear 事项按 team 管，而不是按 project 管，请用 `Allowed teams` 或
`Blocked teams`。Team 过滤可以填 team name 或 team key，匹配时会忽略大小写、空格、
连字符和下划线。

没有配置 Linear allowlist 时，应用默认抓取“分配给我”的未完成 issue。配置了
`Allowed projects` 或 `Allowed teams` 后，应用会抓这些范围下的未完成 issue，
即使它们尚未分配 assignee，然后再执行本地 allow/block 过滤。

Service 里的按钮只管理 macOS 后台服务。`Install` 会创建 `launchd` 任务，用来运行本地 UI、scheduler 和飞书实时长连接；
`Uninstall` 只删除这个后台任务。它们不是安装或卸载整个项目。launchd 后台服务会使用随机本地 UI 端口，避免和前台配置页冲突。

`service.prevent_sleep.enabled=true` 时，Daily OS 运行期间会启动 `caffeinate -i`，防止 Mac 因为空闲进入睡眠。
但 macOS 仍可能在 MacBook 盒盖、尤其是电池状态下强制睡眠。想要稳定常驻，建议接电保持唤醒，或部署到常开机器。

Vault 的 local 模式提供 `Choose folder` 按钮，会打开 macOS 文件夹选择器，
并把选中的路径写入本地配置。顶部的状态例如 `Checks 4/4 OK` 表示本地环境检查结果；
`Run Checks` 会重新检查本地依赖和必填配置。

这里有两个互相独立的 vault 概念：

- `sources.vault.local_path` 是用户已有的知识库 vault，作为证据数据源读取。
- `memory.repository_path` 是 Daily OS 自己的工作记忆库，用来放长期目标、项目、
  commitments、review notes 和待确认的 memory 更新。

Memory repository 区域用于配置 Daily OS 的长期记忆库。`memory.repository_path`
留空时使用仓库自带的通用模板 `memory-vault/default`。真实使用时，建议选择或填写一个
用户自己的私有 memory repository 文件夹。每日运行日志和手动 `remember` 内容仍默认写到
被 git 忽略的 `data/memory` 路径。

决策校准也放在 memory repository 中。内置模板包含 `decision-policy.yaml`、
`decision-policy.md` 和 `policy-skill/SKILL.md`。第一天不要要求用户填写复杂权重，
而是通过对话逐步磨合规则。

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

第一版不要求 vault-gate。默认情况下，知识库 vault 采集是关闭的。如果要用本地知识库 vault，可以启用 `sources.vault`，设置 `provider: "local"`，并填写 `sources.vault.local_path`。

远程 vault 模式是后续可选能力。启用后依赖 vault-gate：

- `GET /scan`
- `GET /read?path=...`

本地 vault 模式会直接读取 `sources.vault.local_path` 下配置的 markdown 文件。

Agent 会把缺失数据当成缺失证据处理，不会直接写入 vault。

## Memory Repository

Daily OS 每次运行 workflow 前，会从一个 Markdown 仓库读取长期工作记忆。仓库内置默认模板在
`memory-vault/default`，只包含通用的 identity、preferences、OKR、projects、
commitments、reviews 和 memory candidates 起始文件。

真实用户的私有记忆库可以这样配置：

```yaml
memory:
  repository_path: "/path/to/private-daily-os-memory"
```

如果 `repository_path` 为空，应用会使用内置模板。模板可以公开；私人记忆应该放在仓库外部。

## 决策校准

Daily OS 支持一个首次使用的决策校准流程。它会创建或复用一个飞书私有群，让用户和 bot
像聊天一样讨论：什么任务更重要、哪些可以交给 Codex、哪些必须用户本人判断。确认过的规则
会变成长期 policy；还没确认的想法只作为 calibration notes 或 pending candidates。

可以在 UI 中点击 **Start decision onboarding**，也可以用 CLI：

```bash
npm run dev -- onboarding start
```

这个命令会：

- 确保 memory repository 中存在决策 policy 文件；
- 创建一个由 `decision.onboarding.chat_name` 命名的私有飞书群；
- 邀请 owner `open_id`；
- 把群 ID 保存到 `DAILY_OS_DECISION_CHAT_ID` 和 `decision.onboarding.state_path`；
- 向该群发送第一条决策校准引导消息。

底层方式参考 `lark-coding-agent-bridge`：由 bot 创建私有群，并用用户 `open_id` 邀请用户。
飞书应用需要 `im:chat` 和 bot 发消息权限。

在 Feishu interaction mode 中，也可以发送：

- `daily-os policy`：查看当前决策 policy 文件。
- `daily-os calibrate`：创建或复用决策校准群，并引导用户去那里继续磨合规则。

决策校准群创建后，用户可以在该群里直接自然聊天，不需要每句话都带 `daily-os` 前缀，也不需要
@bot。系统会用当前 `decision-policy.yaml`、`decision-policy.md` 和候选规则记录作为上下文，
生成中文回复，并把本轮校准对话追加到 `decision.candidates_path`。第一版只记录候选和对话，
不会静默改写长期规则。

首次安装建议保持 `decision.onboarding.auto_create_on_setup: false`，避免工具一启动就意外拉群。

## 飞书集成

Workflow 输出可以使用飞书官方 SDK，和 `lark-coding-agent-bridge` 的交互层思路一致。目标会话和应用凭证通过 `.env` 配置：

```env
FEISHU_CHAT_ID=
LARK_APP_ID=
LARK_APP_SECRET=
```

然后在 `config/config.yaml` 或 UI 里选择输出通道：

```yaml
output:
  feishu:
    enabled: true
    provider: "auto" # auto | sdk | lark_cli
    chat_id_env: "FEISHU_CHAT_ID"
    send_mode: "markdown"
```

推荐默认使用 `auto`：如果 `LARK_APP_ID` 和 `LARK_APP_SECRET` 已配置，就走官方 SDK；否则回退到 `lark-cli`。如果想强制 bot SDK 输出，选 `sdk`；如果想保持旧路径，选 `lark_cli`。

使用 SDK 输出且 `send_mode: "markdown"` 时，计划/复盘摘要会以飞书可交互卡片发送，卡片上有「展开完整内容」「确认今日进展」「生成复盘」「重新生成」等按钮。按钮回调需要飞书 interaction layer 正在运行，并且飞书应用已启用卡片 callback 事件。如果飞书提示“该应用的未配置卡片回调”，请到同一个 App ID 的飞书开发者后台启用交互卡片回调/事件投递，并保持本机 `npm run start` 运行。卡片也会保留文字兜底：`daily-os details`。

当前版本中，飞书日历、任务、文档、IM 历史采集仍然走 `lark-cli`。这样第一步迁移只聚焦消息交互层，不会一次性要求客户开所有飞书 scope。

## Feishu Interaction Layer

Interaction layer 是可选能力，和定时 workflow 分开。它会在本机保持到飞书的 websocket
长连接，接收聊天事件，按 chat/topic scope 合并消息，然后把支持的命令路由到现有 Daily OS
workflow core。

配置：

```yaml
interaction:
  feishu:
    enabled: true
    command_prefix: "daily-os"
    require_mention_in_groups: true
    debounce_ms: 600
    reply_mode: "markdown"
    session_catalog_path: "./data/memory/feishu-session-catalog.json"
    agent_mode:
      enabled: false
      workdir: ""
      sandbox: "read-only"
      include_memory: true
      include_evidence: false
      context_pack:
        enabled: true
        include_latest_workflow: true
        include_progress_ledger: true
        include_decision_policy: true
        include_evidence_summary: true
        max_sources: 12
        max_items_per_source: 4
        max_chars_per_item: 900
      timeout_ms: 300000
    security:
      owner_open_id_env: "FEISHU_OWNER_OPEN_ID"
      admin_open_ids: []
      allowed_user_open_ids: []
      allowed_chat_ids: []
      access_level: "read_only"
      allowed_workspaces: []
```

启动：

```bash
npm run interaction:feishu
```

支持的消息和 feedback polling 一致：

- `daily-os status`：返回带 Plan、Review、Weekly 按钮的操作卡片。
- `/new` 或 `daily-os new`：清除当前飞书 chat/topic 的远程会话。
- `daily-os details`：展开最近一次计划、日复盘或周复盘的完整内容。
- `daily-os chat [todo|review]`：按场景分析飞书聊天上下文，提出 todo、日历、文档和计划变更建议。
- `daily-os remember <text>`：写入 long-term memory。
- `daily-os feedback <text>`：写入本地 feedback log。
- `daily-os policy`：查看当前决策 policy 和 policy-skill 路径。
- `daily-os calibrate`：创建或复用决策校准群。
- `daily-os plan`、`daily-os review`、`daily-os weekly`：运行 workflow，并在同一个聊天里回复。

当 `interaction.feishu.agent_mode.enabled` 为 true 时，无法识别为 Daily OS 固定命令的消息，
会作为自由文本输入交给 Codex。Prompt 会包含结构化 bridge context，例如 chat id、
sender id、thread id、message id、scope id、当前 session metadata、Daily OS memory，
以及默认开启的精简 context pack。这个 context pack 会包含最近一次 workflow 摘要、
今日 progress ledger、已确认决策规则、待确认规则候选、数据源健康状态和少量关键证据样本。
原始 evidence 默认不传，只有设置 `agent_mode.include_evidence=true` 时才会传完整 evidence。
本地 session catalog 会保存 Codex `thread_id`，
同一个飞书 scope 里的后续消息可以继续同一段 Codex 对话。

这一层的目标是让飞书 agent mode 更像助手，而不是无状态聊天机器人：它能参考当前计划/复盘，
区分“确认的 / 暂缓的 / 新增的”，并说明哪些事情可以交给 Codex 做，哪些必须由用户本人判断或沟通。

Agent mode 会回复一张持续更新的飞书运行卡片，而不是一次性文本。卡片会显示运行状态、
最近的 Codex 进度、最终成功/失败/超时状态；运行中可以直接点 **停止**。最终卡片也能把
结构化 follow-up callback 送回同一个飞书 scope，让 Codex 继续这段对话。

Agent mode 控制命令：

- `daily-os status`：显示标准操作卡片。
- `/new` 或 `daily-os new`：归档当前飞书 scope session，下一条自由文本会开启新会话。
- `/stop` 或 `daily-os stop`：停止当前 scope 正在运行的 Codex 任务。

这一层不会替代知识库 vault 或 memory repository。它只是飞书侧的交互入口。

每个飞书私聊、群聊或 topic thread 都会映射到一个稳定的本地 session scope。
`interaction.feishu.session_catalog_path` 指向本地目录文件，只保存 metadata：
scope id、chat/thread id、可选 Codex session id、workdir、policy signature 和时间戳。
它不会保存消息正文。如果 workdir 或远程控制 policy 变化，旧 scope session 会被归档，
并创建新的 active session。

### Interaction Access Policy

Interaction layer 默认拒绝远程消息。启用后，必须至少配置下面任意一项，才会处理飞书消息：

- `.env` 里的 `FEISHU_OWNER_OPEN_ID`
- `interaction.feishu.security.allowed_user_open_ids`
- `interaction.feishu.security.allowed_chat_ids`

权限检查会发生在消息入队、workflow 触发和卡片按钮回调之前。群聊里建议保持
`require_mention_in_groups: true`，除非你是在私有测试群里调试。

角色规则：

- `owner` / `admin`：可以执行 interaction 管理动作，也可以确认写入长期决策规则。
- `allowed_user`：可以执行普通读取/workflow 命令，也可以写反馈或 memory note，但不能确认长期 policy 变更。
- `allowed_chat`：只能执行读取/workflow 命令。这样允许某个群使用 Daily OS，但不会让群里任意成员修改 memory 或 policy。

Access level 含义：

- `read_only`：最安全默认值。允许 Daily OS workflow 触发和内部 memory/feedback 写入，但阻止任意 workspace 写入。
- `workspace`：未来 agent mode 只能写入配置的 `allowed_workspaces`；如果没配置 workspace，Doctor 会给 warning。
- `full`：只建议在可信的私人部署中使用。full-control 动作仍然要求 owner/admin，并且需要显式确认。Doctor 会把它显示为 warning。

workspace 路径会先规范化再检查。请求路径必须等于某个 allowed workspace，或位于其子目录下；兄弟目录和路径逃逸会被拒绝。

用户/admin 使用飞书/Lark `open_id`，群聊使用 `chat_id`。

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
和 vault 路径都留在用户自己的本地配置文件或私有文件夹中，不提交到仓库。
