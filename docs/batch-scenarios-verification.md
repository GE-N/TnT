# Serial scenario batches — issue #26

Verified 2026-10-11 against baseline `31a867f`. **Run all** saves the workspace and captures its scenario definitions, canvas, shared source/configuration and saved order before dispatch. The service also accepts an explicit ordered subset of distinct scenario IDs. Each invalid request receives a not-run reason; valid entries can proceed. Later saves cannot change queued executions.

Every dispatch uses the ordinary scenario preparation, start node, launch/setup/reset configuration, device ownership, confidential-input policy, evidence mapping and independent run report. No additional data reset or fresh server session is implied. Assertion and path failures allow continuation only after verified cleanup; tool/setup/handler errors and ownership or cleanup failures block remaining entries. Unverified cleanup retains the ordinary device lock. Cancellation aborts active preparation/execution, awaits owned cleanup, and labels the remaining queue not-run. A summary-write failure after dispatch also cancels and waits for the ordinary run before releasing the batch reservation.

The sidebar displays queued/running/terminal/not-run outcomes and reasons, with links to each independent report. Opening a report preserves the authoring selection. Batch records retain the saved workspace snapshot and report IDs under `.tnt/batches/<batch-id>/result.json`; runtime values are omitted. Discovery of historical batches and crash recovery remain outside this slice. A crash retains existing ownership protections for manual recovery.

## Automated fixture verification

All **129 tests passed**, including eight public workspace/run-service batch tests and three UI batch journeys. Covered frozen definitions/order, invalid/valid mixes, required inputs and confidential withholding, assertion failure followed by success, cancellation during preparation and execution, cross-runner ownership, unverified cleanup, tool failure, and a summary-write failure while a process is active. UI journeys cover live polling, running/queued states, cancellation, invalid drafts, independent report links, and separation of authoring selection from inspected results. External tool boundary responses in these automated tests are fixtures, not simulator proof.

Typechecking, the production build, and whitespace checks passed. The full suite ran outside the filesystem sandbox because its HTTP tests bind local servers. Parallel code-review Standards and Spec reviews found a summary-persistence lifecycle gap and incomplete UI lifecycle coverage; both were corrected and re-reviewed with no outstanding findings.

## Controlled simulator proof

A real batch executed on the booted iPhone 15 simulator, iOS 17.0, using Maestro 2.11.0 and controlled UIKit fixture `com.example.TnTReportProof`. Its four screens expose exact `Screen N` labels and `Go N` controls. The fixture's saved launch explicitly requests `stopApp: true` and `clearState: true`; the batch added no reset. This demonstrates real runner/simulator behavior for the controlled fixture, not a production application's business behavior.

Workspace: `f13fb438-3019-42b8-9b17-991decbae74f`. Batch: `d3b5a5cc-9cd6-4f94-932d-a6f206e6ce19`.

| Saved sequence    | Independent run                        | Outcome | Started → finished (UTC)    |
| ----------------- | -------------------------------------- | ------- | --------------------------- |
| 1 → 2 → 3 → 2 → 1 | `22eeca9c-195d-4337-9d07-4ab2857d1cac` | passed  | 04:52:46.082 → 04:53:06.390 |
| 1 → 2 → 3 → 4     | `f82a8e79-3734-47d6-b99b-a8ef5376d8f6` | passed  | 04:53:08.988 → 04:53:22.642 |
| 1 → 2 → 1         | `f251eea9-bc1a-47de-aac8-7094ef6f7a24` | passed  | 04:53:24.974 → 04:53:36.318 |

Each next run started after the preceding run finished. All three independently verified owned CLI exit and process-group disappearance. Their immutable snapshots, sequence evidence, reports and tool artifacts remain under ignored `.tnt/runs/<run-id>/`. The acceptance script and summarized proof remain under ignored `.scratch/issue-26/simulator-proof.ts` and `.scratch/issue-26/proof-results.json`; fixture source is `.scratch/issue-25/ReportProof.swift`.
