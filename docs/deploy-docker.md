# Docker / Linux 部署（daily-os-feishu）

同一份代码有两种运行形态：

| 形态 | 供养者 | 调度驱动 | LLM provider |
| --- | --- | --- | --- |
| macOS 原生 | launchd（KeepAlive） | `launchd`（进程内 tick 循环，被 launchd 保活） | 可用 `codex` / `claude` 订阅 CLI，或 API-key |
| Docker / Linux | Docker `restart: unless-stopped` | `loop`（进程内 `setInterval` 每 60s tick） | **必须** `anthropic` / `openai`（API-key） |

> **容器内没有 `claude` / `codex` CLI。** Docker 形态必须使用 API-key provider：
> `config.yaml` 里设 `llm.provider: anthropic`（或 `openai`），并在 `.env` 中提供
> `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`。否则每次 workflow 调用都会失败。

调度形态由 `config.scheduler.driver`（`auto` | `launchd` | `loop`）决定，环境变量
`DAILY_OS_SCHEDULER` 优先级更高。镜像内已固定 `DAILY_OS_SCHEDULER=loop`。

---

## 1. 构建 / 启动

```bash
# 一次性准备（宿主机上，仓库根目录）
cp .env.example .env                       # 填 API-key + 飞书凭据
cp config/config.example.yaml config/config.yaml
#   编辑 config.yaml：llm.provider: anthropic（或 openai），scheduler.driver: auto|loop

# 构建镜像并后台启动
docker compose up -d --build

# 查看日志 / 状态
docker compose logs -f daily-os-feishu
docker compose ps
```

启动后管理台监听容器内 `0.0.0.0:14573`，映射到宿主机 `http://127.0.0.1:14573`。

持久化数据全部落在挂载卷里，容器可随时重建而不丢数据：

- `./data` → `/app/data`（scheduler 状态、锁、usage ledger、记忆、快照）
- `./config` → `/app/config`（`config.yaml`）
- `./memory-vault` → `/app/memory-vault`（决策策略等本地库）

镜像里不写入任何密钥或运行时状态（见 `.dockerignore`）。

---

## 2. 升级

原则：**镜像 tag 固定 + 升级前备份数据卷**，任何一步失败都能干净回退。

```bash
# a) 固定当前版本的 tag（记下来，用于回滚）
docker image tag daily-os-feishu:latest daily-os-feishu:$(date +%Y%m%d-%H%M)

# b) 升级前备份数据卷（挂载目录是普通目录，直接打包即可）
tar czf backup-$(date +%Y%m%d-%H%M).tgz data config memory-vault

# c) 拉取新代码后重建镜像并滚动重启
git pull
docker compose up -d --build

# d) 冒烟检查
docker compose logs --tail=50 daily-os-feishu   # 确认 scheduler 已启动（loop 驱动）
curl -sSf http://127.0.0.1:14573 >/dev/null && echo "UI ok"
```

建议给每次发布打一个明确 tag（例如 `daily-os-feishu:0.1.0`），
`docker-compose.yml` 里的 `image:` 也可从 `:latest` 改为固定 tag，避免误拉。

---

## 3. 回滚

回滚 = **回退到上一个镜像 tag + 恢复对应的数据备份**。

```bash
# a) 停止当前容器
docker compose down

# b) 恢复升级前的数据卷备份（先移开当前数据以便对照）
mv data data.bad && mv config config.bad && mv memory-vault memory-vault.bad
tar xzf backup-<timestamp>.tgz

# c) 用上一个已知良好的镜像 tag 重新启动
#    临时覆盖 compose 里的 image（或直接编辑 docker-compose.yml 的 image: 字段）
docker compose down
docker run -d --name daily-os-feishu \
  --env-file .env \
  -e DAILY_OS_SCHEDULER=loop -e DAILY_OS_IN_CONTAINER=1 -e DAILY_OS_UI_HOST=0.0.0.0 \
  -p 14573:14573 \
  -v "$PWD/data:/app/data" -v "$PWD/config:/app/config" -v "$PWD/memory-vault:/app/memory-vault" \
  --restart unless-stopped \
  daily-os-feishu:<上一个良好 tag>

# d) 确认恢复正常后清理
rm -rf data.bad config.bad memory-vault.bad
```

要点：

- **镜像不可变**：靠固定 tag 回退代码，绝不依赖 `:latest`。
- **数据可回滚**：升级前的 `tar` 备份是唯一可信恢复点；scheduler 的 fired 状态
  （`data/memory/scheduler-state.json`）也在其中，恢复后当天不会重复触发。
- **配置随卷走**：`config.yaml` 在挂载卷里，回滚数据时一并回到旧配置。
