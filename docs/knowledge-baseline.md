# Slice 1 baseline (AC13, KN-11)

Measured on 2026-10-30, 22:53–22:57 ICT (UTC+7), before any slice-1 product change.

| Item | Value |
| --- | --- |
| SHA | `4e6398b464a5f338569a2b796fdb85ce1b2ccbe3` (`4e6398b`, merge of PR #93) |
| Branch | `GE-N/rfc92-s1-baseline` |
| Node | v24.7.0 (engines require `>=22.12.0`) |
| npm | 11.5.1 |
| OS | darwin 24.1.0 |

`npm ci` was not run. `node_modules` was already present and `npm ls --depth=0` exited 0 for both production and development dependencies.

## Commands

### `npm run typecheck`

Pass. Exit 0. `tsc --noEmit` printed no diagnostics. Wall time about 1.4s. Counts: not applicable (compiler, not a test runner). Failures: none.

### `npm run build`

Pass. Exit 0. `tsc --noEmit && vite build` (vite 8.3.2). 125 modules transformed. Output:

- `dist/index.html` 0.45 kB (gzip 0.30 kB)
- `dist/assets/index-DfpXHsu-.css` 93.72 kB (gzip 16.94 kB)
- `dist/assets/index-Bme1XW8Z.js` 678.95 kB (gzip 204.79 kB)

Vite printed a chunk-size warning (the JS chunk is over 500 kB). That warning does not fail the build. `dist/` is gitignored and was not committed. Failures: none.

### `npm test` (full suite, twice)

Command: `node --import tsx --test tests/*.test.ts`.

| Run | tests | suites | pass | fail | cancelled | skipped | todo | duration |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 724 | 3 | 724 | 0 | 0 | 0 | 0 | 99328.737625 ms |
| 2 | 724 | 3 | 724 | 0 | 0 | 0 | 0 | 96389.85775 ms |

Both runs exited 0. There is no current failure to diagnose.

## Known flakes (not observed)

These are the flakes named in `AGENTS.md` and the round-13 brief. Neither full run hit them, so they are not active failures of this baseline. No solo re-run was required.

| Name | Where | What a hit looks like | This baseline |
| --- | --- | --- | --- |
| macOS `plutil` | `tests/apps.test.ts:14` and `tests/apps.test.ts:39` call real `/usr/bin/plutil` through `server/runner.ts:61` when the execute stub does not handle that argv | The two installed-app tests fail while converting `simctl listapps` output | Both passed in run 1 and run 2 |
| `ENOTEMPTY` | `tests/inspector-run-states-ui.test.ts:136` (`rm` of the temp directory) | The file fails to load or clean up with `ENOTEMPTY`; a run of that file alone passes | Not observed |
| Wrong destination | `tests/mock-scenarios.test.ts:77` (`a wrong destination fails the reusable assertion and preserves observed mock traffic`) | The assertion fails under full-suite load; the file passes alone | Passed inside both full runs |

## Comparison with earlier numbers

**RFC #92's 701/707 is not this SHA, and it is not a green gate.** PR #92 (docs-only, head `47d6eb7`, base `bc44340`) reported 701 passed, 6 failed, 707 total, and said those failures were left undiagnosed. It named them: AI timeout handling, provider stream/error handling, simulator-state UI, blank-visit autosave, picker-paused autosave UI, and real Mockoon cleanup. The same six tests exist on `4e6398b` and passed in both full runs:

- `tests/ai-generation.test.ts:294` — a timeout fails the job after one call and a late draft is ignored
- `tests/ai-generation.test.ts:751` — a mid-stream error, a timeout, HTTP 402, and a 200 error body each make one post
- `tests/canvas-layout-ui.test.ts:99` — the simulator state button names the connected app and opens the simulator popup
- `tests/draft-recovery-ui.test.ts:648` — new blank visit steps never reach autosave payloads, and the first valid commit has one Undo
- `tests/inspector-run-states-ui.test.ts:207` — autosave paused by the picker keeps the workspace status without a floating Save button
- `tests/mockoon.test.ts:11` — real Mockoon preserves all responses/rules/modes, defaults at launch, original defaults, passthrough and token-free result

A later record of that same base (`bc44340`) is 707/707 (R10). The six RFC failures did not reproduce there, and they do not reproduce here. This task does not change product or test code to chase them.

**707 to 724 is added tests, not a change in pass rate.** `git diff bc44340..4e6398b -- tests` adds 17 `test(` lines and removes none. R10 then recorded 709 and 711 as those canvas tests landed. The R11 handoff recorded 721/721 on `ccca190`. R12 recorded 724/724 on `1f9bc8e`, which is the commit merged by `4e6398b`. This baseline matches that R12 count: 724 pass, 0 fail, 0 skip, on two consecutive full runs.

## KN-11 decision

The slice-1 baseline on `4e6398b` is green: typecheck pass, build pass, tests 724/724 twice. No failure is open. The RFC's 701/707 figure is an older undiagnosed run of the 707-test suite; those six tests pass on this SHA. The historical `plutil`, `ENOTEMPTY`, and wrong-destination flakes are named above and did not occur.
