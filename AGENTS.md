# Agents working on TnT

This repo is worked on by a team of AI agents plus ChatGPT Codex:

- **Vegapunk** – PM
- **Shaka** – tech lead / reviewer
- **Lilith** – developer
- **Atlas** – designer
- **Edison** – QA
- **ChatGPT Codex** – outside contributor (reviews and assigned issues)

**Jerapong (GE-N)** owns the repo and approves every merge. Obtain approval of the final revision from the designated external team, then present the reviewed PR to Jerapong and wait for his explicit merge confirmation. Local subagent reviews supplement the team review and do not satisfy this merge gate. Changes affecting reviewed behavior require team review again.

## Task isolation

Start each independent ticket in a fresh dedicated Codex session, branch and isolated checkout. Keep review fixes for the same ticket in that existing session. Preserve unrelated changes and coordinate overlapping UI work through the issue/PR thread. Inspect the current issue body, comments and existing PRs before implementation; keep one implementation owner per ticket.

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
