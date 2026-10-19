# TnT Flow Authoring Contract v1

Status: **Detailed design proposal for review — not an implemented or approved API**
Updated: 2026-10-19
Parent: [AI flow RFC](ai-flow-authoring-rfc.md)

This document replaces the RFC's illustrative draft shape. It chooses concrete v1 behavior, including Run script, rather than deferring field semantics to implementation. Review may change the design before it becomes a compatibility commitment.

## 1. Code baseline and scope

Reviewed fetched `origin/main` commit `8ca86e79c3e0a5f8939d3baa457a735d54423490`, including Run script UI PR #84 and scenario panel PR #85. Fetch succeeded during `git pull --ff-only`; checkout update stopped because the incoming tracked `AGENTS.md` conflicts with the local untracked file. Source inspection used `git show` at the fetched revision, not the older working-tree files. No local instructions were removed.

Relevant pinned implementation:

- [ScriptRow / ScriptAnchor / result contract](https://github.com/GE-N/TnT/blob/8ca86e79c3e0a5f8939d3baa457a735d54423490/server/run-script-contract.ts)
- [Run-plan construction and anchor mapping](https://github.com/GE-N/TnT/blob/8ca86e79c3e0a5f8939d3baa457a735d54423490/server/run-script-plan.ts)
- [Machine-local script trust](https://github.com/GE-N/TnT/blob/8ca86e79c3e0a5f8939d3baa457a735d54423490/server/script-trust-store.ts)
- [Editor script ordering and end anchors](https://github.com/GE-N/TnT/blob/8ca86e79c3e0a5f8939d3baa457a735d54423490/src/run-script.ts)
- [Runner integration](https://github.com/GE-N/TnT/blob/8ca86e79c3e0a5f8939d3baa457a735d54423490/server/scenarios.ts)

Current scripts are scenario-owned `ScriptRow`s, not canvas nodes or normal `CanvasTest`s. They are inserted before an authored operation occurrence or at scenario end. Rows at the same anchor preserve array order. Setup and handlers are not counted as anchor steps. The runner materializes generated `.js` files and Maestro `runScript` commands. It already handles script failures, later not-run steps, trust, and evidence protection.

V1 creates one new canvas-authored scenario. It supports reused screens, repeated visits, ordered actions/checks, and inserted JavaScript scripts. It does not patch an existing scenario, accept arbitrary Maestro YAML, import external script paths, or expose shell/Node execution. A script executes in Maestro's JavaScript runtime, not in TnT's server runtime.

## 2. Deliverables and authority

- [Machine-readable draft schema](contracts/ai-flow-v1/flow-draft.schema.json), JSON Schema 2020-12.
- [Complete repeated-visit and script example](contracts/ai-flow-v1/repeated-visits-with-scripts.json).
- Semantic rules, lifecycle, translation, and API behavior in this document.

The schema defines the accepted shape; this document adds semantic invariants that JSON Schema cannot express. Both are required. Unknown properties are rejected, not silently ignored. All keys and enums are case-sensitive. JSON object member order is irrelevant; arrays retain order. Duplicate JSON member names are rejected at request decoding.

The server owns workspace IDs, scenario IDs, test IDs, script row IDs, hashes, and trust. Draft keys are temporary references only. No caller may submit internal anchors, fingerprints, trust flags, execution evidence, or output filenames.

## 3. Draft fields and rules

| Field | Required meaning |
| --- | --- |
| `schemaVersion` | Integer `1`; unsupported versions fail before translation |
| `mode` | `createScenario` only |
| `name` | Trimmed nonempty scenario title, at most 120 characters |
| `appId` | Literal app ID validated by the existing runner; must match workspace configuration |
| `parameters` | Names, types, required flags; no values or secrets in the draft |
| `execution` | Explicit launch/setup, handler references, and mock selection; no implicit inheritance |
| `screens` | New screens or explicit existing screen IDs, assigned draft-local keys |
| `visits` | Execution order; each visit owns an ordered list of UI operations |
| `scripts` | Insertions around UI operation occurrences; source and requirements included |
| `assumptions` | Visible interpretation choices, with affected keys and confirmation requirements |

Keys match `^[A-Za-z][A-Za-z0-9_-]{0,63}$`. Screen, visit, operation, script, and assumption keys must be globally unique within the draft. This makes diagnostic paths and acknowledgements unambiguous. Parameter names have their own uppercase namespace; duplicates and the existing reserved names/prefixes are errors. Every `about` key must resolve to a screen, visit, operation, or script in this draft.

Bounds: at most 80 declared screens, 81 visits, 80 transitions, 100 total UI operations, 100 scripts, and 20 parameters. The schema's per-visit operation cap does not replace the global cap. Script source is limited to 64,000 UTF-8 bytes per row; the request draft is limited to 256,000 UTF-8 bytes. Existing workspace aggregate and YAML limits are checked against the resulting workspace as well. Capabilities may advertise lower available capacity. Reject oversize input; do not truncate code or silently omit steps.

Each declared screen must be visited. An existing screen ID may be declared once; use its key for repeat visits. Existing titles, screenshots, positions, and other scenarios' content are unchanged. New screens are laid out in first-visit order in free canvas space, without overlap or moving existing nodes.

### 3.1 Visits and navigation

`visits` is a finite sequence, not a branching graph program. A visit references a declared `screenKey`.

| Operation kind | Fields beyond `key`/`kind` | Meaning |
| --- | --- | --- |
| `tap` | `target`, `destination` | Tap selected element; explicitly stay or navigate |
| `back` | `target`, `destination` | Tap the app's Back control; no assumed iOS system Back |
| `input` | `value` | Type into currently focused field; no automatic tap/focus |
| `checkVisible` | `target` | Assert visibility on this visit |
| `checkAbsent` | `target` | Assert absence on this visit |

For each nonfinal visit, exactly one operation has destination `{kind:"visit", visitKey:<next visit>}`. It must be the last UI operation of that visit. All earlier tap/back operations explicitly use `{kind:"stay"}`. Checks and input do not navigate. The final visit cannot navigate to another visit. A transition can target another visit of the same screen; occurrence identity remains distinct.

The final visit may have no operations, but then the preview warns `DESTINATION_UNVERIFIED`. A single-screen empty scenario is not applicable unless it contains at least one script. Entirely empty drafts remain generation proposals. Script-only scenarios use one screen/visit and `scenarioEnd` script anchors; v1 does not create a second script-only editor model.

No assertions are auto-added, copied from another visit, or inherited from an existing screen. A journey without UI assertions may still be authored, but preview returns `NO_UI_ASSERTIONS`. Passing commands alone do not establish the user's business expectation.

### 3.2 Target resolution

Targets are a discriminated union:

```json
{"kind":"context","ref":"target-27"}
{"kind":"selector","selector":{"target":"id","match":"exact","value":"submit"}}
{"kind":"unresolved","description":"The payment confirmation button"}
```

`context.ref` resolves only inside the supplied context snapshot and owning screen. References are opaque and version-bound. A deleted/changed source or mismatched screen is an error. A new screen uses explicit selectors or unresolved targets; v1 does not reuse a target from another screen implicitly.

Explicit selectors support only the current canvas form subset: text/id with exact/contains/regex. Validate regex and escape exact/contains using the existing authoring implementation. Literal values must not contain `${...}` expressions. Context targets using unsupported complex selectors are excluded from v1's selectable catalog with an explicit reason. Coordinates are not accepted in v1.

An explicit selector supplied by AI is an unverified proposal, not an observed element. Preview states its provenance; the authoring service must not mark it inspected. Live verification is a separate picker/run operation.

An unresolved target is structurally valid but blocks apply. This is a deliberate initial product choice: retain it in the generation draft until repaired rather than putting fake selectors into the workspace. Future editor support can relax this without changing the unresolved target shape.

### 3.3 Input values and setup

Input values are `{kind:"literal",text}`, `{kind:"parameter",name}`, or `{kind:"unresolved",description}`. Literal text cannot contain `${...}`. Parameter references must be declared; the translator emits the exact `${NAME}` placeholder. Runtime values are supplied through the existing run controls. Missing runtime values do not block authoring application.

`execution.setup` is `{kind:"launchApp"}` or `{kind:"context",ref}`. A setup context reference includes its file, parameter bindings, and configuration digest; it is selected from an existing valid setup and cannot be edited through this API. `handlerRefs` lists existing handlers explicitly; nonempty handlers require a compatible context setup. `execution.mock` is `{kind:"none"}` or a context reference to an existing valid mock selection. TnT does not invent a route/response ID or configure app networking.

Context offers only setup/mock selections whose existing static bindings are valid; it omits secret values from model context. Changing workspace-wide configuration is outside createScenario. If the requested launch/setup policy cannot be represented without changing shared configuration, return `SHARED_EXECUTION_CONFLICT`, not an approximate plan.

## 4. Script contract

```json
{
  "key":"preparePayment",
  "label":"Prepare payment data",
  "language":"maestro-javascript",
  "source":"output.paymentReady = true;",
  "placement":{"kind":"beforeOperation","visitKey":"checkout","operationKey":"pay"},
  "requires":{"parameters":[],"mockSession":false}
}
```

Alternative placement: `{"kind":"scenarioEnd"}`. There is no public index or fingerprint, and no script-as-node representation.

Rules:

1. A before-operation anchor must identify an operation in that exact visit. It cannot point to another script, setup, handler, launch command, or a different occurrence of the same screen.
2. The effective order is visit order → operation order → scripts anchored before that operation in their `scripts` array order → operation. End scripts run after all authored operations in their array order. Array order is meaningful only among scripts sharing an anchor.
3. To insert after an operation, anchor before the next operation, including one in the next visit; after the final operation, use `scenarioEnd`. If the intervening setup/handler order matters, follow the existing run-plan order shown in preview. V1 cannot insert inside setup or a handler.
4. A before-first-operation script is not a before-launch hook. Existing launch/setup/checkpoint processing remains authoritative. Preview includes system steps so this is visible.
5. Source is literal JavaScript preserved byte-for-byte after JSON decoding. No prompt templating, formatter rewrite, or source interpolation occurs. Exact source bytes determine the existing trust hash.
6. `requires.parameters` names must be declared scenario parameters. This is a declaration by the author, not a complete static analysis of JavaScript. `requires.mockSession:true` requires an explicit valid mock selection. `TNT_MOCK_URL` and `TNT_MOCK_TOKEN` are never accepted as user parameters or values; the runner injects them into generated script commands when appropriate.
7. Native syntax checking uses the current syntax gate without executing source. Node syntax acceptance is not proof of Maestro runtime compatibility: the existing integration test explicitly demonstrates a discrepancy for top-level `return`. Preview must not promise runtime validity.
8. No custom per-script timeout, retries, sandbox, or rollback is promised. The current run has its 300-second cap and existing cleanup/evidence behavior. Script side effects are not undone by Undo authoring.
9. Script code may perform real effects through Maestro capabilities. Applying a flow only stores the script; it neither executes nor grants trust.

### 4.1 Trust integration: a required implementation change

At the reviewed commit, newly registered local editor rows are normally trusted by origin. Merely calling ordinary workspace save for an AI-generated row would therefore be incorrect for this feature.

Both in-app generation and external authoring must allocate fresh script IDs and register them with explicit `imported` trust origin before publishing the workspace. Existing imported semantics require approval of the current source hash and invalidate that approval after edits. Do not add an `ai` enum to the current trust contract just for this feature: store server-assigned authoring provenance separately and display “AI-generated” or “External authoring” in the UI. Update the current import-only explanatory copy so it does not falsely claim these scripts came from a file.

The model cannot supply origin, approval, trusted hashes, or an existing local row ID. Copying identical source does not inherit trust. Applying a preview or acknowledging assumptions does not approve a script. The MCP adapter has no trust tool, run tool, or generic proxy to privileged runner endpoints. Its scoped credential must not expose the browser session credential. This separation is an access policy for the supported integration, not a sandbox against an agent with unrelated filesystem or shell permissions.

The authoring write path must explicitly carry trusted server-side provenance into the workspace/trust publication hook. Audit the default `beforePublish -> trustStore.register(next, previous)` path: the imported registration must not accidentally be replaced by default local registration.

## 5. Translation and stable identities

The compiler performs these steps on an isolated copy of the saved workspace:

1. Validate schema, references, target availability, navigation invariants, capabilities, and aggregate capacity.
2. Resolve existing screens and explicit execution context. Allocate IDs for the new scenario/path/screens/operations/scripts and persist the mapping with the preview.
3. Create per-visit ordered operation IDs and scenario-scoped tests. For stay actions use the current same-screen authoring representation. For navigation generate the existing transition representation, preserving the exact selected sequence. Shared screens must not acquire operations in other scenarios through default inheritance.
4. Generate authoring YAML and references using the shared authoring machinery; project the selected route to obtain actual operation occurrences. Verify projection agrees with the requested order.
5. Map `(visitKey, operationKey)` to the ordinal of that occurrence among authored steps. Exclude script rows and system work from this ordinal. Resolve the anchor's fingerprint from the projected occurrence via the existing anchor machinery.
6. Store scripts in `ScenarioDefinition.scripts` as `{id,label,source,beforeStep:{index,fingerprint}}`. For an end anchor use count `N` and the last occurrence fingerprint plus `:end`, or `end` if `N=0`. Do not use command text to distinguish repeated occurrences.
7. Produce preview graph, change summary, script source/hashes, identity mapping, and a timeline including system work. Compute actual run blockers, including untrusted scripts. Keep a symbolic timeline for untrusted scripts: current `buildRunPlan` intentionally emits no script wrappers when blocked, so its blocked executable output alone is insufficient for an authoring preview.

Stored `flow.yaml` must not receive arbitrary caller-authored `runScript` paths. Actual script files and wrappers remain run-time products of the existing runner. Do not use fake trust approvals just to get an executable YAML preview. After legitimate trust, the existing runner must compile the same occurrence order shown symbolically.

Unassociated YAML retained by the existing projection cannot silently become hidden steps in a generated scenario. Preview lists every retained executable command as system/unassociated work. V1 blocks apply with `UNSUPPORTED_SHARED_YAML` if it cannot isolate the proposed scenario to its declared operations plus explicitly selected setup/system work. Supporting arbitrary legacy workspace mixtures is a later extension, not a reason to change their semantics.

Existing row anchor invalidation after later manual edits remains in force. End anchors do not silently slide forward; an edited referenced operation may require relinking. The generation compiler creates initial anchors, not a permanent automatic rebase policy.

## 6. Concrete example and expected preview

The [JSON example](contracts/ai-flow-v1/repeated-visits-with-scripts.json) contains two screen nodes, three visits, five UI operations, and three scripts. Its app ID and element IDs describe a hypothetical fixture, not inspected application facts.

| Timeline | Authored ordinal / anchor | Canvas placement |
| --- | --- | --- |
| Launch/setup | system, not an anchor | Execution context |
| Check Home title | 0 | Home, first visit |
| Initialize script state | before 1 | Before Open details |
| Check prepared script state | before 1, second script | Before Open details |
| Tap Open details | 1 | Home → Details |
| Check Details title | 2 | Details visit |
| Tap app Back control | 3 | Details → Home |
| Check Home title again | 4 | Home, return visit |
| Finish script | end: index 5, fingerprint of ordinal 4 + `:end` | After last step |

The two Home checks have different operation/visit identities despite identical selectors. All three scripts initially require trust. A failed script uses the existing script-error/not-run result mapping. No new node is created for a script.

## 7. Proposed HTTP and MCP surface

MCP tools map directly to these operations, with matching field names and semantic diagnostics. No adapter writes workspace JSON directly.

| HTTP | MCP tool | Request |
| --- | --- | --- |
| `POST /api/authoring/context` | `tnt_get_authoring_context` | `{workspaceId, expectedRevision, screenIds?: string[]}` |
| `POST /api/authoring/preview` | `tnt_preview_flow` | `{workspaceId, expectedRevision, contextId, draft}` |
| `POST /api/authoring/apply` | `tnt_apply_flow` | `{workspaceId, expectedRevision, previewId, idempotencyKey, acknowledgedAssumptionKeys}` |
| `GET /api/authoring/flows/:scenarioId?workspaceId=...` | `tnt_get_flow` | MCP: `{workspaceId, scenarioId}` |

These routes and tools do not exist yet. They are proposed names, not callable interfaces.

Context returns `{contextId, workspaceId, revision, expiresAt, contractVersion, capabilities, screens, targets, executionOptions, omissions}`. Context snapshots last 30 minutes. Reads use saved state only. Filtered omissions must be explicit; callers can request another context and regenerate the preview. Context IDs bind selected target/configuration snapshots, not credentials.

Preview returns:

```ts
type Preview = {
  previewId: string;
  workspaceId: string;
  baseRevision: number;
  expiresAt: string; // 30 minutes after creation
  contractVersion: 1;
  compilerVersion: string;
  draftHash: string;
  applicable: boolean;
  authoringComplete: boolean;
  runReadiness: 'blocked' | 'requires-preflight';
  requiredAssumptionKeys: string[];
  diagnostics: Diagnostic[];
  changes: { created: EntityRef[]; reused: EntityRef[]; updated: EntityRef[] };
  identityMap: Record<string, EntityRef>;
  timeline: TimelineEntry[]; // system | uiOperation | runScript
};
type EntityRef = { kind: 'scenario' | 'path' | 'screen' | 'visit' | 'operation' | 'script'; id: string };
type Diagnostic = {
  code: string;
  path: string; // JSON Pointer into the draft, or empty for request/workspace errors
  entityKey?: string;
  severity: 'error' | 'warning' | 'info';
  blocks: ('apply' | 'run')[];
  message: string;
  remedy: string;
};
type TimelineEntry =
  | { kind: 'system'; label: string }
  | { kind: 'uiOperation'; visitKey: string; operationKey: string; ordinal: number }
  | { kind: 'runScript'; scriptKey: string; anchorOrdinal: number; atEnd: boolean; trust: 'required' };
```

The stored preview additionally contains normalized draft, proposed graph/YAML, and all script sources, exposed through the in-app review view and the preview result's linked read-only resource for MCP. That resource is authenticated and expires with the preview. Full code must be reviewable; summaries are not code review. Preview never returns tokens or runtime secret values.

`applicable` means there are no apply-blocking diagnostics; required assumption acknowledgements are an additional apply precondition. `authoringComplete` means all authoring requirements are resolved; untrusted scripts can be authoring-complete but run-blocked. Runtime input/device/tool checks remain deferred to preflight. V1 blocks apply for unresolved targets/values, empty scripts, syntax failures, and unmet mock requirements; trust alone does not block apply.

Apply returns `{workspaceId, revision, scenarioId, pathId, identityMap, runReadiness, diagnostics}`. Read-back returns saved revision, scenario summary, operation/script order, script trust per current hash, and diagnostics. It also returns `editableAsV1` and `unsupportedFeatures`; it must not pretend every manually edited legacy flow can be losslessly serialized to this draft schema. The existing workspace is authoritative after apply.

### 7.1 Errors and concurrency

- `400`: malformed JSON, duplicate members, invalid envelope, unsupported contract version.
- `401/403`: missing/insufficient credential scope. Separate read/preview/write; no script-trust scope is granted to authoring clients.
- `404`: unknown workspace/scenario/preview in the caller's authorized scope.
- `409`: `REVISION_CONFLICT`, `CONTEXT_CHANGED`, `PREVIEW_STALE`, `WORKSPACE_BUSY`, or `IDEMPOTENCY_CONFLICT`.
- `410`: `CONTEXT_EXPIRED` or `PREVIEW_EXPIRED`.
- `413`: request limit exceeded.
- `422`: apply rejected with semantic diagnostics or missing assumption acknowledgements.

Preview returns `200` with `applicable:false` for well-formed drafts with repairable schema/semantic problems, using `INVALID_DRAFT` diagnostics with JSON Pointer paths. MCP preserves these codes in structured results; transport success is not semantic success.

Apply takes a workspace write lock, verifies active-run restrictions and expected revision, and validates preview content/compiler bindings again. A compiler change invalidates a preview. The HTTP handler does not accept a replacement draft at apply time. A stale preview is regenerated, never silently rebased. Uncommitted editor edits must be resolved before generation; later edits make the preview stale. External application triggers saved-revision change detection in the open editor; dirty editors retain their content and display conflict.

Use a durable apply journal keyed by authenticated client + workspace + idempotency key. Hash the request content excluding retry timing. Keep successful entries for seven days; older keys return an explicit expired-key conflict if a retained preview records that application, never silently duplicate it. Each preview is single-application even with a second key. Repeated identical requests return the original committed receipt, including after a response is lost. Receipt lookup occurs before revision/preview-expiry rejection for already committed attempts.

Before publication, persist intended IDs and explicitly untrusted script provenance. Then commit the workspace under revision control and persist the receipt. On restart, reconcile an unfinished journal against an internal workspace application marker before allowing another authoring apply. A crash after trust registration but before workspace publication may leave harmless untrusted registrations; it must never leave trusted generated code. A crash after workspace publication must recover the original receipt rather than create another scenario. Define this storage integration in implementation tests; multiple JSON-file writes are not automatically atomic.

## 8. Diagnostic examples

| Code | Blocks | Example |
| --- | --- | --- |
| `UNRESOLVED_TARGET` | apply, run | `/visits/0/operations/1/target` needs an element |
| `INVALID_TRANSITION` | apply, run | Navigation does not lead to the next visit |
| `UNKNOWN_SCRIPT_ANCHOR` | apply, run | Script points to an operation in another visit |
| `SCRIPT_SYNTAX` | apply, run | Current syntax check fails; preserve source for editing |
| `SCRIPT_TRUST_REQUIRED` | run | Source hash requires human trust in the existing UI |
| `MOCK_REQUIRED` | apply, run | Script declares a mock session but none is selected |
| `MISSING_PARAMETER_DECLARATION` | apply, run | Input/script requires an undeclared parameter |
| `RUNTIME_INPUT_REQUIRED` | run | Declaration exists; value must be supplied before run |
| `NO_UI_ASSERTIONS` | neither | Flow can run but has no UI checks |
| `UNVERIFIED_SELECTOR` | neither | Explicit selector has no inspected provenance |
| `UNSUPPORTED_SHARED_YAML` | apply, run | Selected projection would retain undeclared executable work |
| `SHARED_EXECUTION_CONFLICT` | apply, run | Requested setup would change shared behavior |

## 9. Decisions selected for implementation review

1. Use explicit script placements referencing visit/operation keys; translate to internal anchors server-side.
2. Support JavaScript source authoring in the first full v1 release; forbid external paths and trust delegation.
3. Keep unresolved generation drafts outside the executable workspace initially. Users can persist/reopen generation drafts locally in a separate store; do not reuse workspace recovery records. Store schema version and source revision, with explicit delete and no automatic content upload.
4. Use local stdio MCP initially: its process calls the local authoring HTTP surface using a separately issued, machine-local scoped credential. Client pairing is explicit in TnT; credential revocation is supported. The adapter never receives the general browser session token. Remote MCP is out of scope.
5. Apply is an authorized write, not a grant to run or trust scripts. In-app preview uses an explicit Apply action; external clients use their established write authorization and show the proposed changes. Assumption acknowledgements are acknowledgements of interpretation only.
6. Optional model/provider choice does not change this contract. Agents get the schema, current capabilities, semantics, and examples at runtime; skills explain the workflow but are not required for schema enforcement.

These are proposed defaults reviewers can accept or change; they are no longer unspecified holes in the design. Model choice and quantitative generation-quality targets remain release configuration decisions, not field-semantics decisions.

## 10. Phases and acceptance fixtures

**Phase 0 — Review this contract and schema.** Agree field semantics and test vectors, especially script trust classification and publication recovery. Freeze v1 only after review; this document is not yet that approval.

**Phase 1 — Authoring compiler without AI.** Implement context, preview, apply, read-back, generation draft storage, imported script registration, and external revision detection. Include scripts from the start; do not design a node-only compiler and retrofit them later.

Required fixtures: the supplied example produces five authored ordinals and three script rows at `[1,1,5]`; end fingerprint uses ordinal 4; setup/handlers do not shift these ordinals; identical commands on different visits remain distinguishable. Two scripts at one anchor preserve order. Unknown/deleted anchors fail. New scripts are untrusted even when applied in the local UI or when identical source already exists elsewhere. No wrapper is generated merely to preview untrusted code. Syntax acceptance is not reported as runtime validation.

Also verify: partial drafts survive reopen without becoming executable; existing scenarios' projections remain unchanged; mixed legacy YAML is refused when isolation cannot be established; stale revisions and duplicate requests cannot overwrite or duplicate; crash points recover correctly; script source changes invalidate trust; manual operation edits trigger the existing anchor-repair behavior; browser and MCP read-back show the same saved flow.

**Phase 2 — In-app AI.** Thai/English scenario → contract draft → diagnostics/repair → preview → apply. Evaluate navigation, repeated visits, script necessity and source, parameter declarations, uncertainty handling, and unsupported requests. Script generation must not be used as an automatic escape hatch for unsupported UI commands.

**Phase 3 — MCP deliverable.** May run alongside Phase 2 after Phase 1 stabilizes. Ship scoped pairing, four tools, schema/semantic resources, the example, and optional skill. Verify one supported external client end to end, plus protocol conformance fixtures. Invalid origin/trust fields are rejected and privileged runner operations are unreachable through its credential.

**Release validation.** Run generated flows on a known fixture app after explicit script trust and runtime setup. Confirm actual script ordering, failure/not-run mapping, cancellation and evidence protection through the existing runner. Schema validation alone does not establish these guarantees. No implementation or simulator validation is claimed by this document update.

## 11. Design-artifact checks performed on 2026-10-19

- The JSON Schema compiles using the repository's installed Ajv 2020 validator in strict mode.
- The complete example validates; the unresolved-target variant also validates as a draft shape.
- Five malformed variants are rejected: caller-supplied trust, numeric/internal anchors, Node language, shell operation, and external script filename.
- Resolving the example's visit/operation placements yields script ordinals `[1, 1, 5]` as documented.
- Local document links and Markdown code fences were checked.

These checks validate the proposal artifacts only. They do not implement semantic validation, prove runtime execution, or constitute independent design approval.
