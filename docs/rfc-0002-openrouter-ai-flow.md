# RFC #2: OpenRouter for AI flow authoring

Status: Proposed — ready for review; specification only, not implementation authorization

Date: 2026-10-20

Related: [Authoring RFC](ai-flow-authoring-rfc.md), [v1 contract](ai-flow-authoring-contract-v1.md), [canonical schema](contracts/ai-flow-v1/flow-draft.schema.json)

## Decision and scope

Add OpenRouter as a provider for real AI flow generation. Users supply their own API key and choose any model ID they want to try. TnT does not certify model quality, maintain an approved-model allowlist, or block a model because it lacks native structured output. TnT still enforces its authoring contract before any workspace mutation.

This specification also includes the reported bug: an API key disappears after clicking **Test connection**. Fixing credential form state and persistence is a release requirement, not a later polish item. The report establishes the required behavior; its root cause has not been reproduced or established in this design task.

Deliver the existing floating bottom composer → generated flow on Canvas → simple confirmation interaction. Preserve Run script support. Do not introduce a chat sidebar, model benchmark dashboard, automatic test execution, or a new authoring format. Existing providers continue to work. This document supersedes model-quality qualification requirements in the parent RFC; it does not replace its compiler, validation, revision, or script-trust rules.

## User experience

### Settings → AI

One provider selector includes OpenRouter. The OpenRouter form contains:

| Field/action | Required behavior |
| --- | --- |
| API key | Password input; paste supported; reveal is temporary. Never populate it with a masked placeholder pretending to be a real secret. |
| Stored-key status | Separate text: “บันทึก API key แล้ว”. Empty replacement input means retain the stored key, not delete it. |
| Model | Editable model ID, for example `vendor/model`. A searchable provider catalog is a convenience; manual entry always works. |
| Test connection | Test the entered replacement key if present, otherwise the stored key. Does not save, clear, replace, or delete credentials. |
| Save | Explicitly commits the selected provider, model, and any replacement key. A blank replacement preserves the stored key. |
| Remove key | Explicit separate action; removes the stored credential only after confirmation. |

Primary setup path: choose OpenRouter → paste key → enter model → optionally Test connection → Save → return to composer. Save does not require a successful connection test; temporary network failures must not prevent saving. Whitespace is trimmed at submission; an empty first-time credential cannot be saved as configured. Save errors retain all typed values for retry.

Connection success text: “เชื่อมต่อ OpenRouter สำเร็จ — ยังไม่ได้ทดสอบโมเดล”. Authentication checks do not prove that the chosen model exists, has credits available, accepts the prompt, or can generate a valid TnT flow. There is no hidden paid generation during Test connection. After Save succeeds, replace the secret input with the explicit stored-key status; this intentional transition must not look like silent data loss.

Catalog failure leaves the model input usable and retains the current value. Do not silently select the first model when a saved model is absent from the catalog. Show provider/model on the composer in a compact secondary control; changing provider/model affects the next request, not a request already running. Missing settings show a direct Settings action and retain the user's scenario text.

### Floating composer and Canvas

1. User describes a scenario in the bottom floating text field. A subtle sparkle/glow indicates AI; support reduced motion, keyboard submission, and an accessible text status.
2. Generate captures a fixed provider/model, settings revision, workspace revision, and bounded context snapshot. Disable duplicate submission; show Cancel.
3. Show the generated draft as a temporary Canvas preview, including repeated screen visits and inline script insertions. Keep the saved scenario intact until Apply.
4. For a valid draft, ask “สร้าง flow ให้แล้ว แบบนี้โอเคไหม?” with “ใช้ flow นี้” and “ปรับอีกนิด”. Apply persists through the canonical authoring API and selects the resulting scenario. It does not run it.
5. Refinement uses the same text field and the current draft. Keep that draft visible while generating the replacement. On failure/cancellation, retain the previous draft and text.
6. Unresolved targets, missing facts, unsupported operations, or invalid scripts show concise actionable diagnostics; Apply stays disabled. User can answer in the composer or edit through available draft controls, followed by validation.
7. Dismiss discards only the temporary draft. Switching workspace cancels the request and drops its workspace-bound preview; late results cannot appear in the new workspace.

Apply failure preserves the draft. Revision conflict requires a refreshed preview and renewed confirmation; never apply an old draft against a changed workspace silently. Duplicate Apply uses the same idempotency key. The v1 contract remains authoritative for content binding and recovery.

## API key bug: state and persistence contract

Keep three independent states: **saved credential metadata**, **editable replacement secret**, and **connection test result**. Do not reuse one `apiKey` field for all three.

- Saved metadata contains `configured`, `credentialRevision`, and storage availability. It never contains the raw key or a fake `********` value.
- The editable secret exists only in the form's memory until Save or explicit discard. Query refreshes, test responses, error banners, model refresh, and provider rerenders cannot reset it.
- A test result carries `testId`, tested credential revision or local edit version, and status. Editing the key invalidates the visible old result. A late test response cannot overwrite a newer edit or claim that the new key passed.
- While testing, disable another test for the same form; permit editing and discard stale results. Test completion must never submit Save or reinitialize the form.
- Test failure (401, timeout, offline, server error) leaves both the typed replacement and existing saved key untouched. Success has the same non-mutating behavior.
- Save atomically replaces the stored key and configuration. Clear the replacement input only after confirmed success; show stored status. If persistence fails, retain the replacement and prior saved configuration.
- Removing a saved key is the only operation that turns a configured provider into unconfigured. Empty input, testing, and cancellation are not deletion operations.
- Closing Settings with an unsaved replacement offers Save / Discard / Keep editing. Discard clears it from memory. Reopening shows stored status if one exists, otherwise an empty input; never claim an unsaved key was persisted.
- Switching provider with unsaved edits uses the same guard. Tests and settings saves must remain bound to the provider they started with.
- A concurrent settings update returns a conflict rather than overwriting a newer key. Refresh metadata without replacing the unsaved input; let the user explicitly retry Save.

Implementation diagnosis must first reproduce the reported sequence and inspect form initialization, settings query invalidation, test response merging, and password-component remounts. These are investigation candidates, not claimed causes. Add regression coverage at the actual failure boundary after identifying it.

## Credential storage and security

Store credentials on the local TnT service side, separate from workspace JSON, exports, repository files, and general settings payloads. Use the OS credential store for persistent credentials. For the current macOS deployment this means Keychain. If secure persistent storage is unavailable, expose an explicit session-only option and label that restart will require the key again; never silently fall back to plaintext. Persist model/provider preferences separately.

The browser may transmit a newly entered key to the local service for Test or Save but cannot read an existing stored key. Do not place keys in localStorage, URLs, telemetry, prompts, exception text, screenshots used for diagnostics, or full HTTP logs. Redact Authorization headers and user-supplied secrets before displaying upstream errors. Use the application's existing authenticated local API/origin protections; credential endpoints must not be accessible cross-origin without authorization.

A generation resolves the chosen credential on the server at request start. Later settings changes apply to subsequent generations. Remove-key aborts pending requests using that credential where possible; already transmitted data cannot be recalled. Removing or replacing a key never changes an already generated draft or its provenance.

## Proposed service interface

Names below are proposed contracts, not claims that routes already exist. Adapt naming to the existing API while retaining these semantics; reuse the existing generation module rather than building a second pipeline.

| Operation | Input | Output and effects |
| --- | --- | --- |
| `getAiSettings` | None | Provider, model, settings revision, credential configured/storage status; no secret. |
| `testAiConnection` | Provider, test ID, credential source (`stored` or nonempty replacement secret), expected credential revision when stored | Authentication outcome and test ID; no settings mutation and no secret echoed. |
| `saveAiSettings` | Expected settings revision, provider, model, credential action (`keep`, `replace` with secret, or explicit `remove`), storage mode | New revision and sanitized metadata; all-or-nothing persistence. UI Remove uses the explicit remove action. |
| `listAiModels` | Provider | Catalog IDs and optional capability metadata, fetched without exposing credentials to the browser. Failure is non-blocking. |
| `generateAiFlow` | Request ID, provider/model, expected settings and workspace revisions, scenario text, optional previous draft and refinement | Validated draft/preview or structured diagnostics; never writes a scenario. |
| `cancelAiGeneration` | Request ID | Cancellation acknowledged; ignores subsequent responses for that request. |
| `applyAiFlow` | Canonical preview binding, expected workspace revision, idempotency key | Canonical authoring result, persisted scenario identity and new revision. |

Reject stale settings at generation start with `SETTINGS_CHANGED`; preserve text and let the user retry using current settings. Do not accept arbitrary upstream base URLs from the browser. The OpenRouter adapter uses a fixed HTTPS endpoint. Transport errors use stable app codes plus safe text, retryability, and request ID; never forward raw upstream objects indiscriminately.

## OpenRouter adapter and generation contract

Use OpenRouter's chat completions API with Bearer authentication and the user's exact model ID. Use `GET /api/v1/key` for credential testing and `GET /api/v1/models` for optional catalog discovery. There is no automatic fallback to another model or provider. OpenRouter may route the selected model among its upstream providers according to its own account/routing rules; TnT must not describe this as a pinned upstream vendor.

Every generation includes the canonical schema, authoring semantics, supported capabilities, a small verified example, user scenario, and relevant workspace context. Maestro YAML alone is not a valid AI response for TnT authoring. The response must decode into the v1 flow draft and pass the same compiler used by other authoring clients.

Default to ordinary chat completion with explicit JSON-only instructions. This allows users to try models without native JSON Schema support. Decode exactly one JSON document; tolerate a single surrounding JSON code fence, but do not extract arbitrary fragments, evaluate code, invent required values, or repair malformed JSON with guesswork. Native structured-output optimization may be added later behind adapter capability handling; it must not create a model eligibility gate.

A parsed draft passes schema validation, semantic validation, target resolution, compiler preview, and script diagnostics. Unknown references remain unresolved; never invent a selector to make validation pass. Scripts retain source, language, placement and requirements per v1. They receive imported/untrusted origin and require existing hash-based trust before execution, independently of Apply.

If decoding or authoring validation fails, permit **one** automatic repair call to the same model with compact diagnostics and the candidate output treated as untrusted data. Then surface useful diagnostics and allow user refinement. Do not loop until something parses. Model output, workspace text, and script source are data, never authorization to invoke tools, read additional secrets, or execute scripts.

### Initial limits and retry behavior

These are application limits, not provider promises. Enforce them server-side and expose validation errors before sending oversized requests.

| Limit | Proposed v1 default |
| --- | --- |
| Scenario/refinement input | 8,000 Unicode characters |
| Serialized context + instructions + schema + input | 128 KiB UTF-8 per call; truncate optional context only, never schema or user text silently |
| Output allowance | Request at most 8,192 output tokens; cap buffered response at 256 KiB |
| Total generation deadline | 120 seconds including repair and any retry |
| Automatic calls | At most two upstream calls per user submission, including repair or retry |
| Concurrency | One active generation per composer; one per workspace on the local service |
| Catalog caching | 15 minutes; stale catalog can be shown with a refresh action |
| Connection test deadline | 15 seconds; no automatic retry |

The authoring contract's structural limits apply as well; do not introduce a divergent schema in the adapter. If prompt size exceeds a model's context limit, show the provider error and let the user shorten the request or choose a model. Do not silently rewrite the scenario.

Allow at most one retry for an explicit 429/503 rejection, honoring Retry-After when it fits the deadline and call budget. Do not retry ambiguous connection loss/timeouts automatically because the upstream may already have processed and billed the request. Never auto-retry authentication, credit, invalid-model, or unsupported-parameter failures. Cancellation aborts the outgoing request best-effort and invalidates the local request ID; it does not guarantee a billing refund.

## Errors and user recovery

| App code | User action and preservation |
| --- | --- |
| `AI_NOT_CONFIGURED` | Open Settings; keep scenario text. |
| `AUTH_FAILED` | Show key guidance; keep typed replacement and previously saved key. Do not delete either automatically. |
| `CREDENTIAL_STORAGE_FAILED` | Retry Save or explicitly choose session storage; retain input. |
| `CREDITS_REQUIRED` | Explain provider billing failure; keep draft/text and link to provider account. |
| `MODEL_UNAVAILABLE` / `UNSUPPORTED_REQUEST` | Show safe upstream explanation and editable model choice; no fallback. |
| `RATE_LIMITED` / `PROVIDER_UNAVAILABLE` | Show retry action or bounded automatic retry status. |
| `NETWORK_ERROR` / `TIMEOUT` | Preserve text/previous preview; explicit retry may incur another request. |
| `INVALID_AI_OUTPUT` / `AUTHORING_INVALID` | Show concise validation issues after the bounded repair attempt; allow refinement. |
| `SETTINGS_CHANGED` / `WORKSPACE_STALE` | Refresh relevant metadata/context and request a new preview when needed. |
| `CANCELLED` | Return to editable composer, retain text/previous draft; no late result accepted. |

A successful connection test is not used as a generation health badge. A generation error must not reset provider/model fields or remove the key. Malformed or HTML upstream error bodies receive a safe generic message.

## Data sharing and observability

Before the first generation, show a compact disclosure that scenario text, relevant screen/selector metadata, the authoring schema, and explicitly included script source are sent to OpenRouter and its serving provider. No screenshots, device recordings, runtime parameter values, unrelated workspace files, or saved credentials enter the prompt by default. Refer to confidential runtime inputs by parameter names. Refinement sends the relevant prior draft, not an unlimited conversation history.

Keep operational metadata only by default: request ID, selected/returned model identity when available, duration, call count, cancellation, contract version and diagnostic codes. Token usage/cost may be shown when returned; do not invent a price or claim that the token limit guarantees a monetary budget. Users control spending through their OpenRouter account/key limits. Raw prompts, generated scripts and upstream bodies are excluded from general logs.

## Delivery phases and dependencies

1. **Credential settings and bug fix:** implement independent form/test/save states, secure storage, free model entry and optional catalog. Exit: regression matrix below passes. Can ship before generation integration.
2. **Real generation integration:** connect OpenRouter to the existing authoring pipeline and floating composer; validate previews, refinement, cancellation and confirmation. Exit: deterministic integration checks plus one documented real OpenRouter generation through Apply on Canvas. Real-provider smoke tests use authorized credentials and spend; no secret in test fixtures.
3. **MCP deliverable:** expose the shared authoring capabilities/context, preview and apply contracts as proposed in the RFC. External MCP clients may bring their own model; they do not need the TnT OpenRouter key. MCP must never expose credential retrieval. This phase does not block phases 1–2.

Coordinate with the existing compiler/generation/UI implementation owners before choosing route names or modifying shared interfaces. This spec does not assign a new implementation owner or authorize changing existing PRs. Native structured output, streaming, model comparison and additional provider-specific tuning are optional later work, not prerequisites for this feature.

## Acceptance and regression matrix

Tests use controlled provider fixtures for repeatable software behavior. Model quality is for the user to evaluate; no benchmark score or approved-model list is a release gate.

| Case | Required evidence |
| --- | --- |
| Fresh key → Test success | Characters remain in input, no Save called, stored configuration unchanged. |
| Fresh key → Test 401/offline/timeout/500 | Input retained and retry possible; no secret in message/log. |
| Saved key A, enter B → Test success/failure | B stays typed; A remains stored until explicit Save. |
| Edit B into C while B test is pending | B result cannot mark C valid or reset C. |
| Settings/catalog refresh during Test | Provider, model and replacement input retained. |
| Save B success | Stored status appears; reopen and service restart retain B through secure store; raw B never returned to client. |
| Save failure / revision conflict | B remains editable and A remains stored; no false success. |
| Blank replacement / explicit Remove | Blank retains A; explicit confirmed Remove deletes it. |
| Close/provider switch with unsaved input | Save/Discard/Keep editing behaves as specified; no silent loss. |
| Session-only storage | Clear label; service restart becomes unconfigured and asks for key again. |
| Test stored key | Server uses stored key; response contains metadata only. |
| Manual model missing from catalog | Save and generation remain available; catalog failure does not block. |
| Plain JSON model without schema support | Can generate; canonical validation runs before preview/apply. |
| Malformed output then valid repair / repeated invalid output | Exactly bounded calls; valid preview or actionable error; no workspace writes. |
| Run script and repeated visits | Preview and applied scenario preserve placement/order; script remains untrusted and never executes on Apply. |
| Refinement failure/cancel / workspace switch | Previous draft/text preserved as specified; late responses cannot apply or leak into another workspace. |
| Apply, double click, stale revision, persistence failure | One scenario on successful Apply; no duplicate or partial mutation; retry/recovery per canonical contract. |
| Real-provider smoke | Thai or English scenario generates an actual validated draft, renders on Canvas, and persists after confirmation; record model ID and sanitized outcome. A mock fixture is not this evidence. |
| Existing providers | Existing settings and generation still pass their integration checks. |

The API-key bug is complete only when the original user sequence is reproduced before the fix and passes after it. A connection-test unit test alone does not establish that the Settings UI retains the key.

## API references

- [OpenRouter chat completions](https://openrouter.ai/docs/api/api-reference/chat/send-chat-completion-request)
- [Current API key information](https://openrouter.ai/docs/api/api-reference/api-keys/get-current-api-key)
- [Model catalog](https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties)
- [Structured output capabilities](https://openrouter.ai/docs/guides/features/structured-outputs)
- [Provider routing](https://openrouter.ai/docs/guides/routing/provider-selection)

These references establish provider API behavior. UI state, limits, storage policy, retry policy and delivery gates above are TnT design decisions proposed for review.
