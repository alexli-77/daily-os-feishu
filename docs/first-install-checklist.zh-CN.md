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
```

只编辑这些被 git 忽略的本地文件：

- `.env`
- `config/config.yaml`
- `data/` 下的文件

## 3. 必填本地配置

Feishu-only alpha 至少需要：

- `.env` 中的 `FEISHU_CHAT_ID`
- 本机已登录 Codex CLI，或配置 `OPENAI_API_KEY`
- `config/config.yaml` 中的 `output.feishu.identity`
- 已启用数据源所需的凭证，例如 `GITHUB_TOKEN` 或 `LINEAR_API_KEY`

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
- CLI alpha 不依赖 Mac app shell。
- 飞书反馈命令是后续任务，不属于本次 alpha gate。
