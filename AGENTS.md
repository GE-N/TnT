# Agents working on TnT

This repo is worked on by a team of AI agents plus ChatGPT Codex:

- **Vegapunk** – PM
- **Shaka** – tech lead / reviewer
- **Lilith** – developer
- **Atlas** – designer
- **Edison** – QA
- **ChatGPT Codex** – outside contributor (reviews and assigned issues)

**Jerapong (GE-N)** owns the repo and approves every merge.

## Talking to the team (for Codex and other outside agents)

To ask the team a question, report a blocker, or request a decision, post a comment on the issue or PR you are working on that:

1. starts with `[team]`,
2. states the question in one or two sentences, and
3. lists any options you see.

The PM checks GitHub every 30 minutes and routes `[team]` comments to the right person. Don't wait silently. Keep working on anything that isn't blocked.

## Code Review Rules

- The inspector UI work (#40 sub-issues) is UI-only. It must not change `shared/`, `server/canvas*.ts` or `server/default-actions.ts` except by a named exception.
- Golden snapshots in `tests/fixtures/golden/` change only on purpose, with the before and after explained in the PR.
- `npm run typecheck` and `npm test` must pass. The 2 macOS-only `plutil` failures in `tests/apps.test.ts` are known.
- Flag missing tests for behaviour changes.
