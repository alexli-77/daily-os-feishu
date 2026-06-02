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
lark-cli --help
```

创建本地配置：

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

在 Sources -> Feishu 可以添加一个或多个默认折叠的飞书 profile。Feishu 字段名会尽量和飞书开放平台一致：
`App ID` 和 `App Secret` 来自应用凭证页；`Chat ID` 是 IM 会话 ID，例如 `oc_xxx`。
在 Sources -> Other sources 里可以分别点击 GitHub 或 Linear 的本地查找按钮，从本地标准位置导入凭证。
密钥字段默认用星号遮住，可以用眼睛按钮显示原文。

在 Sources -> Vault -> Choose folder 可以用 macOS 文件夹选择器选择本地 vault 路径。
`Checks n/n OK` 是本地依赖/配置检查摘要；`Run Checks` 会重新检查。

## 3. 必填本地配置

Feishu-only alpha 至少需要：

- `.env` 中的 `FEISHU_CHAT_ID`
- `.env` 中的 `LARK_APP_ID` 和 `LARK_APP_SECRET`
- 本机 `lark-cli doctor` 通过
- 本机已登录 Codex CLI，或配置 `OPENAI_API_KEY`
- `config/config.yaml` 中的 `output.feishu.identity`
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

## 6. Alpha 已知边界

- v0 只支持飞书作为 IM 输出。
- v0 不要求远程 vault-gate。
- 当前 UI 是本地浏览器 dashboard，还不是已签名的 `.app` 或 DMG。
- 飞书反馈命令通过轮询支持，还不是 webhook。
