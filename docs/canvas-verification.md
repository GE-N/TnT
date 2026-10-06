# Screen canvas — issue #7

Implementation baseline: `956e786d77bf0fa5d0d354a4108f96a65f3eafde`. Verified 2026-10-06 on the prepared iPhone 15 / iOS 17 simulator with `com.example.HybridApp`, Maestro 2.11.0 and Node 24.7.0.

## Implemented behavior

The editor provides a scrollable, zoomable screen canvas with draggable and keyboard-movable screen nodes. Each node has a title, optional local PNG/JPEG reference image, and multiple associated YAML commands/subflows. Tests can be labeled as actions, assertions, setup, handlers or general tests. Screens expose their reusable associations in the inspector. Handler roles are explicitly unavailable until #6 provides execution/reporting.

Transitions reference an action association on their source screen and an executable assertion association on their expected destination. Their response-condition labels explain intent; they do not configure an API or create commands. Mock selection remains the scenario's #5 configuration. Author an explicitly ordered path; no graph paths are enumerated automatically. Selecting a path highlights its screens/edges and never rewrites YAML. A selected route must follow the command order already authored in the scenario.

References bind a root command position or declared reusable flow to an executable-content fingerprint, including root/reusable-flow header configuration, root invocation parameters and called flow dependencies. Changed/deleted/moved references become visible diagnostics. Multiple matching moved commands are ambiguous. Repair requires explicitly choosing and relinking the intended current reference. References are never silently retargeted. Uncalled or multiply called reusable flows cannot be inferred as route steps: select an explicit root `runFlow` command instead. Unsupported/missing outcomes stay unavailable.

Each run snapshots the graph, path identity, executable YAML, reusable flows and references. The results canvas renders that executed snapshot independently of current authoring. Selected screen/test/transition outcomes map from verified top-level Maestro command metadata after execution. This is post-run reporting; the UI discloses that live per-step/nested/handler reporting is unavailable. A selected route with a skipped/unavailable required action or assertion cannot pass just because Maestro's overall report passed: it reports `path-failed` without inventing an observed UI assertion result. A failed destination assertion leaves the selected route failed and never follows another branch.

## Evidence

- Public runner tests cover immutable graph/result mapping, changed assertion-flow references, skipped destination route failure, wrong destination without branch switching, and ambiguous moved commands with explicit repair.
- Browser: authored Home, Settings and Maintenance nodes; associated a Settings tap/visible assertion and shared maintenance YAML; connected two expected destinations; created and selected the Settings route; executed real YAML. Run `cba830d3-31a3-4dd4-832b-23fd03504c80` passed. The selected Home → Settings screen/test/edge outcomes passed while the unselected maintenance branch remained unavailable. Workspace `f0583530-251f-433e-9d4b-55c9c3651743` retains this graph. Keyboard repositioning and save worked. Reopening the workspace restored its graph/YAML, required a fresh explicit route selection, and exposed old-reference diagnostics for deliberate relinking.
- Real negative run `59a546a5-9174-4130-a85e-babc4a10c6b6`: selected Home → Maintenance while YAML tapped Settings then called the reusable maintenance assertion. It reported `assertion-failed`; the selected maintenance node/edge failed, the Settings edge remained unavailable, failure screenshot/hierarchy/logs were retained, and process cleanup was verified.
- Inserting a command before the captured tap then starting the same route was rejected as a broken/stale reference before execution.

The local negative proof is `.tnt/issue-7-proof.json`; artifacts are under `.tnt/runs/<run-id>`. The visual authoring proof is `.tnt/issue-7-canvas.png`. These are local ignored evidence, not published media.

The final repaired-reference browser run `e708e05e-e04e-4e6e-8e80-384fff66a4ab` passed Home → Settings again with the header-aware identities and verified cleanup.

Review fixes: executable header changes now invalidate associations (root, reusable-flow and invocation-parameter public regressions); default placement uses a bounded seven-column grid; the surface measures node heights so long test lists remain reachable. A browser-created 40-screen canvas saved successfully in workspace `96a0eda5-f2bf-4d38-b349-03337b96457d`, and Add screen was disabled at the limit.

Final validation: 36 tests passed; type checking, production build and diff checks passed. Official [Maestro runFlow documentation](https://docs.maestro.dev/reference/commands-available/runflow) supports the file/inline reusable-flow interpretation; actual outcome mapping uses the pinned 2.11 metadata proved above.

## Remaining acceptance gates

#6 is still open and no independent setup/screen-triggered default-action implementation exists. The canvas therefore labels handler reporting unavailable and refuses to use handler roles as required route actions/assertions. It does not substitute simulated outcomes or implement #6 inside this ticket.

The actual API-selected maintenance route and existing Mockoon environment still need #5's real-app proof inputs, even though #5 was closed at user request. The negative Settings-versus-Maintenance check proves path failure behavior, not an actual API maintenance transition. #7's demo of the maintenance route with applicable setup and mapped handler execution remains unverified until those dependencies are supplied/implemented. Keep #7 open unless the user explicitly decides otherwise.

## Limits

YAML owns execution. This slice organizes and validates the current authored scenario; selecting another graph route does not generate a new YAML flow or automatically switch mock variants. Referenced root commands and reusable files must already describe the intended selected route. Multiple-scenario/parameterized authoring expansion is #9; mid-flow mock switching is #10. Reference images are annotations only, never recognition/assertions. Limits: 40 screens, 30 tests per screen, 80 edges and 20 explicit paths; PNG/JPEG references up to 250 KB; the existing combined workspace payload limit applies. Snapshot edits affect only subsequent runs.
