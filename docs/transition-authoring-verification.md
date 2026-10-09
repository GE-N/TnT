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


## Follow-up: Add next screen authors the navigation action

Add next screen now also creates a linked draft Tap action on the current node. Both the source action and destination check open, with focus on the Tap selector first. New ordered connections show their action forms inside the source node under “Actions to reach …”; the inspector retains legacy association editing and connection deletion. The standalone “Add action with destination” control distinguishes a new destination choice from adding an action to an existing connection. A source check added later inserts before its outgoing actions in YAML.

The existing GUI regression verifies the automatically linked source action, open destination condition, focused action selector, action/check order and deletion/Undo. Browser proof shows both forms together: local `.scratch/issue-16-auto-action-proof.jpg`. Type checking, production build, all 85 tests and independent Standards/Spec reviews pass. The app remains running at port 4322.


## Follow-up: editable canvas node titles

Editable canvas nodes expose a title field directly in their header. Enter or blur saves a trimmed nonempty draft; Escape cancels and an empty name reverts. The field sits outside the drag/select button so typing and arrow keys do not move the node. Renaming updates the graph through its stable node identity, preserving connections, route references, actions, checks and executable YAML. Historical result boards remain read-only.

The canvas GUI regression covers direct rename, empty-name recovery, Escape cancellation and unchanged YAML/connection identity. Browser proof renamed Home to Sign in with Enter in the header: local `.scratch/issue-16-node-title-proof.jpg`. Type checking, production build, all 85 tests and independent Standards/Spec reviews pass.


## Follow-up: Add next screen selects a runnable route

A new GUI regression reproduced the reported `Select a nonempty explicit scenario path.` error by creating a screen, adding the next screen, filling its navigation and destination check, and calling the same selected-path validation used by execution. The first screen created a path without selecting it, and Add next screen only appended to a selected path.

Creating the first screen now selects its initial route. Add next screen with no valid selection reuses an empty source route or creates and selects an explicit route for that connection. Existing selected routes still extend only at their tail; dragging connections does not select branches. The regression covers initial selection, recovery after deselection, successful run validation, and creating a separate route from a later source.

All 86 tests, type checking, production build and independent Standards/Spec reviews pass. A separate browser canvas successfully generated its execution preview after Add next screen; screenshot: `.scratch/issue-16-route-selection-proof.jpg`. The user’s existing draft was preserved, and the app remains running at port 4322.


## Follow-up: remove Add next screen

At the user’s request, the Add next screen control and its dedicated draft-focus and route-creation logic are removed. The earlier sections describe historical implementations superseded by this change. Authors now create nodes with Add screen, add checks, and connect existing nodes with an action destination or drag connection. Existing graph data remains intact.

GUI coverage now authors ordered connections through drag and Add action, retaining checks for ordering, YAML synchronization, title editing, deletion and Undo. The first-screen test retains explicit route selection and asserts the removed control is absent. All 86 tests and the production build pass. Spec review found no issues; the Standards review’s test duplication finding was resolved with a local drag helper, followed by passing canvas tests and type checking.
