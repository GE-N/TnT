# Skip in Run All — issue #29

Scenario definitions accept an optional boolean `skipInRunAll`. Workspace save/reopen retains it; an absent field in older definitions means included. Invalid nonboolean values are rejected at the existing definition persistence boundary. Rename and duplicate preserve the definition field, and deletion Undo restores the captured definition and references.

Overflow, right-click, Shift+F10 and ContextMenu open the same menu, including the exact `Skip in Run All` label with `menuitemcheckbox` and `aria-checked`. Overflow buttons are restored to satisfy this ticket's explicit requirement following the previous sidebar simplification. Checked titles use readable gray (`#a8adb0`) without strikethrough. Selection, editing, and individual Run remain available. Counts beside Run all include every workspace scenario regardless of name search.

The UI saves before execution and submits the included scenario IDs in saved order through the existing ordered-subset boundary. Zero included scenarios disable Run all and guard dispatch. Service requests without an explicit subset also respect saved preferences and reject zero inclusion. An explicit subset continues to represent an intentional request and can include skipped scenarios. Intentional omissions do not create failed, cancelled, or validation not-run entries. Included drafts still receive ordinary validation outcomes. Existing frozen snapshots, serial execution, cancellation, setup/reset, confidentiality, process ownership, cleanup and individual reports remain in place.

## Behavioral verification

TDD used the existing public workspace/batch service and UI save/reopen seams, already confirmed in parent issue #27. Observed failing persistence, service filtering, and UI-count tests before implementing each slice. Targeted batch and scenario-sequence UI files passed after implementation.

The public UI journey creates twelve cases, marks two through right-click/overflow, saves/reopens, renames and deletes/Undoes a skipped definition, and executes the ten included cases in saved order while a restrictive search is active. It individually runs a skipped row and checks the ordinary passed report, clears the preference, duplicates a skipped definition, skips every remaining case, and verifies zero included, disabled dispatch, persistence, and continued individual execution. Service tests cover legacy omission, boolean validation, exact ordered filtering, included draft validation, all-skipped rejection, independent reports, and retained explicit subset behavior. Existing regression journeys cover frozen scope and safety behaviors.

## Browser visual review

Completed in live Chrome on 2026-10-11 after the user granted permission to retry. Direct browser-tab access still returned `ERR_BLOCKED_BY_CLIENT`; the existing workbench tab was successfully refreshed and reviewed using the supported native Chrome UI controls.

Created twelve draft scenarios and marked Scenario 3 through overflow and Scenario 2 through right-click. Both skipped titles appeared readable gray without strikethrough, distinguishable from ordinary titles. Selecting Scenario 2 retained the selection highlight and enabled individual Run control. Shift+F10 opened the shared menu with a visible check beside the exact `Skip in Run All` label; the menu rendered above the canvas with visible keyboard focus. The sidebar showed ten included and two skipped. Scrolling the scenario list revealed rows 7–12 while its header, search, inclusion counts and Run all stayed in place. No visual defect was found; no code change was needed.

Local proof images: `.scratch/issue-29/skip-visual-review.png` (checked keyboard menu) and `.scratch/issue-29/skip-sidebar-review.png` (gray titles, selected skipped row, individual controls and counts). This review exercised visual/authoring controls on draft scenarios; it does not claim real simulator execution. Automated service/UI journeys already verify save/reopen and execution behavior.

## Final checks and reviews

All 139 tests passed. The first sandboxed full-suite attempt could not bind sockets required by existing HTTP/Mockoon tests; the complete suite then passed with local socket access. Type checking, production build and whitespace checks passed.

Independent Standards and Spec reviewers examined the implementation against starting commit `d1a7b2b0853839253b4e00eeb236b7bd2a149d41` before commit. Standards: zero findings. Spec: zero code findings, with the initially blocked browser review subsequently completed as recorded above.
