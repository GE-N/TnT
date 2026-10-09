# Screen check authoring — issue #15

Scope: [Create and run a screen with checks from the canvas](https://github.com/GE-N/TnT/issues/15). Implementation baseline: `ab2dcea8039b35f66aa2d0a878839957774491b4`.

Screen titles and layout are descriptive. Inline check rows author visible/absent text or accessibility identifiers with Exact matching by default, and explicit Contains/Regex choices. Exact and Contains escape regex metacharacters. Stable YAML comment identities associate checks with their commands; supported code edits refresh the rows and command positions. Other commands remain in their original relative positions. Complex selectors remain code-owned and require repair before their canvas check can run. Empty or invalid selectors persist in the graph as drafts and produce actionable execution diagnostics.

A single-screen path explicitly selects its initial screen and checks, with no transition required. Existing launch/setup instrumentation, inputs, default actions and reset semantics remain in use. Result mapping requires actual assertion evidence; skipped/unavailable assertions cannot pass through a successful wrapper. Deleting checks/screens warns about affected paths/transitions and offers Undo for graph and YAML together. Undo is disabled after subsequent changes to avoid overwriting newer work. Named-scenario projection preserves check identity comments.

## Automated evidence

The existing workspace/run service seam covers draft save/reload/blocking, invalid YAML retention, supported YAML-to-form synchronization, single-screen checks after declared setup, saved public inputs, reset default No, and passed/failed/skipped assertion outcomes. Browser GUI regressions cover offline authoring, Exact/Contains/Regex choices, check reorder, warning/Undo, unrelated command preservation across deletion and YAML reordering, and workspace reload without duplicate editors. Existing canvas, named-scenario, picker and default-action regressions remain in place.

Validation on 2026-10-09: 77 tests passed; type checking, production build and diff whitespace checks passed.

## Real simulator and browser evidence

Prepared iPhone 15 / iOS 17 simulator; installed `com.example.HybridApp`; Maestro 2.11.0; Node 24.7.0. These are runs on the installed HybridApp, separate from the automated fixture-adapter tests.

In the browser at port 4319, created a screen, authored an Exact visible `Home` check and an Exact absent `TnT unexpected error 15` check, renamed the screen, moved it with the keyboard, saved and reopened workspace `facf56eb-706e-46a4-831c-bfd65fa54771`. Reload restored both checks, their order, layout and YAML. Selected the single-screen path and ran:

- `b45fc31c-a004-4e36-ada4-aee37ba410ba`: passed; both authored checks reported passed.
- `967b1cde-03d6-4202-8d98-a32b4db16f5b`: changed the absent selector to `Home`; reported `assertion-failed`. The visible check passed, absent check and node failed, and screenshot/hierarchy/log evidence was retained. Process cleanup was verified for both runs.

Artifacts are local ignored records under `.tnt/runs/<run-id>`. The browser proof exposed and fixed a sibling React-key collision during workspace reload; a GUI regression covers it. Declared setup and input behavior are verified by service tests; these browser runs use the existing launch command.

Review corrections preserve surviving check positions across intervening YAML actions, refresh GUI row order from YAML, retain invalid YAML drafts, and share leading-comment handling with named-scenario projection.

Final independent reviews against the implementation baseline, including review corrections: Standards — no remaining actionable documented-standard violations or baseline smells. Spec — no remaining actionable findings and no scope creep.


## Follow-up: direct taps and reachable deletion — 2026-10-09

The user reported that nodes had no tapOn authoring and that added checks could not be deleted. The GUI regression initially failed with “Add tap to Home” missing and “Delete must be visible without expanding the check.” Nodes now author tap selectors directly, using the same YAML synchronization and draft validation boundary as checks. A tap added on Home after Coordinator's check exists is inserted before that destination's check. Taps appear as triggering actions; both the destination picker and server validation reject using a tap as the destination assertion.

Delete controls now sit outside collapsed details. Their reference warning opens in the viewport, focuses confirmation, supports Escape cancellation, and retains graph/YAML Undo. Shared operation labels keep nodes, connection choices and results consistent.

Browser proof in workspace `04be05a4-840e-448c-ba49-38b4ef359836`: authored Home and Coordinator nodes, deleted a collapsed draft check, confirmed its removal, and restored it with Undo. Authored Coordinator's check before adding Home's tap, then connected and ran the route on the installed HybridApp. Run `df1e188c-fe13-4b41-bb84-989e3b9f8830` passed; tap, destination check and transition reported passed with verified cleanup. The destination used observed text `Navigation pattern for iOS`. An earlier run `fe1428ce-4f5e-4a59-aa72-b9594e42234e` correctly failed an outdated identifier selector copied from the existing sample, while reporting the tap passed.

Final validation: 79 tests passed, type checking and production build passed. Independent Standards and Spec reviews report no remaining actionable findings after extracting shared labels and rejecting destination taps. No debug instrumentation was added.

## Follow-up: actions choose destination nodes — 2026-10-09

The user clarified that deletion should be a bin icon inside the expanded row, and that Add action should choose its destination and show a connection immediately. Add action now opens the tap selector and destination-screen chooser in the node. Selecting a destination draws/updates the connection, and appends it when extending the selected route's current tail. It reuses an existing route containing that connection when the route selector was cleared. Connection labels sit above the line so the arrow remains visible. Existing manual associations remain available for older workspaces.

A target without checks retains a visible, saveable draft connection. Adding its first check completes the pending association. Missing destinations or destination checks block execution with actionable diagnostics. Every authored destination check contributes to the connection's outcome, and all destination checks must occur before the following navigation action. Deleting an action removes its connection and route entries; Undo restores graph and YAML together. The bin stays inside expanded rows with accessible deletion labels, confirmation and Escape cancellation.

Browser proof: created Home and Coordinator, added an action on Home, chose Coordinator before authoring any destination checks, and visually verified the immediate arrow and inline bin. Added an Exact destination check for observed text `Navigation pattern for iOS`, saved workspace `cbb1a12a-234a-4108-8ba5-bba98a19f4e3`, reopened it, selected the saved route, and ran the installed HybridApp. Run `935a0cde-5781-49cd-9568-b42d73082277` passed with verified cleanup; action, destination and connection outcomes passed.

Validation: 80 tests, type checking, production build and whitespace checks passed. GUI regressions cover inline target selection, immediate line, route append, expanded bin, action deletion and graph/YAML Undo. Service regressions cover draft links, late check binding, all destination-check evidence, and rejection of destination checks scheduled after leaving their node. Standards and Spec reviews report no remaining actionable findings after sharing disconnect cleanup and correcting the route-order boundary.
