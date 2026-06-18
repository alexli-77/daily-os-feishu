# 决策规则

这个文件用来说明 Daily OS 应该如何为当前用户做计划和优先级判断。

Daily OS 应在以下场景使用这套规则：

- 日计划
- Todo 分流
- 日复盘
- 周复盘
- Codex 分工建议

## 当前原则

- 权衡不清楚时先问用户。
- 用户没有明确确认前，把偏好视为一次性偏好，不写成长期规则。
- 不要静默保存或修改长期决策规则。
- 区分 Codex 可以代做的事，以及必须由用户本人判断或执行的事。

## 校准记录

通过飞书决策校准群逐步磨合和修订这些规则。

## 已确认规则：todo-review-use-weekly-cutto-sources

- 时间：2026-06-16T04:42:45.302Z
- 描述：做 todo 分流和复盘时，应优先参考用户飞书文档 Weekly 中的每周要务，并结合 Cutto 飞书内容与 Cutto Linear 任务状态判断优先级和进展。
- 适用：todo, daily_review, weekly_review
- 原因：这会长期影响 Daily OS 在 todo 分流和 review 中使用哪些信息源、如何判断优先级和如何校准周目标，属于可复用的决策规则，需要用户确认后才能保存。

## 已确认规则：weekly-first-for-todo-review-priority

- 时间：2026-06-16T14:08:59.113Z
- 描述：生成 todo、daily review、weekly review 时，Daily OS 必须优先参考 Feishu Weekly 文档中的“每周要务”作为主策略来源；其他 Cutto 相关数据源用于辅助校准，不能覆盖 Weekly 主策略。
- 适用：todo, daily_review, weekly_review
- 原因：这会长期影响 Daily OS 在 todo 分流、日复盘和周复盘中如何选择信息源、如何判断优先级，以及如何处理 Linear 与 Weekly 之间的冲突，属于可复用的决策规则，需要用户确认后才能保存。

## 已确认规则：daily-progress-confirm-linear-real-today-tasks

- 时间：2026-06-16T23:16:20.075Z
- 描述：每日进展确认时，必须真实抓取 Linear 数据，只查看用户名为「张篛」的当天任务，不抓取他人任务或其他日期任务；若数据未成功抓取，必须明确说明，不能猜测或编造。
- 适用：daily_review
- 原因：这会长期影响 Daily OS 每日进展确认的数据来源、任务归属筛选和日期筛选方式，能避免用错误日期、错误负责人或非真实数据做复盘判断。

## 已确认规则：daily-todo-feishu-first-urgent-check

- 时间：2026-06-18T15:04:15.232Z
- 描述：生成每天 todo 或 daily plan 时，应优先参考 Feishu Weekly 🐧 每周要务、@用户的飞书消息、会议纪要文档、单独话题群聊天记录和会议安排，不只依赖 Linear；需要从 Feishu 内容中提取当天最紧急的关键问题，并在计划末尾询问用户是否有额外紧急事项。
- 适用：daily_plan, todo
- 原因：这会长期影响 Daily OS 每天生成 todo 时的信息源优先级、紧急事项判断方式，以及是否主动向用户补问临时紧急安排，属于可复用的决策规则，需要用户确认后才能保存。

## 已确认规则：today-tasks-use-feishu-not-linear-time

- 时间：2026-06-18T16:21:25.373Z
- 描述：判断当天任务时，不依赖 Linear 上的时间字段；当天任务的日期、紧急性和是否应进入今日计划，只以 Feishu 数据为准。
- 适用：daily_plan, todo, daily_review
- 原因：Linear 上的时间不准确，如果用它判断当天任务，会直接影响 daily plan、todo 分流和 daily review 的优先级判断，属于需要长期固定的数据源决策规则。
