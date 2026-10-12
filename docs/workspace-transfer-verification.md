# Editable workspace transfer (#35)

Implements [issue #35](https://github.com/GE-N/TnT/issues/35), under the workspace manager specification (#31). Transfer uses the existing local workspace service and authenticated same-origin HTTP boundary.

## Contract and behavior

The manager exposes Export workspace and Import workspace. Export reviews a stable acknowledged revision, with its saved time, before downloading a human-readable `.tnt-workspace.json` filename. Format `tnt-workspace`, version 1, includes a dependency summary. Packages are bounded to 1.1 MB including formatted serialization; existing YAML, flow, canvas, mock and combined-content bounds still apply. Embedded references accept bounded PNG/JPEG data, never external paths.

Portable content includes the shared graph and internal references, scenario order and visits, authored YAML, reusable flows, setup/default handlers, mock definitions and supported embedded references. The outer workspace identity, metadata, derived execution graph, personal views, recovery drafts, runtime/session/ownership values and historical evidence are excluded. Stored scenario input, setup and handler invocation values are omitted by default and declared by stable owner/name; reviewed opt-in retains them. Authored YAML and mock literals remain included and require human review. Dormant mock TLS paths and credentials are excluded.

Import begins empty. Choose file opens the system picker; dropping one JSON file on the panel or full library uses the same validation and review. File selection does not persist a workspace. Review shows filename, editable title, counts, content, dependencies and repair requirements. Only Import and open preserves pending valid edits or durable invalid drafts, then creates a fresh outer identity and opens it. Write rejection removes incomplete import directories and leaves current work intact. Structurally valid unresolved flow/graph/scenario references remain editable and are diagnosed; execution still validates dependencies and omitted values before device acquisition. Import never runs tools or mocks.

Active execution permits export of an explicitly identified saved revision and review/browsing; committing an import waits for cleanup. Incomplete drafts require repair or explicit review of the last saved revision. Download uses the exact reviewed package even if authoring subsequently changes.

## Evidence

- `tests/workspace-portability.test.ts`: real service round trips, default/opt-in values, retained contracts, revision conflicts, malformed/unsafe/newer/oversized content, unresolved flow repair, failed atomic writes, reference image validation, unsafe scenario setup/canvas paths, legacy placeholder diagnostics, scenario-specific omitted-value validation including projected checkpoints and legacy setup invocations, and export while an immutable run is active.
- `tests/workspace-portability-ui.test.ts`: public React journeys backed by the real service. Picker review/commit, downloaded representative package through library drop, repeated visits, flows/setup/mocks/imagery, original preservation and separate identities, malformed/multiple-file feedback, cancellation, invalid-draft preservation, keyboard Escape/focus return, explicit saved-revision fallback, and retry after persistence failure.
- Browser review used an isolated temporary runner store on port 4355. Native Choose file selected an actual exported package; review and Import and open restored the canvas as a separately named copy. Desktop and 390 × 844 layouts were inspected. Narrow layout uses the existing scrollable single sheet; cancellation/focus and file drop are additionally covered in UI journeys.
- Typecheck and production build passed. Full suite: 215 tests passed, no failures. Existing suite emits React `act` warnings in older journeys; assertions pass.

No simulator/app portability or automatic secret detection is claimed. Recipients must supply their compatible app/simulator and required omitted values. Temporary browser fixtures and stores are separate from the user's `.tnt` records.

## Review

Standards review found no documented-standard violations and one ownership-string heuristic; omitted-value owners now have a shared domain type. Its correctness finding about unrelated scenarios/disabled handlers blocking execution was fixed with execution-scoped validation. Specification review found unsafe scenario setup filenames being retained as repairable and legacy placeholders missing review diagnostics; both were fixed and covered by public service regressions. The original service and execution confidentiality guarantees remain the boundary.
