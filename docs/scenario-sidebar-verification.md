# Scenario sidebar and contextual management — issue #28

The sidebar shows the saved scenario order, a count out of the existing 20-case limit, name search, a separately scrolling list, and reachable New scenario/Run all controls. Search only changes visible rows. Batch details sit below the canvas; single-run and batch cancellation remain in the sidebar footer.

Hover or keyboard focus reveals each row's Run and overflow controls. Overflow, right click and Shift+F10/ContextMenu open the same commands: Run scenario, Rename, Duplicate, and separated Delete. Commands use the target row's identity independently of the authoring selection. Menus render above the canvas and support arrow keys, Home/End, Enter and Escape.

The user confirmed both interaction policies in this implementation conversation: clicking elsewhere leaves a rename draft open until Enter commits or Escape cancels; one deletion notification remains until Undo or Dismiss, and another deletion replaces it. Opening a saved workspace clears transient search/edit/Undo state. Undo is unavailable while busy or if restoring would exceed the existing workspace limits.

Rename trims nonempty names, keeps the 120-character bound, preserves identity and other definition fields, and updates the canvas scenario's sequence name. Duplicate reuses the current definition/sequence/membership behavior. Delete removes only the target definition, exclusive sequence, and membership references. Undo merges those references at their prior positions while retaining unrelated later edits. Shared screens, connections and historical reports remain available. This slice introduces no skip preference; no skip preference existed in the base model. Capturing the whole definition retains any preference subsequently added to that model.

## Public-journey verification

The existing scenario-first and sequence UI journeys use the real workspace/run services, with only simulator/Maestro execution stubbed. Added coverage verifies twelve cases, search/clear/no-match, unchanged Run all scope/order, row targets distinct from selection, inline rename commit/cancel/validation/blur and save/reopen, duplicate targeting, historical evidence, deletion persistence and reference restoration, selected/nonselected/last deletion, replacement and dismissal, and matching right-click/keyboard menus.

## Browser review

Reviewed the live development workbench at 1280 × 720 with twelve scenarios. The list measured 200 pixels high with 456 pixels of scroll content; New scenario, search, and Run all remained reachable. Reviewed readable/truncated names with full title text, focused row actions, Shift+F10, menu activation, inline rename with blur/Enter/Escape, and Delete/Undo. Browser review caught and corrected menu obstruction by the canvas; the menu now renders in a portal above it. Reserved space also keeps mouse actions clear of system overlay scrollbars. Proof images: `.scratch/issue-28/sidebar-undo.png` and `.scratch/issue-28/sidebar-final.png` (local, ignored).

## Checks and reviews

All 134 tests passed. Type checking, production build and whitespace checks passed. The full suite ran once after behavioral fixes; the build was repeated after the final scrollbar clearance adjustment.

Standards review initially identified lost keyboard focus after rename and a repeated test helper expression; both were corrected and rechecked with zero remaining findings. Spec review identified insufficient filtered-batch coverage; Run all now executes with a restrictive search active and asserts the complete saved order. Spec recheck reports zero remaining findings. Reviews used the staged implementation against starting commit `5209844476681becc5909161be76ff92f0cb782d` before committing.

## Scenario count and controls follow-up

The user superseded the original ticket's 20-scenario restriction and requested `+` for scenario creation and removal of each row's overflow button. There is now no fixed scenario-count cap in creation, duplication, Undo, workspace validation, sequence storage, operation memberships, or batch submission. Other validation, execution and unrelated canvas bounds are unchanged. Both sidebar and advanced-library create buttons display `+` and retain accessible names/tooltips. Row commands remain available by right click, Shift+F10 and the keyboard ContextMenu key; hover/focus still exposes the individual Run button.

The public workspace/run journey creates 21 scenarios, reopens them, duplicates to 22 with 22 shared memberships, deletes and creates another case, then restores to 23 scenarios/sequences. Save/reopen and Run all preserve the complete order; the valid 22 cases produce independent reports and the extra draft retains its ordinary not-run validation. Browser review created 23 rows and verified the `+`, count without a denominator, absence of overflow buttons, scrolling and right-click menu. Follow-up proof: `.scratch/issue-28/sidebar-simplified.png`.

Follow-up validation: all 135 tests passed; type checking, production build and whitespace checks passed. Independent Standards and Spec reviews of the staged follow-up against `71b6ebaa80d4f396134b59a42c517339a13e4bcd` both reported zero findings.
