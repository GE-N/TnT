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
