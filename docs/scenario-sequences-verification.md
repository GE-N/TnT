# Shared canvas scenario sequences — issue #22

Scope: [Build multiple scenario sequences through shared canvas nodes](https://github.com/GE-N/TnT/issues/22). Starting commit: `86045f37fa4d9f292b6ae9443a359e4a56b91414`.

The sidebar now duplicates and deletes scenarios in addition to creating, renaming and selecting them. Copies retain shared nodes, connections and commands while receiving new scenario, sequence and visit identities. Explicit operation memberships are copied; deleting a scenario removes its membership and owned sequence without deleting the shared canvas.

Authors draw connections by dragging between nodes, or by clicking the source’s Connect button and selecting the destination node. Connections expose names and ordered Tap, Input text and Back actions inside their source node. Input focus is a separate Tap. The default canvas uses canvas-selected endpoints; the previous destination and route forms remain in legacy mode.

Each node provides a Follow button for each outgoing connection and an Append visit alternative. Appending a node with no connection reports the current end and requested destination without creating an edge. Parallel connections require an explicit named choice. Drawing from the current end extends only the selected unfinished sequence. Finish persists a finite end; Resume permits further appends. Existing saved finite sequences remain executable without a new finish flag. Previously supported sharing of an unambiguous action before choosing its start remains supported.

The sequence strip and node visit badges show each numbered occurrence. Clicking a strip visit selects its node; selecting a node selects its first occurrence in the strip. Switching scenarios clears the previous selection and any pending connection. Selected connections are highlighted, unrelated connections dimmed, and parallel or opposite-direction connections have separate curves and labels. Layout has no execution meaning.

Execution continues through the existing finite route projection and runner. No execution model or branch-switching behavior was added.

## Public UI and service verification

`tests/scenario-sequences-ui.test.ts` uses the default workspace UI with the real save/reopen/run service, substituting only simulator discovery and Maestro execution boundaries. It verifies:

- Exactly `1 → 2 → 3 → 2 → 1`, `1 → 2 → 3 → 4`, and `1 → 2 → 1` across four shared nodes and five connections; save/reopen and independent execution in selected order.
- Fresh identities on duplicated repeated journeys, preservation of shared objects, and sidebar deletion.
- Explicit parallel-connection choices, disconnected diagnostics, keyboard-accessible connection drawing, and ordered Tap/Input/Back actions.
- Finish prevents newly drawn connections from extending the saved sequence, and existing visit identities survive.
- Numbered selection and repeated results; a destination check failure leaves later visits unexecuted and does not choose another branch.

## Controlled simulator demonstration — 2026-10-10

The browser at `http://127.0.0.1:4324` opened a controlled shared-node fixture, created `Return journey`, chose Home as its start, explicitly appended Open Coordinator, Back Home, Open Coordinator and Back Home, finished, saved, reopened and ran it. No route/association forms or YAML editor were used to author the sequence.

- Simulator: booted iPhone 15, iOS 17.0.
- Fixture: `com.example.TnTRepeatedVisitProof`, from `tests/fixtures/repeated-visit-proof.swift`.
- Workspace: `4cb37ae2-2d30-4291-8b8d-c2348b087507`.
- Successful run: `c841e9fb-2ff4-41cf-9641-05e92f2b1226`.
- Maestro: 2.11.0. All five visits, four transition occurrences and required assertions passed; owned-process cleanup verified.
- Three Home visit IDs and two Coordinator visit IDs are distinct. The execution snapshot maps each repeated action/check to its own command position.
- First attempt `1b39d47e-a806-4dfe-873d-37db1b400c76` failed the first Coordinator assertion after its tap reported completion. The retained hierarchy still showed Home. Later visits remained unavailable. Repeating the same saved sequence passed without changing selectors or application code; the first attempt is retained as evidence of failure stopping the route, not counted as a passing demonstration.
- Ignored local evidence: `.tnt/runs/<run-id>/`, `.tnt/issue-22-workspace.json`, and `.scratch/issue-22-simulator.jpg`.

## Validation and review

All 105 tests passed, including existing scenario membership and legacy canvas regressions. Type checking, production build and whitespace checks passed. Independent Standards and Spec reviews found no remaining actionable findings after sharing the visit-screen lookup, introducing an explicit connection-start callback, and clearing selection on scenario switches.

## Connection UX correction — 2026-10-10

The first implementation hid the node action's destination picker and created empty connections when the author dragged after adding an action. That made an existing Home action impossible to connect through its own editor and left the drawn arrow detached from that action.

Node actions now retain their contextual destination picker, including Input and Back actions. Drawing from a node binds its unconnected actions used by the selected scenario in their authored order. Already connected actions remain on their own connections, so a new parallel connection can still be authored independently.

The always-visible Append visit buttons are removed. Existing connections expose Continue only at the current unfinished sequence endpoint. The node menu retains Add to sequence for explicit node appends and disconnected/parallel diagnostics.

A missing screen assertion remains an execution blocker: an action describes the transition, while a check verifies arrival. Nodes without checks explain this beside their authoring controls, and run diagnostics point to Add check in the affected node. The regression recreates Home → Details → Home through existing actions, verifies both missing-check diagnostics, adds checks through the nodes, then executes successfully through the real workspace/run services. A separate regression verifies connecting a node action through its restored destination picker.

Follow-up validation: all 107 tests passed, with type checking, production build and whitespace checks passing. Standards and Spec reviews reported no actionable findings against the user's revised UX requirements. Browser verification selected Details through Home's action destination picker and showed the resulting Home → Details sequence and arrow. The default diagnostic uses the connection's name instead of its internal ID. Screenshot: ignored `.scratch/issue-22-connection-fix.jpg`.


## Optional checks and a single operation order — 2026-10-10

The user's follow-up explicitly supersedes the earlier destination-assertion requirement. Canvas scenarios now run with no checks, including a single-screen launch and Home → Details → Home. Included checks still require their actual execution evidence; the runner does not invent assertion evidence for unchecked screens.

The default node editor now has one ordered list of actions and checks. The arrows can move a check before or after a connected action, and route projection follows that displayed order. The separate “Actions to reach …” group is removed from the default editor. Each action exposes its destination. Drawing binds existing unconnected source actions; adding an action to a sole existing connection fills its destination and extends the selected unfinished tail. Editing or clearing one grouped action's destination preserves its siblings and sequence visits. Splitting the first picker-created action allocates a distinct connection identity.

The simulator demonstration found that raw Maestro `back` reports completion on iOS without returning from Coordinator. [Maestro's Back reference](https://docs.maestro.dev/reference/commands-available/back) documents support for Android and Web only. Canvas Back now targets the app's actual Back control: exact text `Back` by default, with editable text/identifier matching and simulator picking. Its YAML is an executable `tapOn` command; the `tnt-back` comment preserves its row type on save/reopen. Old saved canvas Back rows are projected to the same control. Legacy association-only YAML is unchanged.

Controlled no-check proof: workspace `0c9e0f25-e0f9-4f5c-81c2-59a5b1c62116`, run `d4fce4a0-9029-4493-b6b7-4a9ca96a6f2a`, booted iPhone 15, fixture `com.example.TnTRepeatedVisitProof`. Launch, opening Coordinator, and tapping Back passed. The post-run hierarchy contains `home.returned` and does not contain `coordinator.fixed`, confirming actual return to Home. The preceding raw-Back run `da6d9cfa-c4b0-415a-a3eb-b508467c39f3` reported success but stayed on Coordinator and is not counted as navigation proof. Local evidence remains under ignored `.tnt/`.

Public UI regressions cover optional checks, Back type and selector persistence, check/action reordering in both directions and actual execution order, drag destination binding, per-row destination changes/removal, and first-action connection splitting. Existing finite routes, explicit operation memberships, included-check failures and legacy YAML association behavior remain covered.

Browser verification reopened the corrected workspace, added an optional Home check before the navigation action in the same node list, and ran Home → Coordinator → Home successfully (`89f66cc3-e452-4322-a680-afa68356e283`). Command evidence is launch → Home check → open Coordinator → Back control tap → Home check. Screenshot: ignored `.scratch/issue-22-ordered-operations.jpg`.

Final validation: all 110 tests, type checking, production build and whitespace checks passed.

### Standards

No remaining actionable findings. Review verified the distinct-ID correction and Back selector persistence.

### Spec

No remaining actionable findings against the latest user requirements. Optional checks, drag destinations, one reorderable operation list, per-row destination changes and actual iOS Back navigation are covered.

Review totals: Standards 0; Spec 0.
