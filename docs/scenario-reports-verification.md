# Independent scenario reports — issue #25

Verified 2026-10-11 against implementation baseline `cf2d60a`. The report list retains each run independently during the open workspace session; selecting or editing a scenario leaves the inspected report open. Reports use the executed scenario name, identity, sequence, and canvas snapshot. This does not add persistent history discovery or recovery.

Visit, action/check, and connection-occurrence inspection shows authored expectations, runner command outcomes and evaluated details, occurrence-specific screenshot/hierarchy artifacts when available, and the shared run log. Missing or withheld evidence is explicit. Screenshot association uses Maestro command sequence numbers, including the generated subflow's command subtree, rather than screen names or the authored step number. Existing confidential-input withholding also applies to the added details and artifact associations.

After a structured failure, later authored commands are skipped even if contradictory metadata calls them completed. Included assertions require actual assertion evidence; successful wrappers, screenshots and process exit alone cannot pass the canvas. Failed shared-node/connection aggregates retain failure. Branches outside the executed sequence are labelled outside the scenario. Authoring diagnostics name the selected scenario and affected item and provide keyboard-accessible repair controls.

## Automated verification

All 118 tests passed, including the public workspace UI journey for the three acceptance sequences, reopening independent reports, preserving names after later edits, a second visit failure, expected/actual/log inspection, missing screenshots, and focusing a blocking check for repair. Review regressions additionally cover visit-ID diagnostics and linked-action/reusable-flow expectations resolved from the executed YAML snapshot. Public scenario-service tests cover distinct failure screenshots/details, immutable results after edits, contradictory later completion metadata, nested assertion evidence, tool errors, cancellation and confidential inputs. Existing setup/handler expectations now classify dependent commands as skipped after a failure. Typechecking, production build and whitespace checks passed. The full suite required sandbox escape for local HTTP test servers.

## Controlled simulator evidence

The demonstration used the booted iPhone 15, iOS 17.0, Maestro 2.11.0 and a deliberately controlled UIKit fixture `com.example.TnTReportProof`. Its four screens expose exact `Screen N` labels and explicit `Go N` buttons. This is real simulator/runner evidence for the fixture, not evidence for a production app's business behavior. Fixture source and the acceptance script are retained under ignored `.scratch/issue-25/`.

Workspace: `b53ee551-f680-4a6c-9847-5e55b17bc071`. Each scenario was saved with explicit visit-operation selections through the existing public workspace/run service.

| Scenario                                      | Run                                    | Outcome          |
| --------------------------------------------- | -------------------------------------- | ---------------- |
| 1 → 2 → 3 → 2 → 1                             | `14db7337-22ad-45aa-833d-15f7e8d03d6b` | passed           |
| 1 → 2 → 3 → 4                                 | `7a6b1b9d-5f68-4ad2-ad3f-2a60fb78e7cf` | passed           |
| 1 → 2 → 1                                     | `c599e802-4e6f-4d55-9b34-8db4a4d9afd0` | passed           |
| Second visit to node 2 requires Visit count 1 | `2be41581-d71a-46cc-8218-1e04808636c9` | assertion-failed |

All four runs verified owned-process cleanup. In the failure run, Visit 2 (first node-2 occurrence) passed and Visit 4 (second node-2 occurrence) failed because the fixture displayed `Visit count 2`. The outgoing action and final Home check remained skipped. Its failure screenshot and hierarchy were associated only with `step-8`, using Maestro's sequence number 9 / artifact prefix `step-010`. Earlier successful reports retained their own snapshots and passed outcomes. A subsequent scenario rename and shared screen-title edit did not change the failure report's original name or graph.

Run records and raw artifacts remain under ignored `.tnt/runs/<run-id>/`. The summarized proof is `.scratch/issue-25/proof-results.json`.
