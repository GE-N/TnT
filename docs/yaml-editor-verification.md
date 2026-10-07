# Form/code editing — issue #8

Baseline: `0d634f2fd7394ecdfa1e8acaad97485ce6a7126d`. Specification: https://github.com/GE-N/TnT/issues/8. Verified on the prepared iPhone 15 / iOS 17 simulator.

## Preservation guarantee

The forms and code views share one authoritative YAML string. Forms support scalar `tapOn`, `inputText`, `assertVisible`, `assertNotVisible` and declared-file `runFlow` commands. Applying a form changes only that scalar's source range, leaving all other source bytes unchanged. New commands append using the existing list indentation, without regenerating preceding content. The result is validated before replacing the draft. Unsupported commands remain visible and code-editable.

The tested mixed fixture retains header/leading/trailing/footer comments, an anchored assertion and alias, an expression and a nested repeat command. Complex selectors, aliases, anchored/tagged/block values and complex commands are code-only; flow-style lists and explicit document endings block append. Form changes can invalidate existing canvas associations; the runner rejects stale selected-route references until the user explicitly repairs them.

Syntax errors and unresolved aliases are explained without replacing the draft. Invalid text remains in the code editor for repair. Existing runner validation continues to reject invalid execution configuration and unsafe external references. In-progress form drafts reject changes made against a different YAML source; Reset draft takes the latest code. Forms do not silently retarget references or change the application.

## Verification

- Public editor tests verify source preservation, direct-code projection, common-command append, invalid retention, unsafe/stale transformations and unresolved alias handling.
- Authoring UI regression alternates form/code edits, shows code-only content, retains invalid drafts and repairs them. Runner regression proves a form edit makes its canvas association stale and prevents device execution.
- Real mixed-flow run `2a9e0233-31fd-4bc5-b339-c7e543fe6b92` passed Home → Coordinator Details → Home, including a reusable Details/ID assertion and a code-only wait command. Comments were preserved. Existing runner metadata mapping does not recognize that wait command, so per-step statuses remain unavailable; raw metadata and the passed overall report are retained.
- Browser run `ff5828ad-2c6a-41b7-84fd-84848ffa7c79` passed all eight mapped steps after editing the Home assertion to `^Home$` in its form and removing the wait command directly in code. The executed snapshot retains both the form comment and direct-code comment. Cleanup was verified for both runs.
- Saved proof workspace: `b32739f4-55c8-4238-ba72-b08603e86d24`. Local ignored evidence: `.tnt/issue-8-proof.json`, `.tnt/issue-8-forms.png` and corresponding run artifacts.

Final checks: 49 tests passed, type checking, production build and diff checks passed. Existing external-file restrictions and nested/unsupported result-mapping limits are unchanged.

## Compact editor follow-up

Command forms now use compact rows with inline scalar values and one expandable
argument editor. Supported argument maps expose existing string, number and
boolean fields; nested values and other complex syntax retain a source preview
and Edit YAML action. Applying a field preserves sibling drafts and rejects
stale drafts instead of discarding them.

Every block-list step can be deleted, including middle and final steps. The last
step leaves an empty YAML list that can be rebuilt with Add command. Deletions
that would break an alias or produce invalid YAML are rejected. Undo restores
the exact prior YAML and is disabled after further YAML edits; workspace loading
resets editing history.

Canvas-linked deletions warn before proceeding. Deleted and shifted references
are explicitly invalidated, including identical adjacent commands, so a reference
cannot silently inherit another step. Undo restores unchanged invalidated links
while preserving later node movement, renaming, removal and explicit relinking.

Browser verification on the existing Hybrid sample confirmed a middle-step
warning, deletion, stale-reference diagnostics, and Undo returning the step and
its links. No saved workspace was changed during that check. Automated coverage
includes middle/tail deletion, alias protection, rebuilding an empty list,
argument preservation, sibling drafts, warning cancellation/confirmation,
Undo safeguards, duplicate-step references, and reference restoration after
canvas edits.
