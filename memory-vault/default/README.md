# Daily OS Memory Vault

This is the default, generic memory repository shipped with daily-os-feishu.

Use it as a starter structure only. It contains no personal data, tokens, chat
IDs, calendars, tasks, or private history.

Recommended flow:

1. Copy this folder to a private location.
2. Fill in the files with your own goals, projects, commitments, and review
   notes.
3. Set `memory.repository_path` in `config/config.yaml` to that private folder.

When `memory.repository_path` is empty, daily-os-feishu reads this default
repository so first-run workflows still have a stable memory shape.
