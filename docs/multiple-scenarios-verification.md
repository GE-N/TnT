# Multiple scenarios — issue #9

Implementation baseline: `234ae6d`. Verified 2026-10-08 with Node 24.7.0, Maestro 2.11.0, Mockoon CLI 9.9.0 and the prepared iPhone 15 / iOS 17 simulator.

## Product decisions

The user confirmed that every scenario starts through its declared setup. Mid-flow starting is not implemented. Before running, the browser offers **Reset app data before setup**, default **No**. No relaunches the app and preserves its data; setup must establish the declared app/session state. Yes requests Maestro `launchApp` with `clearState: true` before setup. Neither mode clears the simulator-wide Keychain or resets server-side sessions. Those states remain the responsibility of explicit setup, and app data is not restored after a run.

## Authoring and execution

A workspace owns one authored root YAML command pool, reusable YAML files, screen graph, shared handler/checkpoint definitions and a shared Mockoon environment. Up to 20 named scenarios reference selected root steps by position and executable fingerprint, plus a path ID, saved test inputs, input requirements, setup invocation, enabled handler IDs and optional mock response ID. Executable actions and assertions stay in YAML; scenario metadata never copies their command bodies.

The browser adds, selects, renames and removes scenarios. Selected steps execute in authored order. Its selected path is highlighted in the shared canvas. Setup, enabled handlers and mock response are reviewed per scenario. JSON drafts require Apply; independent draft guards prevent saving/running or switching scenarios while any draft is pending. Loading another workspace resets its editor state. Deleting a YAML step warns about affected scenarios and invalidates their references even for identical adjacent commands; targeted Undo restores still-matching invalidated references without overwriting later edits. Relink selected steps explicitly accepts current identities.

Each selected scenario projects referenced commands into executable YAML and remaps valid canvas/checkpoint associations to their execution positions. Existing stale associations remain stale; omitted steps do not execute. Its declared setup always precedes the selected steps. Only its enabled handlers are instrumented. Mock selection references the shared environment's response identity; each run creates/restores its own owned copy, and displayed expected screens follow the selected path. Selecting another graph path changes metadata, not executable commands.

Saved inputs are non-confidential test data and persist with scenario metadata. Confidential runtime inputs use the existing password field and override saved inputs for that run only; their values are omitted from snapshots, raw evaluated artifacts/logs/images are withheld and temporary tool artifacts are deleted. Every Maestro process receives only that run's inputs and the existing restricted tool environment. Snapshots retain scenario identity/configuration, reset choice, original authored root YAML, selected executable YAML, projected graph, setup/handlers, mock choice and versions. Later authoring does not change historical results.

Required inputs and text/number/boolean contracts are checked before simulator acquisition. Simple `${NAME}` placeholders are validated across root/reusable-flow invocation scopes, including setup/action parameter templates. Maestro-provided built-ins are exempt from user-input requirements. Arbitrary JavaScript expressions remain Maestro-owned; declare their required inputs explicitly in scenario requirements rather than relying on static JavaScript evaluation. Existing workspace and flow size limits still apply, as do the canvas limits. There is no scenario batch runner, automatic route enumeration or mid-flow mock switching (#10).

The [official Maestro parameter documentation](https://docs.maestro.dev/maestro-flows/flow-control-and-logic/parameters-and-constants) describes CLI string parameters and subflow environment scope. [launchApp documentation](https://docs.maestro.dev/reference/commands-available/launchapp) describes clearState. Actual pinned-tool behavior was verified below.

## Verification

71 tests passed; type checking, production build and diff checks passed. Standards and Spec reviews reported no remaining actionable findings. Regressions exercise the public scenario service and browser authoring UI: independent input/setup runs in both orders, reset No/Yes, required/type/template validation, subset-to-canvas mapping, immutable confidential snapshots, independent draft guards, duplicate-step deletion/Undo, and loading with a pending draft.

Real integration used the separate controlled API app compiled from `tests/fixtures/canvas-api-proof.swift`, bundle `com.example.TnTCanvasAPIProof`. It makes a real GET to `http://localhost:4320/items`, displays Maintenance for HTTP 500 with code MAINTENANCE and Success for HTTP 200. The existing local `tests/fixtures/mockoon.json` fixture environment supplies both responses; fallback port 4321 is an owned local test server.

Workspace `c3cb9e8b-d1c2-4a63-a15e-408042344d01` contains both scenarios sharing Home, `setup.yaml` and `page.yaml`. Setup asserts `${START_PAGE}` (Home); the shared page flow asserts `${EXPECTED_PAGE}` (Maintenance or Success). Both explicitly enable the same notice-dismissal handler before Load page and select their distinct paths/mock responses.

| Order / choice | Scenario | Run | Result |
| --- | --- | --- | --- |
| A then B, reset No | Maintenance | `1d8ba552-ae7f-4084-a751-ab38299313a9` | Passed; captured GET /items HTTP 500 |
| A then B, reset No | Success | `a7c7920c-6e11-4636-ba0f-28337680c5b5` | Passed; captured GET /items HTTP 200 |
| B then A, reset No | Success | `f1bfe733-7079-42e8-b006-1294fb1402b3` | Passed; captured GET /items HTTP 200 |
| B then A, reset No | Maintenance | `8c7392fb-68c7-42cb-bd69-7c39b0d2491a` | Passed; captured GET /items HTTP 500 |
| Explicit reset Yes | Success | `edd7a326-a257-49dc-bce1-15f7f9599626` | Passed; snapshot reset true |
| Browser selection, preview and run, reset No | Success | `16ac0a5f-a1e9-45fc-9aab-868eae4e1260` | Passed; setup/handler/action/assertion and Success edge mapped; Maintenance unavailable |

Owned native/Mockoon process cleanup and mock environment reset were verified. Local ignored proof script/results are `.tnt/issue-9-proof.ts` and `.tnt/issue-9-proof.json`; run artifacts remain under `.tnt/runs/<run-id>`. Browser screenshot: `.tnt/issue-9-browser-success.png`.

This proves real execution against a controlled fixture, not API integration with the user's existing HybridApp or production target. Actual-target-app endpoint/base URL and relevant setup/session conditions are still separate inputs. With reset No, order independence depends on the declared setup establishing the required state; no broader promise about external sessions is inferred.
