# Golden canvas routes

These fixtures lock the canvas linking and YAML behaviour from before the floating inspector. Later tasks re-run the same scripts and require the same bytes.

`shared/`, `server/canvas.ts`, `server/canvas-route.ts` and `server/default-actions.ts` are not part of this change. `scripts/check-canvas-contract.sh` checks that their diff against the task base is empty. `npm test` runs that check, and CI can call the script directly:

```bash
bash scripts/check-canvas-contract.sh
bash scripts/check-canvas-contract.sh origin/main
```

## Fixtures

| File | What it locks |
| --- | --- |
| `linear-route.json` | Home → Detail, then connect to an existing screen, clear that destination, and undo |
| `text-tap.json` | `tapOn` by text |
| `id-tap.json` | `tapOn` by element id |
| `repeated-visit.json` | Home → Detail → Home, with the Home check reused on the return visit |
| `shared-step.json` | One tap shared by two scenario routes |
| `multi-action-edge.json` | A tap and an input on one edge, then retarget splits the edge |
| `legacy-visits.json` | Saved visits with no `operationIds`; the return visit keeps a check subset |
| `deletion-cut.json` | Delete a step, a connection, and a screen, each cutting the route suffix, with undo |
| `default-actions.json` | Setup plus a handler checkpoint on an ordered route |

Each snapshot records, for the baseline and after every script:

- workspace YAML from `writeChecks`
- `projectCanvasRoute` execution YAML and step mapping
- `routeVisits`, `visitScreenId` and `visitOperations` for every visit
- the screen, edge and path identities those visits sit on

Generated ids are seeded from `crypto.randomUUID` and then rewritten as `id:1`, `id:2`, … in the order they first appear. A second run produces the same snapshot. Hand-written ids such as `home` and `tap-gear` stay as they are.

## Runners

`tests/golden-canvas.test.ts` runs every fixture twice:

- the pure-function runner calls the `shared/` helpers directly
- the UI runner mounts today's canvas in jsdom and sends workspace save/open through `tests/workspace-ui-helpers.ts`

Add-check placement is intentionally not a golden script. A new check landing at the end of a visit is the one later behaviour change and belongs in its own test.

## Update on purpose

Regenerate the fixture JSON and the snapshots only when the current canvas behaviour is meant to change:

```bash
GOLDEN_UPDATE=1 node --import tsx --test tests/golden-canvas.test.ts
```

Review the diff. Do not update a snapshot to hide an accidental route or YAML change.
