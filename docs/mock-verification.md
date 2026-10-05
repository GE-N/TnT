# Mock scenario implementation and verification — issue #5

Implementation baseline: `07938d0cfbb96f8a47413a577c52eb201ff59292`. Verified 2026-10-05, macOS 15.1 / Node 24.7.0 / Maestro 2.11.0 / Mockoon CLI and commons 9.9.0.

## Implemented behavior

The workbench imports an existing Mockoon JSON environment, selects one existing HTTP route/response, and records explicit HTTP/body failure semantics and source/expected screen labels. It starts a dedicated loopback-only CLI process with a unique admin token and a copied environment. No original file or shared server is edited. The app must already route its API calls to the dedicated port.

The controller resets counters, data buckets, global variables and logs before any scenario command. It selects the response using an acknowledged full environment update. The selected variant is the only response for that route during the run, applies to every matching request, and has its original conditional rules removed in the dedicated copy. All other routes retain their original behavior. Unmatched requests and explicitly selected passthrough routes forward to the chosen test backend. The selected route cannot also be passthrough.

Configuration failure prevents Maestro execution and returns `setup-error`. Success, assertion failure, nonzero process exit and cancellation all reach mock cleanup. Cleanup restores/purges the owned copy when possible, then stops its process group and verifies disappearance. If the controller has failed, stopping the isolated process destroys its in-memory state; this fallback is disclosed. Unverified process cleanup keeps device ownership for manual recovery. Runner crashes still use the existing conservative ownership-lock recovery policy; automatic crash recovery belongs to #11.

Reusable YAML files use declared flat filenames, are included in immutable snapshots, and permit parameterized `runFlow` calls. References must resolve within the declared files, cannot cycle, and must use the same literal app ID. External scripts/media/artifact paths remain unsupported. The UI can append a separate reusable assertion and shows a minimal expected screen path. Screen labels describe expectations; executable YAML owns the actual assertion.

Mock intent is separate from observed server transactions. Intent acknowledgement alone is not request evidence or UI success. Evidence retains method, route/path, HTTP status, variant/route identity, proxy flag and timestamp, with bodies, query values and headers omitted. Controller traffic is excluded. Server observations do not independently identify the originating app. Empty/missing evidence is unavailable; confidential runtime inputs withhold request evidence and raw Maestro artifacts. At most the latest 100 transactions are retained.

## Validation

- Public runner boundary contract tests use a real Mockoon process and a local test backend, with simulator/Maestro output fixtures clearly identified.
- The positive contract verifies HTTP 500 selection before execution, fallback, reusable YAML snapshotting, observed evidence, and owned process disappearance.
- Final full suite: 28 tests passed; type checking, production build, and diff checks passed.
- Negative contracts cover wrong application in a reusable flow, port conflict preventing the app action, a failed nested destination assertion with screenshot evidence, and cancellation through mock cleanup before device release.
- Real simulator `com.example.HybridApp`: reusable Home assertion passed in run `23a9fce6-9600-486c-a0fc-945f796d032c`; deliberately missing maintenance text failed in `33fcc6a0-6595-4484-81ac-23b68b040dde`. Both mapped top-level `runFlow` correctly and verified Maestro/Mockoon cleanup. These are reusable-flow integration checks, **not** proof of the app's API-to-maintenance path.
- The sample app's Home implementation uses `Task.sleep` and local items, with no inspected API request or maintenance navigation. A concurrently started contract test touched the second proof server's admin endpoint; those controller requests are now excluded from captured request evidence. No request was attributed to the app.

- Browser smoke on localhost:4318 imported the fixture environment, selected its HTTP 500 variant, authored `Home.*` through the literal-label helper, appended a reusable assertion, and ran it on the simulator. Run `96e5fcc8-6086-4ac2-b3b5-3ad70f30a4a7` failed the exact literal `^Home\.\*$` as intended instead of matching Home. The browser showed acknowledged intent, unavailable observed requests, mapped failed `runFlow`, failure screenshot/logs, executed reusable YAML and verified cleanup.
- Standards review identified loopback self-proxy aliases and unescaped helper labels; both were fixed. The loopback regression covers localhost, trailing-dot localhost, IPv4 loopback, IPv6 loopback and IPv4-mapped IPv6. The real browser negative run verifies literal-label escaping. Spec review shares the self-proxy finding and records the remaining real-app acceptance gate.

## Remaining release inputs / gate

The actual existing Mockoon environment, proof app/feature, API endpoint, app networking route/base URL, HTTP versus body failure semantics, and maintenance-screen condition have not been supplied. A real picked action → selected mock response → app maintenance screen, including target-app cancellation/restoration proof, is still required by #5. This ticket must remain open; fixture traffic and the local sample app cannot satisfy that gate.

## Integration references and limits

Verified against the installed CLI help/source and official [environment-update API](https://mockoon.com/docs/latest/admin-api/environment-configuration-update/), [state reset](https://mockoon.com/docs/latest/admin-api/server-state/), [transaction logs](https://mockoon.com/docs/latest/admin-api/transaction-logs/) and [proxy behavior](https://mockoon.com/docs/latest/server-configuration/proxy-mode/).

This adapter accepts current 9.9 environment schema with inline/data-bucket responses, without TLS file configuration, response files, or callbacks. Mock ports are dedicated and loopback-only. Mid-flow response switching is #10; generic setup/default actions are #6; complete canvas editing is #7; richer evidence is #12. Import only test environments and keep confidential values out of authored YAML/JSON.

Dependency audit: Faker was overridden to patched 10.6.0. The registry still reports the unresolved `braces <=3.0.3` stack-exhaustion advisory through Mockoon's proxy dependencies (five reported packages including dependents); latest braces remains 3.0.3. No forced downgrade to obsolete Mockoon was applied. Mockoon remains restricted to the owned localhost test process.
