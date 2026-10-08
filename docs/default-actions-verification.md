# Independent setup and screen-triggered actions (#6)

## Approved behavior

Opt-in automation always relaunches the installed app (`stopApp: true`,
`clearState: false`), then calls the explicitly declared reusable setup flow.
App data and keychain are preserved. Setup must establish the scenario's required
session and starting state; authored commands remain authoritative. Remove a
redundant authored launch if it would undo setup. Legacy workspaces without this
configuration retain their existing behavior.

Default actions pair a visible-text or accessibility-ID condition with a declared
reusable Maestro flow and string parameters. Values may refer to confidential
runtime inputs such as `${TOKEN}`. Never save actual secrets in parameters/YAML.

Checks run only before explicitly selected top-level navigation/assertion steps.
No checks are inserted inside setup, actions, or other reusable flows. Enabled
actions are checked in configured order; the first match wins at a checkpoint.
An action may match again at a later checkpoint. Failure stops the scenario and
is reported as `handler-error`; failed reset/setup is `setup-error`.

A checkpoint's visibility window is 0–5000 ms. Zero performs one pass; positive
windows poll until a match or the deadline. An in-progress Maestro visibility
query may complete after the polling window. No background watcher runs. Disable
an action when directly testing its matching screen; authored assertions are
retained, not replaced by handler outcomes or alternate canvas routes.

## Authoring and execution

Enable independent setup, select a declared YAML setup file, and configure
ordered default actions in the browser. Select checkpoints explicitly from the
step catalog. Preview execution YAML before running; stale previews are marked.

Original YAML remains byte-for-byte in `flow.yaml` and the snapshot. Generated
`.tnt-execution.yaml` holds relaunch/setup/checkpoint wrappers. Its filename is
outside the reusable-file namespace, so a declared `execution.yaml` cannot
replace it. The snapshot digest includes the actual derived plan/source.

Checkpoint references include position and executable fingerprint. Direct edits
require explicit relinking when stale. Deletion invalidates removed/shifted
references even for duplicate commands, and warns before proceeding. Undo
restores unchanged invalidated references while preserving later configuration
edits. Loading a workspace resets editor history.

Results show authored steps, setup, and per-checkpoint handler outcomes separately.
Missing/unsupported metadata is unavailable, never inferred as execution. Raw
Maestro metadata supports ordinary runs. With confidential runtime inputs, raw
logs, evaluated metadata, images and temporary artifacts follow the existing
withholding/deletion policy; persisted snapshots contain placeholders only.

## Verification (2026-10-08)

Maestro 2.11.0 / Java 17, prepared iPhone 15 / iOS 17 simulator
`E5C92F6E-40DC-493C-93B4-469E67193736`:

- HybridApp (`com.example.HybridApp`): run
  `fd676fad-373e-4041-9a55-2bdfbcb65234` passed. Setup establishes Home; the Home
  accessibility-ID condition calls parameterized `tap-target.yaml` with
  `TARGET=Coordinator`, then the Coordinator ID condition calls the same flow
  with `TARGET=Home`. Both authored destination assertions passed. Distinct IDs
  are necessary because Coordinator text also appears on its detail page.
- Nonmatching condition and disabled matching action:
  `9de4a53e-923c-46b8-9186-ab269398660d` passed; both were skipped.
- Two simultaneous matches and repeated checkpoints:
  `ee4ba942-f742-4c2d-a165-ae9fd618d618` passed; first action ran at both
  checkpoints and the second action (which would fail) was skipped.
- Deliberate action assertion failure:
  `b40cc225-bd0a-4411-b098-4eb9a2b7d138` reported `handler-error`; subsequent
  authored steps/checkpoints remained unavailable and cleanup was verified.
- Delayed appearance: separate local UIKit fixture
  `com.example.TnTDefaultActionProof`, source
  `tests/fixtures/default-action-proof.swift`. Its notice appears three seconds
  after tapping Start; a five-second checkpoint calls the dismiss flow.
  `8733ab46-5bf0-4005-8ec2-9ac90d7a0df0` passed. This case used the fixture,
  not an unverified delayed screen in HybridApp.
- Browser: opened workspace `5e14c731-199c-484d-be41-2c50fd95ced0`, inspected the
  derived preview, ran the scenario, and observed passed setup, both actions and
  both authored assertions. Screenshot: `.tnt/issue-6-result.png` (local/ignored).

Every real run above verified owned process cleanup. The local fixture leaves
app data untouched; it was installed only on the test simulator and removed after verification.

Automated public-interface checks cover independent execution, authoring UI,
stale checkpoints, missing setup files, disabled action preview, handler/setup
failure classification, generated filename isolation, and confidential runs.
Existing runner/canvas/mock/editor tests cover ownership, cancellation,
immutable snapshots, reference repair and runtime-input redaction.

## Maestro references

Uses official [conditional runFlow](https://docs.maestro.dev/maestro-flows/flow-control-and-logic/conditions),
[repeat conditions](https://docs.maestro.dev/reference/commands-available/repeat),
[parameterized flows](https://docs.maestro.dev/reference/commands-available/runflow),
and [launch behavior](https://docs.maestro.dev/reference/commands-available/launchapp).
Actual generation and reporting were verified against the pinned local version.

Final checks: all 60 tests and the production build passed. Standards and spec
reviews against `da084cb` reported no remaining actionable findings.
