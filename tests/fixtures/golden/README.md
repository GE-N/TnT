# Golden canvas routes

These fixtures lock the canvas linking and YAML behaviour from before the floating inspector. Later tasks re-run the same scripts and require the same bytes.

`shared/`, `server/canvas.ts`, `server/canvas-route.ts` and `server/default-actions.ts` are protected. `npm run check:canvas-contract` runs `scripts/check-canvas-contract.sh`, which compares them with the contract base `6639263` (the merge of #44, optional destination and same-screen actions, in #53, on top of the #41 golden snapshots). It is not part of `npm test`.

The diff against that base must equal the named exceptions in `scripts/canvas-contract-exceptions/` exactly. The #52 exception records the exact literal Back selector-preservation fix in `52-literal-back-selector.patch`; any other change to the protected files fails the check. Changes to the exceptions folder and the contract script require review from @GE-N (`.github/CODEOWNERS`).

CI must check out the repository with `fetch-depth: 0`. A shallow clone may not contain the contract base, and the script fails with that requirement instead of reporting a vacuous pass. On a push to `main` in CI there is no feature branch to compare, so the script prints a skip message and exits 0. That skip runs only when `CI` is set. A local checkout of `main` is still checked.

```bash
npm run check:canvas-contract
```

## Fixtures

| File | What it locks |
| --- | --- |
| `linear-route.json` | Home → Detail, then connect to an existing screen, clear that destination, and undo |
| `text-tap.json` | `tapOn` by text, rewritten when its selector is edited, then retargeted from Detail onto More |
| `id-tap.json` | `tapOn` by element id, rewritten when its selector is edited, then retargeted from Detail onto More |
| `literal-back.json` | A literal `- back` command linked to an id `backSelector`. Projection rewrites it as `tapOn` by id; the opened page retains the same id selector |
| `back.json` | Back by element id; editing the selector rewrites the `tnt-back` tap |
| `repeated-visit.json` | Home → Detail → Home. Editing Visit 3 by `visitId` copies the shared Home check |
| `shared-step.json` | One tap shared by two scenario routes. An edit in scenario A leaves scenario B unchanged |
| `multi-action-edge.json` | A tap and an input on one edge. After the sibling and destination check are removed, retargeting leaves a route whose execution YAML is projected |
| `unfrozen-visits.json` | A scenario route whose visits have no `operationIds`. Editing Visit 1 by `visitId` freezes them |
| `legacy-visits.json` | Saved visits with no `operationIds`. Deleting the return connection runs the visit freeze, then stores the surviving visits without `operationIds` |
| `deletion-cut.json` | Delete a step, a connection, and a screen, each cutting the route suffix, with undo |
| `default-actions.json` | Setup plus a handler checkpoint on an ordered route. Editing the authored tap keeps the checkpoint |
| `same-screen-steps.json` | A same-screen tap and a same-screen input run in place before the navigating tap. Only the navigating tap carries the `edgeId` (#44) |
| `stays-on-screen.json` | Clearing the destination of a navigating tap cuts the route, keeps the tap as a same-screen step, and the route still projects. Undo restores it (#44) |
| `check-after-navigation.json` | A check after the navigating tap in the same visit runs after it, with no diagnostic (#44) |
| `same-screen-last-visit.json` | A same-screen tap in the last visit, which has no outgoing connection, runs in place (#44) |
| `retarget-frozen-visit.json` | Retargeting the navigating tap of a frozen visit onto another screen keeps the same-screen tap off the connection, and the route still projects (#44) |
| `retarget-same-screen.json` | Retargeting a navigating tap to its current destination is a no-op (#44) |
| `legacy-missing-destination.json` | A legacy start-only route whose tap has no destination reports the missing destination instead of projecting. Connecting the tap makes the route project |

Each snapshot records, for the baseline and after every script:

- workspace YAML from `writeChecks`
- `projectCanvasRoute` execution YAML and step mapping
- `routeVisits`, `visitScreenId` and `visitOperations` for every visit
- the screen, edge and path identities those visits sit on

Generated ids are seeded from `crypto.randomUUID` and then rewritten as `id:1`, `id:2`, … in the order they first appear. A second run produces the same snapshot. Hand-written ids such as `home` and `tap-gear` stay as they are.

## Runners

`tests/golden-canvas.test.ts` runs every fixture twice:

- the pure-function runner calls the `shared/` helpers directly. Its editor copy must stay in sync with `CanvasEditor` in `src/canvas.tsx`
- the UI runner opens the saved workspace on the real scenarios page (`src/scenarios.tsx`) through the service, and drives save/open with `tests/workspace-ui-helpers.ts`

Add-check placement is intentionally not a golden script. A new check landing at the end of a visit is the one later behaviour change and belongs in its own test.

## Update on purpose

Regenerate the fixture JSON and the snapshots only when the current canvas behaviour is meant to change:

```bash
GOLDEN_UPDATE=1 node --import tsx --test tests/golden-canvas.test.ts
```

Review the diff. Do not update a snapshot to hide an accidental route or YAML change. Baselines for fixtures whose authored graph did not change must stay byte-identical.
