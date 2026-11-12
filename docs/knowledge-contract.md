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
active workspace directory. Sidecar source reads run outside the queue, with a
shared writer epoch and saved workspace revision rechecked inside it; final commits
reject a superseded capture. Every sidecar writer advances that epoch in the queue. `queue` is `{enqueue(scopeId,job): void | Promise<void>}`;
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
   Production passes the held guard into `createKnowledgeService` together with
   `renderKnowledgeHtml`, reconciles saved sources before accepting requests, and
   injects that same service as `createApiHandler`'s sixth argument. Its workspace
   store shares the existing root-keyed serialization queue; no second queue or
   always-owned production writer is created by the HTTP fallback.
4. Tests and `npm run dev` keep working: tests use their own temp roots; the lock is
   released on clean exit and recovered when its owner is provably dead.

## AI update path

This addendum does not change the slice-1 sidecar. `schemaVersion` stays 1.
`origin` and `skill` are not sidecar fields. They live on the apply receipt only.
An unapplied or dismissed draft is never written to the sidecar, the published HTML,
or the LLM index. Saving a draft is a separate apply call; generation only stores
the draft on the AI job.

### Skills

Two skills ship with the server and are loaded at startup:

- `router@1` from `server/ai/skills/router/v1/prompt.md` and `schema.json`
- `knowledge-update@1` from `server/ai/skills/knowledge-update/v1/prompt.md` and `schema.json`

Each job that uses a skill records `skill` (`router@1` or `knowledge-update@1`) and
`skillHash`, the SHA-256 of the raw `prompt.md` bytes immediately followed by the
raw `schema.json` bytes. A hash-pin test fails if either file changes without a
new version folder. Request text is data, not instructions.

### Routing

`POST /api/ai/generations` keeps the existing body (`workspaceId`,
`expectedRevision`, `expectedSettingsRevision`, `prompt`, optional `previousJobId`
and `answers`). There is no intent or mode field. When a scenario catalog is
available, the server asks the router skill and infers
`intent: "flow" | "knowledge" | "mixed" | "unclear"`. Off-schema router output, a
provider error, or a timeout while routing becomes `unclear` and an ask-back.
A router failure never becomes a flow draft.

The job phase stays one of the existing phases. Routing uses `context`. There is
no `routing` phase. Refining a draft skips the router because the kind is already
known, except when the text says “I meant the flow” or “I meant the details”.
That misroute runs the router again.

`mixed` produces a flow draft first and stores the original request as `remainder`
on the job and on `GenerationView`. The knowledge pipeline does not run until a
later confirmation. There is no combined apply.

A pending or needs-info draft of the other kind in the same workspace answers
“Finish the current draft first?” with Apply it · Dismiss it, and does not start
a second draft.

### Jobs

`StoredJob` gains `kind: "flow" | "knowledge"`, optional `knowledgeDraft`,
`skill`, and `skillHash`. `GenerationView` gains `intent` and, for a knowledge
draft, `knowledgeDraft` (the six context fields plus `baseContextRevision`).
The knowledge draft is not a flow `draft` and has no preview. Flow provider
bytes after the router call stay the flow prompt from contract v1.

The knowledge skill returns the six context fields, at most three questions, and
`conflicts`. Purpose and Expected outcome may be drafted from the flow. Why
(`rationale`) is kept only when it is the user’s own words. A purpose, expected
outcome, or precondition that names a screen or action the steps do not reach
becomes questions and no draft. “Save as written” then drafts that wording.
“Update the flow instead” and “The flow” send the same request through the flow
pipeline.

### Apply and undo

Apply and undo go through the existing sidecar writer (store queue, root guard,
`saveContext` for the forward write). Publication is scheduled and never awaited.
Knowledge has no Versions history.

- `POST /api/knowledge/workspaces/:workspaceId/scenarios/:scenarioId/apply`
  body `{"jobId":"…","expectedContextRevision":1,"idempotencyKey":"…"}`.
  The context bytes come from the stored knowledge draft, not from the client.
  The server writes `knowledge/receipts/<receiptId>.json` under the workspace
  first, holding the previous sidecar bytes (or `null` when there was no file)
  plus `origin: "ai"` and `skill`. It then `saveContext`. The same idempotency
  key returns that receipt and does not write the sidecar again. A context
  revision mismatch is `CONTEXT_REVISION_CONFLICT` and writes neither a receipt
  nor the sidecar.
- `POST /api/knowledge/workspaces/:workspaceId/scenarios/:scenarioId/undo`
  body `{"receiptId":"…","expectedContextRevision":2}`.
  Restores the receipt’s previous sidecar bytes exactly, including
  `reviewedAgainstSourceHash`, so a “needs review” context stays “needs review”.
  A later PUT cannot do that, because `saveContext` records the current source
  hash. Undo uses the same queue, guard, and atomic write as the sidecar; it
  does not call `saveContext`, because that would re-review the source.

The client hides Undo after 10 seconds (`UNDO_CLIENT_WINDOW_MS`). This server does not.

A confirmed flow diagram is not a seventh context field. It is `<scenarioId>.diagram.json` beside the sidecar (Mermaid plus the path list, no image bytes). Diagram apply writes a receipt with the same fields as a knowledge receipt plus `previousDiagram` (`null` when there was no file) and `skill: "diagram@1"`. Knowledge receipts stay the old shape. Undo of a diagram receipt restores the previous diagram file as well as the previous sidecar bytes. `GET .../context` does not include the diagram. `GET .../diagram` returns it only when asked. The info sheet does not grow a diagram block.
It accepts a receipt until pruning. Receipts older than 24 hours
(`RECEIPT_RETENTION_MS`) may be deleted on the next apply or undo. A pruned
receipt is `KNOWLEDGE_NOT_FOUND`. Auth, `Cache-Control: no-store`, id decoding,
and the slice-1 error codes are unchanged.

### Client review

The workbench reviews a knowledge draft in the existing info sheet and the existing
Ask AI capsule. Nothing here adds a mode, a second field, or a Versions entry.

- While the request is running, the Ask AI field keeps the prompt, animates the
  spark, and shows Stop. It does not show a heading or the words “Generating…”.
- When a knowledge draft arrives, the info sheet opens. Purpose and Expected
  outcome that differ from the saved context are tinted `rgba(10,132,255,.08)`
  with a 2px accent in the sheet gutter, so the text column does not move.
  Why stays collapsed and is never tinted. ✓ Apply and ✕ stay on the Ask AI
  capsule.
- If the sheet is closed while the draft is pending, it stays closed. No other
  right-hand panel opens, and the info button gains no badge. Apply remains.
- An ask-back uses the existing question UI. It can be dismissed and has no Apply.
  The sheet is unchanged.
- A mixed request stays a flow draft. The info sheet does not open. After that
  flow is applied, the capsule asks “Update the purpose too?” with Update details
  and Skip, beside the flow’s 10 second Undo. Update details sends the stored
  remainder through the same generation endpoint. Skip leaves the flow as applied.
- Knowledge Apply clears the tint, shows Updating and then the saved freshness,
  and offers Undo on the capsule for 10 seconds. It does not write a Versions row.
- `KNOWLEDGE_UNAVAILABLE` shows “Scenario details aren't available right now.
  Nothing was changed.” `CONTEXT_REVISION_CONFLICT` shows “These details changed
  somewhere else. Nothing was applied.” The codes are not shown. Apply waits
  until the sheet has reloaded the server copy, then sends that revision.
