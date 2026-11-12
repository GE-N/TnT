# Diagram intake

Status: decisions locked 2026-11-12. The backend slice is in progress on this branch. No client UI in that slice.

Baseline for the research below: `main` at `1e9acce` (PR #104). Official docs were read on 2026-11-12. No live Copilot, Claude, or OpenAI call was made.

The user gives a picture of a flow instead of typing the steps. The model reads it, asks until the sequences are clear, and turns it into Mermaid. The user confirms that Mermaid. TnT stores it as knowledge and can create scenarios from it.

## Decisions (2026-11-12)

These close the questions in section 5.

1. **Option C.** Mermaid is the shared intermediate for an uploaded image and for pasted Mermaid.
2. After the diagram is saved, ask whether to create a scenario. Then author **only the path the user names**. Do not offer every branch.
3. Only a clean exported PNG or JPEG. Whiteboard photos are not a supported input. Any other format gets one plain error: "This file isn't a PNG or JPEG export." The server checks magic bytes. It does not try to tell a JPEG photo from a JPEG export; the UI must not offer a camera or a photo library.
4. Sending that diagram image to the selected provider is allowed. Screenshots and recordings stay on the not-sent list. The first-run disclosure has to say a diagram image is sent. That copy change is part of the UI slice, not the backend slice.
5. After Apply, the diagram is stored only. No block in the info sheet. It is returned only when something asks for it (`GET .../diagram`).

The stored file is `<scenarioId>.diagram.json` next to the scenario sidecar: the confirmed Mermaid and its paths. The original image is not kept after the draft. Why is unchanged by a diagram apply. Undo uses the existing knowledge receipt (the client still hides Undo after 10 seconds; the server does not enforce that window) and restores the previous diagram bytes.

## 1. What we can reuse

**Ask AI.** One field, bottom center, labeled “Ask AI” (`src/ai-flow.tsx`). It is text only: no paste, drop, or file handler. Send posts `prompt`, and optionally `previousJobId` and `answers`. Any other field is `Unknown generation field` (`server/ai/job.ts`). An empty prompt is `PROMPT_REQUIRED`. The cap is 4,000 characters (`server/ai/prompt.ts`). A running request keeps the text and offers Stop. A finished draft is reviewed on the same capsule with Apply, X, and Undo. Questions use the existing ask-back card (`data-testid="ai-questions"`): a short question, two or three options, and the field still takes typed text. An ask-back can be dismissed and has no Apply (`docs/knowledge-contract.md`, Client review).

The first-run disclosure says screenshots and recordings are not sent (`Disclosure` in `src/ai-flow.tsx`). Decision 4 allows a diagram image to be sent and leaves screenshots and recordings unsent. The disclosure sentence itself changes in the UI slice.

**Router.** `POST /api/ai/generations` has no mode. `router@1` (`server/ai/skills/router/v1/prompt.md`, `server/ai/router.ts`) returns `flow`, `knowledge`, `mixed`, or `unclear`. A provider error, a timeout, or a bad body becomes `unclear`, never a flow. `unclear` asks “Change the flow, or update the scenario details?” `mixed` drafts the flow first and keeps the original words as `remainder`. Knowledge waits for “Update the purpose too?” There is no combined apply. A pending draft of the other kind asks “Finish the current draft first?”

The router only sees text (`routerUserMessage`). The offline helper `classifyIntent` only matches words. A picture with no caption would be `unclear` and would get the wrong question.

**Knowledge.** One sidecar per scenario, schema version 1, six strings, 16,000 UTF-8 bytes each: purpose, expected outcome, rationale (Why), preconditions, exceptions, scope (`server/knowledge/types.ts`). Unknown fields are rejected. AI may draft purpose and expected outcome. Why is kept only when the new text is the user’s own words (`allows` in `server/ai/knowledge-update.ts`). Preconditions, exceptions, and scope follow the same rule: the field must be named, and the new text must appear in the prompt. An unapplied draft is not written. Apply and undo use the receipt in `server/knowledge/receipts.ts`. The client hides Undo after 10 seconds. Knowledge has no Versions.

**Scenarios.** A flow draft creates one scenario, `mode: "createScenario"` (`server/ai/prompt.ts`). Visits are one sequence, not a branching graph (`docs/ai-flow-authoring-contract-v1.md`, §3.1). One diagram with branches cannot be one scenario. Flow Apply records a version (`makeVersion` in `src/ai-flow.tsx`). Knowledge Apply does not.

### Can a provider accept an image today?

No provider in this repo can. `Msg` is `{role, content: string}` (`server/ai/providers/types.ts`). `generate` has no image argument. The AI log stores tokens and outcome, not the prompt (`server/ai/log.ts`).

At `1e9acce` none of these sent an image. The backend slice now sends one for Copilot (blob attachment, and only when that model reports vision) and for OpenAI-compatible (`image_url` parts, capped at 2 MB of image bytes). OpenRouter and `claude -p` still return "This model can't read images." Copilot `auto` does too, because vision is not known up front.

| Provider | At `1e9acce` | What the docs require | This slice |
| --- | --- | --- | --- |
| Copilot SDK (embeds CLI 1.0.105) | `session.send({prompt})` only | `attachments` on `send`; `capabilities.supports.vision` | Blob attachment. No vision, or `auto`: plain error. |
| Claude Code `claude -p` | Not a provider | No `--image` flag. Path-in-prompt for `-p` is unproven | Plain error. Still unwired. |
| OpenAI-compatible | String `content` | `image_url` content parts | Sent, within the 2 MB cap. Not the 128 KiB text budget. |
| OpenRouter (same adapter) | String `content` | Documented on `/api/v1/responses`, not the chat body we send | Plain error. Unproven. |

**Copilot.** `package.json` pins `@github/copilot-sdk` 1.0.28. That package names CLI 1.0.105. TnT does not spawn `copilot` itself. `createSdkCopilotRuntime` sends `{prompt}` only (`server/ai/providers/copilot-runtime.ts`). The session sets `availableTools: []`, so a path written into the prompt cannot be opened. SDK 1.0.28 `MessageOptions.attachments` already allows `type: "file"` (absolute path) or `type: "blob"` (base64 plus `mimeType`). GitHub’s image-input page documents both, auto-resize, and `capabilities.supports.vision`. If the image still does not fit, the runtime skips it and does not send it. Our model list keeps only id, name, and enabled, so we never read that flag. **Unknown:** whether a skip is an error or silent. **Unknown:** whether model `auto` can be checked for vision before the image is sent.

**Claude `claude -p`.** `server/ai/config.ts` rejects `anthropic` with “Anthropic is not available in this version.” Nothing spawns `claude`. The CLI reference describes `-p` as print mode and has no `--image` flag. “Work with images” says drag-drop, paste, or a path in the prompt. The programmatic page shows `claude -p` with `--allowedTools` (the example pre-approves `Read`). `--json-schema` can force JSON. `--no-session-persistence` skips saving the session. **Unknown:** in `-p`, is a path inlined, or does the model see the image only if `Read` is pre-approved and the model calls it? Do not point `Read` at the workspace.

**OpenAI.** `createOpenAiCompatibleProvider` POSTs `chat/completions` with string `content` (`server/ai/providers/openai-compatible.ts`). The vision guide accepts a content array: text plus `{type: "image_url", image_url: {url}}`, where `url` is https or a base64 data URL. Named types: PNG, JPEG, WEBP, non-animated GIF. Not every model accepts images. Our text budget is 128 KiB (`REQUEST_BYTE_LIMIT`). A base64 diagram does not fit there, so image bytes need their own cap. The reader keeps `delta.content` only when it is a string, which is fine if the reply stays text.

**OpenRouter.** Same function, `preset: 'openrouter'`, still `chat/completions`, still a string. The image page read for this note puts images on `/api/v1/responses` as `input_image` (URL or base64; PNG, JPEG, WEBP, GIF), not on the body we send. **Unknown:** whether OpenRouter `chat/completions` still accepts an `image_url` part. A change that works for OpenAI may not be enough.

If the selected model cannot see, stop with a plain error. Do not switch models. Never put the diagram on a public URL for a provider to fetch.

## 2. Proposed flow

The upload uses the existing Ask AI field: attach, paste, or drop. One PNG or JPEG export, plus an optional caption in the same field. Pasted Mermaid is ordinary text in that field. No second field and no mode. Whiteboard photos are out of scope.

An image, or a message that is a Mermaid flowchart, is data on the same generation. It does not get “Change the flow, or update the scenario details?” A caption that clearly asks for something else still uses the existing ask-back. An image and a Mermaid block together ask which is the source. A pending draft still has to be applied or dismissed first.

The picture is a temp file for that job. It is not placed on the job view, in the AI log, or in the six knowledge fields. Dismiss and expiry delete it. The API has to allow an image with an empty caption, because an empty prompt is rejected today. The server must not invent a caption.

A new skill, next to `router@1` and `knowledge-update@1`, reads the image once. Pasted Mermaid skips the image call and uses the same skill. The skill returns Mermaid plus questions. Questions use the ask-back card. Apply stays hidden while a question is open. The user picks an option or types. That is the existing `previousJobId` and `answers` refine. After a few rounds the loop stops and lists what is still unclear. It does not guess a missing arrow.

Mermaid is the reading the user confirms. The picture is the evidence. Later scenarios are built from the graph, not from a second look at the pixels. Show the Mermaid source as soon as the backend can return it. Draw it only after a UI preview, so branches can be compared with the picture. V1 accepts a flowchart. Anything else comes back as a question.

Apply and X stay on the capsule. Apply writes `<scenarioId>.diagram.json` next to the sidecar, not a seventh context field and not `scope` or `exceptions`. The file holds the confirmed Mermaid and the path list. It does not hold the image, and it is not copied into the HTML reader or the info sheet. A diagram apply does not change the six context fields, so Why stays as the user left it. The receipt records the previous diagram bytes (null when there was no file) and the previous sidecar bytes. Undo restores both. The diagram gets no Versions row. The client hides Undo after 10 seconds; this server does not add a second timer.

Scenarios are a second confirmation. The only options are “Yes” and “Not now”. Yes asks the user to name one path. The options on that question are “The path I named” and “Not now”. Branch titles are not offered. The named path becomes one existing flow draft, with its own Apply, X, Undo, and flow version. Other branches are not authored.

A model that cannot see never receives the image. The error says this model can’t read images, and that the user can paste Mermaid or pick a model that can. The file stays local.

## 3. Options

**A. Minimal.** Image, then Mermaid, then confirm, then store the attachment. Scenarios wait for a later Ask AI message, which reads the stored Mermaid as text and does not look at the image again. Smallest change. The scenario step is easy to skip, and the user may retype the flow.

**B. One sitting.** Grill, confirm, store, and author every path before the user leaves. That matches the request as one session. It fights the current rules: no combined apply, one linear scenario per draft, and a misread diagram would become authored flows.

**C. Mermaid first, including a paste.** The image and a pasted graph share one confirm step and one attachment. Scenario creation is the follow-up in section 2, one path per draft. A provider without vision still works. Tests do not need a live vision model.

**Decision: C.** Locked on 2026-11-12. It keeps one field and no modes, and it reuses ask-back, Apply, X, and the 10-second Undo. The scenario step asks first and then authors one named path.

## 4. Slices, risks, tests

Backend first. No UI build until the owner has seen a UI preview.

1. Accept one PNG or JPEG, including an empty caption. Check magic bytes. Cap the size. Reference images are already limited to 250 KB (`server/workspace-package.ts`); a diagram cap may be higher, but it must be explicit and must not reuse the 128 KiB text budget. Store a temp file. No model call.
2. An optional image on one provider message, tested with `createFakeProvider` and `createFakeCopilotRuntime`. OpenAI shape: content parts on `chat/completions`. Copilot shape: one blob attachment, tools still empty, vision checked before send. Leave OpenRouter and `claude -p` unwired until the unknowns in section 1 are closed. A non-vision model returns a typed error and does not hit the network.
3. The diagram skill and the question loop. The fake model asks once, then returns Mermaid and no questions. The sidecar is not written.
4. Apply and undo for the attachment. A purpose change is allowed only when today’s knowledge rules allow it. The image stays out of the knowledge HTML. Dismiss deletes the temp file.
5. A pure function that lists start-to-end paths, and one flow preview per chosen path. Still no UI.

Then a static preview, and only then any UI. The preview has to show: the chip on Ask AI for one PNG or JPEG (and the one error for anything else, including a photo the user tried to drop), the ask-back card while the diagram is unclear, the Mermaid confirm with Apply and X, the disclosure line that this diagram image is sent while screenshots and recordings are not, “Create a scenario from this diagram?” with only Yes and Not now, and “Name the one path to author” without a list of branches. After Apply there is no diagram block in the info sheet.

Risks:

- Vision misreads crossed arrows, small type, Thai labels, and whiteboard photos. The user confirms Mermaid before anything is saved.
- Large images miss the text budget. Copilot may skip an image that still does not fit. If we cannot prove the image was sent, fail. Do not trust Mermaid that might have come from the caption alone.
- The disclosure currently says screenshots are not sent. Diagrams often contain names, account numbers, and internal URLs. Keep the file local, out of logs, and out of the HTML reader.
- No vision is a plain error, not a prose guess and not a model switch. Copilot `auto` may pick a model that cannot see. Require a known vision model for an image until that is settled.
- Model Mermaid can be invalid or can add a path. Parse a flowchart subset. Ask when a path is ambiguous.

Tests use the fake provider and the fake Copilot runtime only. Cover an empty caption, bad bytes, an oversize file, the non-vision error, a question then Mermaid, Why left unchanged unless the user wrote it, undo restoring the previous Mermaid, dismiss deleting the temp file, one scenario preview per path, and pasted Mermaid that never calls the image API.

## 5. Open questions

None. The five questions from the first draft are decided in the section at the top.
