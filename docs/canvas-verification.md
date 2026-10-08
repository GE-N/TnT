# Screen canvas — issue #7

Initial implementation baseline: `956e786d77bf0fa5d0d354a4108f96a65f3eafde`. Verified 2026-10-06 on the prepared iPhone 15 / iOS 17 simulator with `com.example.HybridApp`, Maestro 2.11.0 and Node 24.7.0.

## Implemented behavior

The editor provides a scrollable, zoomable screen canvas with draggable and keyboard-movable screen nodes. Each node has a title, optional local PNG/JPEG reference image, and multiple associated YAML commands/subflows. Tests can be labeled as actions, assertions, setup, handlers or general tests. Screens expose their reusable associations in the inspector. Independent setup and checkpoint-bound default actions now have executable references and mapped outcomes using #6. A handler reference includes its action ID and checkpoint, not just its flow filename.

Transitions reference an action association on their source screen and an executable assertion association on their expected destination. Their response-condition labels explain intent; they do not configure an API or create commands. Mock selection remains the scenario's #5 configuration. Author an explicitly ordered path; no graph paths are enumerated automatically. Selecting a path highlights its screens/edges and never rewrites YAML. A selected route must follow the command order already authored in the scenario.

References bind a root command position or declared reusable flow to an executable-content fingerprint, including root/reusable-flow header configuration, root invocation parameters and called flow dependencies. Setup fingerprints also include reset policy and invocation configuration; handler fingerprints include checkpoint identity and the ordered action definitions. Changed/deleted/moved references become visible diagnostics. Multiple matching moved commands are ambiguous. Repair requires explicitly choosing and relinking the intended current reference. References are never silently retargeted. Uncalled or multiply called reusable flows cannot be inferred as route steps: select an explicit root `runFlow` command instead. Unsupported/missing outcomes stay unavailable.

Each run snapshots the graph, path identity, executable YAML, reusable flows and references. The results canvas renders that executed snapshot independently of current authoring. Selected screen/test/transition outcomes map from scoped Maestro command metadata after execution. A destination requires completed assertion evidence inside the referenced command or reusable flow; a completed wrapper alone is insufficient. Skipped or missing nested assertions remain skipped or unavailable. Setup and handler outcomes use their executed automation snapshot, and handler labels are matched only inside the generated checkpoint subtree. This is post-run reporting; live per-step reporting remains unavailable. A selected route with a skipped/unavailable required action or assertion cannot pass just because Maestro's overall report passed: it reports `path-failed` without inventing an observed UI assertion result. A failed destination assertion leaves the selected route failed and never follows another branch.

## Evidence

- Public runner tests cover immutable graph/result mapping, changed assertion-flow references, skipped destination route failure, wrong destination without branch switching, and ambiguous moved commands with explicit repair.
- Browser: authored Home, Settings and Maintenance nodes; associated a Settings tap/visible assertion and shared maintenance YAML; connected two expected destinations; created and selected the Settings route; executed real YAML. Run `cba830d3-31a3-4dd4-832b-23fd03504c80` passed. The selected Home → Settings screen/test/edge outcomes passed while the unselected maintenance branch remained unavailable. Workspace `f0583530-251f-433e-9d4b-55c9c3651743` retains this graph. Keyboard repositioning and save worked. Reopening the workspace restored its graph/YAML, required a fresh explicit route selection, and exposed old-reference diagnostics for deliberate relinking.
- Real negative run `59a546a5-9174-4130-a85e-babc4a10c6b6`: selected Home → Maintenance while YAML tapped Settings then called the reusable maintenance assertion. It reported `assertion-failed`; the selected maintenance node/edge failed, the Settings edge remained unavailable, failure screenshot/hierarchy/logs were retained, and process cleanup was verified.
- Inserting a command before the captured tap then starting the same route was rejected as a broken/stale reference before execution.

The local negative proof is `.tnt/issue-7-proof.json`; artifacts are under `.tnt/runs/<run-id>`. The visual authoring proof is `.tnt/issue-7-canvas.png`. These are local ignored evidence, not published media.

The final repaired-reference browser run `e708e05e-e04e-4e6e-8e80-384fff66a4ab` passed Home → Settings again with the header-aware identities and verified cleanup.

Review fixes: executable header changes now invalidate associations (root, reusable-flow and invocation-parameter public regressions); default placement uses a bounded seven-column grid; the surface measures node heights so long test lists remain reachable. A browser-created 40-screen canvas saved successfully in workspace `96a0eda5-f2bf-4d38-b349-03337b96457d`, and Add screen was disabled at the limit.

Final validation: 36 tests passed; type checking, production build and diff checks passed. Official [Maestro runFlow documentation](https://docs.maestro.dev/reference/commands-available/runflow) supports the file/inline reusable-flow interpretation; actual outcome mapping uses the pinned 2.11 metadata proved above.

## Follow-up verification — 2026-10-08

Reviewed against `0fde17c` after #6 completed. The follow-up adds setup/handler catalogue entries, binds handler associations to action IDs and checkpoints, and maps actual automation outcomes onto the executed canvas. Stale auxiliary references remain unavailable even when a newly configured action passes. Undo preserves an explicit relink between different handlers that share a file. Destination mapping requires completed nested assertions, preventing a skipped assertion from passing through a completed reusable-flow wrapper.

Validation: 66 tests passed, type checking and production build passed, and both Standards and Spec reviews reported no remaining actionable implementation findings. Public scenario regressions cover handler mapping, unrelated labels, stale auxiliary references and skipped nested assertions. A browser authoring regression verifies that selecting a handler keeps its action ID and role.

A separate controlled simulator app, `com.example.TnTCanvasAPIProof`, was compiled from `tests/fixtures/canvas-api-proof.swift`. It makes a real `GET http://localhost:4320/items` request. The Mockoon environment is `tests/fixtures/mockoon.json`, with a dedicated local fallback server on port 4321. The app starts at Home, opens a session notice, and disables Load page until a checkpoint handler dismisses the notice. Setup asserts Home; the authored scenario then loads the page and calls a shared destination assertion. HTTP 500 with JSON code `MAINTENANCE` renders Maintenance; HTTP 200 renders Success.

Verified on the prepared iPhone 15 / iOS 17 simulator with Maestro 2.11.0:

| Proof | Run | Result |
| --- | --- | --- |
| Maintenance, HTTP 500 | `888dcf32-6484-4bea-b148-13c37e1c0fdc` | Setup, notice handler, action, destination assertion and selected edge passed; Success remained unavailable. |
| Success, HTTP 200 | `f8ea23e7-50b5-4d59-959d-2da4b2ea003c` | Selected Success route passed; Maintenance remained unavailable. |
| Maintenance selected, HTTP 200 returned | `7c427f71-1bc1-4d7a-9025-d0661e8eacc3` | Destination assertion failed; no switch to the Success branch. |

Changing the shared maintenance assertion produced a stale-reference diagnostic and rejected execution before launch; restoring the saved definition repaired it. Native process cleanup and owned Mockoon environment/process cleanup were verified for each run. App data was intentionally not restored.

The browser reopened workspace `f17cfe36-2f26-472d-ac72-183295daa0fc`, explicitly selected Maintenance, and ran it successfully. It displayed a captured mocked `GET /items → 500`, verified cleanup, passed setup/handler outcomes and the executed canvas. Local screenshots: `.tnt/issue-7-completed-canvas.png` (run summary) and `.tnt/issue-7-executed-canvas.png` (mapped graph). The proof script and results are `.tnt/issue-7-completion.ts` and `.tnt/issue-7-completion.json`; raw artifacts remain under `.tnt/runs/<run-id>`. These local artifacts are ignored, while the fixture source is tracked.

## Target-app acceptance gate

The controlled fixture proves the API-selected maintenance transition with setup and mapped handler execution. It does not establish that the existing HybridApp or the user's actual target app uses the intended API environment. That separate real-app proof still requires the target app, configurable endpoint/base URL, existing environment and maintenance-screen condition. Those inputs have not been supplied. Keep that limitation explicit when deciding whether to close #7; do not describe the fixture as actual-target-app validation.

## Limits

YAML owns execution. This slice organizes and validates the current authored scenario; selecting another graph route does not generate a new YAML flow or automatically switch mock variants. Referenced root commands and reusable files must already describe the intended selected route. Multiple-scenario/parameterized authoring expansion is #9; mid-flow mock switching is #10. Reference images are annotations only, never recognition/assertions. Limits: 40 screens, 30 tests per screen, 80 edges and 20 explicit paths; PNG/JPEG references up to 250 KB; the existing combined workspace payload limit applies. Snapshot edits affect only subsequent runs.
