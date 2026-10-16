# Komori agent instructions

Komori is a lightweight Windows EPUB reader for readers and learners, with dictionary lookup popups and Anki support. The repository is the long-term source of truth; prompts stay small.

## Default task workflow

1. Read this file, then `docs/local-development.md` if it exists (untracked; local paths and private workflow steps).
2. Read `docs/tasks/active.md` if it exists. It is the current scope contract; task files are the maintainer's local planning files and are not published.
3. Read only the authoritative docs the active task explicitly references.
4. Inspect the relevant implementation and tests.
5. Read additional repository context only when the task actually requires it.

`docs/README.md` indexes the authoritative docs. Archived tasks in `docs/tasks/archive/` are historical context, not required operating context.

## Rules

- Implement only the active task unless a blocking prerequisite is unavoidable.
- Preserve existing behavior unless the active task explicitly changes it.
- Permanent behavior belongs in authoritative docs and tests, not repeated in future tasks.
- Treat the EPUB and dictionary corpora as external, read-only data. Never rewrite source EPUBs or imported dictionary archives.
- Keep EPUB rendering behind the Komori-owned adapter and security-sensitive filesystem/database/network access native-owned.
- Prefer small reusable UI primitives and centralized design tokens.
- If real manual behavior contradicts automated tests, reproduce the real problem and improve both implementation and tests.
- Do not write long speculative design documents for decisions that have not been implemented.
- Prefer substantial tasks that deliver a complete user-visible feature from configuration through real use. Keep related settings, adapter behavior, actions, persistence, lifecycle handling, UI, documentation, and validation together; do not spread the steps of one feature across successive small tasks. Split only at a substantial, independently useful boundary, not per field, control, layer, or implementation step.

## Completing a task

- Run the task's validation, plus real/manual checks when relevant.
- Move long-term behavior established by the task into the authoritative docs and tests.
- Record concise validation results.
- Move the completed task to `docs/tasks/archive/`.
- Follow any further completion steps in `docs/local-development.md`.
- Commit, leave the worktree clean, and stop.
