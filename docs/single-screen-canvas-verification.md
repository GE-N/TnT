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

## Node authoring UX follow-up — 2026-10-10

Add action, Add check and the scenario start control now live inside each node. Nodes are created through the canvas context menu and renamed inline in their header. The redundant Screen inspector, Add screen form, Selected screen selector and separate title input are removed. Legacy YAML associations use the node selected on the canvas.

Right-click a node and choose Node info to upload, preview or remove its optional reference screenshot. The popup supports Escape, outside-click dismissal, keyboard focus containment and focus return to its node. Existing PNG/JPEG size restrictions and save/reopen persistence remain in place.

The public UI journey now creates nodes on the canvas, verifies node-local controls, uploads a reference image through Node info, closes the popup with Escape, reopens the saved image and executes the scenario. All 97 tests, type checking, production build and whitespace checks passed. Standards and Spec reviews report no remaining findings. The workbench remains available on port 4324.

## Scenario membership follow-up — 2026-10-10

Nodes now show the actions and checks used by the selected scenario. New operations belong to that scenario; each operation's Scenarios checklist can share it with multiple scenarios. Hidden operations remain available through the node's Use existing actions/checks disclosure. Selector picking remains available under Selector tools.

Existing checks initially remain shared, and existing connected actions infer membership from saved scenario routes. Checking a connected action for another scenario appends its connection when it continues that scenario's current endpoint; ambiguous or disconnected routes are not inferred. Membership changes preserve the shared operation and its YAML identity.

Execution projects both actions and checks through the selected scenario and validates inputs after projection, so an excluded action cannot require another scenario's inputs. Explicitly assigned actions without a connection still block execution, while unassigned legacy orphan actions remain outside the selected scenario. A single-screen draft with no selected checks continues to reject before simulator access, with guidance to add a check or the next action.

The public UI regression recreates a two-scenario workspace where Scenario 2 initially has neither checks nor a next connection. It verifies the rejection, shares the existing action through its checklist, runs Scenario 2 successfully through the real workspace/run services with simulator and Maestro boundaries stubbed, and confirms memberships survive save/reopen. It also verifies a new Scenario 1 check stays hidden in Scenario 2. Service regressions cover shared checks, selected actions, required destination checks, incomplete actions and scenario-specific inputs.

All 101 tests, type checking, production build and whitespace checks passed. Independent Standards and Spec reviews report no remaining findings. This follow-up was verified through the public UI/service seams; the simulator demonstration above applies to the original single-screen implementation.
