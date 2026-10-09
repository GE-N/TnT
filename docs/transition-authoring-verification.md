# Ordered transition authoring — issue #16

Scope: [Connect screens with ordered actions and an explicit runnable route](https://github.com/GE-N/TnT/issues/16). Baseline: `2cef53078daaf6915d46a906f4a161afdc855bb1`.

Add next screen creates a node and connection. Drag to connect joins existing nodes. Only connections extending the explicitly selected route tail append automatically. Connections elsewhere require explicit selection; branches are never enumerated or switched by outcomes. Connection inspectors contain compact ordered Tap, Input text and Back rows. Tap selectors use manual text/identifier matching or the existing picker. Input text acts on the focused field.

Stable YAML comment identities round-trip supported operations and refresh their order from code edits. Unsupported commands remain intact. New ordered routes project initial screen checks, edge actions and destination checks into one executable YAML snapshot, while retaining unassociated commands and launch/setup associations. Checkpoint positions and valid associated references are remapped for that snapshot. Execution preview uses the same projection. Legacy association-only canvases retain their YAML-order behavior. Repeated visits and advanced commands remain separate tickets.

Deleting ordered actions leaves missing identities in the route. Deleting connections or referenced screens retains affected route references. Warnings name affected content and Undo restores graph/YAML together. Missing, draft, unsupported and invalid references block execution. Removing a valid Input text or Back command in YAML cannot be silently reversed by editing another form.

## Behavioral verification

Existing canvas GUI and workspace/run service seams cover:

- Add next screen, dragged connections, route-tail append and explicit branch exclusion.
- Tap/Input text/Back authoring, reorder, YAML-to-form edits, and unrelated command preservation.
- Saved graph/action order reload, route-specific execution preview, branch projection, and immutable authored/executed snapshots.
- Initial checks, every ordered action and destination checks mapped from execution metadata; skipped initial assertions cannot pass a route.
- Failed actions retain failure status while subsequent destination evidence remains unavailable.
- Middle action and connection deletion, affected route warnings, invalid reference retention, and graph/YAML Undo.
- Associated launch/setup preservation, mixed legacy-handler/ordered-edge execution, and protection against resurrecting commands removed in YAML.

Browser authoring proof on 2026-10-09 used the local workbench at port 4322: created Home → Details with Add next screen; authored initial/destination checks and Tap/Input text/Back; reviewed executable YAML; saved and reopened workspace `bea63941-7e69-4b0b-ae3a-3b61cbd3b0d7`; selected its saved route and verified all action rows and its connection persisted. The browser proof is authoring/save/reload evidence, not a real simulator execution of these draft selectors. Screenshot: local ignored `.scratch/issue-16-browser-proof.jpg`.

Validation: 85 tests passed with local networking enabled; type checking, production build and whitespace checks passed. The initial sandbox-only full-suite attempt could not bind local HTTP/mock ports; the enabled run passed. Review corrections were covered by focused canvas regressions before final validation.

Final independent re-review: Standards — 0 remaining findings after sharing action creation and route membership helpers. Spec — 0 remaining actionable findings after preserving launch/setup associations, refusing silently restored Input text/Back commands, and keeping checkpoint handlers separate from top-level command occurrences. No scope creep found.


## Follow-up: immediate screen conditions and node deletion

Add next screen now creates one draft destination check, opens its full visible/absent selector form, scrolls the destination into view and focuses the selector. The draft remains saveable and requires a selector before execution. No title is inferred as an assertion. A bin icon in each editable node header uses the existing reference-warning and Undo flow; deleting a referenced screen retains invalid route references for repair. The inspector deletion control shares the same operation.

Extended the canvas GUI regression to verify the immediate condition and focus, direct node deletion, affected-route warnings, preserved route identities and graph/YAML Undo. Browser verification confirmed the same behavior and left an unsaved Home → Next screen example open, with the destination selector ready to fill. Local screenshot: `.scratch/issue-16-screen-conditions-proof.jpg`. Final checks: 85 tests, type checking, production build and whitespace checks passed. Independent Standards and Spec reviews: no actionable findings.
