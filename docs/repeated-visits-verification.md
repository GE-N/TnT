# Repeated visits — issue #17

Scope: [Reuse screens and transitions with checks and results per visit](https://github.com/GE-N/TnT/issues/17). Baseline: `a389d8d7d1aa86616285e523b39d15402e100e77`.

Explicit finite routes can repeat shared screens and connections, bounded at 80 transitions. Each saved visit has an identity separate from authored screen, connection and command identities. Existing routes acquire deterministic visit identities on save; appending creates a new visit and removing a transition retains the surviving identities.

Visit controls default to all screen checks and allow an explicit subset. Shared selector edits affect every selected occurrence. Deleted selections remain visible as missing identities, block execution and never pick a replacement. Existing deletion warnings and graph/YAML Undo restore selections together.

Route projection copies the ordered checks/actions into an executed snapshot and records each occurrence's command position. Unassociated YAML is retained; default-action checkpoints are remapped to executed positions. Results show each visit and transition separately, plus authored test, screen and edge aggregates. Any failed occurrence keeps its aggregate failed; missing or skipped evidence cannot become a pass. Execution plans are derived by the runner, never accepted as client-authored canvas data.

The workspace/run regressions cover repeated node/edge execution, immutable occurrence evidence, different initial/returned Home checks, save/reload, shared YAML edits, stale selections and missing metadata. GUI coverage exercises subsets, appending a repeated connection, stable surviving visit identities, deletion warnings and Undo.

Controlled simulator evidence and final validation are recorded below after execution and review. The fixture source is `tests/fixtures/repeated-visit-proof.swift`; it is a separate UIKit app, not the user's Hybrid app. Its Coordinator label has the fixed accessibility identifier `coordinator.fixed` and text `CF65D`. iOS navigation uses the visible Back button as a Tap action; the service regressions also exercise the authored Maestro Back command.

Simulator proof on 2026-10-09: booted iPhone 15 / iOS 17.0, Maestro 2.11.0, fixture app `com.example.TnTRepeatedVisitProof`. Saved and reloaded workspace `5d6765c7-7395-48e2-9abf-90131c692c83`; run `ea7c8fcc-4df5-4563-a730-0444c688c0a8` passed Home → Coordinator → Home → Coordinator → Home. All five visits and four transition occurrences passed, including both fixed-identifier checks and both returned-Home checks. Owned process cleanup was verified. Ignored local proof script/results: `.tnt/issue-17-proof.ts` and `.tnt/issue-17-proof.json`; raw artifacts remain under `.tnt/runs/<run-id>`.

Browser verification reopened the same saved workspace on the updated workbench at port 4323, displayed all five saved visit selections, and executed the real fixture successfully. The result view displayed each visit's own step evidence and all four transition results. The previous server on port 4322 retained its old backend; a separate updated server was started rather than interrupting it.

Review corrections: transition removal now warns about its destination visit/check selections and records Undo; a valid explicit subset no longer depends on an obsolete connection assertion when the destination has shared authored checks. Focused regressions reproduced both failures before the fixes. Visit-screen lookup and outcome aggregation now share rules across editor, validation and execution.

Validation: all 89 tests passed with local networking enabled; type checking, production build and whitespace checks passed. The final canvas-focused run passed all 31 tests after the small result-layout and bounded-identity adjustments.

Final independent review: Standards — 0 remaining actionable findings; Spec — 0 remaining actionable findings. Browser proof screenshot: ignored `.scratch/issue-17-visits-proof.jpg`.
