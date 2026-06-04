---
name: daily-os-decision-policy
description: 在计划、Todo 分流、复盘和 Codex 分工建议中，应用用户已经确认的 Daily OS 决策规则。
---

# Daily OS 决策规则 Skill

这个本地 policy skill 只作为用户 memory repository 的配套规则。

做计划判断前：

1. 读取 `decision-policy.yaml` 中可执行的规则。
2. 读取 `decision-policy.md` 中给人看的解释和校准记录。
3. 如果证据冲突且规则无法解决，提出一个简短澄清问题，不要假装确定。
4. 除非用户明确确认，不要保存新的长期规则。

输出中需要区分：

- 今日重点
- 为什么重要
- Codex 可以做
- 用户必须做
- 等待或阻塞
