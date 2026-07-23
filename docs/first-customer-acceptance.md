# 首客户交付验收清单（干净 Linux，30 分钟跑通）

LEO-235 的真机验收脚本。目标:一台**干净 Linux 机器**上,按本清单在 ~30 分钟内跑通
build → 起服务 → 调度触发一次 plan → 控制台登录 → web chat 一轮,并演练一次备份/恢复
与升级/回滚。配套 [deploy-docker.md](deploy-docker.md)。

> 图例:🔑 需要真实 API key 的步骤 · 👀 需要人工肉眼确认 · ⏱ 预算时间。
> 沙箱只验证过编译层,以下每一步在真机上都属于**首次真实验证**。

## 0. 前置(机器准备)⏱ ~5 min

- [ ] Docker + Docker Compose 已装(`docker --version`、`docker compose version`)
- [ ] git 已装,能 clone 本仓库
- [ ] 🔑 手上有一个可用的 LLM API key:`ANTHROPIC_API_KEY` 或 `OPENAI_API_KEY`
      （容器内没有 codex/claude CLI,**必须** API-key provider)

## 1. 拉取 + 首次配置 ⏱ ~5 min

```bash
git clone <repo-url> && cd daily-os-feishu
cp .env.example .env
cp config/config.example.yaml config/config.yaml
```

编辑 `.env` 填入 🔑 provider key,编辑 `config/config.yaml` 设
`llm.provider: anthropic`（或 `openai`）、`scheduler.driver: loop`。

> 也可用首启向导代替手工编辑(在交互式终端,非容器内):
> `npm ci && npm run setup` —— 向导会生成 admin 密码、引导填 provider/BYOK key、
> 飞书设为可选。容器/管道等无 TTY 环境自动退化为"只 seed 文件",不阻塞自动化
> （或显式 `npm run setup -- --no-wizard`）。

- [ ] `.env` 含 provider key,`config.yaml` 的 `llm.provider` 与之匹配

## 2. 构建 + 起服务 ⏱ ~8 min（首次镜像 build 偏慢）

```bash
docker compose up -d --build
docker compose ps
docker compose logs -f daily-os-feishu
```

- [ ] 镜像 build 成功（关注 better-sqlite3 native 编译,glibc≥2.38,base 为 trixie）
- [ ] 容器状态 `Up`,日志无 fatal
- [ ] 👀 日志出现调度器起步（`loop` driver,每 60s tick）

## 3. 调度触发一次 plan ⏱ ~3 min

等 loop 到点自动触发,或进容器手动跑一次:

```bash
docker compose exec daily-os-feishu node dist/index.js plan --no-send
```

- [ ] 🔑 plan 真实调用 LLM 成功产出（不是 provider/key 报错）
- [ ] 👀 产出内容合理(不是空壳 / 不是原始 JSON 泄漏)

## 4. 控制台登录 + web chat 一轮 ⏱ ~5 min

浏览器打开 `http://<host>:14573`(容器映射到宿主 14573)。

- [ ] 用 admin 账号登录(密码来自向导输出,或你在 UI 首次设置)
- [ ] 👀 页脚显示版本号 `Daily OS Feishu · v0.2.0`
- [ ] 进入 **Chat 页**,发一条 `daily-os status` → 看到流式回复
- [ ] 🔑 发一条触发 plan 的对话 → 看到 plan 流式结果 → 勾选/捕获一个 todo
- [ ] （回归覆盖项,可略）member 账号发越权 free-form 指令被拒(403)
- [ ] 全程**未开飞书**也能完成以上(M8「飞书可整体停用」验收)

## 5. 备份 / 恢复演练 ⏱ ~2 min

```bash
docker compose stop            # 停写,保证 SQLite 一致
./scripts/backup.sh            # 产出 backups/daily-os-backup-<ts>.tgz
docker compose up -d
# 制造一点变化后,演练恢复:
docker compose stop
./scripts/restore.sh backups/daily-os-backup-<ts>.tgz --force
docker compose up -d
```

- [ ] 备份归档生成,含 `data` / `memory-vault` / `config`
- [ ] 恢复后原目录被移到 `*.pre-restore-*`（可回退）,服务重启后 👀 数据还原正确
- [ ] （若装了 `sqlite3` CLI）备份用了 `.backup` 一致性快照;否则清单已提示停服

## 6. 升级 → 回滚演练 ⏱ ~2 min

```bash
# 升级:拉新 tag/镜像,重建
git fetch --tags && git checkout v0.2.0
docker compose up -d --build
# 回滚:切回上一个可用 tag,并按需从 §5 备份恢复数据卷
git checkout <上一个 tag>
docker compose up -d --build
```

- [ ] 升级后服务正常,数据卷不丢
- [ ] 回滚到上一个 tag 后服务正常;必要时用 §5 备份恢复数据
- [ ] 👀 回滚过程数据无损

## 计费默认值(交付前 review,非阻塞)

`config/config.yaml` 的 `billing` 三层默认(per_task / daily / monthly)——交付客户实例前
确认默认值合理,BYOK 流程在 §1 已覆盖。**此项留给 Leon 定,不由脚本设死。**

---

**通过标准**:§1–§4 全绿 = 「代码可部署 + 客户可用」核心闭环成立;§5–§6 全绿 = 运维可恢复。
全程 ≤30 分钟即达 LEO-235 验收线。
