# Scenario knowledge contract — RFC #92 slice 1

Version 1. This slice covers an isolated workspace scope only; there are no projects,
search, suggestions, observation sidecars, package changes or execution changes.
Knowledge never writes authored/compiled YAML, trust records or execution snapshots.

## Authored sidecar

`.tnt/workspaces/<workspaceId>/knowledge/scenarios/<scenarioId>.json`:

```json
{"schemaVersion":1,"workspaceId":"uuid","scenarioId":"scenario-id","contextRevision":1,"updatedAt":"2026-10-30T00:00:00.000Z","purpose":"","expectedOutcome":"","rationale":"","preconditions":"","exceptions":"","scope":"","reviewedAgainstSourceHash":"64 lowercase hex characters"}
```

All six content fields are plain strings (maximum 16,000 UTF-8 bytes each, no NUL).
`rationale` is the Why field; `scope` is authored scope notes. Unknown fields are
rejected. IDs follow existing workspace UUID and scenario `[A-Za-z][A-Za-z0-9_-]{0,63}`
validation. Paths never use titles. Missing sidecars return empty content, revision
0, `updatedAt: null`, `reviewedAgainstSourceHash: null`; reads do not create them.
Save validates all fields and the nonnegative integer expected revision. It records
the current saved source hash as reviewed, increments the context revision, and
atomically persists only the sidecar through the workspace store's existing
root-keyed serialization queue. An identical content/hash save is a no-op. A review
of unchanged prose against changed saved source is a new context revision.

## Source projection and freshness

`sourceDescriptor` is `{projectionVersion:1,workspaceRevision,sourceHash}`.
`workspaceRevision` is provenance only. `sourceHash` is SHA-256 over UTF-8 canonical
JSON (recursively sorted object keys, preserved array order, omitted undefined object
properties, no whitespace). Projection includes the selected scenario's ordered
commands/visits/checks and relevant root YAML configuration, referenced reusable
flows recursively, declared setup and enabled default actions/checkpoints, mock
configuration/selected response, parameter declarations and input names, and script
identity/anchor/content SHA-256. Script source is hashed but never published.
Canvas-authored scenarios select operations from the saved path, preserving repeated
visits. Broken references have explicit diagnostics and stable missing markers.
It excludes unrelated scenarios, unused flows/tests/edges, display names/labels,
canvas coordinates/screenshots, timestamps/openedAt, workspace revision counters,
knowledge, script trust, device/tool versions and per-run/runtime input values.
Renames republish navigation without invalidating reviewed intent. Step/check,
setup, relevant mock and script changes invalidate it. Restoring the exact reviewed
content restores reviewed intent. Source projection does not compile or run a flow.

Every scenario read exposes both independent fields:

- `publicationFreshness: "current" | "publication-stale"`: current only when a
  complete published generation matches the live workspace/context/evidence inputs.
- `intentFreshness: "reviewed" | "intent-needs-review"`: missing context or a
  reviewed-against hash unequal to the saved source needs review.
- `freshness: "up-to-date" | "updating" | "needs-review"`: needs-review takes
  precedence for unresolved intent or publication error; otherwise stale means
  updating, and only current + reviewed means up-to-date.

A current generation cannot clear intent review. Save success means context saved,
not knowledge published. An absent generation is stale/pending, never empty/current.
Source capture and publication errors retain authored context and the older pointer.
Reconciliation/rebuild retries from live saved sources, including save-before-enqueue
crashes. Unsaved editor drafts are never indexed.

## Read model and evidence

A scenario detail contains `workspaceId`, `scenarioId`, `title`, `context`,
`sourceDescriptor`, `flow: {steps,visits,diagnostics}`, `evidence`, `freshness`,
`publicationFreshness`, `intentFreshness`, `generationId` (string or null),
`generatedAt` (ISO UTC or null), `publicationError` (string or null), and `readerUrl`.
Each numbered step is `{number,text,visitId?,testId?}`; `text` uses the canvas node
wording, e.g. `"1 · Tap text · Continue"`. Visits are
`{number,id,screenId,title,steps}`; repeat visits remain distinct. Opaque scripts
are explicitly opaque, broken references are diagnostics, never invented facts.

Evidence is `{status,runId,finishedAt,label,notice}` from the latest **completed**
existing run whose saved snapshot workspace/scenario IDs match. Without one:
`{status:null,runId:null,finishedAt:null,label:"No runs yet",notice:"Run results do not establish authored expected outcomes."}`.
Existing run status strings are preserved (including failures/cancelled). No logs,
inputs, screenshots, mock bodies or script source are published; no new evidence
storage is introduced and legacy results do not prove current source coverage.

## HTTP API

Existing local-host/origin/session-token checks apply. All JSON responses use
`Cache-Control: no-store`. URI IDs are decoded once and validated.

- `GET /api/knowledge/workspaces/:workspaceId/scenarios/:scenarioId/context`
  → 200 scenario detail (shape above).
- `PUT /api/knowledge/workspaces/:workspaceId/scenarios/:scenarioId/context`
  body: `{"expectedContextRevision":0,"context":{"purpose":"…","expectedOutcome":"…","rationale":"…","preconditions":"…","exceptions":"…","scope":"…"}}`
  → 200 scenario detail after durable context save; indexing is scheduled, never
  awaited. Save reviews against the saved flow captured inside the store queue.
- `GET /api/knowledge/workspaces/:workspaceId/status`
  → 200 `{workspaceId,scopeId,generationId,generatedAt,publicationFreshness,freshness,publicationError,scenarios:[{scenarioId,freshness,publicationFreshness,intentFreshness}]}`.
- Reserved for T4: `GET /knowledge/workspaces/:workspaceId/` (reader workspace
  page), `GET /knowledge/` (reader index), anchors `#scenario-<scenarioId>`.
  `readerUrl` is `/knowledge/workspaces/<workspaceId>/#scenario-<scenarioId>`.
  These are read-only runner routes; live visibility and freshness must be checked.
  T4 may use the status API for live checks with the existing runner session token.

Errors are `{code,error}`: 400 `INVALID_KNOWLEDGE_INPUT`, 404
`KNOWLEDGE_NOT_FOUND` (missing/trashed workspace or missing saved scenario), 413
`KNOWLEDGE_TOO_LARGE`, 503 `KNOWLEDGE_UNAVAILABLE` (storage/ownership failure).
409 is exactly `{code:"CONTEXT_REVISION_CONFLICT",error:"Context was changed in another editor.",currentContextRevision:2,context:{…server sidecar…}}`.
The client retains its draft on conflict. Existing authentication failures retain
the runner's existing 403 shape; unsupported knowledge methods return 405.

## Generation, index and extension seams

Scope ID: `workspace-<workspaceId>`. Generation ID: a generated UUID.

```text
.tnt/knowledge/generations/<scopeId>/<generationId>/
  manifest.json
  index.jsonl
  documents/<scenarioId>.txt
  index.html
  workspaces/<workspaceId>.html
.tnt/knowledge/current/<scopeId>.json
```

Manifest: `{formatVersion:1,generationId,scopeId,workspaceId,generatedAt,sources:[{scenarioId,sourceDescriptor,contextRevision}],documents:[{documentId,path,sha256}],artifacts:[{path,sha256}]}`.
Each JSONL section: `{documentId,sectionId,generationId,workspaceId,scenarioId,title,section,text,tags:[],language:"und",sourceDescriptor,contextRevision,generatedAt,kind,publicationFreshness,intentFreshness,sourceReferences:[],htmlLocation}`.
`kind` is `authored-context`, `derived-flow-facts` or `observation`. Semantic section
IDs are stable (`purpose`, `expectedOutcome`, `rationale`, `preconditions`, `flow`,
`exceptions`, `scope`, `evidence`); UTF-8 sections are bounded deterministically.
The evidence notice is included. No search is exposed in this slice.

Pointer: `{formatVersion:1,scopeId,generationId,previousGenerationId,generatedAt,inputHash}`.
CPU-heavy flow projection and text/index construction run in worker threads, outside
the runner event loop and workspace queue. Required files, matching descriptors,
checksums, HTML and all text documents are validated before the final queued
source/lifecycle comparison. The fsynced temporary pointer is atomically renamed
under the scope serialization and workspace store queue. A partial generation
never becomes current. Keep current and previous complete generation; readers pin
a generation while reading; cleanup cannot remove a pinned generation. Pointer
rename is the commit point; acknowledgment failure may leave the complete new
pointer committed. Other scopes' pointers are untouched.

Core exports `createKnowledgeService({root,store?,guard?,queue?,now?,faults?,readRuns?,renderHtml?})`.
`store` is `ReturnType<typeof createWorkspaceStore>`; its `withKnowledge` method
captures/commits under the existing serialization queue and supplies the validated
active workspace directory. `queue` is `{enqueue(scopeId,job): void | Promise<void>}`;
its result is never awaited by save or run. `readRuns(workspaceId)` returns existing
completed/running run records. `renderHtml(generation)` returns a map of relative
HTML paths to UTF-8 strings and must include `index.html` and
`workspaces/<workspaceId>.html`; T4 owns `server/knowledge/html/` and supplies it.
The core supplies inert minimal HTML/text fallback until T4's reader is integrated.
Generation input is `{generationId,scopeId,workspaceId,workspaceTitle,generatedAt,scenarios}`
with scenario details captured from the same sources as text. `service.readContext`,
`saveContext`, `status`, `rebuild`, `reconcile`, `publish`, `pinCurrent`, `close` are
available internally. `createApiHandler` takes an optional sixth knowledge-service
argument; its default uses the root above the launches artifact directory. T6 can
construct a guarded service with T4 renderer and inject it explicitly.

Injectable async `faults.hit(stage, detail)` pauses or fails at:
`after-source-commit`, `after-descriptor-capture`, `artifact-write` (each file),
`before-generation-complete`, `before-validation`, `after-validation`,
`before-final-check`, `after-final-check`, `before-pointer-rename`,
`after-pointer-rename`. Hooks do not make editing/running await publication.
Recovery enqueues rebuilds from source; generated artifacts are disposable.

## AC21 ordering (binding SESSION-SPLIT agreement)

1. `server/main.ts` acquires root ownership of the canonical `.tnt` root
   (`server/root-ownership.ts`, O_EXCL lock file `.tnt/runner.lock` holding host, pid,
   process start time, nonce; liveness check; conservative stale recovery) **before**
   constructing the workspace store, the knowledge queue/publisher, any recovery,
   or the HTTP listener. A loser exits non-zero and constructs none of them.
2. Only then: workspace store and its serialization queue → knowledge recovery
   (pending generations) → knowledge indexing queue → HTTP routes. The existing
   per-device execution lock is unchanged and still taken lazily at run time.
3. Knowledge writers (sidecar save, generation write, `current/<scope>.json`
   pointer switch, recovery enqueue) take an injectable
   `RootGuard { assertOwned(): void }` and call it immediately before each mutation.
   T2 ships a default always-owned guard for tests; T5 exports the real guard from
   `server/root-ownership.ts` (`acquireRootOwnership(root) → { guard, release }`).
   T6 wires T5's guard into T2's constructors.
4. Tests and `npm run dev` keep working: tests use their own temp roots; the lock is
   released on clean exit and recovered when its owner is provably dead.
