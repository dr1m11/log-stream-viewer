---
name: ship
description: Ship the current change as a pull request — branch, run pnpm verify, conventional commit without AI attribution, push, and open a PR from the template.
argument-hint: '[type(scope): summary] [#issue]'
disable-model-invocation: true
allowed-tools: Read, Bash(git *), Bash(gh pr *), Bash(gh issue view*), Bash(pnpm verify*), Bash(pnpm format*)
---

# Ship the current change

Arguments: `$ARGUMENTS` (optional commit/PR title and issue number).

1. `git status` and `git diff` to understand the change. If there is nothing to ship, stop.
2. Title: use the argument if given; otherwise derive `type(scope): summary` (Conventional Commits, English, imperative, ≤ 72 chars, scope from `commitlint.config.js`). If an issue number is given, read it with `gh issue view` for context. If `gh` is not on PATH, call it as `"/c/Program Files/GitHub CLI/gh.exe"`.
3. If on `main`, create a branch: `git switch -c <type>/<kebab-summary>`.
4. Run `pnpm verify`. If it fails, fix the problems (or stop and report if the fix is not obvious). Never use `--no-verify`.
5. If the change touches `packages/protocol`, check that `docs/protocol.md` and the golden fixtures were updated (see `/protocol-change`).
6. Stage only files that belong to this change (`git add <paths>`; no blind `git add -A` if unrelated files are modified). Commit with the title as the subject and, if useful, a short body explaining _why_. **No trailers: no `Co-Authored-By`, no "Generated with Claude Code".**
7. `git push -u origin HEAD`.
8. Open the PR with a body built from `.github/pull_request_template.md`:
   ```bash
   gh pr create --title "<title>" --body-file - <<'EOF'
   ## Summary
   …
   Closes #<issue>
   …
   EOF
   ```
   Fill Summary, Changes and the checklist honestly (tick only what was actually done). For performance work, put before/after numbers in Summary. No AI attribution anywhere.
9. Print the PR URL, then `gh pr checks --watch` (or `gh pr checks` if the user does not want to wait) and report the result.
