# Skip in Run All — issue #29

Scenario definitions accept an optional boolean `skipInRunAll`. Workspace save/reopen retains it; an absent field in older definitions means included. Invalid nonboolean values are rejected at the existing definition persistence boundary. Rename and duplicate preserve the definition field, and deletion Undo restores the captured definition and references.

Overflow, right-click, Shift+F10 and ContextMenu open the same menu, including the exact `Skip in Run All` label with `menuitemcheckbox` and `aria-checked`. Overflow buttons are restored to satisfy this ticket's explicit requirement following the previous sidebar simplification. Checked titles use readable gray (`#a8adb0`) without strikethrough. Selection, editing, and individual Run remain available. Counts beside Run all include every workspace scenario regardless of name search.

The UI saves before execution and submits the included scenario IDs in saved order through the existing ordered-subset boundary. Zero included scenarios disable Run all and guard dispatch. Service requests without an explicit subset also respect saved preferences and reject zero inclusion. An explicit subset continues to represent an intentional request and can include skipped scenarios. Intentional omissions do not create failed, cancelled, or validation not-run entries. Included drafts still receive ordinary validation outcomes. Existing frozen snapshots, serial execution, cancellation, setup/reset, confidentiality, process ownership, cleanup and individual reports remain in place.

## Behavioral verification

TDD used the existing public workspace/batch service and UI save/reopen seams, already confirmed in parent issue #27. Observed failing persistence, service filtering, and UI-count tests before implementing each slice. Targeted batch and scenario-sequence UI files passed after implementation.

The public UI journey creates twelve cases, marks two through right-click/overflow, saves/reopens, renames and deletes/Undoes a skipped definition, and executes the ten included cases in saved order while a restrictive search is active. It individually runs a skipped row and checks the ordinary passed report, clears the preference, duplicates a skipped definition, skips every remaining case, and verifies zero included, disabled dispatch, persistence, and continued individual execution. Service tests cover legacy omission, boolean validation, exact ordered filtering, included draft validation, all-skipped rejection, independent reports, and retained explicit subset behavior. Existing regression journeys cover frozen scope and safety behaviors.

## Browser review limitation

Browser review was attempted against the local development workbench using both `127.0.0.1:4317` and `localhost:4317`. Chrome's browser tool blocked both addresses (`ERR_BLOCKED_BY_CLIENT`), so live visual verification of gray titles, contrast and menu placement could not be completed. DOM tests do not prove those visual properties. No simulator execution is claimed; tests stub only the external simulator/Maestro boundaries.

## Final checks and reviews

All 139 tests passed. The first sandboxed full-suite attempt could not bind sockets required by existing HTTP/Mockoon tests; the complete suite then passed with local socket access. Type checking, production build and whitespace checks passed.

Independent Standards and Spec reviewers examined the implementation against starting commit `d1a7b2b0853839253b4e00eeb236b7bd2a149d41` before commit. Standards: zero findings. Spec: zero code findings, with the browser-review limitation above explicitly retained.
