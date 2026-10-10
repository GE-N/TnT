# Single-screen scenario canvas — issue #21

Scope: [Create and run a single-screen scenario from the canvas](https://github.com/GE-N/TnT/issues/21). Starting commit: `6c818a63673743c83bb1094aaedb305ce0ba6380`.

The default workspace opens on a shared canvas with a scenario sidebar and compact simulator/app controls. New named scenarios own an internal sequence; the author selects a node and marks it as the scenario start. The contextual node editor supports ordered visible/absent checks, exact matching by default, optional reference images, and the existing picker. YAML, setup, mock configuration, legacy scenario controls and legacy canvas forms remain available under Advanced mode.

Named drafts can save with no selected executable steps, setup file or start node. Empty or incomplete scenarios are rejected before simulator access. Canvas-authored scenarios project their saved sequence through the existing YAML and runner boundaries. Ordinary launch is supplied when needed, while configured setup and legacy authored step selections retain their existing behavior. Required assertion evidence is still necessary for a passing scenario run; checks on other nodes remain outside the selected single-screen scenario.

The public UI integration test creates a draft without a device, saves/reopens it, names a screen, marks its start, authors exact visible and absent checks, saves/reopens again, then executes the selected scenario through the real workspace/run service with only simulator and Maestro boundaries stubbed. Service regressions cover empty drafts, a start without assertions, an empty check subset, ordinary launch, shared-node isolation, assertion failure and missing assertion evidence. Existing launch/setup, picker freshness, immutable result, legacy route and default-action regressions also pass.

Remembered device/app choices are local to the browser. Device selection is checked against current runner status; an app becomes validated only after successful inventory discovery for that device and session. A cold-start regression reproduces and prevents clearing a valid remembered app before discovery completes. Removed apps and stale device responses remain covered by the existing tests.

## Simulator demonstration

On 2026-10-10, the browser at `http://127.0.0.1:4324` created `Home single screen`, added a Home node and an Exact visible-text assertion for `Home`, selected the node as the start, saved the workspace, reopened it and ran it. No YAML editor, reusable setup flow or route selector was used.

- Device: booted iPhone 15, iOS 17.0.
- App: `com.example.TnTRepeatedVisitProof`, the existing controlled UIKit fixture from `tests/fixtures/repeated-visit-proof.swift`.
- Workspace: `dd05240a-9e90-442e-8776-775293dfa925`.
- Final run: `7661fb71-5e63-4225-beba-fe6e85fb152c`.
- Maestro: 2.11.0; Node: v24.7.0.
- Outcome: passed, including the launch, required Home assertion and initial visit, with verified owned-process cleanup. Reset remained No and the snapshot recorded ordinary app launch.
- A fresh browser reload retained and revalidated the fixture app choice before reopening and rerunning the same workspace.
- Local evidence: `.tnt/runs/7661fb71-5e63-4225-beba-fe6e85fb152c/`, with immutable snapshot, report and command metadata. Browser screenshot: `.scratch/issue-21-simulator.png`. These generated artifacts are ignored by Git.

## Validation and review

All 97 tests passed with local networking enabled. Type checking, production build and whitespace checks passed. Independent Standards and Spec reviews report zero remaining findings after correcting empty-check draft execution and remembered-app startup validation, and simplifying the scenario compatibility adapter.
