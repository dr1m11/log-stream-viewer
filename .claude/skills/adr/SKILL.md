---
name: adr
description: Record an Architecture Decision Record in docs/adr from the MADR template with the next number, and update the ADR index.
argument-hint: <decision title>
disable-model-invocation: true
allowed-tools: Read, Write, Edit, Glob
---

# Write an ADR

Title: `$ARGUMENTS`.

1. List `docs/adr/` and take the next four-digit number (`0001`, `0002`, …).
2. Create `docs/adr/NNNN-<kebab-title>.md` from `docs/adr/template.md` with status `Accepted` (unless the user says otherwise) and today's date. Fill the sections from the current conversation and code:
   - **Context** — the problem, constraints and forces, with links to issues/PRs if known.
   - **Decision** — one or two sentences first, then the specifics that matter for future readers.
   - **Consequences** — what gets easier, what gets harder, what to monitor. For performance decisions, include the measurements that justified them.
   - **Alternatives considered** — each with the concrete reason it lost.
3. Keep it under ~60 lines, in English, factual — no marketing language.
4. Add a row to the table in `docs/adr/README.md`: `| [NNNN](./NNNN-<kebab-title>.md) | Title | Accepted |`.
5. If the decision supersedes an older ADR, set the old one's status to `Superseded by [NNNN](./NNNN-….md)`.
6. Show the user the file path and the Decision paragraph.
