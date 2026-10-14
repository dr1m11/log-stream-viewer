---
name: stage
description: Deliver a whole roadmap stage (B1–B6) — plan, GitHub issues, one agent per issue in a git worktree, PRs, reviewer agents, green CI, merges with the user's permission, roadmap update.
argument-hint: <stage id, e.g. B2>
disable-model-invocation: true
---

# Deliver roadmap stage `$ARGUMENTS`

Work as the orchestrator: you plan, delegate, review and merge; agents implement.

1. **Plan.** Read `docs/roadmap.md`, `docs/product-spec.md`, the ADRs and the code. If there is no approved plan for this stage yet, write one in plan mode (tasks = PRs, dependencies, protocol changes, new deps with exact versions, DoD) and get approval. Ask before adding dependencies.
2. **Issues.** Find the exact milestone title (`gh issue list --milestone "<exact title>"`; a partial title silently matches nothing). Create one issue per PR with Goal / Scope / Acceptance criteria (template `.github/ISSUE_TEMPLATE/feature_request.yml`). `gh` may need its full path: `"/c/Program Files/GitHub CLI/gh.exe"`.
3. **Brief.** Write a brief file in the scratchpad: repo rules (CLAUDE.md, no AI attribution, commit locally only, never push or open PRs), the API contracts between tasks, file ownership to avoid conflicts, done criteria (`pnpm verify` green, tests), report format (branch, commits, what was verified, open questions).
4. **Agents.** Independent issues: one `general-purpose` agent each with `isolation: worktree`, launched in one message. Dependent issues start stacked on their parent branch or after it merges. Each agent first runs `pnpm install --frozen-lockfile` in its worktree, works on branch `<type>/<kebab>`, uses `git -C <worktree>` for git, and frees its ports (`pnpm ports:free`) — parallel e2e runs collide on 4173/8787.
5. **PR per branch.** Push (asks for confirmation), `gh pr create` with the template and `Closes #N`. Review with `pr-review-toolkit:code-reviewer`, plus `arch-reviewer` and `perf-reviewer` when the diff touches architecture or the hot path. Send findings back to the same agent (SendMessage) and push its fix commits.
6. **CI.** `gh pr checks <n> --watch` until green; fix failures through the agent.
7. **Merge.** Only with the user's explicit permission for this stage (ask once, summarizing the reviews). `gh pr merge <n> --squash --delete-branch`. Then rebase dependent branches: `git -C <wt> rebase --onto origin/main <old-parent-tip>` and `git push --force-with-lease`.
8. **Close the stage.** Final e2e scenario PR if planned; update `docs/roadmap.md` (status + `current-stage` marker), README if needed; close the milestone; remove worktrees (on Windows, leftovers may need PowerShell `Remove-Item -Recurse -Force`). Report what shipped, with links.
