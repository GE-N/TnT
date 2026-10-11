# Workspace visual cleanup — issue #30

## Reviewed treatment

The whole-workspace proposal is retained in [workspace-visual-proposal.html](workspace-visual-proposal.html). It shows the sidebar, canvas, contextual editor, workspace controls, scenario commands, setup/reset, inputs, mocks/handlers, notices, execution feedback and reports. Both proposed treatments can be inspected with the palette buttons.

On 2026-10-11, the user selected Paper & blue in this implementation conversation: “paper & blue is look good”. This approval precedes changes to application styling. The selected treatment uses a cool neutral page (`#f4f6f8`), white surfaces (`#ffffff`), subtle gray canvas (`#edf1f5`), dark text (`#253041`), readable secondary/skip text (`#596579`), neutral borders (`#cbd3dd`), blue selection/actions (`#315eaa`, `#eaf0fc`), and the system sans-serif font. The proposal also supplies the reviewed green success, amber warning and red error treatments. Compact rows, restrained corners and consistent spacing retain the existing application layout and controls.

## Implementation

The application stylesheet now uses shared palette variables across authoring, menus/dialogs, advanced forms, reports, evidence and error feedback. Canvas SVG strokes and route-node borders use those same variables. Selection and running use blue; passed outcomes use green; warnings/skipped execution outcomes use amber; failures use red. Every existing result retains its textual status. Skip in Run All titles remain gray without strikethrough, including when selected. Unavailable buttons/fields retain readable text on gray surfaces; keyboard focus and hover remain visible.

The sidebar remains independently scrollable and sticky while viewing the canvas. The surrounding panel no longer clips its sticky positioning. Expanded settings and report content use consistent padding; small layouts wrap controls and keep the canvas's existing internal pan/zoom area. Scenario menus reserve enough vertical space for the new line height. No authoring or execution semantics, scenario limits, workflow steps, AI features or decorative animation were added. The user's previous removal of row overflow buttons and scenario-count limits is preserved.

## Browser review

Reviewed the real application with twelve scenarios at 1280 × 720, 900 × 700, 390 × 844 and 320 × 640. The isolated review fixture uses the real HTTP handler, workspace persistence, scenario service, batch service and React UI, with simulator/Maestro execution stubbed. It is visual/functional fixture proof, not real-device proof. An additional live development workbench review confirmed the treatment with the actual simulator/app list.

- At 1280 × 720 the twelve-row list had 474 pixels of content in a 200-pixel scrolling area. Reaching the final rows changed only list scrolling; header/search and aggregate controls remained reachable. At 900 × 700 the sidebar stayed at 12 pixels from the viewport top while scrolling the workspace, with Run all inside the viewport.
- Reviewed truncated long names with full title text, hover/focus row Run, selected included and skipped scenarios, and gray skipped text without strikethrough. The computed skipped-title color was `rgb(89, 101, 121)`.
- Right-click and Shift+F10 menus appeared above the canvas. End focused Delete, with a visible focus outline; Escape closed the menu. At 320 × 640 the menu fit within the viewport (210 × 220.5 pixels, ending at y=560.2). Its checked Skip in Run All command remained readable.
- Save/reopen retained twelve scenarios, two skip preferences, canvas references and sequence controls. Run all produced ten independent fixture reports. Reviewed running/queued feedback, unavailable authoring controls, success/failure feedback, historical report selection and failed-visit evidence.
- Reviewed the selected visit's expanded contextual check editor, sequence selection, setup/default-action controls, reset, saved inputs, confidential runtime inputs, expanded mock configuration, and evidence/log controls.
- At 390 and 320 pixels wide, the expanded advanced settings produced no horizontal page overflow. Controls outside the canvas stayed inside the viewport. The canvas kept its existing scroll/pan area rather than shrinking nodes or changing editing behavior.

Local ignored screenshots: `.scratch/issue-30/desktop-workspace.jpg`, `desktop-menu.jpg`, `failed-evidence.jpg`, `narrow-sidebar.jpg`, `narrow-settings.jpg`, and `small-menu.jpg`.

## Regression checks and review

Reused the parent specification's already-confirmed public UI and workspace/run-service seams. No tests of CSS implementation were introduced. The existing scenario-first public UI journey and all 26 scenario-sequence UI journeys pass, covering editing/selection, Save/reopen, scenario management, skips, individual/batch execution, cancellation and report separation. All 139 tests pass, including setup/reset, confidential inputs, mocks/handlers, runner ownership, cancellation and evidence regression coverage. Type checking, the production build and whitespace checks pass. Independent review results are recorded below after completion.

The final visual pass also gives pressed YAML tabs the reviewed selection surface and uses existing outcome classes for step status text, so failed steps are red rather than inheriting the previous unconditional green. Browser inspection confirmed passed text as `rgb(37, 103, 71)` and failed text as `rgb(163, 52, 57)`; selected YAML/report buttons use `rgb(234, 240, 252)`.

Independent Standards and Spec reviewers examined the staged implementation against starting commit `4276744246dc3106f9d0edff0f4bce1b5629b535`, including the final tab and step-status refinements. Standards: zero findings. Spec: zero findings.
