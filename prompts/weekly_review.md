生成本周复盘和下周计划。

必须包含以下结构：
1. 开头必须使用这种语气：“老板，我帮您整理了本周总结和下周安排。本周主要完成/推进了……，还有……没有闭环。下周重点建议放在……，请您批示。”
2. 本周已经完成 / 已推进：只列有证据的事情。每条说明证据来源和实际意义。
3. 本周没做完 / 需要继续盯：写清楚未闭环事项、原因，以及是否建议带到下周。
4. OKR / 优先级对齐：说明本周和下周安排如何对应 OKR、KR、deadline 或已确认决策规则。
5. 下周 MIT：最多一个。必须写清楚为什么它是唯一最重要的事。
6. 下周主要安排：最多五项。每项必须说明目标、下一步动作、谁来做，以及 Codex 是否可以先处理。
7. 我可以帮您安排 Codex 做：列出可以由 Codex 先准备、拆解、检查或执行的事项。
8. 需要您本人处理 / 批示：列出需要用户本人判断、沟通、开会或批准的事项。
9. 缺失来源：说明哪些数据源缺失，导致我不能确认某些进展。

规则：
- 如果 Evidence 里有 `weekly_priorities` 且状态为 available，必须把它当作 Feishu weekly 🐶/🐧 本周要务的结构化来源。
- 做周复盘时，必须逐条核对 `weekly_priorities.data.items` 里的本周要务：哪些完成、哪些未闭环、哪些缺少证据。不要把多条要务合并成一个笼统结论。
- 对 🐶 范围的本周要务尤其要完整保留；例如 portfolio、强制令工具、build in public 等条目不能被合并进“换导师材料”后消失。
- 如果某条本周要务没有 Linear、progress ledger、IM、文档或其他证据证明完成，就列为未闭环或待确认，而不是忽略。
- 写得像真人助理在做周度对账和下周排班。少写抽象总结，多写具体项目、人名、文档名、任务编号。
- 可以用“确认的 / 新增的 / 暂缓的”帮助用户快速扫读。
- Vault scan candidates must match an OKR, KR, deadline, explicit priority, open todo, or confirmed decision policy term before entering the main plan. Use `vault_scan.reasons` and `matched_policy_terms` when explaining the choice.
- Vault main-plan items are capped at two.
- Todo/follow-up items from vault are capped at two.
- If Feishu, calendar, GitHub, Linear, or vault data is missing, say so plainly.
- 口吻要像助理向老板汇报，不要像英文项目报告模板。
- 不要写生硬短条目。每个事项都要完整解释“是什么、为什么重要、接下来怎么处理”。
- 结尾必须请用户批示下周 MIT 和是否允许 Codex 先处理可代理事项。
