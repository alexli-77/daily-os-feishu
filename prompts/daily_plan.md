从今天的已评分候选中，挑出并改写今天真正要做的 todo。

# 输入

Evidence 里有一个 `todo_scored` 源（`sources.todo_scored.data`）：

- `top`: 已经用程序化评分器排好序的候选数组，每项包含：
  - `rank`: 程序给出的初始排序（1 最高）。
  - `candidateId`: 候选唯一 id（**必须原样回填**，不要改）。
  - `title`: 候选原始标题（可能是 Linear 任务、飞书周要务、vault 笔记或用户随手记）。
  - `source`: 来源（`todo_inbox` / `linear` / `vault` / `weekly_priorities`）。
  - `score` 和 `breakdown`: 总分与加分明细（逾期 / 24h 内到期 / Linear 优先级 / 日历临近 / carry-over / OKR 关联 / 客户信号）。
  - 可能还有 `dueDate`、`priority`、`okrKrId`、`isCustomerFacing`。

这些分数是**排序建议**，不是命令。你可以微调顺序、合并重复、剔除今天明显不该做的项，但要尊重高分项：`breakdown` 里有 `overdue`、`dueWithin24h` 或高 `okr` 的项，除非有明确理由，否则应进入今日清单。

# 你的任务

1. 从 `top` 里选出今天真正要做的 **5-8 条**（工作和生活可以混排，完全按分数和当天现实排序，不要人为分组）。
2. 把每条候选的 `title` **改写成一句真人助理式的行动指令**，遵守下面的模板规则。
3. 输出严格的 JSON，不要输出任何解释、Markdown、代码块或额外文字。

# 改写模板规则（few-shot）

每条 `text`：动词开头、具体到今天能交付的动作、一句话说清做什么，不带证据尾巴、不带「因为」。

- 原始：`LEO-142 todo 评分器` → 改写：`把 todo 评分器的四源归一化写完，跑通去重和排序`
- 原始：`飞书周要务：portfolio 上线` → 改写：`把 portfolio 首页部署到线上，至少能公开访问`
- 原始：`跟进客户 A 合同` → 改写：`给客户 A 发确认邮件，敲定合同签署时间`
- 原始：`健身` → 改写：`下午留 40 分钟做一次力量训练`
- 原始：`vault: 读完 XX 论文` → 改写：`读完 XX 论文并写 3 条要点笔记`

不要写只有短标签的句子（例如「Feishu 旧任务清理」）；要写成能直接照做的一句话。

# 输出格式（严格 JSON）

```
{
  "todos": [
    { "rank": 1, "text": "把 todo 评分器的四源归一化写完，跑通去重和排序", "candidateId": "linear:LEO-142" },
    { "rank": 2, "text": "给客户 A 发确认邮件，敲定合同签署时间", "candidateId": "todo_inbox:todo-2026..." }
  ],
  "note": "今天逾期项偏多，建议先清逾期再做新任务"
}
```

规则：

- 只输出这个 JSON 对象本身，不要加 ```json 代码块、不要加前后说明。
- `rank` 从 1 开始连续编号，代表你最终认可的今日顺序。
- `candidateId` 必须来自输入的 `top[].candidateId`，原样回填，不要编造。
- `text` 用中文，5-8 条，动词开头。
- `note` 可选：一句话点出今天排序的关键取舍（逾期、客户、OKR 冲突等）；没有可省略或留空字符串。
- 如果 `todo_scored.top` 为空，返回 `{ "todos": [], "note": "今天没有可排的候选，请检查数据源。" }`。
