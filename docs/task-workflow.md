# Daily OS Task Workflow

This project uses Linear as the product task source, GitHub as the code and release record, and Codex as the implementation agent.

## Source of Truth

| Area | Source of truth | Notes |
| --- | --- | --- |
| Product tasks | Linear | New work starts as a Linear issue whenever possible. |
| Code changes | GitHub branches and PRs | PRs are the review and merge boundary. |
| Release history | GitHub Releases | Release notes live in `docs/releases/` before publishing. |
| Engineering dashboard | GitHub Projects, optional | Use only for PR/release visibility, not as a second task database. |

## Standard Flow

1. Confirm or create the Linear issue.
2. Start a branch from latest `main`.
3. Name the branch with the Linear id when one exists.
4. Implement the smallest useful change.
5. Run the relevant validation.
6. Open a GitHub PR.
7. Link the PR back to the Linear issue.
8. After merge, pull latest `main`.
9. Update Linear status.
10. For releases, tag from `main` and publish a GitHub prerelease or release.

## Branch Names

Use:

```text
codex/leo-82-release-alpha-2
```

For small untracked maintenance work without a Linear issue:

```text
codex/task-workflow-doc
```

## PR Checklist

Every PR should include:

```markdown
## Summary
- What changed
- Why it changed

## Linear
- LEO-xx, if applicable

## Validation
- npm run typecheck
- npm run build
- Other relevant checks
```

Use a draft PR when the change is incomplete or still needs product review.

## Linear Status Rules

| Linear status | Meaning |
| --- | --- |
| Backlog | Real idea, not current work. |
| Todo | Ready to start soon. |
| In Progress | A branch or implementation is actively being worked on. |
| In Review | PR is open or user acceptance is in progress. |
| Done | PR is merged, validation is complete, and any release/update step is finished. |

If a task is intentionally delayed because the scenario does not exist yet, keep it in Backlog and say why in the issue description.

## Release Flow

1. Create a release prep branch.
2. Bump `package.json` and `package-lock.json`.
3. Add release notes under `docs/releases/`.
4. Run:

```bash
npm run typecheck
npm run build
npm run regression:test
npm run privacy:scan
npm run alpha:smoke:ci
```

5. Open and merge a release prep PR.
6. Tag the merged `main` commit.
7. Publish a GitHub prerelease using the release notes file.
8. Mark the Linear release issue Done.

## Privacy Rules

Never commit:

- `.env`
- `config/config.yaml`
- API keys, tokens, chat ids, document tokens, or personal paths
- runtime files under `data/`
- logs under `logs/`
- user-specific decision files

Generic examples and templates are okay when they contain no real personal data.

## When Starting Future Work

Read this file first, then inspect:

```bash
git status --short --branch
git fetch origin main --prune
```

If the working tree has unrelated local changes, leave them alone.
